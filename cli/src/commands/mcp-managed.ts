// party mcp --managed <stateDir> — managed profile lane 的角色裁剪 MCP server（#581 Phase 2）。
//
// 与通用 `party mcp` 的分工：那边是 agent 自愿接入的全工具面；这边是 supervisor（party serve
// --profile）替 front/worker 两条 lane 拉起的受限工具面——「角色即工具集」：模型没有的能力
// 不需要靠 reminder 禁止（#578 用散文 + 文本信封约束模型的四条缺陷由此消除）。
//
// 文件握手（cli/src/managed.ts 是两侧唯一事实源）：
//   managed.json  lane 清单（attach 时写一次：身份/频道/角色/token config/附件围栏根）
//   wake.json     当前 wake（supervisor 每回合覆写：frame/delivery/owner 决策绑定）
//   outcome-<seq>.ndjson  工具 handler 落盘的动作回执，supervisor 回合结束后消费
//
// 安全边界（#578 语义不变处）：
//   - 模型 env 仍是 denied-home（token 不进模型环境）；token 只在本进程读的 config 文件里。
//   - front 恒禁主机文件附件；worker 附件 realpath 围栏在 channelWorkdir（工具层拒 symlink 逃逸）。
//   - 派工/返工消息不再带文本前缀：front 的 party_reply 没有 mentions 能力，任何 front @worker
//     的消息在结构上就只能出自 dispatch/feedback 工具——worker 侧据 delivery 结构化字段验收。
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  BODY_LIMIT,
  DECISION_OPTION_LIMIT,
  DECISION_OPTIONS_MAX,
  DECISION_PROMPT_LIMIT,
  type DecisionResolution,
  type SendDecisionRequest,
} from "@agentparty/shared";
import { stripTerminalControls } from "../format";
import {
  appendManagedAction,
  createManagedLineageResolver,
  ManagedActionError,
  readManagedManifest,
  readManagedWake,
  resolveManagedAttachmentPath,
  type ManagedLaneManifest,
  type ManagedWakeState,
} from "../managed";
import { fetchChannelCharter, fetchRecentMessages, postMessage } from "../rest";
import { uploadAttachmentPaths } from "./send";

const ACTION_TEXT_MAX = BODY_LIMIT - 1024;

function ok(data: Record<string, unknown>, text?: string): CallToolResult {
  return {
    content: [{ type: "text", text: stripTerminalControls(text ?? JSON.stringify(data, null, 2)) }],
    structuredContent: data,
  };
}

function fail(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: stripTerminalControls(message) }],
  };
}

interface LaneAuth {
  server: string;
  token: string;
}

function laneAuth(manifest: ManagedLaneManifest): LaneAuth {
  const raw = JSON.parse(readFileSync(manifest.config, "utf8")) as { server?: string; token?: string };
  if (typeof raw.token !== "string" || raw.token === "") {
    throw new ManagedActionError("managed lane token config is missing or empty");
  }
  return { server: manifest.server, token: raw.token };
}

/** 每回合动作幂等闸：同一 wake 内重复调用同名独占动作直接拒，防模型循环刷屏。 */
const EXCLUSIVE_ACTIONS = new Set(["owner_decision"]);

export function createManagedMcpServer(stateDir: string): McpServer {
  const manifest = readManagedManifest(stateDir);
  const role = manifest.role;
  const server = new McpServer({ name: `agentparty-managed-${role}`, version: "1.0.0" });
  const seenExclusive = new Map<number, Set<string>>();

  const wake = (): ManagedWakeState => readManagedWake(stateDir);
  const record = (
    seq: number,
    action: "channel_reply" | "worker_dispatch" | "worker_feedback" | "owner_decision" | "worker_report",
    postedSeq: number,
    decisionState?: "pending" | "auto_resolved",
  ) => {
    appendManagedAction(stateDir, seq, {
      action,
      seq: postedSeq,
      ...(decisionState === undefined ? {} : { decision_state: decisionState }),
      at: Date.now(),
    });
  };
  // 幂等闸分两步：调用前只查、动作成功后才落标——失败的尝试不许堵死本回合的重试。
  const assertExclusiveUnused = (seq: number, action: string) => {
    if (!EXCLUSIVE_ACTIONS.has(action)) return;
    if (seenExclusive.get(seq)?.has(action) === true) {
      throw new ManagedActionError(`${action} already issued for this wake`);
    }
  };
  const markExclusive = (seq: number, action: string) => {
    if (!EXCLUSIVE_ACTIONS.has(action)) return;
    const seen = seenExclusive.get(seq) ?? new Set<string>();
    seen.add(action);
    seenExclusive.set(seq, seen);
  };

  const lineage = () => {
    const auth = laneAuth(manifest);
    return createManagedLineageResolver({
      server: auth.server,
      token: auth.token,
      channel: manifest.channel,
      frontName: manifest.front,
      workerName: manifest.worker,
      ownerAccount: manifest.owner_account,
    });
  };

  // ---------- 只读件（两角色都有）：模型每回合重锚用 ----------
  server.registerTool(
    "party_charter",
    {
      title: "Read channel charter",
      description: "Read this channel's charter (scope, etiquette, roles). Read it before acting.",
      inputSchema: {},
    },
    async () => {
      try {
        const auth = laneAuth(manifest);
        const body = await fetchChannelCharter(auth.server, auth.token, manifest.channel);
        return ok({ type: "charter", channel: manifest.channel, ...body });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_history",
    {
      title: "Read recent channel messages",
      description: "Read the most recent messages in this channel (read-only).",
      inputSchema: {
        limit: z.number().int().positive().max(50).optional().describe("How many recent messages (default 20)."),
      },
    },
    async ({ limit }) => {
      try {
        const auth = laneAuth(manifest);
        const messages = await fetchRecentMessages(auth.server, auth.token, manifest.channel, limit ?? 20);
        return ok({ type: "history", channel: manifest.channel, messages });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  if (role === "front") {
    // ---------- front：频道回复（无 mentions 能力——@worker 只能走 dispatch/feedback） ----------
    server.registerTool(
      "party_reply",
      {
        title: "Reply in the channel",
        description:
          "Post your synthesis/reply to the channel, threaded onto the conversation origin. This is your ONLY way to speak to channel members; it cannot @-mention your worker (use party_worker_dispatch / party_worker_feedback for that).",
        inputSchema: {
          body: z.string().min(1).max(ACTION_TEXT_MAX).describe("Reply body (plain prose is fine)."),
        },
      },
      async ({ body }) => {
        try {
          const auth = laneAuth(manifest);
          const state = wake();
          const origin = await lineage()(state.frame, state.delivery);
          const replyTo = origin?.seq ?? state.frame.seq;
          const posted = await postMessage(auth.server, auth.token, manifest.channel, {
            kind: "message",
            body: body.trim(),
            mentions: [],
            reply_to: replyTo,
          });
          // 血缘续接（worker 报告/owner 答复）时补一条 completion status，与文本协议路由同语义。
          if (origin !== null) {
            await postMessage(auth.server, auth.token, manifest.channel, {
              kind: "status",
              state: "done",
              note: `front synthesis delivered for seq=${state.frame.seq}`,
              mentions: [],
              summary_seq: state.frame.seq,
            } as Parameters<typeof postMessage>[3]);
          }
          record(state.frame.seq, "channel_reply", posted.seq);
          return ok({ type: "reply", channel: manifest.channel, seq: posted.seq, reply_to: replyTo });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    );

    // ---------- front：派工 / 返工（结构化：reply_to=origin + mentions=[worker]，无文本前缀） ----------
    const dispatchLike = (kind: "worker_dispatch" | "worker_feedback") =>
      async ({ instruction }: { instruction: string }): Promise<CallToolResult> => {
        try {
          const auth = laneAuth(manifest);
          const state = wake();
          const origin = await lineage()(state.frame, state.delivery);
          const replyTo = origin?.seq ?? state.frame.seq;
          const posted = await postMessage(auth.server, auth.token, manifest.channel, {
            kind: "message",
            body: instruction.trim(),
            mentions: [manifest.worker],
            reply_to: replyTo,
          });
          if (origin !== null) {
            await postMessage(auth.server, auth.token, manifest.channel, {
              kind: "status",
              state: "done",
              note: `front synthesis delivered for seq=${state.frame.seq}`,
              mentions: [],
              summary_seq: state.frame.seq,
            } as Parameters<typeof postMessage>[3]);
          }
          record(state.frame.seq, kind, posted.seq);
          return ok({ type: kind, channel: manifest.channel, seq: posted.seq, worker: manifest.worker, reply_to: replyTo });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      };

    server.registerTool(
      "party_worker_dispatch",
      {
        title: "Dispatch work to your execution worker",
        description:
          "Send a work instruction to your execution worker. Code changes, multi-step investigation, and long-running execution MUST go through this tool — you are the control plane and never execute yourself.",
        inputSchema: { instruction: z.string().min(1).max(ACTION_TEXT_MAX) },
      },
      dispatchLike("worker_dispatch"),
    );

    server.registerTool(
      "party_worker_feedback",
      {
        title: "Ask the worker for fixes / follow-up",
        description: "Send follow-up or rework instructions to your execution worker about its last report.",
        inputSchema: { instruction: z.string().min(1).max(ACTION_TEXT_MAX) },
      },
      dispatchLike("worker_feedback"),
    );

    // ---------- front：owner 决策（绑定 responder；binding 未启用 fail closed，同 #578） ----------
    server.registerTool(
      "party_decision_ask",
      {
        title: "Ask the channel owner for a decision",
        description:
          "Ask the human owner to approve or choose. Non-blocking: after this returns pending, END your turn — the owner's answer wakes you later with full context. Do not poll.",
        inputSchema: {
          prompt: z.string().min(1).max(DECISION_PROMPT_LIMIT),
          options: z.array(z.string().min(1).max(DECISION_OPTION_LIMIT)).max(DECISION_OPTIONS_MAX).optional(),
        },
      },
      async ({ prompt, options }) => {
        try {
          const auth = laneAuth(manifest);
          const state = wake();
          assertExclusiveUnused(state.frame.seq, "owner_decision");
          if (state.delivery === null || state.delivery.work_id === null || state.delivery.continuation_ref === null) {
            throw new ManagedActionError("managed owner decision requires an active durable delivery");
          }
          if (state.owner_decision_binding !== true) {
            throw new ManagedActionError(
              "server does not enforce owner_decision responder binding (owner_decision_binding v1); upgrade the Worker before managed owner decisions",
            );
          }
          if (options !== undefined && options.length === 1) {
            throw new ManagedActionError("choice decision requires at least 2 options");
          }
          const origin = await lineage()(state.frame, state.delivery);
          const decisionRequest: SendDecisionRequest = options === undefined || options.length === 0
            ? { kind: "approval", prompt }
            : { kind: "choice", prompt, options };
          const payload: Parameters<typeof postMessage>[3] & {
            expected_decision_lineage?: { delivery_id: string; work_id: string; continuation_ref: string };
            expected_decision_responder_owner?: string;
          } = {
            kind: "message",
            body: prompt,
            mentions: [],
            reply_to: origin?.seq ?? state.frame.seq,
            decision_request: decisionRequest,
            expected_decision_lineage: {
              delivery_id: state.delivery.id,
              work_id: state.delivery.work_id,
              continuation_ref: state.delivery.continuation_ref,
            },
            expected_decision_responder_owner: manifest.owner_account,
          };
          const posted = await postMessage(auth.server, auth.token, manifest.channel, payload);
          const resolution: DecisionResolution | undefined = posted.decision_resolution;
          const decisionState = resolution?.state === "auto_resolved" ? "auto_resolved" : "pending";
          markExclusive(state.frame.seq, "owner_decision");
          record(state.frame.seq, "owner_decision", posted.seq, decisionState);
          if (decisionState === "auto_resolved") {
            return ok(
              { type: "decision", seq: posted.seq, state: "auto_resolved", chosen_option: resolution?.chosen_option },
              `decision #${posted.seq} auto_resolved → ${resolution?.chosen_option ?? "?"} (unattended mode). Continue your work in this same turn.`,
            );
          }
          return ok(
            { type: "decision", seq: posted.seq, state: "waiting_owner" },
            `decision #${posted.seq} posted; a HUMAN resolves it. END this turn now — the owner's answer arrives as a new wake with continuation context. Do not poll.`,
          );
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    );
  }

  if (role === "worker") {
    // ---------- worker：结构化报告（reply_to=派工消息；附件过 realpath 围栏） ----------
    server.registerTool(
      "party_worker_report",
      {
        title: "Report back to your front agent",
        description:
          "Report your execution result back to the front agent that dispatched you. Attach deliverables (diffs, logs, screenshots) from your channel workspace via `attach` — paths outside the workspace are rejected.",
        inputSchema: {
          body: z.string().min(1).max(ACTION_TEXT_MAX).describe("Report body: what you did, evidence, and outcome."),
          attach: z
            .array(z.string())
            .max(8)
            .optional()
            .describe("Absolute file paths inside your channel workspace to upload as attachments (max 25MB each)."),
        },
      },
      async ({ body, attach }) => {
        try {
          const auth = laneAuth(manifest);
          const state = wake();
          // 围栏先行：任何一个路径越界，整个报告不发（与 CLI attach 的整体失败语义一致）。
          const realPaths = (attach ?? []).map((path) => resolveManagedAttachmentPath(path, manifest.attachment_root));
          const attachments = realPaths.length > 0
            ? await uploadAttachmentPaths(auth.server, auth.token, manifest.channel, realPaths)
            : undefined;
          const posted = await postMessage(auth.server, auth.token, manifest.channel, {
            kind: "message",
            body: body.trim(),
            mentions: [],
            reply_to: state.frame.seq,
            ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
          });
          record(state.frame.seq, "worker_report", posted.seq);
          return ok({
            type: "worker_report",
            channel: manifest.channel,
            seq: posted.seq,
            reply_to: state.frame.seq,
            ...(attachments !== undefined
              ? { attachments: attachments.map((a) => ({ filename: basename(a.filename), size: a.size })) }
              : {}),
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    );
  }

  return server;
}

export async function runManagedMcp(stateDir: string): Promise<number> {
  const server = createManagedMcpServer(stateDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return new Promise<number>((resolve) => {
    transport.onclose = () => resolve(0);
  });
}

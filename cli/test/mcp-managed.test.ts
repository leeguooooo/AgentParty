// #581 Phase 2 验收（MCP server 侧）：party mcp --managed 的角色裁剪工具面。
// 真 stdio server + mock REST：
//   - 角色即工具集：front 无 worker_report/attach 面；worker 无 dispatch/decision/reply 面；
//   - front 派工/返工消息零前缀（body=instruction 原文，mentions=[worker]）；
//   - owner 决策：binding 未启用 fail closed；启用时带 expected lineage + responder owner；
//   - worker 附件 symlink 逃逸在工具层被拒且一字不发（issue 验收标准原文场景）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MsgFrame } from "@agentparty/shared";
import {
  MANAGED_CONFIG_FILE,
  writeManagedManifest,
  writeManagedWake,
  readManagedActions,
  type ManagedWakeState,
} from "../src/managed";
import { msgFrame } from "./mock-server";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let stateDir: string;
let channelWorkdir: string;
let restServer: ReturnType<typeof Bun.serve> | null = null;
const seen: { method: string; path: string; body: unknown }[] = [];
let nextSeq = 100;

function startRest(): void {
  restServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const isUpload = url.pathname === "/api/channels/dev/attachments";
      const body = req.method === "GET" ? null : isUpload ? await req.text() : await req.json().catch(() => null);
      seen.push({ method: req.method, path: `${url.pathname}${url.search}`, body });
      if (url.pathname === "/api/channels/dev/charter") {
        return Response.json({ charter: "be nice", charter_rev: 1, updated_at: null, updated_by: null });
      }
      if (url.pathname === "/api/channels/dev/messages" && req.method === "GET") {
        return Response.json({ messages: [] });
      }
      if (isUpload && req.method === "POST") {
        const filename = url.searchParams.get("filename") ?? "unknown";
        return Response.json(
          {
            key: `dev/sha256/${filename}`,
            filename,
            content_type: "application/octet-stream",
            size: (body as string).length,
            url: `/api/channels/dev/attachments/sha256/${filename}`,
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/api/channels/dev/messages" && req.method === "POST") {
        const frame = body as Record<string, unknown>;
        nextSeq += 1;
        return Response.json({
          seq: nextSeq,
          ...(frame.decision_request !== undefined
            ? { decision_request: frame.decision_request, decision_resolution: { state: "pending" } }
            : {}),
        });
      }
      return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    },
  });
}

function wakeFrame(seq: number, over: Partial<MsgFrame> = {}): MsgFrame {
  return { ...(msgFrame(seq, `wake ${seq}`, { mentions: ["me"] }) as unknown as MsgFrame), ...over };
}

function writeLane(role: "front" | "worker", wakeOver: Partial<ManagedWakeState> = {}): void {
  writeManagedManifest(stateDir, {
    version: 1,
    server: `http://127.0.0.1:${restServer!.port}`,
    channel: "dev",
    role,
    self: role === "front" ? "front-1" : "worker-1",
    front: "front-1",
    worker: "worker-1",
    owner_account: "owner@example.com",
    config: join(stateDir, MANAGED_CONFIG_FILE),
    attachment_root: role === "worker" ? channelWorkdir : null,
  });
  writeFileSync(
    join(stateDir, MANAGED_CONFIG_FILE),
    JSON.stringify({ server: `http://127.0.0.1:${restServer!.port}`, token: "ap_child" }) + "\n",
    { mode: 0o600 },
  );
  writeManagedWake(stateDir, {
    version: 1,
    seq: 50,
    frame: wakeFrame(50),
    delivery: { id: "d-50", cause: "mention", work_id: "w-50", continuation_ref: "ref-50" },
    owner_decision_binding: false,
    ...wakeOver,
  });
}

async function connect(): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "AGENTPARTY_CONFIG") env[k] = v;
  }
  env.AGENTPARTY_HOME = home;
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", indexPath, "mcp", "--managed", stateDir],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "agentparty-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function messagePosts(): Record<string, unknown>[] {
  return seen
    .filter((s) => s.method === "POST" && s.path === "/api/channels/dev/messages")
    .map((s) => s.body as Record<string, unknown>);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-mcp-managed-"));
  stateDir = join(home, "mcp-state");
  channelWorkdir = join(home, "channel-workdir");
  mkdirSync(channelWorkdir, { recursive: true });
  seen.length = 0;
  nextSeq = 100;
  startRest();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  restServer?.stop(true);
  restServer = null;
});

describe("front 角色工具面（#581）", () => {
  test("角色即工具集：只暴露 front 面，无 worker_report、无通用 send/attach", async () => {
    writeLane("front");
    const client = await connect();
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(
        ["party_charter", "party_decision_ask", "party_history", "party_reply", "party_worker_dispatch", "party_worker_feedback"].sort(),
      );
    } finally {
      await client.close();
    }
  }, 20000);

  test("party_reply：prose 正文原样进频道、reply_to 锚到 wake；回执落盘", async () => {
    writeLane("front");
    const client = await connect();
    try {
      const r = await client.callTool({ name: "party_reply", arguments: { body: "这是一段随意的自然语言汇总。" } });
      expect(r.isError).not.toBe(true);
      const posts = messagePosts();
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ kind: "message", body: "这是一段随意的自然语言汇总。", reply_to: 50, mentions: [] });
      const actions = readManagedActions(stateDir, 50);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ action: "channel_reply", seq: 101 });
    } finally {
      await client.close();
    }
  }, 20000);

  test("party_worker_dispatch：零前缀、mentions=[worker]、instruction 原文即 body", async () => {
    writeLane("front");
    const client = await connect();
    try {
      const instruction = "修复登录页 bug：复现步骤如下……验收标准：所有 e2e 通过。";
      const r = await client.callTool({ name: "party_worker_dispatch", arguments: { instruction } });
      expect(r.isError).not.toBe(true);
      const posts = messagePosts();
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ body: instruction, mentions: ["worker-1"], reply_to: 50 });
      expect(String(posts[0]!.body)).not.toContain("已派工");
      expect(readManagedActions(stateDir, 50)[0]).toMatchObject({ action: "worker_dispatch", seq: 101 });
    } finally {
      await client.close();
    }
  }, 20000);

  test("party_decision_ask：binding 未启用 fail closed 一字不发；启用后带 lineage+responder 且提示结束回合", async () => {
    writeLane("front");
    const client = await connect();
    try {
      const refused = await client.callTool({ name: "party_decision_ask", arguments: { prompt: "可以合并吗？" } });
      expect(refused.isError).toBe(true);
      expect(messagePosts()).toHaveLength(0);

      writeManagedWake(stateDir, {
        version: 1,
        seq: 50,
        frame: wakeFrame(50),
        delivery: { id: "d-50", cause: "mention", work_id: "w-50", continuation_ref: "ref-50" },
        owner_decision_binding: true,
      });
      const r = await client.callTool({ name: "party_decision_ask", arguments: { prompt: "可以合并吗？" } });
      expect(r.isError).not.toBe(true);
      const post = messagePosts()[0]!;
      expect(post).toMatchObject({
        decision_request: { kind: "approval", prompt: "可以合并吗？" },
        expected_decision_lineage: { delivery_id: "d-50", work_id: "w-50", continuation_ref: "ref-50" },
        expected_decision_responder_owner: "owner@example.com",
      });
      expect((r.content as { text: string }[])[0]!.text).toContain("END this turn");
      expect(readManagedActions(stateDir, 50).at(-1)).toMatchObject({ action: "owner_decision", decision_state: "pending" });
    } finally {
      await client.close();
    }
  }, 20000);
});

describe("worker 角色工具面（#581）", () => {
  test("角色即工具集：只暴露 report + 只读件，无 dispatch/decision/reply", async () => {
    writeLane("worker");
    const client = await connect();
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(["party_charter", "party_history", "party_worker_report"].sort());
    } finally {
      await client.close();
    }
  }, 20000);

  test("party_worker_report：回执 reply_to=派工消息，工作区内附件走上传链", async () => {
    writeLane("worker");
    const deliverable = join(channelWorkdir, "result.diff");
    writeFileSync(deliverable, "diff --git a/x b/x\n");
    const client = await connect();
    try {
      const r = await client.callTool({
        name: "party_worker_report",
        arguments: { body: "改完了，diff 附上。", attach: [deliverable] },
      });
      expect(r.isError).not.toBe(true);
      const post = messagePosts()[0]!;
      expect(post).toMatchObject({ body: "改完了，diff 附上。", reply_to: 50 });
      expect(Array.isArray(post.attachments)).toBe(true);
      expect(readManagedActions(stateDir, 50)[0]).toMatchObject({ action: "worker_report" });
    } finally {
      await client.close();
    }
  }, 20000);

  test("attach symlink 逃逸 → isError 且零上传零消息（issue 验收标准）", async () => {
    writeLane("worker");
    const outside = join(home, "outside-secret.txt");
    writeFileSync(outside, "host secret");
    const escape = join(channelWorkdir, "innocent-link.txt");
    symlinkSync(outside, escape);
    const client = await connect();
    try {
      const r = await client.callTool({
        name: "party_worker_report",
        arguments: { body: "带个附件", attach: [escape] },
      });
      expect(r.isError).toBe(true);
      expect((r.content as { text: string }[])[0]!.text).toContain("escapes allowed workspace");
      expect(messagePosts()).toHaveLength(0);
      expect(seen.some((s) => s.path.startsWith("/api/channels/dev/attachments"))).toBe(false);
      expect(readManagedActions(stateDir, 50)).toHaveLength(0);
    } finally {
      await client.close();
    }
  }, 20000);
});

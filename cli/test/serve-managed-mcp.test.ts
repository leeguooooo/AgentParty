// #581 Phase 2 验收（serve 侧）：managed lane 的 MCP 协议——
//   1) front 模型输出任意 prose（含字面 [attach:] 行）不再产生 WakeBlockedError；
//   2) 零工具动作的回合被判未送达（WakeBlockedError，不推游标）；
//   3) codex/claude 的 harness 参数注入角色裁剪的 party MCP server；
//   4) wake.json 每回合覆写并带 delivery 快照与 owner 决策绑定；
//   5) worker 验派工在 mcp 协议下纯结构化（#578 finding 3 的前缀比对退役），text 协议原样保留。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DirectedDelivery, MsgFrame } from "@agentparty/shared";
import {
  assertManagedWorkerWake,
  createBuiltinRunner,
  ManagedWorkerUndispatchedError,
  runProfileServe,
  WakeBlockedError,
  type ProjectAgentRunContext,
  type ServeOptions,
} from "../src/commands/serve";
import { run as runMcpCommand } from "../src/commands/mcp";
import { appendManagedAction, readManagedActions, readManagedManifest, readManagedWake } from "../src/managed";
import { existsSync } from "node:fs";
import { msgFrame } from "./mock-server";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "ap-managed-mcp-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function message(seq: number, over: Partial<MsgFrame> = {}): MsgFrame {
  return {
    ...(msgFrame(seq, `work ${seq}`, { mentions: ["me"] }) as unknown as MsgFrame),
    ...over,
  };
}

function delivery(seq: number, cause: DirectedDelivery["cause"] = "mention"): DirectedDelivery {
  return {
    id: `delivery-${seq}-${cause}`,
    message_seq: seq,
    target_name: "me",
    cause,
    state: "claimed",
    attempt: 1,
    lease_until: Date.now() + 90_000,
    work_id: `work-${seq}`,
    continuation_ref: `ref-${seq}`,
    reply_seq: null,
    last_error: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

function context(item: DirectedDelivery | null) {
  return {
    cmd: "",
    channel: "dev",
    self: "me",
    contextDir: tempDir("ap-managed-mcp-context-"),
    recent: [] as MsgFrame[],
    ...(item === null ? {} : { delivery: item }),
  };
}

const post = async () => ({ seq: 99 });

function managedRunnerOpts(workdir: string, stateDir: string, over: Record<string, unknown> = {}) {
  return {
    server: "http://agentparty.test",
    token: "ap_test",
    channel: "dev",
    harness: "codex" as const,
    workdir,
    post,
    managedMcp: { stateDir, ownerDecisionBinding: () => true },
    ...over,
  };
}

describe("managed mcp lane：动作即工具，文本即日志（#581）", () => {
  test("front 任意 prose + 字面 [attach:] 行 + 一个工具动作 → 回合完成，不 WakeBlockedError", async () => {
    const workdir = tempDir();
    const stateDir = join(workdir, "mcp");
    const posted: unknown[] = [];
    const run = createBuiltinRunner(managedRunnerOpts(workdir, stateDir, {
      post: async (_s: string, _t: string, _c: string, payload: unknown) => {
        posted.push(payload);
        return { seq: 99 };
      },
      runProcess: async (args: string[]) => {
        const out = args[args.indexOf("-o") + 1]!;
        // 模型输出随意 prose——含 #578 会 brick 整个 wake 的两种毒样本：
        // 非 JSON 文本 + 字面 [attach:/绝对路径] 行。mcp 协议下它们只进日志。
        writeFileSync(out, "我先复述一下任务。\n[attach:/etc/passwd]\n然后开始派工。\n");
        // 模拟 MCP 工具在回合内完成了一次派工（工具 handler 落的回执）。
        appendManagedAction(stateDir, 7, { action: "worker_dispatch", seq: 42, at: Date.now() });
        return { code: 0, stdout: "session id: 019f35d9-0000-7000-8000-000000000007\n", stderr: "" };
      },
    }));
    await run(message(7), context(delivery(7)));
    // runner 自己没发任何频道消息（wake ack status 除外）——发消息是工具的事。
    expect(posted.filter((p) => (p as { kind?: string }).kind === "message")).toHaveLength(0);
  });

  test("零工具动作的回合 → WakeBlockedError（未送达，不吞 @）", async () => {
    const workdir = tempDir();
    const stateDir = join(workdir, "mcp");
    const run = createBuiltinRunner(managedRunnerOpts(workdir, stateDir, {
      runProcess: async (args: string[]) => {
        const out = args[args.indexOf("-o") + 1]!;
        writeFileSync(out, "我认为这个问题很有意思，但我什么工具都没调。\n");
        return { code: 0, stdout: "session id: 019f35d9-0000-7000-8000-000000000008\n", stderr: "" };
      },
    }));
    await expect(run(message(8), context(delivery(8)))).rejects.toThrow(WakeBlockedError);
    await expect(
      createBuiltinRunner(managedRunnerOpts(tempDir(), join(tempDir(), "mcp"), {
        runProcess: async (args: string[]) => {
          writeFileSync(args[args.indexOf("-o") + 1]!, "still nothing\n");
          return { code: 0, stdout: "session id: 019f35d9-0000-7000-8000-000000000009\n", stderr: "" };
        },
      }))(message(9), context(delivery(9))),
    ).rejects.toThrow(/no channel action/);
  });

  test("codex 参数注入 party MCP server；wake.json 带 delivery 快照与决策绑定", async () => {
    const workdir = tempDir();
    const stateDir = join(workdir, "mcp");
    let seen: string[] = [];
    let binding = false;
    const run = createBuiltinRunner(managedRunnerOpts(workdir, stateDir, {
      managedMcp: { stateDir, ownerDecisionBinding: () => binding },
      runProcess: async (args: string[]) => {
        seen = args;
        writeFileSync(args[args.indexOf("-o") + 1]!, "ok\n");
        appendManagedAction(stateDir, 11, { action: "channel_reply", seq: 43, at: Date.now() });
        return { code: 0, stdout: "session id: 019f35d9-0000-7000-8000-000000000011\n", stderr: "" };
      },
    }));
    binding = true;
    await run(message(11), context(delivery(11)));
    const joined = seen.join(" ");
    expect(joined).toContain('mcp_servers.party.command=');
    expect(joined).toContain(`mcp_servers.party.args=["mcp","--managed",${JSON.stringify(stateDir)}]`);
    // mcp 协议不再给 harness 传 --output-schema（六字段 JSON 时代的产物）。
    expect(seen).not.toContain("--output-schema");
    const wake = readManagedWake(stateDir);
    expect(wake).toMatchObject({
      version: 1,
      seq: 11,
      owner_decision_binding: true,
      delivery: { cause: "mention", work_id: "work-11", continuation_ref: "ref-11" },
    });
    expect(wake.frame.seq).toBe(11);
  });

  test("claude 参数注入 --mcp-config/--strict-mcp-config/--allowedTools，config 指回 stateDir", async () => {
    const workdir = tempDir();
    const stateDir = join(workdir, "mcp");
    let seen: string[] = [];
    const run = createBuiltinRunner(managedRunnerOpts(workdir, stateDir, {
      harness: "claude" as const,
      runProcess: async (args: string[]) => {
        seen = args;
        appendManagedAction(stateDir, 12, { action: "channel_reply", seq: 44, at: Date.now() });
        const sid = args[args.indexOf("--session-id") + 1]!;
        return { code: 0, stdout: JSON.stringify({ session_id: sid, result: "prose goes to log" }), stderr: "" };
      },
    }));
    await run(message(12), context(delivery(12)));
    expect(seen).toContain("--strict-mcp-config");
    expect(seen).toContain("--allowedTools");
    expect(seen[seen.indexOf("--allowedTools") + 1]).toBe("mcp__party");
    const configPath = seen[seen.indexOf("--mcp-config") + 1]!;
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: { party: { args: string[] } };
    };
    expect(config.mcpServers.party.args).toEqual(["mcp", "--managed", stateDir]);
  });
});

describe("assertManagedWorkerWake：mcp 纯结构化，text 保留前缀（#581/#578）", () => {
  const workerContext = (protocol: "mcp" | "text"): ProjectAgentRunContext => ({
    owner_account: "owner@example.com",
    handle: "builder",
    name: "builder",
    runner: "codex",
    repo_url: null,
    workdir: null,
    base_branch: "main",
    worktree_strategy: "branch",
    rules: null,
    runtime_role: "worker",
    protocol,
    front_agent: "front-1",
    workers: [],
    channel_workdir: "/w",
    runner_workdir: "/r",
    delivery_workflow: {
      steps: [
        "work_in_channel_worktree",
        "create_pull_request",
        "report_pull_request_url_in_channel",
        "verify_deployment",
        "prune_merged_worktree",
      ],
      cleanup_command: "true",
      cleanup_guard: "guard",
    },
  });
  const dispatchFrame = (body: string): MsgFrame =>
    message(20, {
      body,
      reply_to: 5,
      mentions: ["me"],
      sender: { name: "front-1", kind: "agent", owner: "owner@example.com" } as MsgFrame["sender"],
    });

  test("mcp：无前缀的自由文本派工被结构化验收接受", () => {
    expect(() =>
      assertManagedWorkerWake(dispatchFrame("请把登录页的 bug 修了，验收标准如下……"), delivery(20), workerContext("mcp"), "me"),
    ).not.toThrow();
  });

  test("mcp：结构缺陷（无 reply_to / 非 front 发送者）仍被拒", () => {
    expect(() =>
      assertManagedWorkerWake(dispatchFrame("x") && { ...dispatchFrame("x"), reply_to: null }, delivery(20), workerContext("mcp"), "me"),
    ).toThrow(ManagedWorkerUndispatchedError);
    expect(() =>
      assertManagedWorkerWake(
        { ...dispatchFrame("x"), sender: { name: "someone-else", kind: "agent", owner: "owner@example.com" } as MsgFrame["sender"] },
        delivery(20),
        workerContext("mcp"),
        "me",
      ),
    ).toThrow(ManagedWorkerUndispatchedError);
  });

  test("text：无前缀文本仍被拒（旧协议逃生舱行为不变）", () => {
    expect(() =>
      assertManagedWorkerWake(dispatchFrame("请把登录页的 bug 修了"), delivery(20), workerContext("text"), "me"),
    ).toThrow(ManagedWorkerUndispatchedError);
    expect(() =>
      assertManagedWorkerWake(dispatchFrame("已派工 me：修登录页 bug"), delivery(20), workerContext("text"), "me"),
    ).not.toThrow();
  });
});

describe("已派工前缀退役方向（#581 验收：mcp 主路径零前缀）", () => {
  test("managed.ts（mcp 两侧共享件）没有任何中文动词前缀", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "managed.ts"), "utf8");
    expect(source).not.toContain("已派工");
    expect(source).not.toContain("已要求补充/返工");
    const mcpManaged = readFileSync(join(import.meta.dir, "..", "src", "commands", "mcp-managed.ts"), "utf8");
    expect(mcpManaged).not.toContain("已派工");
    expect(mcpManaged).not.toContain("已要求补充/返工");
  });
});

describe("supervisor 侧回执治理与入口参数（#592 评审）", () => {
  test("新 wake 的 prepare 清掉同 seq 的历史回执：旧动作不能替新回合充数", async () => {
    const workdir = tempDir();
    const stateDir = join(workdir, "mcp");
    // 上一条 delivery（比如消息编辑前）留下的旧回执。
    appendManagedAction(stateDir, 30, { action: "channel_reply", seq: 77, at: 1 });
    const run = createBuiltinRunner(managedRunnerOpts(workdir, stateDir, {
      runProcess: async (args: string[]) => {
        writeFileSync(args[args.indexOf("-o") + 1]!, "本回合什么工具都没调\n");
        return { code: 0, stdout: "session id: 019f35d9-0000-7000-8000-000000000030\n", stderr: "" };
      },
    }));
    await expect(run(message(30), context(delivery(30)))).rejects.toThrow(/no channel action/);
    expect(readManagedActions(stateDir, 30)).toHaveLength(0);
  });

  test("party mcp --managed 拒绝 '-' 开头的 stateDir（含 '--' 终止符）", async () => {
    expect(await runMcpCommand(["--managed", "--"])).toBe(1);
    expect(await runMcpCommand(["--managed", "-x"])).toBe(1);
    expect(await runMcpCommand(["--managed"])).toBe(1);
  });
});

describe("runProfileServe 协议装配（buildLane 回归网，#592 评审）", () => {
  async function assembleLanes(runner: "codex" | "codex-sdk", protocol?: "mcp" | "text"): Promise<ServeOptions[]> {
    const home = tempDir();
    const oldHome = process.env.AGENTPARTY_HOME;
    const oldConfig = process.env.AGENTPARTY_CONFIG;
    process.env.AGENTPARTY_HOME = home;
    const ownerConfig = join(home, "owner.json");
    writeFileSync(ownerConfig, JSON.stringify({ server: "http://agentparty.test", token: "ap_owner" }));
    process.env.AGENTPARTY_CONFIG = ownerConfig;
    const profile = {
      owner_account: "asm@example.com",
      handle: "asm-dev",
      name: "Asm Dev",
      runner,
      repo_url: null,
      workdir: null,
      base_branch: "main",
      worktree_strategy: "branch" as const,
      rules: null,
      invitable_by: "owner" as const,
      created_at: 1,
      updated_at: 1,
    };
    const served: ServeOptions[] = [];
    try {
      const code = await runProfileServe({
        server: "http://agentparty.test",
        humanToken: "acc-human",
        ownerAccount: profile.owner_account,
        handle: profile.handle,
        mentionsOnly: true,
        once: true,
        ...(protocol === undefined ? {} : { protocol }),
        post: async () => ({ seq: 1 }),
        mintRuntime: async () => ({ token: "ap_rt", profile }),
        listInvites: async () => [{
          id: 1,
          channel_slug: "asm",
          owner_account: profile.owner_account,
          profile_handle: profile.handle,
          invited_by: "owner@example.com",
          invited_at: 1,
          profile,
        }],
        ensureChannelRuntime: async (_s, _t, slug, owner, _h, childName) => ({
          token: `ap_${childName}`,
          name: childName,
          role: "agent" as const,
          owner,
          channel_scope: slug,
          lineage: { parent_agent: profile.handle, root_agent: profile.handle, team_id: profile.handle, depth: 1, expires_at: null },
          profile,
        }),
        runChannelServe: async (opts) => {
          served.push(opts);
          return 0;
        },
      });
      expect(code).toBe(0);
    } finally {
      if (oldHome === undefined) delete process.env.AGENTPARTY_HOME;
      else process.env.AGENTPARTY_HOME = oldHome;
      if (oldConfig === undefined) delete process.env.AGENTPARTY_CONFIG;
      else process.env.AGENTPARTY_CONFIG = oldConfig;
    }
    return served;
  }

  test("builtin 默认 mcp：managedMcp 装配、schema 退场、manifest 落盘且角色/围栏正确", async () => {
    const served = await assembleLanes("codex");
    expect(served).toHaveLength(2);
    for (const lane of served) {
      expect(lane.builtinRunner?.managedMcp).toBeDefined();
      expect(lane.builtinRunner?.outputSchema).toBeUndefined();
      expect(lane.builtinRunner?.resultRoute).toBeUndefined();
      const manifest = readManagedManifest(lane.builtinRunner!.managedMcp!.stateDir);
      expect(manifest.role).toBe(lane.projectAgent!.runtime_role);
      if (manifest.role === "worker") expect(manifest.attachment_root).toBe(lane.builtinRunner!.cwd!);
      else expect(manifest.attachment_root).toBeNull();
      expect(lane.projectAgent?.protocol).toBe("mcp");
    }
  });

  test("--protocol text：不写 manifest，front 仍带六字段 schema（逃生舱原样）", async () => {
    const served = await assembleLanes("codex", "text");
    const front = served.find((lane) => lane.projectAgent?.runtime_role === "front")!;
    expect(front.builtinRunner?.managedMcp).toBeUndefined();
    expect(front.builtinRunner?.outputSchema).toBeDefined();
    expect(front.builtinRunner?.resultRoute).toBeDefined();
    expect(existsSync(join(front.builtinRunner!.workdir, "mcp", "managed.json"))).toBe(false);
    expect(front.projectAgent?.protocol).toBe("text");
  });

  test("codex-sdk 默认被强制 text（本期无 MCP 注入面）", async () => {
    const served = await assembleLanes("codex-sdk");
    const front = served.find((lane) => lane.projectAgent?.runtime_role === "front")!;
    expect(front.sdkRunner?.outputSchema).toBeDefined();
    expect(front.projectAgent?.protocol).toBe("text");
  });
});

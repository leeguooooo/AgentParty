// Claude 原生投递回执（peer_message_status）：解析、监听、注入并订阅的编排。
// 协议正本：open-cross-session docs/wake-protocol.md §6。假收件箱见 fake-claude-inbox.ts——
// 它照真机行为核对回执地址形状、同目录、以及「监听者 pid == 写帧者 pid」。
// 临时 sessions 目录 + 临时 socket 目录，绝不碰真实 `~/.claude/sessions` 或 `/tmp/cc-socks/`。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLAUDE_NATIVE_SESSIONS_DIR_ENV } from "../src/claude-inbox-inject";
import {
  CLAUDE_RECEIPTS_DISABLE_ENV,
  RECEIPT_MAX_PENDING,
  sweepStaleReceiptSockets,
  injectWithReceipt,
  openReceiptListener,
  parsePeerReceipt,
  replySocketPathFor,
  type InboxReceiptEvent,
} from "../src/claude-inbox-receipt";
import type { ClaudeSessionRegistryEntry } from "../src/claude-session-registry";
import { socketWakeProxyForwarder, wakeProxyReceiptLogLine } from "../src/serve-wake-proxy";
import { fakeClaudeInbox, userFrame, type FakeInbox, type InboundPolicy } from "./fake-claude-inbox";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const MSG = "0b0f6f0e-2f0b-4a51-9d0c-1f6f6f0e2f0b";

let sessionsDir: string;
let sockDir: string;
let sockPath: string;
let inbox: FakeInbox | null;

/** 指向临时 sessions 目录的环境。 */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: sessionsDir, ...extra };
}

/** 起假收件箱，并把本进程登记成一个指向它的 Claude 原生会话。 */
async function startInbox(policy: InboundPolicy): Promise<FakeInbox> {
  inbox = fakeClaudeInbox(sockPath, policy);
  await new Promise<void>((resolve) => inbox!.server.once("listening", () => resolve()));
  writeFileSync(
    join(sessionsDir, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: SESSION_ID,
      name: "agentparty-d4",
      status: "idle",
      kind: "interactive",
      messagingSocketPath: sockPath,
    }),
    { mode: 0o600 },
  );
  return inbox;
}

/** socket 目录里除收件箱外还剩什么——回执 socket 用完必须一个不留。 */
function leftovers(): string[] {
  return readdirSync(sockDir).filter((name) => name !== "inbox.sock");
}

/** 注入入参：目标是本进程冒充的那个会话。 */
const input = (extra: Record<string, unknown> = {}) => ({
  pid: process.pid,
  sessionId: SESSION_ID,
  name: "claude-111111111111",
  body: "AgentParty wake: #dev seq=42",
  fromName: "leo",
  env: env(),
  ...extra,
});

beforeEach(() => {
  // 前缀要短：macOS 的 tmpdir 很长，回执 socket `<16 hex>.sock` 不能超过 sun_path 的 104 字节。
  sessionsDir = mkdtempSync(join(tmpdir(), "ap-rs-"));
  sockDir = mkdtempSync(join(tmpdir(), "ap-rc-"));
  sockPath = join(sockDir, "inbox.sock");
  inbox = null;
});

afterEach(() => {
  inbox?.close();
  rmSync(sessionsDir, { recursive: true, force: true });
  rmSync(sockDir, { recursive: true, force: true });
});

describe("parsePeerReceipt", () => {
  const frame = (extra: Record<string, unknown>) =>
    JSON.stringify({ type: "control", action: "peer_message_status", orig_msg_id: MSG, msgV: 1, ...extra });

  test("六种状态逐一归一；线上的 expired+status_detail:refused 归为 refused", () => {
    for (const status of ["held", "delivered", "expired", "refused", "dropped", "denied"] as const) {
      expect(parsePeerReceipt(frame({ status }), MSG)).toEqual({ status });
    }
    expect(parsePeerReceipt(frame({ status: "expired", status_detail: "refused", reason: "no" }), MSG))
      .toEqual({ status: "refused", reason: "no" });
  });

  test("orig_msg_id 对不上 / 不是回执帧 / 状态不认识 / 不是 JSON → null", () => {
    expect(parsePeerReceipt(frame({ status: "held", orig_msg_id: "someone-else" }), MSG)).toBeNull();
    expect(parsePeerReceipt(JSON.stringify({ type: "user", orig_msg_id: MSG, status: "held" }), MSG)).toBeNull();
    expect(parsePeerReceipt(frame({ status: "read" }), MSG)).toBeNull();
    expect(parsePeerReceipt("not json", MSG)).toBeNull();
    expect(parsePeerReceipt("[]", MSG)).toBeNull();
  });

  test("reason 是对方可控文本：压成一行、限 200 字符，drop_reason 并入", () => {
    const parsed = parsePeerReceipt(
      frame({ status: "dropped", reason: "queue\nfull\u001b[31m", drop_reason: "queue_full" }),
      MSG,
    );
    expect(parsed?.status).toBe("dropped");
    expect(parsed?.reason).not.toMatch(/[\n\u001b]/);
    expect(parsed?.reason).toContain("queue_full");
    expect(parsePeerReceipt(frame({ status: "held", reason: "x".repeat(5000) }), MSG)?.reason?.length).toBe(200);
  });
});

describe("replySocketPathFor / openReceiptListener", () => {
  test("回执路径与目标 socket 同目录、过得了接收端的形状校验；只检查不建文件", () => {
    const chosen = replySocketPathFor(sockPath);
    expect(chosen.ok).toBe(true);
    if (!chosen.ok) return;
    expect(dirname(chosen.path)).toBe(sockDir);
    expect(chosen.path).toMatch(/\/[0-9a-f]{16}\.sock$/);
    expect(existsSync(chosen.path)).toBe(false);
  });

  test("Windows / 相对路径 / 目录不存在 → 不建", () => {
    expect(replySocketPathFor(sockPath, "win32")).toMatchObject({ ok: false });
    expect(replySocketPathFor("inbox.sock")).toMatchObject({ ok: false });
    expect(replySocketPathFor(join(sockDir, "missing", "inbox.sock"))).toMatchObject({ ok: false });
  });

  test("监听文件 0600；close() 后文件删除，可重复调用；umask 不被改动", async () => {
    const before = process.umask();
    const opened = await openReceiptListener(sockPath, MSG);
    expect(process.umask()).toBe(before);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(statSync(opened.listener.path).mode & 0o777).toBe(0o600);
    expect(await opened.listener.next(20)).toBeNull();
    opened.listener.close();
    opened.listener.close();
    expect(existsSync(opened.listener.path)).toBe(false);
  });
});

describe("injectWithReceipt", () => {
  const collect = () => {
    const events: InboxReceiptEvent[] = [];
    return { events, onReceipt: (event: InboxReceiptEvent) => void events.push(event) };
  };

  test("accept：接收端一条都不回 ⇒ first=accepted，帧带 from + msg_id，回执 socket 用完即删", async () => {
    const box = await startInbox("accept");
    const { events, onReceipt } = collect();
    const result = await injectWithReceipt(input(), { onReceipt, firstWindowMs: 80 });
    expect(result).toMatchObject({ ok: true, receipts: true });
    const frame = userFrame(await box.nextFrame());
    expect(frame.from).toMatch(/^uds:.*\/[0-9a-f]{16}\.sock$/);
    expect(frame.message.content).toContain(`from="${frame.from}"`);
    await result.settled;
    expect(events).toEqual([{ phase: "first", status: "accepted" }]);
    expect(box.receipts).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  test("hold → expired：先报 held，再报终态一次；写帧者就是监听者（假收件箱核对 pid）", async () => {
    const box = await startInbox("hold");
    const { events, onReceipt } = collect();
    const result = await injectWithReceipt(input(), { onReceipt, firstWindowMs: 2000, targetPollMs: 20 });
    expect(result.ok).toBe(true);
    await box.nextFrame();
    while (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events[0]).toMatchObject({ phase: "first", status: "held" });
    expect(box.rejected).toEqual([]);
    // 终态连发两条：一次性——只报第一条。
    await box.resolveHeld("expired", { repeat: 2 });
    await result.settled;
    expect(events.map((event) => `${event.phase}:${event.status}`)).toEqual(["first:held", "terminal:expired"]);
    expect(leftovers()).toEqual([]);
  });

  test("hold → delivered（有人批准）", async () => {
    const box = await startInbox("hold");
    const { events, onReceipt } = collect();
    const result = await injectWithReceipt(input(), { onReceipt, firstWindowMs: 2000, targetPollMs: 20 });
    await box.nextFrame();
    while (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    await box.resolveHeld("delivered");
    await result.settled;
    expect(events.map((event) => `${event.phase}:${event.status}`)).toEqual(["first:held", "terminal:delivered"]);
  });

  for (const [policy, status] of [["refuse", "refused"], ["drop", "dropped"], ["deny", "denied"]] as const) {
    test(`${policy}：第一阶段就报 ${status}，不进第二阶段`, async () => {
      await startInbox(policy);
      const { events, onReceipt } = collect();
      const result = await injectWithReceipt(input(), { onReceipt, firstWindowMs: 2000 });
      await result.settled;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ phase: "first", status });
      expect(leftovers()).toEqual([]);
    });
  }

  test("held 之后到点没有终态 ⇒ unknown", async () => {
    await startInbox("hold");
    const { events, onReceipt } = collect();
    const result = await injectWithReceipt(input(), {
      onReceipt,
      firstWindowMs: 2000,
      terminalWaitMs: 60,
      targetPollMs: 20,
    });
    await result.settled;
    expect(events.map((event) => `${event.phase}:${event.status}`)).toEqual(["first:held", "terminal:unknown"]);
    expect(leftovers()).toEqual([]);
  });

  test("held 之后目标会话消失（连续 3 次读不到）⇒ 提前以 unknown 结束，不空等满 TTL", async () => {
    await startInbox("hold");
    const { events, onReceipt } = collect();
    const result = await injectWithReceipt(input(), { onReceipt, firstWindowMs: 2000, targetPollMs: 20 });
    while (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    rmSync(join(sessionsDir, `${process.pid}.json`));
    await result.settled;
    expect(events.at(-1)).toMatchObject({ phase: "terminal", status: "unknown" });
    expect(events.at(-1)?.reason).toContain("gone");
  });

  test("回落到今天的行为：Windows / 开关关闭 / 无 pid / 调用方自带 fromSock ⇒ 帧不带 from，目录里不建文件", async () => {
    const box = await startInbox("hold");
    const cases = [
      { label: "win32", run: () => injectWithReceipt(input(), { os: "win32", inject: async (i) => spy(i) }) },
      {
        label: "disabled",
        run: () => injectWithReceipt(input({ env: env({ [CLAUDE_RECEIPTS_DISABLE_ENV]: "1" }) })),
      },
      { label: "no pid", run: () => injectWithReceipt(input({ pid: undefined, name: "agentparty-d4" })) },
    ];
    const seen: Array<{ fromSock?: string; msgId?: string }> = [];
    const spy = (i: { fromSock?: string; msgId?: string }) => {
      seen.push(i);
      return { ok: true as const, socketPath: sockPath, usedAuth: false, target: "x" };
    };
    for (const { label, run } of cases) {
      const result = await run();
      expect([label, result.ok, result.receipts, result.settled]).toEqual([label, true, false, undefined]);
    }
    expect(seen[0]?.fromSock).toBeUndefined();
    expect(seen[0]?.msgId).toBeUndefined();
    for (const raw of [await box.nextFrame(), await box.nextFrame()]) {
      expect(userFrame(raw).from).toBeUndefined();
    }
    expect(box.receipts).toEqual([]);
    expect(leftovers()).toEqual([]);
    const own = await injectWithReceipt(input({ fromSock: join(sockDir, "mine.sock") }), { inject: async (i) => spy(i) });
    expect(own.receipts).toBe(false);
    expect(seen.at(-1)?.fromSock).toBe(join(sockDir, "mine.sock"));
  });

  test("并发注入也守住监听上限：超出的走不带回执的旧路径，结束后名额全部归还", async () => {
    await startInbox("accept");
    const total = RECEIPT_MAX_PENDING + 4;
    const results = await Promise.all(
      Array.from({ length: total }, () => injectWithReceipt(input(), { firstWindowMs: 150 })),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.receipts)).toHaveLength(RECEIPT_MAX_PENDING);
    await Promise.all(results.map((result) => result.settled));
    expect(leftovers()).toEqual([]);
    const again = await injectWithReceipt(input(), { firstWindowMs: 20 });
    expect(again.receipts).toBe(true);
    await again.settled;
  });

  test("目标解析不出来 ⇒ 交给 inject 报真实失败原因，不建监听", async () => {
    const result = await injectWithReceipt(input());
    expect(result).toMatchObject({ ok: false, reason: "no-match", receipts: false });
    expect(leftovers()).toEqual([]);
  });

  test("注入失败 ⇒ 监听立刻关、文件删、不报任何回执", async () => {
    await startInbox("hold");
    const { events, onReceipt } = collect();
    const result = await injectWithReceipt(input(), {
      onReceipt,
      inject: async () => ({ ok: false, reason: "write-failed", detail: "boom" }),
    });
    expect(result).toMatchObject({ ok: false, reason: "write-failed", detail: "boom" });
    expect(result.settled).toBeUndefined();
    expect(events).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  test("onReceipt 抛错不影响清理", async () => {
    await startInbox("refuse");
    const result = await injectWithReceipt(input(), {
      firstWindowMs: 2000,
      onReceipt: () => {
        throw new Error("display only");
      },
    });
    await result.settled;
    expect(leftovers()).toEqual([]);
  });
});

describe("宿主关停与 SIGKILL 残留", () => {
  test("lifecycle 信号中止 ⇒ 挂着的监听立刻关、socket 文件与登记都删，且不把被打断的等待报成 accepted / unknown", async () => {
    await startInbox("hold");
    const registryDir = join(sessionsDir, "registry");
    const controller = new AbortController();
    const events: InboxReceiptEvent[] = [];
    const result = await injectWithReceipt(input(), {
      onReceipt: (event) => void events.push(event),
      firstWindowMs: 2000,
      targetPollMs: 20,
      signal: controller.signal,
      registryDir,
    });
    while (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(leftovers()).toHaveLength(1);
    expect(readdirSync(registryDir)).toEqual([leftovers()[0]!.replace(/\.sock$/, ".json")]);
    controller.abort();
    // 同步生效：serve 的 finally 里 abort 之后进程就可能退出，不能依赖后续事件循环。
    expect(leftovers()).toEqual([]);
    expect(readdirSync(registryDir)).toEqual([]);
    await result.settled;
    expect(events.map((event) => `${event.phase}:${event.status}`)).toEqual(["first:held"]);
  });

  test("第一窗口内中止 ⇒ 一个事件都不报；已中止的信号 ⇒ 直接走不带回执的旧路径", async () => {
    const box = await startInbox("accept");
    const controller = new AbortController();
    const events: InboxReceiptEvent[] = [];
    const result = await injectWithReceipt(input(), {
      onReceipt: (event) => void events.push(event),
      firstWindowMs: 2000,
      signal: controller.signal,
    });
    controller.abort();
    await result.settled;
    expect(events).toEqual([]);
    expect(leftovers()).toEqual([]);
    await box.nextFrame();
    const after = await injectWithReceipt(input(), { signal: controller.signal });
    expect(after).toMatchObject({ ok: true, receipts: false });
    expect(userFrame(await box.nextFrame()).from).toBeUndefined();
  });

  test("serve 唤醒代理把 signal 与登记目录传下去：中止后目录里不留回执 socket", async () => {
    await startInbox("hold");
    const registryDir = join(sessionsDir, "registry");
    const controller = new AbortController();
    const events: InboxReceiptEvent[] = [];
    const forward = socketWakeProxyForwarder({
      env: env(),
      fromName: () => "leo",
      fromId: () => null,
      onReceipt: (event) => void events.push(event),
      receiptTiming: { firstWindowMs: 2000, targetPollMs: 20 },
      signal: controller.signal,
      receiptRegistryDir: registryDir,
    });
    await forward(
      { version: 1, session_id: SESSION_ID, pid: process.pid, display_name: null, channel: "dev", server: "https://a.example.com", cwd: "/tmp/project", registered_at: 1 },
      { channel: "dev", server: "https://a.example.com", seq: 1 },
    );
    while (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(leftovers()).toHaveLength(1);
    expect(readdirSync(registryDir)).toHaveLength(1);
    controller.abort();
    expect(leftovers()).toEqual([]);
    expect(readdirSync(registryDir)).toEqual([]);
  });

  test("SIGKILL 留下的回执 socket：下次启动按登记删掉；活进程的、没登记的、形状不对的一律不碰", async () => {
    const registryDir = join(sessionsDir, "registry");
    mkdirSync(registryDir, { mode: 0o700 });
    // 真的杀一个监听着 socket 的进程：文件留在目录里，没人监听。
    const stale = join(sockDir, "aaaaaaaaaaaaaaaa.sock");
    const child = Bun.spawn(
      ["bun", "-e", `require("node:net").createServer().listen(${JSON.stringify(stale)}); setInterval(() => {}, 1000);`],
      { stdout: "ignore", stderr: "ignore" },
    );
    const deadline = Date.now() + 4000;
    while (!existsSync(stale) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(stale)).toBe(true);
    child.kill("SIGKILL");
    await child.exited;
    expect(existsSync(stale)).toBe(true);
    writeFileSync(join(registryDir, "aaaaaaaaaaaaaaaa.json"), JSON.stringify({ pid: child.pid, path: stale }));

    // 活进程（本进程）登记的：不碰。
    const live = await openReceiptListener(sockPath, MSG);
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    const liveName = live.listener.path.split("/").at(-1)!.replace(/\.sock$/, "");
    writeFileSync(join(registryDir, `${liveName}.json`), JSON.stringify({ pid: process.pid, path: live.listener.path }));
    // 登记项指向别的文件（名字对不上 / 不是回执形状 / 不是 socket）：不删目标。
    const inboxLike = await startInbox("accept");
    writeFileSync(join(registryDir, "bbbbbbbbbbbbbbbb.json"), JSON.stringify({ pid: child.pid, path: inboxLike.path }));
    const plainFile = join(sockDir, "cccccccccccccccc.sock");
    writeFileSync(plainFile, "not a socket");
    writeFileSync(join(registryDir, "cccccccccccccccc.json"), JSON.stringify({ pid: child.pid, path: plainFile }));
    writeFileSync(join(registryDir, "dddddddddddddddd.json"), "not json");

    expect(sweepStaleReceiptSockets(registryDir)).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live.listener.path)).toBe(true);
    expect(existsSync(inboxLike.path)).toBe(true);
    expect(existsSync(plainFile)).toBe(true);
    expect(readdirSync(registryDir).sort()).toEqual([`${liveName}.json`, "dddddddddddddddd.json"].sort());
    live.listener.close();
    expect(sweepStaleReceiptSockets(join(registryDir, "missing"))).toEqual([]);
  });

  test("登记目录别人写得进来（权限不是 0700 / 是符号链接）⇒ 整个不信：不清理、也不往里登记", async () => {
    const registryDir = join(sessionsDir, "registry");
    mkdirSync(registryDir, { mode: 0o700 });
    const opened = await openReceiptListener(sockPath, MSG);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const name = opened.listener.path.split("/").at(-1)!.replace(/\.sock$/, "");
    // 伪造的登记：pid 已死，指向一个活着的、属于我们的 socket。
    writeFileSync(join(registryDir, `${name}.json`), JSON.stringify({ pid: 999_999_999, path: opened.listener.path }));
    chmodSync(registryDir, 0o777);
    expect(sweepStaleReceiptSockets(registryDir)).toEqual([]);
    expect(existsSync(opened.listener.path)).toBe(true);
    const link = join(sessionsDir, "registry-link");
    chmodSync(registryDir, 0o700);
    symlinkSync(registryDir, link);
    expect(sweepStaleReceiptSockets(link)).toEqual([]);
    expect(existsSync(opened.listener.path)).toBe(true);
    opened.listener.close();

    // 不可信目录里不登记；注入与回执照常。
    rmSync(join(registryDir, `${name}.json`));
    chmodSync(registryDir, 0o777);
    await startInbox("refuse");
    const result = await injectWithReceipt(input(), { firstWindowMs: 2000, registryDir });
    expect(result).toMatchObject({ ok: true, receipts: true });
    expect(readdirSync(registryDir)).toEqual([]);
    await result.settled;
  });
});

describe("serve 唤醒代理：回执打到日志，转投结果语义不变", () => {
  const entry: ClaudeSessionRegistryEntry = {
    version: 1,
    session_id: SESSION_ID,
    pid: process.pid,
    display_name: null,
    channel: "dev",
    server: "https://a.example.com",
    cwd: "/tmp/project",
    registered_at: 1000,
  };
  const ref = { channel: "dev", server: "https://a.example.com", seq: 42 };

  test("hold：转投仍返回 ok:true（帧已写进收件箱），随后日志先报扣留、再报终态", async () => {
    const box = await startInbox("hold");
    const lines: string[] = [];
    const events: InboxReceiptEvent[] = [];
    const forward = socketWakeProxyForwarder({
      env: env(),
      fromName: () => "leo",
      fromId: () => null,
      log: (line) => lines.push(line),
      onReceipt: (event) => void events.push(event),
      receiptTiming: { firstWindowMs: 2000, targetPollMs: 20 },
    });
    expect(await forward(entry, ref)).toEqual({ ok: true });
    expect(userFrame(await box.nextFrame()).from).toMatch(/^uds:/);
    while (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("@claude-111111111111");
    expect(lines[0]).toContain("status=held");
    expect(lines[0]).toContain("channel=dev seq=42");
    await box.resolveHeld("expired");
    while (events.length === 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("status=expired");
    expect(lines[1]).toContain("请勿重发");
  });

  test("#1130 hold → expired：同一份回执上报到频道，目标＝宣告名；转投结果不变", async () => {
    const box = await startInbox("hold");
    const reports: string[] = [];
    const forward = socketWakeProxyForwarder({
      env: env(),
      fromName: () => "leo",
      fromId: () => null,
      report: async (target, event) => {
        reports.push(`${target.channel}:${target.seq}:${target.target}:${event.status}`);
      },
      receiptTiming: { firstWindowMs: 2000, targetPollMs: 20 },
    });
    expect(await forward(entry, ref)).toEqual({ ok: true });
    await box.nextFrame();
    while (reports.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reports).toEqual(["dev:42:claude-111111111111:held"]);
    await box.resolveHeld("expired");
    while (reports.length === 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reports).toEqual(["dev:42:claude-111111111111:held", "dev:42:claude-111111111111:expired"]);
  });

  test("#1130 accept：没有回执 ⇒ 什么都不上报（accepted 不是已读回执）", async () => {
    await startInbox("accept");
    const reports: string[] = [];
    let settled = false;
    const forward = socketWakeProxyForwarder({
      env: env(),
      fromName: () => "leo",
      fromId: () => null,
      onReceipt: () => {
        settled = true;
      },
      report: async (_target, event) => {
        reports.push(event.status);
      },
      receiptTiming: { firstWindowMs: 60 },
    });
    expect(await forward(entry, ref)).toEqual({ ok: true });
    while (!settled) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reports).toEqual([]);
  });

  test("#1130 回落（开关关闭 / 测试注入 inject）⇒ 不订阅，也就没有任何上报", async () => {
    await startInbox("hold");
    const reports: string[] = [];
    const report = async (_target: unknown, event: InboxReceiptEvent) => {
      reports.push(event.status);
    };
    await socketWakeProxyForwarder({
      env: env({ AGENTPARTY_NO_CLAUDE_RECEIPTS: "1" }),
      fromName: () => "leo",
      fromId: () => null,
      report,
      receiptTiming: { firstWindowMs: 60 },
    })(entry, ref);
    await socketWakeProxyForwarder({ env: env(), receipts: false, fromName: () => "leo", fromId: () => null, report })(entry, ref);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(reports).toEqual([]);
  });

  test("accept：没有回执 ⇒ 一行日志都不打", async () => {
    await startInbox("accept");
    const lines: string[] = [];
    const events: InboxReceiptEvent[] = [];
    const forward = socketWakeProxyForwarder({
      env: env(),
      fromName: () => "leo",
      fromId: () => null,
      log: (line) => lines.push(line),
      onReceipt: (event) => void events.push(event),
      receiptTiming: { firstWindowMs: 60 },
    });
    expect(await forward(entry, ref)).toEqual({ ok: true });
    while (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual([{ phase: "first", status: "accepted" }]);
    expect(lines).toEqual([]);
  });

  test("测试注入了 inject ⇒ 默认不订阅回执（帧不带 fromSock）；receipts:false 同样", async () => {
    await startInbox("hold");
    const seen: Array<{ fromSock?: string; msgId?: string }> = [];
    const inject = async (i: { fromSock?: string; msgId?: string }) => {
      seen.push(i);
      return { ok: true as const, socketPath: sockPath, usedAuth: false, target: "x" };
    };
    await socketWakeProxyForwarder({ env: env(), inject })(entry, ref);
    expect(seen[0]?.fromSock).toBeUndefined();
    expect(seen[0]?.msgId).toBeUndefined();
    expect(leftovers()).toEqual([]);
    const box = inbox!;
    await socketWakeProxyForwarder({ env: env(), receipts: false, fromName: () => "leo", fromId: () => null })(entry, ref);
    expect(userFrame(await box.nextFrame()).from).toBeUndefined();
  });

  test("wakeProxyReceiptLogLine：accepted 不打；各状态措辞可区分", () => {
    const at = { channel: "dev", seq: 7 };
    expect(wakeProxyReceiptLogLine("a", at, { phase: "first", status: "accepted" })).toBeNull();
    const held = wakeProxyReceiptLogLine("a", at, { phase: "first", status: "held", reason: "waiting" })!;
    expect(held).toContain("扣留待审");
    expect(held).toContain("reason=waiting");
    expect(wakeProxyReceiptLogLine("a", at, { phase: "terminal", status: "delivered" })).toContain("已获批准并送达");
    expect(wakeProxyReceiptLogLine("a", at, { phase: "terminal", status: "unknown" })).toContain("结局未知");
    expect(wakeProxyReceiptLogLine("a", at, { phase: "first", status: "refused" })).toContain("没有送达");
    expect(wakeProxyReceiptLogLine("a", at, { phase: "terminal", status: "expired" })).toContain("被扣留后最终没有送达");
  });
});

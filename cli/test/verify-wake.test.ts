// #990：接入引导第 4 步——真发一条 @ 验证往返，超时说清哪一层没通。
//
// 钉三件事：① 往返成功 ⇒ 第 4 步过（healthy / wake_pending 都算）；② 三种超时各落到**不同的层**、给不同的
// 文案与修法（把判层短路成常量，这里至少两条会红）；③ 本机证据的真实读法（认领文件 / bridge 恢复日志）与
// #959 的 waiting 帧去重互不干扰（验证帧是 message，去重只看 status）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WAKE_VERIFY_PREFIX, isWakeVerifyFrame, type MsgFrame } from "@agentparty/shared";
import { deliveryRecoveryJournalPath } from "../src/delivery-recovery-journal";
import { mentionWakeClaimDir, mentionWakeClaimKey } from "../src/mention-wake-claim";
import {
  classifyWakeVerify,
  formatWakeVerifyStep,
  readWakeLocalEvidence,
  verifyWakeBody,
  verifyWakeRoundTrip,
  wakeVerifyRetryAfterSec,
  type VerifyWakeDeps,
  type WakeLocalEvidence,
} from "../src/onboarding/verify-wake";
import { resolveVerifyIdentity } from "../src/commands/wake";
import { RestError } from "../src/rest";
import { serveWakeAlreadyAdvertised, serveWakeNote } from "../src/commands/serve";
import type { WakeTestFrame } from "../src/commands/wake";
import type { ResolvedAuthDetailed } from "../src/oidc-cli";
import { msgFrame } from "./mock-server";
import { startRestMock, type RestMock, type RestRequest } from "./rest-mock";

const SERVER = "https://party.example.com";
const TOKEN = "ap_tok";
const CHANNEL = "ludo";
const ME = "server";

function frame(over: Omit<Partial<WakeTestFrame>, "phases"> & { phases?: Partial<WakeTestFrame["phases"]> } = {}): WakeTestFrame {
  const base: WakeTestFrame = {
    type: "wake_test",
    channel: CHANNEL,
    target: ME,
    result: "timeout",
    generated_at: 1,
    timeout_sec: 30,
    presence: { state: "waiting", residency: "supervised", wake_kind: "serve", wake_verified_at: null, last_seen: 1 },
    phases: {
      mention_delivered: { ok: true, seq: 42, evidence: "message accepted by channel history" },
      wake_invoked: { ok: null, status: "broadcast_pending", adapter: "serve", evidence: "serve broadcast delivered for mention #42; awaiting linked resume to confirm consumption" },
      agent_resumed: { ok: false, seq: null, evidence: null },
    },
    reason: "timed out waiting for linked reply_to/status.summary_seq",
  };
  return { ...base, ...over, phases: { ...base.phases, ...(over.phases ?? {}) } } as WakeTestFrame;
}

const noLocal: WakeLocalEvidence = { listener: { live: null, sessions: 0 }, claimed: false, journaled: false, runnerTask: false };
const armedLocal: WakeLocalEvidence = { listener: { live: { pid: 41233, launch: "claude-channel" }, sessions: 1 }, claimed: false, journaled: false, runnerTask: false };

function deps(probe: WakeTestFrame | Error, local: WakeLocalEvidence = noLocal): VerifyWakeDeps & { probed: unknown[]; asked: number[] } {
  const probed: unknown[] = [];
  const asked: number[] = [];
  let t = 1_000;
  return {
    probed,
    asked,
    probe: async (opts) => {
      probed.push(opts);
      t += 3_200;
      if (probe instanceof Error) throw probe;
      return probe;
    },
    localEvidence: ({ seq }) => {
      asked.push(seq);
      return local;
    },
    now: () => t,
  };
}

const classify = (f: WakeTestFrame, local: WakeLocalEvidence, harness: "claude" | "codex" | "other" = "claude") =>
  classifyWakeVerify(f, local, { identity: ME, channel: CHANNEL, elapsedMs: 3_200, timeoutMs: 30_000, harness });

describe("验证帧本体（#990）", () => {
  test("正文以 [wake-verify] 开头、只 @ 自己：服务端与本机监听都认它是验证帧", () => {
    const body = verifyWakeBody(ME);
    expect(body.startsWith(WAKE_VERIFY_PREFIX)).toBe(true);
    expect(body).toContain(`@${ME}`);
    expect(isWakeVerifyFrame({ kind: "message", body, mentions: [ME], sender: { name: ME } })).toBe(true);
  });

  test("往返探针复用 wake test 的本体：目标＝自己、正文＝验证帧、超时按秒上取整", async () => {
    const d = deps(frame({ result: "healthy", phases: { agent_resumed: { ok: true, seq: 43, evidence: "reply_to" } } }));
    const r = await verifyWakeRoundTrip({ server: SERVER, token: TOKEN, channel: CHANNEL, identity: ME, timeoutMs: 2_500 }, d);
    expect(d.probed).toEqual([{ server: SERVER, token: TOKEN, channel: CHANNEL, target: ME, timeoutSec: 3, body: verifyWakeBody(ME) }]);
    expect(r.ok).toBe(true);
    expect(r.seq).toBe(42);
    expect(r.probe?.type).toBe("wake_test");
  });
});

describe("往返成功 ⇒ 第 4 步过（#990）", () => {
  test("收到回帖：ok、带耗时与回帖 seq，无 layer，不读本机证据也不留 local", async () => {
    const d = deps(frame({ result: "healthy", phases: { agent_resumed: { ok: true, seq: 43, evidence: "reply_to" } } }));
    const r = await verifyWakeRoundTrip({ server: SERVER, token: TOKEN, channel: CHANNEL, identity: ME }, d);
    expect(r).toMatchObject({ ok: true, elapsedMs: 3_200, seq: 42, local: null });
    expect(r.layer).toBeUndefined();
    expect(r.fix).toBeUndefined();
    expect(formatWakeVerifyStep(r)).toEqual([`第 4 步  真发一条 @ 验证 · @${ME} ping → 3.2s 收到回执 ✓（回帖 #43）`]);
  });

  test("runner 已接手（wake_pending，#689）同样算过——headless runner 数分钟才回帖", async () => {
    const d = deps(frame({ result: "wake_pending", phases: { wake_invoked: { ok: true, status: "invoked", adapter: "serve", evidence: "processing" } } }));
    const r = await verifyWakeRoundTrip({ server: SERVER, token: TOKEN, channel: CHANNEL, identity: ME }, d);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("收到回执 ✓");
    expect(r.detail).toContain("runner 已接手 #42");
  });

  test("wake_pending 但 seq 为 null（#997 防御）：仍算过，文案不拼 #null / #undefined", () => {
    const v = classify(
      frame({
        result: "wake_pending",
        phases: {
          mention_delivered: { ok: true, seq: null, evidence: "accepted" },
          wake_invoked: { ok: true, status: "invoked", adapter: "serve", evidence: "processing" },
        },
      }),
      noLocal,
    );
    expect(v.ok).toBe(true);
    expect(v.detail).toContain("runner 已接手，");
    expect(v.detail).not.toMatch(/#(null|undefined)/);
  });
});

describe("服务端限频（#997）", () => {
  test("wake_verify_rate_limited：不是三层里的任何一层，说清等多久，修法带 sleep N", async () => {
    const e = new RestError(429, "wake_verify_rate_limited", "already sent a wake-verify frame", {
      error: { code: "wake_verify_rate_limited", message: "x", retry_after_ms: 12_400, retry_at: 1 },
    });
    const r = await verifyWakeRoundTrip({ server: SERVER, token: TOKEN, channel: CHANNEL, identity: ME }, deps(e));
    expect(r.ok).toBe(false);
    expect(r.layer).toBeUndefined();
    expect(r.seq).toBeNull();
    expect(r.detail).toBe("✗ 验证帧被服务端限频：同一身份 30s 内只能发一条，13s 后可再发");
    expect(r.fix).toBe(`sleep 13 && party wake verify ${CHANNEL}`);
  });

  test("错误体缺 retry_after_ms：不编秒数", async () => {
    const e = new RestError(429, "wake_verify_rate_limited", "limited", { error: { code: "wake_verify_rate_limited" } });
    const r = await verifyWakeRoundTrip({ server: SERVER, token: TOKEN, channel: CHANNEL, identity: ME }, deps(e));
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("✗ 验证帧被服务端限频：同一身份 30s 内只能发一条");
    // 没有 retry_after 时修法只能是可执行的验证命令本身（coderabbit on #999：`稍等片刻 && …` 进 shell 会先炸）。
    expect(r.fix).toBe(`party wake verify ${CHANNEL}`);
  });

  test("wakeVerifyRetryAfterSec：向上取整、至少 1s、形状不对为 null", () => {
    expect(wakeVerifyRetryAfterSec({ error: { retry_after_ms: 12_400 } })).toBe(13);
    expect(wakeVerifyRetryAfterSec({ error: { retry_after_ms: 200 } })).toBe(1);
    expect(wakeVerifyRetryAfterSec({ error: { retry_after_ms: "soon" } })).toBeNull();
    expect(wakeVerifyRetryAfterSec({ error: {} })).toBeNull();
    expect(wakeVerifyRetryAfterSec(null)).toBeNull();
    expect(wakeVerifyRetryAfterSec("nope")).toBeNull();
  });
});

describe("身份以 /api/me 为准，config 只是缓存（#997）", () => {
  const cfg = { server: SERVER, token: TOKEN };
  function idDeps(cached: string | null, me: string | Error) {
    const warned: string[] = [];
    return {
      warned,
      deps: {
        cached: () => cached,
        fetchMe: async () => {
          if (me instanceof Error) throw me;
          return { name: me };
        },
        warn: (line: string) => warned.push(line),
      },
    };
  }

  test("缓存与权威不一致：取权威身份，打印一条提示", async () => {
    const { deps: d, warned } = idDeps("stale-me", ME);
    await expect(resolveVerifyIdentity(cfg, d)).resolves.toEqual({ identity: ME, source: "server" });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("stale-me");
    expect(warned[0]).toContain(ME);
    expect(warned[0]).toContain("以服务端为准");
  });

  // coderabbit on #999（CWE-150）：/api/me 的 name 与网络错误消息来自远端，写 stderr 前必须剥终端控制字符；
  // 但返回给验证帧用的身份值保持原样（那是要精确匹配的原值，不是显示用）。
  test("远端身份名 / 错误消息含终端控制字符：提示行剥掉，返回值不动", async () => {
    const evil = "me\u001b]0;pwned\u0007\u001b[31m";
    const { deps: d, warned } = idDeps("stale-me", evil);
    await expect(resolveVerifyIdentity(cfg, d)).resolves.toEqual({ identity: evil, source: "server" });
    expect(warned).toHaveLength(1);
    expect({ hasEsc: warned[0]!.includes("\u001b"), hasBel: warned[0]!.includes("\u0007") }).toEqual({ hasEsc: false, hasBel: false });
    const err = idDeps("cached-me", new Error("boom\u001b[2J\u001b]52;c;evil\u0007"));
    await expect(resolveVerifyIdentity(cfg, err.deps)).resolves.toEqual({ identity: "cached-me", source: "cache" });
    expect(err.warned[0]!.includes("\u001b")).toBe(false);
  });

  test("缓存一致 / 无缓存：取权威身份，不提示", async () => {
    const same = idDeps(ME, ME);
    await expect(resolveVerifyIdentity(cfg, same.deps)).resolves.toEqual({ identity: ME, source: "server" });
    expect(same.warned).toEqual([]);
    const none = idDeps(null, ME);
    await expect(resolveVerifyIdentity(cfg, none.deps)).resolves.toEqual({ identity: ME, source: "server" });
    expect(none.warned).toEqual([]);
    const empty = idDeps("", ME);
    await expect(resolveVerifyIdentity(cfg, empty.deps)).resolves.toEqual({ identity: ME, source: "server" });
    expect(empty.warned).toEqual([]);
  });

  test("/api/me 不可达：有缓存才退回缓存并警告；没缓存就把错误抛出去", async () => {
    const fallback = idDeps("cached-me", new Error("fetch failed"));
    await expect(resolveVerifyIdentity(cfg, fallback.deps)).resolves.toEqual({ identity: "cached-me", source: "cache" });
    expect(fallback.warned).toHaveLength(1);
    expect(fallback.warned[0]).toContain("fetch failed");
    expect(fallback.warned[0]).toContain("cached-me");
    const dead = idDeps(null, new Error("fetch failed"));
    await expect(resolveVerifyIdentity(cfg, dead.deps)).rejects.toThrow("fetch failed");
  });
});

describe("三种超时各落不同的层（#990）", () => {
  test("服务端未投递：presence 没登记可唤醒 ⇒ server_delivery，验证帧没发", () => {
    const v = classify(
      frame({
        result: "not_auto_wakeable",
        reason: "no presence for target",
        phases: {
          mention_delivered: { ok: false, seq: null, evidence: "not sent because target is not auto-wakeable" },
          wake_invoked: { ok: false, status: "not_invoked", adapter: null, evidence: "no presence for target" },
        },
      }),
      noLocal,
    );
    expect(v.ok).toBe(false);
    expect(v.layer).toBe("server_delivery");
    expect(v.detail).toContain("✗ 30s 未收到");
    expect(v.detail).toContain("服务端没把 @server 当成可唤醒目标");
    expect(v.detail).toContain("no presence for target");
    expect(v.fix).toContain(`party claude ${CHANNEL}`);
  });

  test("服务端未投递：帧发了但账本没有这条 @ 的行 ⇒ server_delivery", () => {
    const v = classify(
      frame({ phases: { wake_invoked: { ok: null, status: "not_audited", adapter: "serve", evidence: "not audited" } } }),
      armedLocal,
    );
    expect(v.layer).toBe("server_delivery");
    expect(v.detail).toContain("服务端未投递");
    expect(v.detail).toContain("账本没有这条 @ 的投递记录");
  });

  test("本机未收到：服务端已广播、本机没有任何收到痕迹且没有武装监听 ⇒ local_listener", () => {
    const v = classify(frame(), { ...noLocal, listener: { live: null, sessions: 2 } });
    expect(v.layer).toBe("local_listener");
    expect(v.detail).toContain("服务端已投递、本机监听未收到");
    expect(v.detail).toContain("本机没有武装监听");
    expect(v.detail).toContain("2 个蛰伏会话");
    expect(v.fix).toContain(`party claude ${CHANNEL}`);
  });

  test("本机未收到：服务端判 listening=deaf ⇒ local_listener，说清是连接没在消费", () => {
    const v = classify(
      frame({ result: "not_listening", presence: { state: "waiting", residency: "supervised", wake_kind: "serve", wake_verified_at: null, last_seen: 1, listening: "deaf" } }),
      armedLocal,
    );
    expect(v.layer).toBe("local_listener");
    expect(v.detail).toContain("listening=deaf");
  });

  test("模型未回：本机 runtime 已认领这条唤醒，30s 内没回帖 ⇒ model_reply", () => {
    const v = classify(frame(), { ...armedLocal, claimed: true });
    expect(v.layer).toBe("model_reply");
    expect(v.detail).toContain("服务端已投递、本机监听已收到，模型未回");
    expect(v.detail).toContain("已认领这条唤醒");
    expect(v.fix).toContain("卡住");
  });

  test("模型未回：runner 连败（#603）⇒ model_reply，带失败次数与最后错误", () => {
    const v = classify(
      frame({
        result: "runner_failing",
        presence: { state: "waiting", residency: "supervised", wake_kind: "serve", wake_verified_at: null, last_seen: 1, runner_health: { ok: false, consecutive_failures: 3, last_error: "claude: not logged in" } },
      }),
      armedLocal,
      "codex",
    );
    expect(v.layer).toBe("model_reply");
    expect(v.detail).toContain("runner 连败 x3");
    expect(v.detail).toContain("not logged in");
    expect(v.fix).toContain("party health");
  });

  test("三层互斥：同一份服务端帧，只改本机证据就换层（判层不是常量）", () => {
    const f = frame();
    expect(classify(f, noLocal).layer).toBe("local_listener");
    expect(classify(f, { ...noLocal, journaled: true }).layer).toBe("model_reply");
    expect(classify(f, { ...noLocal, runnerTask: true }).layer).toBe("model_reply");
    expect(
      classify(frame({ phases: { wake_invoked: { ok: false, status: "not_invoked", adapter: "webhook", evidence: "webhook delivery attempt 1 failed status=502" } } }), noLocal).layer,
    ).toBe("server_delivery");
  });

  test("超时时读一次本机证据（按这条 seq），结果里带 layer/fix/local，退出形态是 ✗ 一行 + 修法一行", async () => {
    const d = deps(frame(), noLocal);
    const r = await verifyWakeRoundTrip({ server: SERVER, token: TOKEN, channel: CHANNEL, identity: ME, harness: "claude" }, d);
    expect(d.asked).toEqual([42]);
    expect(r).toMatchObject({ ok: false, layer: "local_listener", seq: 42, local: noLocal });
    const lines = formatWakeVerifyStep(r);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith("第 4 步  真发一条 @ 验证 · ✗ 30s 未收到：服务端已投递、本机监听未收到 → ");
    expect(lines[1]).toBe(`         → 修法：party claude ${CHANNEL}   （重新起一个武装监听；常驻：party serve ${CHANNEL} --runner claude）`);
  });

  test("验证帧发不出去（频道熔断）：不是三层里的任何一层，修法指向 reset-guard", async () => {
    const d = deps(new Error("loop_guard: 30 consecutive agent messages, waiting for a human"));
    const r = await verifyWakeRoundTrip({ server: SERVER, token: TOKEN, channel: CHANNEL, identity: ME }, d);
    expect(r.ok).toBe(false);
    expect(r.layer).toBeUndefined();
    expect(r.seq).toBeNull();
    expect(r.detail).toContain("验证帧没发出去");
    expect(r.fix).toContain(`party channel reset-guard ${CHANNEL}`);
    expect(d.asked).toEqual([]);
  });
});

describe("本机证据的真实读法（#990）", () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ap-990-home-"));
    saved = process.env.AGENTPARTY_HOME;
    process.env.AGENTPARTY_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENTPARTY_HOME;
    else process.env.AGENTPARTY_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  test("空 home：没有监听、没有任何痕迹", () => {
    const e = readWakeLocalEvidence({ server: SERVER, token: TOKEN, channel: CHANNEL, identity: ME, seq: 42, cwd: home });
    expect(e).toEqual({ listener: { live: null, sessions: 0 }, claimed: false, journaled: false, runnerTask: false });
  });

  test("#963 认领文件（同 server/身份/频道/seq）⇒ claimed；别的 seq 不算", () => {
    const dir = mentionWakeClaimDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${mentionWakeClaimKey({ server: SERVER, identity: ME, channel: CHANNEL, seq: 42 })}.json`), "{}");
    expect(readWakeLocalEvidence({ server: SERVER, token: TOKEN, channel: CHANNEL, identity: ME, seq: 42, cwd: home }).claimed).toBe(true);
    expect(readWakeLocalEvidence({ server: SERVER, token: TOKEN, channel: CHANNEL, identity: ME, seq: 43, cwd: home }).claimed).toBe(false);
  });

  test("claude bridge 的 delivery 恢复日志里有这条 seq ⇒ journaled；坏 JSON 按没有算", () => {
    const path = deliveryRecoveryJournalPath("claude", SERVER, TOKEN, CHANNEL);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, channel: CHANNEL, bridge: "claude", entries: [{ message: { seq: 42 } }] }));
    expect(readWakeLocalEvidence({ server: SERVER, token: TOKEN, channel: CHANNEL, identity: ME, seq: 42, cwd: home }).journaled).toBe(true);
    expect(readWakeLocalEvidence({ server: SERVER, token: TOKEN, channel: CHANNEL, identity: ME, seq: 41, cwd: home }).journaled).toBe(false);
    writeFileSync(path, "{not json");
    expect(readWakeLocalEvidence({ server: SERVER, token: TOKEN, channel: CHANNEL, identity: ME, seq: 42, cwd: home }).journaled).toBe(false);
  });
});

describe("与 #959 的 waiting 帧去重互不干扰", () => {
  const auth: ResolvedAuthDetailed = {
    server: SERVER,
    token: TOKEN,
    auth_source: "runtime_config",
    config: { present: true, kind: "workspace", path: "/tmp/x.json" } as never,
    account: { present: false, path: "/tmp/account.json" } as never,
  };
  const note = serveWakeNote("claude");
  const status = (seq: number, n: string) =>
    msgFrame(seq, "", { sender: { name: ME, kind: "agent" }, kind: "status", state: "waiting", note: n }) as unknown as MsgFrame;
  const verify = (seq: number) =>
    msgFrame(seq, verifyWakeBody(ME), { sender: { name: ME, kind: "agent" }, mentions: [ME] }) as unknown as MsgFrame;

  test("验证帧不是状态帧：它夹在中间不会让去重把上线帧误判成「已发过」，也不会被去重吃掉", async () => {
    // 上一条状态帧是别的 note，中间有验证帧 ⇒ 去重不命中（照发上线帧）。
    expect(await serveWakeAlreadyAdvertised(auth, CHANNEL, note, { self: ME, recent: (async () => [status(1, "别的"), verify(2)]) as never })).toBe(false);
    // 上一条状态帧一字不差，验证帧在它之后 ⇒ 去重照常命中（验证帧不干扰去重判定）。
    expect(await serveWakeAlreadyAdvertised(auth, CHANNEL, note, { self: ME, recent: (async () => [status(1, note), verify(2)]) as never })).toBe(true);
    // 验证帧本身永远不是 waiting 状态帧——去重的判据碰不到它。
    expect(verify(2).kind).toBe("message");
    expect(isWakeVerifyFrame(verify(2))).toBe(true);
  });
});

// ── CLI 入口：party wake verify（走 REST mock，与 wake.test.ts 同一套） ──
describe("party wake verify（#990）", () => {
  const indexPath = join(import.meta.dir, "..", "src", "index.ts");
  let home: string;
  let mock: RestMock | null = null;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ap-wake-verify-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    mock?.stop();
    mock = null;
  });

  async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
      env: { ...process.env, AGENTPARTY_HOME: home, ADMIN_SECRET: undefined },
      stdout: "pipe",
      stderr: "pipe",
      cwd: home,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  function writeCfg(server: string, cachedName: string = ME) {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      server,
      token: TOKEN,
      identity: { name: cachedName, email: null, kind: "agent", role: "agent", owner: null, channel_scope: null, verified_at: 0 },
    }));
  }

  // #997：身份以 /api/me 为准。
  const me = () => Response.json({ name: ME, email: null, kind: "agent", role: "agent", owner: null, channel_scope: null, verified_at: 0 });
  const presence = () => Response.json({
    presence: [{ name: ME, state: "waiting", note: null, ts: Date.now(), last_seen: Date.now(), residency: "supervised", wake: { kind: "serve" } }],
  });
  const reqsOf = (m: RestMock, method: string, path: string): RestRequest[] => m.requests.filter((r) => r.method === method && r.path === path);

  test("往返成功：以本身份发验证帧（[wake-verify] + 只 @ 自己），收到回帖 ⇒ exit 0，印第 4 步那一行", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/me") return me();
      if (req.method === "GET" && req.path === `/api/channels/${CHANNEL}/presence`) return presence();
      if (req.method === "POST" && req.path === `/api/channels/${CHANNEL}/messages`) return Response.json({ seq: 5 });
      if (req.method === "GET" && req.path === `/api/channels/${CHANNEL}/wake-deliveries`) {
        return Response.json({ deliveries: [{ mention_seq: 5, target_name: ME, webhook_name: "", adapter_kind: "serve", attempt: 1, result: "broadcast", http_status: null, error: null, attempted_at: 1, ack_seq: null, resume_seq: null }] });
      }
      if (req.method === "GET" && req.path === `/api/channels/${CHANNEL}/messages`) {
        return Response.json({ messages: [{ type: "message", seq: 6, sender: { name: ME, kind: "agent" }, kind: "message", body: "pong", mentions: [], reply_to: 5, ts: 1 }] });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["wake", "verify", CHANNEL, "--timeout", "2"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const posts = reqsOf(mock, "POST", `/api/channels/${CHANNEL}/messages`);
    expect(posts).toHaveLength(1);
    const body = posts[0]!.body as { kind: string; body: string; mentions: string[] };
    expect(body.kind).toBe("message");
    expect(body.body.startsWith(WAKE_VERIFY_PREFIX)).toBe(true);
    expect(body.mentions).toEqual([ME]);
    expect(r.stdout).toMatch(/^第 4 步 {2}真发一条 @ 验证 · @server ping → \d+(\.\d)?s 收到回执 ✓（回帖 #6）\n$/);
  });

  test("超时：服务端已广播、这台机器没有武装监听 ⇒ exit 2，✗ 行说清 local_listener 与修法；--json 带 layer", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/me") return me();
      if (req.method === "GET" && req.path === `/api/channels/${CHANNEL}/presence`) return presence();
      if (req.method === "POST" && req.path === `/api/channels/${CHANNEL}/messages`) return Response.json({ seq: 7 });
      if (req.method === "GET" && req.path === `/api/channels/${CHANNEL}/wake-deliveries`) {
        return Response.json({ deliveries: [{ mention_seq: 7, target_name: ME, webhook_name: "", adapter_kind: "serve", attempt: 1, result: "broadcast", http_status: null, error: null, attempted_at: 1, ack_seq: null, resume_seq: null }] });
      }
      if (req.method === "GET" && req.path === `/api/channels/${CHANNEL}/messages`) return Response.json({ messages: [] });
      return undefined;
    });
    writeCfg(mock.url);
    const human = await runCli(["wake", "verify", "--channel", CHANNEL, "--timeout", "1"]);
    expect(human.code).toBe(2);
    expect(human.stdout).toContain("第 4 步  真发一条 @ 验证 · ✗ 1.0s 未收到：服务端已投递、本机监听未收到 → 本机没有武装监听");
    expect(human.stdout).toContain("→ 修法：party wake check");

    const json = await runCli(["wake", "verify", CHANNEL, "--timeout", "1", "--json"]);
    expect(json.code).toBe(2);
    const out = JSON.parse(json.stdout.trim());
    expect(out).toMatchObject({ type: "wake_verify", channel: CHANNEL, identity: ME, identity_source: "server", ok: false, layer: "local_listener", seq: 7 });
    expect(out.probe.type).toBe("wake_test");
    expect(out.local.listener.live).toBeNull();
  });

  test("超时：服务端账本没有这条 @ 的行 ⇒ server_delivery（与本机层文案不同）", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/me") return me();
      if (req.method === "GET" && req.path === `/api/channels/${CHANNEL}/presence`) return presence();
      if (req.method === "POST" && req.path === `/api/channels/${CHANNEL}/messages`) return Response.json({ seq: 8 });
      if (req.method === "GET" && req.path === `/api/channels/${CHANNEL}/wake-deliveries`) return Response.json({ deliveries: [] });
      if (req.method === "GET" && req.path === `/api/channels/${CHANNEL}/messages`) return Response.json({ messages: [] });
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["wake", "verify", CHANNEL, "--timeout", "1", "--json"]);
    expect(r.code).toBe(2);
    const out = JSON.parse(r.stdout.trim());
    expect(out.layer).toBe("server_delivery");
    expect(out.detail).toContain("服务端未投递");
  });

  test("config 缓存的是旧身份：验证帧仍 @ /api/me 的权威身份，stderr 提示不一致（#997）", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/me") return me();
      if (req.method === "GET" && req.path === `/api/channels/${CHANNEL}/presence`) return presence();
      if (req.method === "POST" && req.path === `/api/channels/${CHANNEL}/messages`) return Response.json({ seq: 9 });
      if (req.method === "GET" && req.path === `/api/channels/${CHANNEL}/wake-deliveries`) {
        return Response.json({ deliveries: [{ mention_seq: 9, target_name: ME, webhook_name: "", adapter_kind: "serve", attempt: 1, result: "broadcast", http_status: null, error: null, attempted_at: 1, ack_seq: null, resume_seq: null }] });
      }
      if (req.method === "GET" && req.path === `/api/channels/${CHANNEL}/messages`) {
        return Response.json({ messages: [{ type: "message", seq: 10, sender: { name: ME, kind: "agent" }, kind: "message", body: "pong", mentions: [], reply_to: 9, ts: 1 }] });
      }
      return undefined;
    });
    writeCfg(mock.url, "stale-me");
    const r = await runCli(["wake", "verify", CHANNEL, "--timeout", "2", "--json"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("stale-me");
    expect(r.stderr).toContain("以服务端为准");
    const posts = reqsOf(mock, "POST", `/api/channels/${CHANNEL}/messages`);
    expect(posts).toHaveLength(1);
    expect((posts[0]!.body as { mentions: string[] }).mentions).toEqual([ME]);
    expect((posts[0]!.body as { body: string }).body).toContain(`@${ME} ping`);
    const out = JSON.parse(r.stdout.trim());
    expect(out).toMatchObject({ type: "wake_verify", identity: ME, identity_source: "server", ok: true });
  });

  test("/api/me 不可达：退回 config 缓存身份继续验证，stderr 警告（#997）", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/me") return Response.json({ error: { code: "unavailable", message: "directory down" } }, { status: 503 });
      if (req.method === "GET" && req.path === `/api/channels/${CHANNEL}/presence`) return presence();
      if (req.method === "POST" && req.path === `/api/channels/${CHANNEL}/messages`) return Response.json({ seq: 11 });
      if (req.method === "GET" && req.path === `/api/channels/${CHANNEL}/wake-deliveries`) {
        return Response.json({ deliveries: [{ mention_seq: 11, target_name: ME, webhook_name: "", adapter_kind: "serve", attempt: 1, result: "broadcast", http_status: null, error: null, attempted_at: 1, ack_seq: null, resume_seq: null }] });
      }
      if (req.method === "GET" && req.path === `/api/channels/${CHANNEL}/messages`) {
        return Response.json({ messages: [{ type: "message", seq: 12, sender: { name: ME, kind: "agent" }, kind: "message", body: "pong", mentions: [], reply_to: 11, ts: 1 }] });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["wake", "verify", CHANNEL, "--timeout", "2", "--json"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("/api/me 不可达");
    const out = JSON.parse(r.stdout.trim());
    expect(out).toMatchObject({ identity: ME, identity_source: "cache", ok: true });
  });

  test("服务端限频：exit 2，说清等多久与修法（#997）", async () => {
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/me") return me();
      if (req.method === "GET" && req.path === `/api/channels/${CHANNEL}/presence`) return presence();
      if (req.method === "POST" && req.path === `/api/channels/${CHANNEL}/messages`) {
        return Response.json(
          { error: { code: "wake_verify_rate_limited", message: "limited", retry_after_ms: 21_500, retry_at: Date.now() + 21_500 } },
          { status: 429 },
        );
      }
      return undefined;
    });
    writeCfg(mock.url);
    const r = await runCli(["wake", "verify", CHANNEL, "--timeout", "2"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("第 4 步  真发一条 @ 验证 · ✗ 验证帧被服务端限频：同一身份 30s 内只能发一条，22s 后可再发");
    expect(r.stdout).toContain(`→ 修法：sleep 22 && party wake verify ${CHANNEL}`);
  });

  test("用法错误：verify 不收目标位置参数", async () => {
    writeCfg("https://party.example.com");
    const r = await runCli(["wake", "verify", CHANNEL, "extra"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("usage: party wake verify");
  });
});

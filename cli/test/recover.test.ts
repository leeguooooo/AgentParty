// party recover <chan>（issue #991，epic #987）——恢复 / 重连引导。
//
// 第 1 步「找回身份」是本命令自己的：绑定 → config → /api/me 真核 token / 名字；
// 第 2/3/4 步复用 party join 的第 0/3/4 步（同一份实现），这里只验它们真的被接上、编号从 1 数起、
// rerun 文案是 party recover。
//
// 反假绿纪律：token 有效与否**必须**以 /api/me 的真实响应为准——rest-mock 回 401 时引导必须停在
// 第 1 步。变异自检（写这份测试时做过）：把 recoverIdentityStep 里的 fetchMe 核验删掉 ⇒
// 「token 已撤」那条红（引导跑到第 3 步去了）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentpartyHome } from "../src/config";
import { joinBindingsPath, writeJoinBinding, type BindingHarness, type JoinBinding } from "../src/join-binding";
import { fetchMe } from "../src/rest";
import { runJoin } from "../src/commands/join";
import { pickBinding, run as runRecoverCli, runRecover, type RecoverDeps, type RecoverOptions } from "../src/commands/recover";
import { main } from "../src/index";
import { startRestMock, type RestMock } from "./rest-mock";
import { STUB_WAKE_VERIFY_SUMMARY, baseJoinOpts, fixCount, fixLine, joinDeps, joinEnv, stepLine, type SpawnBehavior } from "./join-fixture";

let tmp: string;
let mock: RestMock;
const env = joinEnv();

beforeEach(() => {
  tmp = env.setup();
});
afterEach(() => {
  mock?.stop();
  env.teardown();
});

const CWD = "/work/ludo-project";
const TOKEN = "ap_bot_secret";

/** 在盘上种一份「接入过」的状态：config（带 token + 服务端确认过的身份）+ 加入即绑定。 */
function seedBinding(over: Partial<JoinBinding> & { token?: string; identityInConfig?: string | null; noConfig?: boolean } = {}): JoinBinding {
  const identity = over.identity ?? "agent";
  const agentsDir = join(agentpartyHome(), "agents");
  mkdirSync(agentsDir, { recursive: true });
  const configPath = over.config_path ?? join(agentsDir, `agentparty-${identity}-dev.json`);
  if (over.noConfig !== true) {
    const identityInConfig = over.identityInConfig === undefined ? identity : over.identityInConfig;
    writeFileSync(
      configPath,
      JSON.stringify({
        server: over.server ?? mock.url,
        token: over.token ?? TOKEN,
        ...(identityInConfig === null
          ? {}
          : { identity: { name: identityInConfig, email: null, kind: "agent", role: "agent", owner: null, channel_scope: null, verified_at: 1 } }),
      }),
    );
  }
  const binding: JoinBinding = {
    harness: over.harness ?? "claude",
    server: over.server ?? mock.url,
    channel: over.channel ?? "dev",
    owner: null,
    identity,
    config_path: configPath,
    cwd: over.cwd ?? CWD,
    created_at: over.created_at ?? 1_000,
  };
  writeJoinBinding(joinBindingsPath(agentpartyHome()), binding, { replace: false });
  return binding;
}

function deps(logs: string[], over: Partial<RecoverDeps> = {}, behavior: SpawnBehavior = {}, record: string[][] = []): RecoverDeps {
  return {
    ...joinDeps(tmp, record, behavior, logs),
    bindingsPath: joinBindingsPath(agentpartyHome()),
    cwd: CWD,
    fetchMe: (server, token) => fetchMe(server, token),
    detectHarness: () => null,
    ...over,
  };
}
function opts(over: Partial<RecoverOptions> = {}): RecoverOptions {
  return { channel: "dev", harnessFlag: null, yes: true, ...over };
}
/** /api/me 回 401：token 被撤了。 */
const revokedTokenMock = () =>
  startRestMock((req) =>
    req.path === "/api/me" ? Response.json({ error: { code: "unauthorized", message: "token revoked" } }, { status: 401 }) : undefined,
  );

describe("party recover —— 第 1 步 找回身份", () => {
  test("绑定存在且 token 有效 ⇒ 第 1 步过、直接走到第 3 步（本机没有武装监听就停在第 3 步）", async () => {
    mock = startRestMock();
    seedBinding();
    const logs: string[] = [];
    const code = await runRecover(opts(), deps(logs, { claudeArmedListener: () => ({ live: null, sessions: 1 }) }));
    const out = logs.join("\n");

    expect(code).toBe(1);
    // 第 1 步 ✓：找回的是绑定里那个身份，且说明了 token 有效。
    const step1 = stepLine(logs, 1);
    expect(step1).toContain("找回身份");
    expect(step1).toContain("agent");
    expect(step1).toContain("token 有效");
    expect(step1?.endsWith("✓")).toBe(true);
    // 核 token 真打了 /api/me，bearer 是 config 里的 token。
    const me = mock.requests.find((r) => r.method === "GET" && r.path === "/api/me");
    expect(me).toBeDefined();
    expect(me!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // token 绝不出现在输出里（#676）。
    expect(out).not.toContain(TOKEN);
    // 第 2 步（版本＝join 第 0 步）✓，第 3 步（起一个可唤醒的会话＝join 第 3 步）✗ 停在这。
    expect(stepLine(logs, 2)).toContain("版本");
    expect(stepLine(logs, 2)?.endsWith("✓")).toBe(true);
    const step3 = stepLine(logs, 3);
    expect(step3).toContain("起一个可唤醒的会话");
    expect(step3?.endsWith("✗")).toBe(true);
    expect(fixCount(logs)).toBe(1);
    expect(fixLine(logs)).toBe("party claude dev");
    // 修法文案是 recover 自己的 rerun，不是 party join。
    expect(out).toContain("修法（做完重跑同一条 party recover dev）：");
    expect(out).toContain("恢复停在第 3 步（起一个可唤醒的会话）");
    expect(stepLine(logs, 4)).toBeUndefined();
    expect(out).not.toContain("✅");
  });

  test("token 已撤（/api/me 401）⇒ 停在第 1 步，说清是 token 失效，修法是 party join（token 占位）", async () => {
    mock = revokedTokenMock();
    seedBinding();
    const logs: string[] = [];
    const record: string[][] = [];
    const code = await runRecover(opts(), deps(logs, {}, {}, record));
    const out = logs.join("\n");

    expect(code).toBe(1);
    const step1 = stepLine(logs, 1);
    expect(step1).toContain("token");
    expect(step1).toContain("失效");
    expect(step1?.endsWith("✗")).toBe(true);
    expect(fixCount(logs)).toBe(1);
    const fix = fixLine(logs)!;
    expect(fix).toContain("party join");
    expect(fix).toContain("AGENTPARTY_TOKEN='<T>'");
    expect(fix).toContain(`--server ${mock.url}`);
    expect(fix).toContain("--channel dev");
    expect(fix).toContain("--as agent");
    expect(fix).toContain("--harness claude");
    // 失效的 token 也不许印出来。
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("恢复停在第 1 步（找回身份）");
    // 后面的步骤一个都没跑：没印第 2 步、没碰 claude 二进制。
    expect(stepLine(logs, 2)).toBeUndefined();
    expect(record.some((r) => r[0] === "claude")).toBe(false);
  });

  test("没绑定 ⇒ 停在第 1 步，提示走 party join；不打服务端", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const code = await runRecover(opts(), deps(logs));
    const out = logs.join("\n");

    expect(code).toBe(1);
    const step1 = stepLine(logs, 1);
    expect(step1).toContain("没有 #dev 的身份绑定");
    expect(step1?.endsWith("✗")).toBe(true);
    expect(fixCount(logs)).toBe(1);
    expect(fixLine(logs)).toContain("party join");
    expect(fixLine(logs)).toContain("--channel dev");
    expect(out).toContain("party join");
    expect(mock.requests.some((r) => r.path === "/api/me")).toBe(false);
    expect(stepLine(logs, 2)).toBeUndefined();
  });

  test("绑定在、config 丢了 ⇒ 停在第 1 步（config 是 token 的唯一载体），修法 party join", async () => {
    mock = startRestMock();
    seedBinding({ noConfig: true });
    const logs: string[] = [];
    const code = await runRecover(opts(), deps(logs));

    expect(code).toBe(1);
    expect(stepLine(logs, 1)).toContain("config 读不到 token");
    expect(fixLine(logs)).toContain("party join");
    expect(fixLine(logs)).toContain("--as agent");
    expect(mock.requests.some((r) => r.path === "/api/me")).toBe(false);
  });

  test("名字被改（/api/me 回的 name ≠ 本机记的）⇒ 停在第 1 步，修法是按新名字 party join", async () => {
    mock = startRestMock((req) =>
      req.path === "/api/me"
        ? Response.json({ name: "agent-renamed", email: null, kind: "agent", role: "agent", owner: null, channel_scope: null })
        : undefined,
    );
    seedBinding();
    const logs: string[] = [];
    const code = await runRecover(opts(), deps(logs));

    expect(code).toBe(1);
    const step1 = stepLine(logs, 1);
    expect(step1).toContain("agent-renamed");
    expect(step1).toContain("名字被改");
    expect(step1?.endsWith("✗")).toBe(true);
    expect(fixLine(logs)).toContain("party join");
    expect(fixLine(logs)).toContain("--as agent-renamed");
    expect(stepLine(logs, 2)).toBeUndefined();
  });

  test("服务端不可达 ⇒ 停在第 1 步（核不了 token 不等于有效），修法是重跑 party recover", async () => {
    mock = startRestMock();
    seedBinding({ server: "http://127.0.0.1:9" }); // 连不上的端口
    const logs: string[] = [];
    const code = await runRecover(opts(), deps(logs));

    expect(code).toBe(1);
    expect(stepLine(logs, 1)).toContain("核不了 token");
    expect(fixLine(logs)).toContain("party recover dev");
    expect(stepLine(logs, 2)).toBeUndefined();
  });

  test("本机该频道有多条绑定：本目录（cwd 相同）的优先，并说明选了哪条", async () => {
    mock = startRestMock();
    seedBinding({ identity: "elsewhere", cwd: "/somewhere/else", created_at: 9_000 });
    seedBinding({ identity: "agent", cwd: CWD, created_at: 1_000 });
    const logs: string[] = [];
    await runRecover(opts(), deps(logs));

    expect(stepLine(logs, 1)).toContain("绑的是 agent");
    expect(logs.join("\n")).toContain("有 2 条绑定，选了本目录（cwd 相同）的这条");
  });

  test("pickBinding：--harness 先过滤；cwd 相同 > 探测出的 harness > 最近加入；没有就 null", () => {
    const mk = (over: Partial<JoinBinding>): JoinBinding => ({
      harness: "claude",
      server: "https://x",
      channel: "dev",
      owner: null,
      identity: "a",
      config_path: "/c",
      cwd: "",
      created_at: 0,
      ...over,
    });
    const rows = [
      mk({ identity: "old-cwd", cwd: CWD, created_at: 1 }),
      mk({ identity: "new-codex", harness: "codex", created_at: 9 }),
      mk({ identity: "newest", created_at: 10 }),
      mk({ identity: "other-chan", channel: "ops", cwd: CWD, created_at: 99 }),
    ];
    const pick = (harnessFlag: BindingHarness | null, detected: BindingHarness | null, cwd = CWD) =>
      pickBinding(rows, { channel: "dev", cwd, harnessFlag, detected })?.chosen.identity ?? null;
    expect(pick(null, null)).toBe("old-cwd");
    expect(pick(null, "codex", "/elsewhere")).toBe("new-codex");
    expect(pick(null, null, "/elsewhere")).toBe("newest");
    expect(pick("codex", null)).toBe("new-codex");
    expect(pick("other", null)).toBeNull();
    expect(pickBinding(rows, { channel: "nope", cwd: CWD, harnessFlag: null, detected: null })).toBeNull();
  });
});

describe("party recover —— 第 2～4 步复用 join 的第 0/3/4 步", () => {
  test("第 3 步探活到武装监听 ⇒ 进第 4 步；全过 ⇒ ✅ 恢复完成，写明谁会被唤醒（pid）", async () => {
    mock = startRestMock();
    seedBinding();
    const logs: string[] = [];
    const record: string[][] = [];
    const code = await runRecover(opts(), deps(logs, {}, {}, record));
    const out = logs.join("\n");

    expect(code).toBe(0);
    for (const n of [1, 2, 3, 4]) expect(stepLine(logs, n)?.endsWith("✓")).toBe(true);
    expect(stepLine(logs, 3)).toContain("武装监听 party claude-channel，pid 5150）在接 @");
    // 第 3 步印的是 party claude 那条命令（展开含 dev-channels）。
    expect(out).toContain("运行：party claude dev");
    expect(out).toContain("--dangerously-load-development-channels");
    // 第 4 步（join 第 4 步的 verifyWake 注入点）以找回的身份验证。
    expect(stepLine(logs, 4)).toContain(STUB_WAKE_VERIFY_SUMMARY("agent"));
    expect(fixCount(logs)).toBe(0);
    const verdict = logs.find((l) => l.startsWith("✅"));
    expect(verdict).toContain("恢复完成");
    expect(verdict).toContain("@ agent");
    expect(verdict).toContain("pid 5150");
    expect(out).not.toContain("停在");
    // 第 2 步跑的是 join 的第 0 步：插件壳检查真的查了 claude（plugin list），且没多跑 update。
    expect(record.some((r) => r[0] === "claude" && r[1] === "plugin" && r[2] === "list")).toBe(true);
    expect(record.some((r) => r[0] === "claude" && r[1] === "plugin" && r[2] === "update")).toBe(false);
    // 不是接入：不写 rules、不报到、不注册 MCP。
    expect(existsSync(join(agentpartyHome(), "agents", "agentparty-agent-dev.rules.md"))).toBe(false);
    expect(mock.requests.some((r) => r.method === "POST" && r.path === "/api/channels/dev/messages")).toBe(false);
    expect(record.some((r) => r[1] === "mcp")).toBe(false);
  });

  test("第 2 步是 join 的第 0 步：插件旧版且 update 失败 ⇒ 停在第 2 步，修法是 plugin update、文案说重跑 party recover", async () => {
    mock = startRestMock();
    seedBinding();
    const logs: string[] = [];
    const code = await runRecover(opts(), deps(logs, {}, { installedPluginVersion: "0.2.203", failPluginUpdate: true }));
    const out = logs.join("\n");

    expect(code).toBe(1);
    expect(stepLine(logs, 1)?.endsWith("✓")).toBe(true);
    const step2 = stepLine(logs, 2);
    expect(step2).toContain("版本");
    expect(step2).toContain("plugin_version_mismatch");
    expect(step2?.endsWith("✗")).toBe(true);
    expect(fixLine(logs)).toBe("claude plugin update agentparty@agentparty");
    expect(out).toContain("修法（做完重跑同一条 party recover dev）：");
    expect(out).toContain("恢复停在第 2 步（版本）");
    expect(stepLine(logs, 3)).toBeUndefined();
  });

  test("第 4 步不过 ⇒ 停在第 4 步，修法是验证器给的那一条", async () => {
    mock = startRestMock();
    seedBinding();
    const logs: string[] = [];
    const code = await runRecover(
      opts(),
      deps(logs, { verifyWake: () => ({ ok: false, summary: "@agent ping → 30s 没回执（local_listener 没通）", fix: { do: "party doctor claude-plugin --channel dev" } }) }),
    );
    expect(code).toBe(1);
    expect(stepLine(logs, 4)?.endsWith("✗")).toBe(true);
    expect(fixLine(logs)).toBe("party doctor claude-plugin --channel dev");
    expect(logs.join("\n")).toContain("恢复停在第 4 步（真发一条 @ 验证）");
  });

  test("codex 档绑定：第 3 步走 join 的 codex 路（拉起唤醒层 + 探活），✅ 指向 serve 进程", async () => {
    mock = startRestMock();
    seedBinding({ harness: "codex" });
    const logs: string[] = [];
    const code = await runRecover(opts({ verbose: true }), deps(logs));
    const out = logs.join("\n");

    expect(code).toBe(0);
    expect(stepLine(logs, 1)).toContain("codex 档");
    expect(stepLine(logs, 3)).toContain("唤醒层进程在跑 pid 4242");
    expect(out).toContain("已拉起 party serve dev --runner codex（pid 4242）");
    expect(logs.find((l) => l.startsWith("✅"))).toContain("party serve dev --runner codex（pid 4242）");
  });

  test("codex 档唤醒层拉不起 ⇒ 停在第 3 步，修法 party serve --runner codex", async () => {
    mock = startRestMock();
    seedBinding({ harness: "codex" });
    const logs: string[] = [];
    const code = await runRecover(
      opts(),
      deps(logs, {
        startCodexWakeLayer: async () => ({ action: "start-failed", channel: "dev", detail: "spawn 失败" }),
        codexWakeLayerLive: async () => null,
      }),
    );
    expect(code).toBe(1);
    expect(stepLine(logs, 3)?.endsWith("✗")).toBe(true);
    expect(fixLine(logs)).toBe("party serve dev --runner codex");
  });

  test("other 档绑定：没有唤醒层，第 3/4 步只印说明，✅ 指向 party watch / serve", async () => {
    mock = startRestMock();
    seedBinding({ harness: "other" });
    const logs: string[] = [];
    const code = await runRecover(opts(), deps(logs));
    expect(code).toBe(0);
    expect(stepLine(logs, 3)).toContain("harness 是 other");
    expect(stepLine(logs, 4)).toContain("harness 是 other");
    expect(logs.find((l) => l.startsWith("✅"))).toContain("party watch dev");
  });

  test("--harness 指定档位：本目录只有 claude 绑定时 --harness codex ⇒ 没绑定，修法带 --harness codex", async () => {
    mock = startRestMock();
    seedBinding({ harness: "claude" });
    const logs: string[] = [];
    const code = await runRecover(opts({ harnessFlag: "codex" }), deps(logs));
    expect(code).toBe(1);
    expect(stepLine(logs, 1)).toContain("（codex 档）");
    expect(fixLine(logs)).toContain("--harness codex");
  });

  test("端到端：先 party join 接入，再 party recover 能找回 join 写的绑定并 ✅", async () => {
    mock = startRestMock();
    const joinLogs: string[] = [];
    const joinCode = await runJoin(baseJoinOpts(mock.url, { harnessFlag: "claude", yes: true }), joinDeps(tmp, [], {}, joinLogs));
    expect(joinCode).toBe(0);
    // join 记的 cwd 是 process.cwd()：recover 从同一目录跑。
    const logs: string[] = [];
    const code = await runRecover(opts(), deps(logs, { cwd: process.cwd() }));
    expect(code).toBe(0);
    expect(stepLine(logs, 1)).toContain("绑的是 agent（claude 档）");
    // 绑定指向 join 写的那份 config（补充行）。
    expect(logs.join("\n")).toContain(`config ${join(agentpartyHome(), "agents", "agentparty-bot-dev.json")}`);
    expect(logs.find((l) => l.startsWith("✅"))).toContain("恢复完成");
  });

  test("同一状态重跑两次输出逐行相同（幂等）", async () => {
    mock = startRestMock();
    seedBinding();
    const a: string[] = [];
    const b: string[] = [];
    expect(await runRecover(opts(), deps(a))).toBe(0);
    expect(await runRecover(opts(), deps(b))).toBe(0);
    expect(b).toEqual(a);
  });
});

describe("party recover —— 命令行", () => {
  test("--help 退出 0；没给频道 / 频道不合法 / 未知 flag 都退出 1", async () => {
    const errs: string[] = [];
    const origErr = console.error;
    const origLog = console.log;
    const outs: string[] = [];
    console.error = (l: unknown) => errs.push(String(l));
    console.log = (l: unknown) => outs.push(String(l));
    try {
      expect(await runRecoverCli(["--help"])).toBe(0);
      expect(outs.join("\n")).toContain("usage: party recover <channel>");
      expect(await runRecoverCli([])).toBe(1);
      expect(await runRecoverCli(["Bad_Slug"])).toBe(1);
      expect(await runRecoverCli(["dev", "--bogus"])).toBe(1);
      expect(await runRecoverCli(["dev", "--harness", "vim"])).toBe(1);
      expect(errs.some((l) => l.includes("--harness must be one of"))).toBe(true);
    } finally {
      console.error = origErr;
      console.log = origLog;
    }
  });

  test("顶层 help 列出 recover；party recover <chan> 在没绑定的机器上停在第 1 步", async () => {
    const outs: string[] = [];
    const origLog = console.log;
    console.log = (l: unknown) => outs.push(String(l));
    try {
      expect(await main(["--help"])).toBe(0);
      expect(outs.join("\n")).toMatch(/^\s+recover\s+<channel>/m);
      outs.length = 0;
      // 干净 HOME：没绑定 ⇒ 退出 1、修法 party join。绝不打网络（没绑定就没 server 可打）。
      expect(await main(["recover", "dev"])).toBe(1);
      const out = outs.join("\n");
      expect(out).toContain("第 1 步  找回身份");
      expect(out).toContain("party join");
    } finally {
      console.log = origLog;
    }
  });
});

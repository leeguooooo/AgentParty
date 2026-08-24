// party join 端到端（issue #944）——把 108 行接入包收进一条命令，跑完自检报「就绪 / 还差哪一步」。
//
// 反假绿纪律（本仓反复踩的坑）：每个失败用例都确保**只有被测的那道闸**决定结果，其余步骤全绿，
// 免得「另一个分支单独满足条件遮住闸」。收尾自检从**本地盘真实状态**重判，不信步骤返回码——
// 所以 checkin 真失败（服务端 500）、codex hook 真处于 disabled 时，自检必须如实报「还差」。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BEHAVIOR_CONTRACT_BODY_LINES } from "@agentparty/shared/onboarding";
import { runJoin, type JoinDeps, type JoinOptions } from "../src/commands/join";
import { run as initRun } from "../src/commands/init";
import { run as hookRun } from "../src/commands/hook";
import { run as sendRun } from "../src/commands/send";
import { buildWakeChecklist } from "../src/wake-checklist";
import { diagnoseCodexWake } from "../src/wake-diagnosis";
import { startRestMock, type RestMock } from "./rest-mock";

// 只读 .error / .status 的最小 spawnSync 桩。record 记下每次调用，便于断言 MCP 注册确实发生。
interface SpawnBehavior {
  noBinary?: boolean; // 二进制不存在（ENOENT）
  mcpAlreadyRegistered?: boolean; // mcp get 返回 0（已注册）
  failMcpAdd?: boolean; // mcp add 返回非 0
}
function fakeSpawn(record: string[][], behavior: SpawnBehavior = {}) {
  return ((cmd: string, args: readonly string[]) => {
    record.push([cmd, ...args]);
    const base = { pid: 0, output: [], stdout: "", stderr: "", signal: null } as Record<string, unknown>;
    if (behavior.noBinary) return { ...base, status: null, error: new Error("spawn ENOENT") };
    if (args[0] === "mcp" && args[1] === "get") {
      return { ...base, status: behavior.mcpAlreadyRegistered ? 0 : 1 };
    }
    if (args[0] === "mcp" && args[1] === "add") {
      return { ...base, status: behavior.failMcpAdd ? 1 : 0 };
    }
    return { ...base, status: 0 };
  }) as unknown as JoinDeps["spawn"];
}

let tmp: string;
let mock: RestMock;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["AGENTPARTY_HOME", "AGENTPARTY_CONFIG", "AGENTPARTY_TOKEN", "CODEX_HOME", "HOME"];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "party-join-"));
  process.env.HOME = tmp;
  process.env.AGENTPARTY_HOME = join(tmp, ".agentparty");
  process.env.CODEX_HOME = join(tmp, ".codex");
  delete process.env.AGENTPARTY_CONFIG;
  delete process.env.AGENTPARTY_TOKEN;
});
afterEach(() => {
  mock?.stop();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function deps(record: string[][], behavior: SpawnBehavior, logs: string[]): JoinDeps {
  return {
    spawn: fakeSpawn(record, behavior),
    initRun,
    hookRun,
    sendRun,
    log: (l) => logs.push(l),
    errlog: (l) => logs.push(l),
    home: tmp,
    // hook 步骤的 ok/fail 仍由 diagnoseCodexWake 读**真实盘状态**决定；只把「哪个 codex 带信任闸」
    // 的探测换成快桩，免得默认实现 spawn 真机上的 codex 二进制（慢且不确定）。
    codexWakeChecklist: () =>
      buildWakeChecklist(
        diagnoseCodexWake(),
        process.env,
        () => ({ onPath: null, candidates: [], gated: [], desktop: null }),
        () => null,
      ),
  };
}
function baseOpts(over: Partial<JoinOptions>): JoinOptions {
  return {
    server: mock.url,
    channel: "dev",
    agentName: "bot",
    harnessFlag: "claude",
    mention: "leo",
    yes: false,
    coexist: false,
    token: "ap_bot_secret",
    ...over,
  };
}

const configPath = () => join(tmp, ".agentparty", "agents", "agentparty-bot-dev.json");
const rulesPath = () => join(tmp, ".agentparty", "agents", "agentparty-bot-dev.rules.md");
const bindingsPath = () => join(tmp, ".agentparty", "join-bindings.json");

describe("party join —— 一条命令跑完整段接入（#944）", () => {
  test("claude 档 happy path：config / rules / 绑定 / MCP 注册 / 报到全部落地，自检报「全部就绪」", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const code = await runJoin(baseOpts({ harnessFlag: "claude" }), deps(record, {}, logs));
    const out = logs.join("\n");

    // 返回 0 且自检结论是「全部就绪」——用户看到的最后一句。
    expect(code).toBe(0);
    expect(out).toContain("全部就绪");
    expect(out).not.toContain("还差");

    // 1) config 落地：token（来自 AGENTPARTY_TOKEN，绝不进 argv）+ 服务端确认的身份都写进去了。
    expect(existsSync(configPath())).toBe(true);
    const cfg = JSON.parse(readFileSync(configPath(), "utf8")) as { token: string; identity?: { name: string } };
    expect(cfg.token).toBe("ap_bot_secret");
    expect(cfg.identity?.name).toBe("agent"); // mock /api/me 返回的身份

    // 2) rules 落地：正文逐字＝ shared 的行为契约常量（静态，绝不掺动态输入）。
    expect(existsSync(rulesPath())).toBe(true);
    expect(readFileSync(rulesPath(), "utf8")).toBe(`${BEHAVIOR_CONTRACT_BODY_LINES.join("\n")}\n`);

    // 3) 加入即绑定落地（#924）：harness=claude 传给 init，init 记下 (harness,server,channel,owner)→identity。
    expect(existsSync(bindingsPath())).toBe(true);
    const bindings = JSON.parse(readFileSync(bindingsPath(), "utf8")) as { bindings: { harness: string; channel: string }[] };
    expect(bindings.bindings.some((b) => b.harness === "claude" && b.channel === "dev")).toBe(true);

    // 4) MCP 注册落地（先探后加，#898）：claude mcp get 探到未注册 → claude mcp add 带 --identity。
    expect(record).toContainEqual(["claude", "mcp", "get", "party-bot"]);
    const add = record.find((r) => r[0] === "claude" && r[1] === "mcp" && r[2] === "add");
    expect(add).toBeDefined();
    expect(add).toContain("party-bot");
    expect(add).toContain("--identity");
    expect(add).toContain("dev");
    // token 绝不出现在任何 spawn 的 argv 里（#676）。
    expect(record.flat().some((a) => a.includes("ap_bot_secret"))).toBe(false);

    // 5) 报到落地（#597）：POST 到频道消息，且 @ 了邀请人。
    const checkin = mock.requests.find((r) => r.method === "POST" && r.path === "/api/channels/dev/messages");
    expect(checkin).toBeDefined();
    expect((checkin!.body as { mentions: string[] }).mentions).toContain("leo");

    // claude 档附带：crossSessionInbound=accept 写进 ~/.claude/settings.json（#844）。
    const settings = JSON.parse(readFileSync(join(tmp, ".claude", "settings.json"), "utf8")) as { crossSessionInbound: string };
    expect(settings.crossSessionInbound).toBe("accept");
  });

  test("失败可见：报到被服务端 500 打回时，自检如实报「还差」并给出可执行下一步，不是静默成功", async () => {
    // 只让 POST 消息（＝报到）失败，其余端点全 200——隔离「报到闸」，别让别的分支遮住它。
    mock = startRestMock((req) => {
      if (req.method === "POST" && /^\/api\/channels\/[^/]+\/messages$/.test(req.path)) {
        return Response.json({ error: { code: "boom", message: "boom" } }, { status: 500 });
      }
      return undefined;
    });
    const record: string[][] = [];
    const logs: string[] = [];
    const code = await runJoin(baseOpts({ harnessFlag: "claude" }), deps(record, {}, logs));
    const out = logs.join("\n");

    // config / 身份都成功（隔离），唯独报到失败 → 自检必须报「还差」，不能是「全部就绪」。
    expect(existsSync(configPath())).toBe(true);
    expect(code).toBe(1);
    expect(out).not.toContain("全部就绪");
    expect(out).toContain("还差");
    // 如实报出是哪一步、给一条可执行的下一步（#926 口径）。
    expect(out).toContain("报到");
    expect(out).toContain("party send");
    // 这类失败没有报错——自检必须明说，否则没人知道自己坏了。
    expect(out).toContain("别人只会以为你在忙");
  });

  test("codex 档 happy path：装 hook + codex mcp add，空 CODEX_HOME（无信任闸）下自检「全部就绪」", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const code = await runJoin(baseOpts({ harnessFlag: "codex" }), deps(record, {}, logs));
    const out = logs.join("\n");

    // codex hook 装进 CODEX_HOME/hooks.json（party hook install --codex 复用）。
    const hooksJson = join(tmp, ".codex", "hooks.json");
    expect(existsSync(hooksJson)).toBe(true);
    expect(readFileSync(hooksJson, "utf8")).toContain("codex-stop");

    // MCP 走 codex 二进制（不是 claude）。
    expect(record.some((r) => r[0] === "codex" && r[1] === "mcp" && r[2] === "add")).toBe(true);
    expect(record.some((r) => r[0] === "claude")).toBe(false);

    // 无 config.toml（老版本 codex / 无信任闸）→ hook 判 ok → 自检「全部就绪」。
    expect(code).toBe(0);
    expect(out).toContain("全部就绪");
  });

  test("失败可见（owner 场景）：codex hook 已装但信任闸 disabled、非交互不批准时，自检报「还差」hook 那一步", async () => {
    mock = startRestMock();
    const codexHome = join(tmp, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const hooksJson = join(codexHome, "hooks.json");
    // 预置我们那条 stop hook（命令含 "hook codex-stop"，classify 认得），位置 Stop[0].hooks[0]。
    writeFileSync(
      hooksJson,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "party hook codex-stop", timeout: 10 }] }] } }),
    );
    // 预置信任表：我们那条 enabled=false（带 trusted_hash）——codex 会静默跳过它。key 跟着 hooksPath 走。
    const key = `${hooksJson}:stop:0:0`;
    writeFileSync(codexHome + "/config.toml", `[hooks.state."${key}"]\ntrusted_hash = "deadbeef"\nenabled = false\n`);

    const record: string[][] = [];
    const logs: string[] = [];
    // hookRun 注入 no-op：模拟「非交互 / 用户没批准」——信任闸不被翻动，disabled 状态原样留在盘上。
    // 收尾自检读盘真实状态（diagnoseCodexWake），必须如实报「还差」hook 那一步，而不是静默成功。
    const d = deps(record, {}, logs);
    d.hookRun = async () => 0;
    const code = await runJoin(baseOpts({ harnessFlag: "codex", yes: false }), d);
    const out = logs.join("\n");

    // 隔离：config/身份/报到都成功，唯独 hook 信任那道闸不过。
    expect(existsSync(configPath())).toBe(true);
    expect(code).toBe(1);
    expect(out).not.toContain("全部就绪");
    expect(out).toContain("还差");
    // 自检明确点出是 hook 那一步（#926 措辞：未获批准的 hook 会被静默跳过）。
    expect(out).toContain("hook");
    // 红线：绝不建议绕过信任闸。
    expect(out).not.toContain("dangerously-bypass-hook-trust");
  });

  test("other 档（harness 探不出）：两侧 MCP 都试，且如实说「按 other 处理」", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const code = await runJoin(baseOpts({ harnessFlag: "other" }), deps(record, {}, logs));
    const out = logs.join("\n");
    expect(code).toBe(0);
    // other＝不知道是哪个 harness，claude 与 codex 两条 MCP 注册都尝试（“不知道就都覆盖”）。
    expect(record.some((r) => r[0] === "claude" && r[2] === "add")).toBe(true);
    expect(record.some((r) => r[0] === "codex" && r[2] === "add")).toBe(true);
    // other 档不装插件、不装 hook（不知道装哪个）。
    expect(record.some((r) => r[1] === "plugin")).toBe(false);
    expect(out).toContain("other");
  });

  test("token 只从 AGENTPARTY_TOKEN 读、只经环境变量往下游传，绝不进任何 argv/日志", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    await runJoin(baseOpts({ harnessFlag: "claude", token: "ap_secret_xyz" }), deps(record, {}, logs));
    // 任何 spawn argv、任何日志行都不得出现明文 token。
    expect(record.flat().some((a) => a.includes("ap_secret_xyz"))).toBe(false);
    expect(logs.some((l) => l.includes("ap_secret_xyz"))).toBe(false);
    // 但它确实经环境变量到了 init 手里——config 里落了这个 token。
    expect((JSON.parse(readFileSync(configPath(), "utf8")) as { token: string }).token).toBe("ap_secret_xyz");
  });
});

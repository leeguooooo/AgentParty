// party join 端到端（issue #944）——把 108 行接入包收进一条命令，跑完引导报「接入完成 / 停在第 N 步」。
//
// 反假绿纪律（本仓反复踩的坑）：每个失败用例都确保**只有被测的那道闸**决定结果，其余步骤全绿，
// 免得「另一个分支单独满足条件遮住闸」。每步从**本地盘真实状态**重判，不信步骤返回码——
// 所以 checkin 真失败（服务端 500）、codex hook 真处于 disabled 时，引导必须如实停在那一步。
//
// #988 起 join 是分步引导（第 0～4 步，onboarding/steps.ts）：不过就停在该步、恰一条修法。
// 输出形态相应变了（`第 N 步  标题 · 摘要 ✓/✗`、`修法（…）：` + 一行命令、`✅ 接入完成`），
// 断言按新形态等价改写；判据（哪一步过/不过、修法是哪条、退出码）一条没放宽。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BEHAVIOR_CONTRACT_BODY_LINES } from "@agentparty/shared/onboarding";
import { probeClaudeArmedListener, probeCodexWakeLayer, runJoin, type JoinDeps, type JoinOptions } from "../src/commands/join";
import { classifyListenerCommand } from "../src/claude-armed-listener";
import { healServerUrl } from "../src/validation";
import { RUNNING_VERSION } from "../src/upgrade";
import { codexAutoWakeAuth, codexAutoWakeMarkerPath, codexAutoWakeTarget, writeCodexAutoWakeMarker } from "../src/codex-auto-wake";
import { currentProcessStartedAt, instanceLockTarget } from "../src/instance-lock";
import { listCodexSessions, registerClaudeSession, registerCodexSession } from "../src/claude-session-registry";
import { startRestMock, type RestMock } from "./rest-mock";
import { PLUGIN, baseJoinOpts, fixLine, joinDeps, joinEnv, stepLine, type SpawnBehavior } from "./join-fixture";

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

function deps(record: string[][], behavior: SpawnBehavior, logs: string[]): JoinDeps {
  return joinDeps(tmp, record, behavior, logs);
}
/** 引导停下时给出的唯一修法命令（「修法（…）：」下面那一行）。 */
const nextActionLine = fixLine;
function baseOpts(over: Partial<JoinOptions>): JoinOptions {
  return baseJoinOpts(mock.url, over);
}

const configPath = () => join(tmp, ".agentparty", "agents", "agentparty-bot-dev.json");
const rulesPath = () => join(tmp, ".agentparty", "agents", "agentparty-bot-dev.rules.md");
const bindingsPath = () => join(tmp, ".agentparty", "join-bindings.json");

describe("party join —— 一条命令跑完整段接入（#944）", () => {
  test("claude 档 happy path：config / rules / 绑定 / MCP 注册 / 报到全部落地，引导报「✅ 接入完成」", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const code = await runJoin(baseOpts({ harnessFlag: "claude" }), deps(record, {}, logs));
    const out = logs.join("\n");

    // 返回 0 且结论是「✅ 接入完成」——用户看到的最后一句；没有任何一步停下。
    expect(code).toBe(0);
    expect(out).toContain("✅ 接入完成");
    expect(out).not.toContain("接入停在");

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

    // 插件已是当前版本：不跑 update，自检里插件那一步 ✓，结论不要求重开会话。
    expect(record.some((r) => r[0] === "claude" && r[1] === "plugin" && r[2] === "update")).toBe(false);
    expect(out).toContain("版本与 CLI 一致");
    expect(out).not.toContain("重开");

    // #979：✅ 句写明「就能被唤醒」指的是谁——本机那个 party claude 起的武装监听（pid），不是眼前这个会话。
    const verdict = logs.find((l) => l.startsWith("✅"));
    expect(verdict).toContain("pid 5150");
    expect(verdict).toContain("party claude-channel");
    // 第 3 步那一行 ✓，且摘要指向那个武装监听。
    const step3 = stepLine(logs, 3);
    expect(step3).toContain("武装监听 party claude-channel，pid 5150）在接 @");
    expect(step3?.endsWith("✓")).toBe(true);
  });

  // ★ #961 事故场景：本机插件 0.2.203、CLI 0.2.212。旧 join 只 install（回 already installed，不升级）
  //   就印 ✅，而 doctor 判 plugin_version_mismatch、SessionStart 唤醒根本没布上。
  test("#961：已装旧版插件时 join 会跑 plugin update，结论明说「要重开会话」而不是埋在 warn 里", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const code = await runJoin(baseOpts({ harnessFlag: "claude" }), deps(record, { installedPluginVersion: "0.2.203" }, logs));
    const out = logs.join("\n");

    // install 之后跟了 update（install 对已装的原地踏步）。
    const install = record.findIndex((r) => r[0] === "claude" && r[1] === "plugin" && r[2] === "install");
    const update = record.findIndex((r) => r[0] === "claude" && r[1] === "plugin" && r[2] === "update" && r[3] === PLUGIN);
    expect(install).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(install);
    // 更新到位 → 就绪，但**当前会话还挂着旧插件**——「重开」是结论句的一部分。
    expect(code).toBe(0);
    expect(stepLine(logs, 0)).toContain(`claude 插件 0.2.203 → 已更新到 ${RUNNING_VERSION}`);
    const verdict = logs.find((l) => l.startsWith("✅"));
    expect(verdict).toBeDefined();
    expect(verdict).toContain("重开");
    expect(verdict).toContain("当前这个会话还挂着旧插件");
  });

  test("#961：update 没成、插件仍是旧版 ⇒ 第 0 步报 plugin_version_mismatch 并停在那、不印 ✅，修法是 update 不是 install", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const code = await runJoin(
      baseOpts({ harnessFlag: "claude" }),
      deps(record, { installedPluginVersion: "0.2.203", failPluginUpdate: true }, logs),
    );
    const out = logs.join("\n");

    // #988：版本是第 0 步，不过就停在这——身份那步（写 config）根本不跑；修好重跑同一条 join 即可。
    expect(existsSync(configPath())).toBe(false);
    expect(stepLine(logs, 1)).toBeUndefined();
    expect(code).toBe(1);
    expect(out).not.toContain("✅");
    expect(out).toContain("plugin_version_mismatch");
    expect(out).toContain(`本机插件 0.2.203，CLI ${RUNNING_VERSION}`);
    // 唯一那条修法必须是 update：照旧教 install 等于原地踏步。
    expect(nextActionLine(logs)).toBe(`claude plugin update ${PLUGIN}`);
    // 做完要重开会话——写在修法旁边，不是埋在 warn 里。
    expect(out).toContain("重开一个 Claude 会话");
  });

  test("#961：没装过插件 → install 装上（不跑 update），结论同样明说要重开会话", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const code = await runJoin(baseOpts({ harnessFlag: "claude" }), deps(record, { installedPluginVersion: null }, logs));
    expect(code).toBe(0);
    expect(record.some((r) => r[0] === "claude" && r[2] === "install")).toBe(true);
    expect(record.some((r) => r[0] === "claude" && r[2] === "update")).toBe(false);
    const verdict = logs.find((l) => l.startsWith("✅"));
    expect(verdict).toContain("重开");
  });

  test("失败可见：报到被服务端 500 打回时，引导如实停在第 1 步并给出可执行下一步，不是静默成功", async () => {
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

    // config / 身份都成功（隔离），唯独报到失败 → 引导必须停在第 1 步，不能是「接入完成」。
    expect(existsSync(configPath())).toBe(true);
    expect(code).toBe(1);
    expect(out).not.toContain("✅");
    expect(out).toContain("接入停在第 1 步");
    expect(stepLine(logs, 2)).toBeUndefined();
    // 如实报出是哪一步、给一条可执行的下一步（#926 口径）。
    expect(stepLine(logs, 1)).toContain("报到失败");
    expect(nextActionLine(logs)).toContain("party send");
    // 这类失败没有报错——自检必须明说，否则没人知道自己坏了。
    expect(out).toContain("别人只会以为你在忙");
  });

  test("codex 档 happy path：装 hook + codex mcp add，空 CODEX_HOME（无信任闸）下引导「✅ 接入完成」", async () => {
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

    // 无 config.toml（老版本 codex / 无信任闸）→ hook 判 ok；唤醒层进程在（pid 4242）→ 「✅ 接入完成」。
    expect(code).toBe(0);
    expect(out).toContain("✅ 接入完成");
    expect(stepLine(logs, 3)).toContain("唤醒层进程在跑 pid 4242");
    expect(logs.find((l) => l.startsWith("✅"))).toContain("pid 4242");
  });

  // ★ #957 事故场景：四项静态前置条件全绿、唤醒层进程根本不在，旧 join 照印「就能被唤醒」，
  //   owner @ 了 25 分钟纹丝不动。
  test("#957：唤醒层拉不起来 ⇒ 结论是降级文案（Stop hook 兜底 / 新开会话），绝不说「就能被唤醒」", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const d = deps(record, {}, logs);
    d.startCodexWakeLayer = async () => ({
      action: "start-failed",
      channel: "dev",
      detail: "拉 `party serve dev --runner codex` 失败（spawn 没返回 pid）",
    });
    d.codexWakeLayerLive = async () => null;
    const code = await runJoin(baseOpts({ harnessFlag: "codex" }), d);
    const out = logs.join("\n");

    // 隔离：config / 身份 / hook / 报到全成，唯独唤醒层进程不在。
    expect(existsSync(configPath())).toBe(true);
    expect(code).toBe(1);
    expect(out).not.toContain("就能被唤醒");
    expect(out).not.toContain("✅");
    // 第 3 步那一行是 ✗，且带原因；停在这，第 4 步不跑。
    const step3 = stepLine(logs, 3);
    expect(step3).toContain("唤醒层没起来");
    expect(step3).toContain("spawn 没返回 pid");
    expect(step3?.endsWith("✗")).toBe(true);
    expect(stepLine(logs, 4)).toBeUndefined();
    // 降级文案：照实说此刻能被怎么叫到。
    expect(out).toContain("本会话只能在你下次发言、回合结束时收到 @");
    expect(out).toContain("新开一个 codex 会话");
    expect(out).toContain("party serve dev --runner codex");
  });

  test("#957：用户显式关了 auto-wake（skip: disabled）同样不印 ✅，原因照实带出来", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const d = deps(record, {}, logs);
    d.startCodexWakeLayer = async () => ({ action: "skip", reason: "disabled", detail: "codex auto-wake 被显式关掉了（默认是开的）" });
    d.codexWakeLayerLive = async () => null;
    const code = await runJoin(baseOpts({ harnessFlag: "codex" }), d);
    const out = logs.join("\n");
    expect(code).toBe(1);
    expect(out).not.toContain("就能被唤醒");
    expect(out).toContain("被显式关掉了");
    expect(out).toContain("本会话只能在你下次发言、回合结束时收到 @");
  });

  test("#957：已有唤醒层在跑（skip: already-serving）且探活得到 pid ⇒ 就绪，不再拉第二个", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const d = deps(record, {}, logs);
    d.startCodexWakeLayer = async () => ({ action: "skip", reason: "already-serving", detail: "#dev 上本身份已有 serve 在跑（pid 777）" });
    d.codexWakeLayerLive = async () => ({ pid: 777, source: "serve-lock" });
    const code = await runJoin(baseOpts({ harnessFlag: "codex" }), d);
    const out = logs.join("\n");
    expect(code).toBe(0);
    expect(out).toContain("已有唤醒层在跑");
    expect(out).toContain("pid 777");
    expect(out).toContain("✅ 接入完成");
  });

  test("#957：跑 join 的 codex 会话在注册表里挂到本频道（否则唤醒层宽限期一过就判无人使用退场）", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    // 预置：本会话 SessionStart 时绑的是别的频道、身份没解析出来——事故当天注册表里就是这样。
    const sessionId = "019f95e8-2c0b-7903-8779-cd102c5ecd4c";
    expect(registerCodexSession({
      session_id: sessionId,
      pid: process.pid,
      display_name: null,
      channel: "elsewhere",
      identity: null,
      server: null,
      cwd: process.cwd(),
    })).toBe(true);
    const d = deps(record, {}, logs);
    d.codexAncestorPid = () => process.pid;
    const code = await runJoin(baseOpts({ harnessFlag: "codex" }), d);
    expect(code).toBe(0);
    const entry = listCodexSessions().find((e) => e.session_id === sessionId);
    expect(entry).toBeDefined();
    expect(entry!.channel).toBe("dev");
    expect(entry!.identity).toBe("agent"); // mock /api/me 的身份
    expect(entry!.server).toBe(new URL(mock.url).origin);
    // 挂上了就不该再有「没入册」的警告。
    expect(logs.join("\n")).not.toContain("没入册");
  });

  test("#957：找不到本会话的注册表条目时不伪造，如实提示唤醒层会提前退场", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const d = deps(record, {}, logs);
    d.codexAncestorPid = () => process.pid; // 有 codex 进程，但注册表里没它
    const code = await runJoin(baseOpts({ harnessFlag: "codex" }), d);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("没入册");
    expect(listCodexSessions().length).toBe(0);
  });

  test("失败可见（owner 场景）：codex hook 已装但信任闸 disabled、非交互不批准时，引导停在第 2 步（hook）", async () => {
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
    expect(out).not.toContain("✅");
    expect(out).toContain("接入停在第 2 步");
    // 第 2 步那一行明确点出是 hook（#926 措辞：未获批准的 hook 会被静默跳过）；唤醒层那步不跑。
    expect(stepLine(logs, 2)).toContain("hook");
    expect(stepLine(logs, 3)).toBeUndefined();
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

  // 下面三条覆盖 SpawnBehavior 的三个分支。它们不是补覆盖率——这三条正是本切片声称
  // 「失败要能看见」的路径：桩写了却没人用，那个声称就没被验证过（CodeRabbit 逮到）。

  test("目标机器没装 claude CLI：第 0 步如实报 claude_unavailable 并停在那，不崩、不印 ✅", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const code = await runJoin(baseOpts({ harnessFlag: "claude" }), deps(record, { noBinary: true }, logs));
    const out = logs.join("\n");

    // #961：claude 档的唤醒层就是插件；claude 都不在 PATH 上，插件装没装、版本对不对一概核实不了——
    // 这时说「就能被唤醒」是拿前置条件顶替判据。第 0 步如实报 claude_unavailable，给一条修法。
    // #988：版本是第 0 步，停在这——身份那步（写 config / MCP 注册）不跑；装好 claude 重跑同一条 join。
    expect(code).toBe(1);
    expect(out).not.toContain("✅");
    expect(stepLine(logs, 0)).toContain("claude_unavailable");
    expect(stepLine(logs, 0)?.endsWith("✗")).toBe(true);
    expect(nextActionLine(logs)).toContain("PATH");
    expect(stepLine(logs, 1)).toBeUndefined();
    expect(existsSync(configPath())).toBe(false);
  });

  test("重复接入：mcp get 命中已注册 ⇒ 跳过 add，不再叠一个常驻进程（#898）", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const code = await runJoin(baseOpts({ harnessFlag: "claude" }), deps(record, { mcpAlreadyRegistered: true }, logs));

    expect(code).toBe(0);
    // 探到了（get 跑过），但**没有** add——每个注册在每个会话里都是一个常驻进程。
    expect(record.some((r) => r[0] === "claude" && r[2] === "get")).toBe(true);
    expect(record.some((r) => r[0] === "claude" && r[2] === "add")).toBe(false);
    expect(logs.join("\n")).toMatch(/(已注册|already)/i);
  });

  test("MCP 注册失败：如实报出来，不冒充成功", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const code = await runJoin(baseOpts({ harnessFlag: "claude" }), deps(record, { failMcpAdd: true }, logs));
    const out = logs.join("\n");

    // 确实尝试过 add（不是压根没跑）。
    expect(record.some((r) => r[0] === "claude" && r[2] === "add")).toBe(true);
    // 失败必须出现在输出里——静默吞掉正是本切片要根除的形态。
    expect(out).toMatch(/(失败|failed|warn)/i);
    // 仍是 best-effort：不因它把整段接入判死。
    expect(code).toBe(0);
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

// #957 的判据本身：wake_layer_live 来自**进程探活**（serve 实例锁 / 启动标记里的 pid 是否还活着），
// 不是 auto-wake 开关是不是 default-on。开关默认就是开的——按开关判永远是绿的，那正是事故。
describe("probeCodexWakeLayer —— 唤醒层进程探活（#957）", () => {
  const config = { server: "https://party.example.com", token: "agent-token" };
  const auth = () => codexAutoWakeAuth(config)!;
  let home: string;
  let lockDir: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "party-join-wake-home-"));
    lockDir = mkdtempSync(join(tmpdir(), "party-join-wake-locks-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  });
  /** 假时钟：每问一次前进 1s，waitMs=2s ⇒ 两轮就到期，sleep 不真睡。 */
  function clock() {
    let t = 1_000;
    return { now: () => (t += 1_000), sleep: async () => {}, waitMs: 2_000 };
  }

  test("什么都没有（开关默认开着也一样）→ null：没有进程就是没有唤醒层", async () => {
    expect(await probeCodexWakeLayer({ home, lockDir, config, channel: "dev", ...clock() })).toBeNull();
  });

  test("config 没有 agent token → null（人类账号会话没有唤醒层可言）", async () => {
    expect(await probeCodexWakeLayer({ home, lockDir, config: { server: config.server }, channel: "dev", ...clock() })).toBeNull();
  });

  test("serve 已持实例锁（进程活着）→ pid 来自锁，source=serve-lock", async () => {
    const target = instanceLockTarget(auth().server, auth().token, "dev");
    writeFileSync(join(lockDir, `serve-${target}.lock`), JSON.stringify({ pid: process.pid, id: "t", started_at: currentProcessStartedAt() }));
    expect(await probeCodexWakeLayer({ home, lockDir, config, channel: "dev", ...clock() })).toEqual({ pid: process.pid, source: "serve-lock" });
  });

  test("只有启动标记、进程活着 → 等到期后按标记算在（刚拉起、还在连服务端）", async () => {
    const marker = codexAutoWakeMarkerPath(home, codexAutoWakeTarget(auth(), "dev"));
    writeCodexAutoWakeMarker(marker, { pid: 31337, started_at: null, claimed_at: 0, channel: "dev" });
    const alive = (pid: number) => pid === 31337;
    expect(await probeCodexWakeLayer({ home, lockDir, config, channel: "dev", alive, ...clock() })).toEqual({ pid: 31337, source: "starting-marker" });
  });

  test("启动标记里的进程已经死了 → null：spawn 成功过不算数，此刻不在就是不在", async () => {
    const marker = codexAutoWakeMarkerPath(home, codexAutoWakeTarget(auth(), "dev"));
    writeCodexAutoWakeMarker(marker, { pid: 31337, started_at: null, claimed_at: 0, channel: "dev" });
    const alive = () => false;
    expect(await probeCodexWakeLayer({ home, lockDir, config, channel: "dev", alive, ...clock() })).toBeNull();
  });

  test("标记只占了位、还没回填 pid → 等到期仍没进程就 null（占位不是进程）", async () => {
    const marker = codexAutoWakeMarkerPath(home, codexAutoWakeTarget(auth(), "dev"));
    const c = clock();
    writeCodexAutoWakeMarker(marker, { pid: null, started_at: null, claimed_at: 2_000, channel: "dev" });
    expect(await probeCodexWakeLayer({ home, lockDir, config, channel: "dev", alive: () => true, ...c })).toBeNull();
  });
});

// ★ #979 事故场景：piggo 机上 14 个 `party claude-channel --require-launch-opt-in` 全是蛰伏档（普通 claude
//   起的，#615 local-only），插件装好、版本一致、报到成功——旧 join 照印「✅ 就能被唤醒」，@ 了 5 分钟 0 pong。
//   判据必须是「本机有没有会接 @ 的进程」：serve 锁的活持有者，不是插件状态、不是 opt-in 开关。
describe("party join claude 档 —— 武装监听闸（#979）", () => {
  /** 用真锁目录跑真探活（不注入 lockHolder），只把 ps 换成桩；注册表走 AGENTPARTY_HOME 下的真目录。 */
  function realProbe(lockDir: string, commandOf: (pid: number) => string | null): JoinDeps["claudeArmedListener"] {
    return () => {
      // 与生产同一来源：AGENTPARTY_CONFIG 已由 runJoin 指向 join 刚写的 config。
      const raw = JSON.parse(readFileSync(configPath(), "utf8")) as { server: string; token: string; identity?: { name: string } };
      return probeClaudeArmedListener({ lockDir, config: raw, channel: "dev", commandOf });
    };
  }
  /** 预置一个普通 claude 会话（SessionStart 入册的形态）：pid 是本进程，所以「活着」。 */
  function registerDormantSession(sessionId: string, server: string): void {
    expect(registerClaudeSession({
      session_id: sessionId,
      pid: process.pid,
      display_name: null,
      channel: "dev",
      identity: "agent", // mock /api/me 的身份
      server,
      cwd: process.cwd(),
    })).toBe(true);
  }
  function lockFileFor(lockDir: string, server: string, token: string): string {
    return join(lockDir, `serve-${instanceLockTarget(healServerUrl(server)!, token, "dev")}.lock`);
  }

  test("只有蛰伏档 claude-channel 进程 ⇒ 不印 ✅、不说「就能被唤醒」，两条命令原样印出，并说清本机 N 个会话全是蛰伏档", async () => {
    mock = startRestMock();
    const lockDir = mkdtempSync(join(tmpdir(), "party-join-claude-locks-"));
    registerDormantSession("019f95e8-2c0b-7903-8779-cd102c5ecd4d", mock.url);
    const record: string[][] = [];
    const logs: string[] = [];
    const d = deps(record, {}, logs);
    // 真探活：锁目录是空的（蛰伏档从不抢 serve 锁）；ps 桩不该被问到（没有持有者）。
    d.claudeArmedListener = realProbe(lockDir, () => "party claude-channel --require-launch-opt-in");
    const code = await runJoin(baseOpts({ harnessFlag: "claude" }), d);
    const out = logs.join("\n");
    rmSync(lockDir, { recursive: true, force: true });

    // 隔离：config / 身份 / 插件（同版）/ 报到全成，唯独没有武装监听——事故当天就是这个形态。
    expect(existsSync(configPath())).toBe(true);
    expect(out).toContain("版本与 CLI 一致");
    expect(code).toBe(1);
    expect(out).not.toContain("就能被唤醒");
    expect(out).not.toContain("接入完成");
    expect(out).not.toContain("✅");
    // 第 3 步那一行是 ✗，停在这（第 4 步不跑）。
    const step3 = stepLine(logs, 3);
    expect(step3).toContain("本机没有会接 @ 的 Claude 会话");
    expect(step3?.endsWith("✗")).toBe(true);
    expect(stepLine(logs, 4)).toBeUndefined();
    // 唯一那条修法就是 party claude dev。
    expect(nextActionLine(logs)).toBe("party claude dev");
    // 降级文案：身份已绑、为什么叫不醒、两条命令**原样**印出。
    expect(out).toContain("已绑定身份 agent，但这台机现在没有会接 @ 的 Claude 会话");
    expect(out).toContain("local-only");
    expect(out).toContain("party claude dev");
    expect(out).toContain("party serve dev --runner claude");
    // 本机那个普通 claude 会话被数出来了，且说明它是蛰伏档。
    expect(out).toContain("1 个 claude 会话全是蛰伏档");
    // 这类失败没有报错——必须明说。
    expect(out).toContain("别人只会以为你在忙");
  });

  test("有 party claude 起的武装进程（持 serve 锁的 claude-channel）⇒ ✅ 且指出 pid 与起法", async () => {
    mock = startRestMock();
    const lockDir = mkdtempSync(join(tmpdir(), "party-join-claude-locks-"));
    const record: string[][] = [];
    const logs: string[] = [];
    const d = deps(record, {}, logs);
    const asked: number[] = [];
    d.claudeArmedListener = () => {
      // 锁由「本进程」持有（pid + 出生时间都对得上）——这就是 party claude 起的 claude-channel 的形态。
      const raw = JSON.parse(readFileSync(configPath(), "utf8")) as { server: string; token: string };
      writeFileSync(lockFileFor(lockDir, raw.server, raw.token), JSON.stringify({ pid: process.pid, id: "t", started_at: currentProcessStartedAt() }));
      return realProbe(lockDir, (pid) => {
        asked.push(pid);
        return "party claude-channel --channel dev";
      })();
    };
    const code = await runJoin(baseOpts({ harnessFlag: "claude" }), d);
    const out = logs.join("\n");
    rmSync(lockDir, { recursive: true, force: true });

    expect(code).toBe(0);
    expect(asked).toEqual([process.pid]);
    const verdict = logs.find((l) => l.startsWith("✅"));
    expect(verdict).toBeDefined();
    expect(verdict).toContain("就能被唤醒");
    expect(verdict).toContain(`pid ${process.pid}`);
    expect(verdict).toContain("party claude-channel");
    const step3 = stepLine(logs, 3);
    expect(step3).toContain(`pid ${process.pid}）在接 @`);
    expect(step3?.endsWith("✓")).toBe(true);
    expect(out).toContain(`由 party claude / party bridge claude 起的 Claude 会话（武装监听 party claude-channel，pid ${process.pid}）`);
    expect(out).not.toContain("蛰伏档（普通 claude 起的，不接频道消息）");
  });

  test("有 serve 锁（party serve --runner claude 常驻）⇒ ✅ 且写明是 serve", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const d = deps(record, {}, logs);
    d.claudeArmedListener = () => ({ live: { pid: 777, launch: "serve" }, sessions: 0 });
    const code = await runJoin(baseOpts({ harnessFlag: "claude" }), d);
    expect(code).toBe(0);
    const verdict = logs.find((l) => l.startsWith("✅"));
    expect(verdict).toContain("party serve dev --runner claude（pid 777）");
    expect(verdict).toContain("就能被唤醒");
  });

  test("锁持有者认不出起法 ⇒ 仍算武装监听（进程事实优先），只是描述退回「持锁进程 pid」", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const d = deps(record, {}, logs);
    d.claudeArmedListener = () => ({ live: { pid: 888, launch: "unknown" }, sessions: 2 });
    const code = await runJoin(baseOpts({ harnessFlag: "claude" }), d);
    expect(code).toBe(0);
    expect(logs.find((l) => l.startsWith("✅"))).toContain("持有 #dev 监听锁的进程（pid 888）");
  });

  test("探活本身抛异常 ⇒ 按「没有武装监听」处理（绝不因探不到就假定有），结论是降级文案", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const d = deps(record, {}, logs);
    d.claudeArmedListener = () => {
      throw new Error("ps exploded");
    };
    const code = await runJoin(baseOpts({ harnessFlag: "claude" }), d);
    const out = logs.join("\n");
    expect(code).toBe(1);
    expect(out).not.toContain("✅");
    expect(out).toContain("party claude dev");
  });

  test("插件旧版且 update 失败 + 无武装监听 ⇒ 唯一修法是 plugin update（版本是第 0 步，停在那；监听那步根本不跑）", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const d = deps(record, { installedPluginVersion: "0.2.203", failPluginUpdate: true }, logs);
    let listenerAsked = false;
    d.claudeArmedListener = () => {
      listenerAsked = true;
      return { live: null, sessions: 0 };
    };
    const code = await runJoin(baseOpts({ harnessFlag: "claude" }), d);
    const out = logs.join("\n");
    expect(code).toBe(1);
    expect(nextActionLine(logs)).toBe(`claude plugin update ${PLUGIN}`);
    // 停在第 0 步：监听那步不跑、不探活、不给第二条修法（前面没过它的修法没意义）。
    expect(listenerAsked).toBe(false);
    expect(stepLine(logs, 3)).toBeUndefined();
    expect(out).not.toContain("party claude dev");
  });

  test("#961 重开文案（#979 修订）：重开要用 party claude 起，不是裸 claude", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const code = await runJoin(baseOpts({ harnessFlag: "claude" }), deps(record, { installedPluginVersion: "0.2.203" }, logs));
    expect(code).toBe(0);
    const verdict = logs.find((l) => l.startsWith("✅"));
    expect(verdict).toContain("用 party claude dev 新开一个 Claude 会话");
  });

  test("codex 档不受影响：不查 claude 武装监听、不印 claude 的降级文案", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const logs: string[] = [];
    const d = deps(record, {}, logs);
    let asked = false;
    d.claudeArmedListener = () => {
      asked = true;
      return { live: null, sessions: 0 };
    };
    const code = await runJoin(baseOpts({ harnessFlag: "codex" }), d);
    expect(code).toBe(0);
    expect(asked).toBe(false);
    expect(logs.join("\n")).not.toContain("武装监听");
  });
});

// #979 的判据本身：armed_listener_live 来自 serve 锁的**活持有者**（pid + 出生时间），不是插件状态、
// 不是 AGENTPARTY_CLAUDE_CHANNEL_OPT_IN 开关。蛰伏档从不抢锁，所以「只有蛰伏档」⇒ 锁目录为空 ⇒ null。
describe("probeClaudeArmedListener —— 武装监听探活（#979）", () => {
  const config = { server: "https://party.example.com", token: "agent-token", identity: { name: "server" } };
  const target = () => instanceLockTarget(config.server, config.token, "dev");
  let lockDir: string;
  beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), "party-join-claude-locks-"));
  });
  afterEach(() => {
    rmSync(lockDir, { recursive: true, force: true });
  });
  const dormantEntry = (id: string, identity = "server") => ({
    version: 1 as const,
    session_id: id,
    pid: process.pid,
    display_name: null,
    channel: "dev",
    server: "https://party.example.com",
    identity,
    cwd: process.cwd(),
    registered_at: 1,
    harness: "claude" as const,
  });

  test("没有锁（只有蛰伏档入册）→ live=null，蛰伏会话按 (channel, server, identity) 数出来", () => {
    const sessions = () => [
      dormantEntry("019f95e8-2c0b-7903-8779-cd102c5ecd41"),
      dormantEntry("019f95e8-2c0b-7903-8779-cd102c5ecd42"),
      dormantEntry("019f95e8-2c0b-7903-8779-cd102c5ecd43", "someone-else"), // 别的身份不算
      { ...dormantEntry("019f95e8-2c0b-7903-8779-cd102c5ecd44"), channel: "other" }, // 别的频道不算
    ];
    const asked: number[] = [];
    const r = probeClaudeArmedListener({ lockDir, config, channel: "dev", sessions, commandOf: (pid) => (asked.push(pid), null) });
    expect(r).toEqual({ live: null, sessions: 2 });
    expect(asked).toEqual([]); // 没有持有者就不问 ps
  });

  test("serve 锁被活进程持有 → live=pid，起法由命令行认出（claude-channel）", () => {
    writeFileSync(join(lockDir, `serve-${target()}.lock`), JSON.stringify({ pid: process.pid, id: "t", started_at: currentProcessStartedAt() }));
    const r = probeClaudeArmedListener({
      lockDir,
      config,
      channel: "dev",
      sessions: () => [dormantEntry("019f95e8-2c0b-7903-8779-cd102c5ecd41")],
      commandOf: (pid) => (pid === process.pid ? "party claude-channel --channel dev" : null),
    });
    expect(r).toEqual({ live: { pid: process.pid, launch: "claude-channel" }, sessions: 1 });
  });

  test("serve 锁被活进程持有、命令行是 serve → launch=serve", () => {
    writeFileSync(join(lockDir, `serve-${target()}.lock`), JSON.stringify({ pid: process.pid, id: "t", started_at: currentProcessStartedAt() }));
    const r = probeClaudeArmedListener({ lockDir, config, channel: "dev", sessions: () => [], commandOf: () => "party serve dev --runner claude" });
    expect(r.live).toEqual({ pid: process.pid, launch: "serve" });
  });

  test("锁文件在、持有者进程已死 → null：锁文件不是进程", () => {
    // 出生时间对不上 ⇒ instanceLockHolderPid 判「不是原持有者」（PID 复用防线），等价于死了。
    writeFileSync(join(lockDir, `serve-${target()}.lock`), JSON.stringify({ pid: process.pid, id: "t", started_at: currentProcessStartedAt() - 3_600_000 }));
    const r = probeClaudeArmedListener({ lockDir, config, channel: "dev", sessions: () => [], commandOf: () => "party claude-channel" });
    expect(r.live).toBeNull();
  });

  test("config 没有 token（人类账号 / 没绑）→ null，不去碰锁", () => {
    writeFileSync(join(lockDir, `serve-${target()}.lock`), JSON.stringify({ pid: process.pid, id: "t", started_at: currentProcessStartedAt() }));
    const r = probeClaudeArmedListener({ lockDir, config: { server: config.server }, channel: "dev", sessions: () => [] });
    expect(r.live).toBeNull();
  });

  test("锁属于另一个身份/实例（token 不同）→ 不算本身份的监听", () => {
    writeFileSync(join(lockDir, `serve-${instanceLockTarget(config.server, "other-token", "dev")}.lock`), JSON.stringify({ pid: process.pid, id: "t", started_at: currentProcessStartedAt() }));
    const r = probeClaudeArmedListener({ lockDir, config, channel: "dev", sessions: () => [], commandOf: () => "party claude-channel" });
    expect(r.live).toBeNull();
  });

  test("classifyListenerCommand：只认 claude-channel / serve 两个子命令名，其余 unknown", () => {
    expect(classifyListenerCommand("/usr/local/bin/party claude-channel --channel dev")).toBe("claude-channel");
    expect(classifyListenerCommand("bun /x/cli/src/index.ts serve dev --runner claude")).toBe("serve");
    expect(classifyListenerCommand("node something-else")).toBe("unknown");
    expect(classifyListenerCommand(null)).toBe("unknown");
  });
});

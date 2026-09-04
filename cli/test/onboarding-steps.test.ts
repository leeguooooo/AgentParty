// 接入引导步骤机（issue #988，epic #987）。
//
// 两层：
//  1. onboarding/steps.ts 的机器本身——顺序跑、不过就停、恰一条修法、异常算不过、输出形态。
//  2. party join 装配出来的第 0～4 步——每一步失败都停在该步且只印一条修法；--yes 无 TTY 全流程；
//     全部过 ⇒ ✅ 且写明 pid / 起法；同一状态重跑输出相同（幂等）。
//
// 变异自检（写这份测试时做过）：把 runSteps 的「不过就 return」删掉让它继续跑 ⇒ 下面
// 「停在该步」「只印一条修法」「后续步骤不跑」全红。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatStep, runSteps, type Step, type StepResult } from "../src/onboarding/steps";
import { roundTripWakeVerifier, runJoin } from "../src/commands/join";
import type { VerifyWakeDeps } from "../src/onboarding/verify-wake";
import type { ClaudeArmedListenerProbe } from "../src/claude-armed-listener";
import type { WakeTestFrame } from "../src/commands/wake";
import { RUNNING_VERSION } from "../src/upgrade";
import { startRestMock, type RestMock } from "./rest-mock";
import { PLUGIN, STUB_WAKE_VERIFY_SUMMARY, baseJoinOpts, fixCount, fixLine, joinDeps, joinEnv, stepLine } from "./join-fixture";

// ── 1. 机器本身 ───────────────────────────────────────────────────────────────

describe("runSteps —— 顺序跑、不过就停、恰一条修法", () => {
  const ok = (id: string, summary = `${id} 过了`): Step<string[]> => ({
    id,
    title: id,
    run(ran) {
      ran.push(id);
      return { ok: true, summary };
    },
  });
  const bad = (id: string, fix?: StepResult["fix"]): Step<string[]> => ({
    id,
    title: id,
    run(ran) {
      ran.push(id);
      return { ok: false, summary: `${id} 没过`, fix };
    },
  });

  test("全部过 ⇒ ok，每步一行「第 N 步  标题 · 摘要 ✓」，从第 0 步数起，没有修法", async () => {
    const ran: string[] = [];
    const logs: string[] = [];
    const out = await runSteps({ steps: [ok("版本"), ok("身份")], ctx: ran, log: (l) => logs.push(l) });
    expect(out.ok).toBe(true);
    expect(ran).toEqual(["版本", "身份"]);
    expect(logs).toEqual(["第 0 步  版本 · 版本 过了 ✓", "第 1 步  身份 · 身份 过了 ✓"]);
  });

  test("中间一步不过 ⇒ 停在该步：后面的步骤不跑、只印一条修法、stoppedAt 指向它", async () => {
    const ran: string[] = [];
    const logs: string[] = [];
    const out = await runSteps({
      steps: [ok("版本"), bad("身份", { do: "party send hi --channel dev", notes: ["先知道这个"] }), ok("接收方式"), bad("验证")],
      ctx: ran,
      log: (l) => logs.push(l),
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.stoppedAt.index).toBe(1);
    expect(out.stoppedAt.id).toBe("身份");
    // 后面的步骤一个都没跑——不是「跑了但没印」。
    expect(ran).toEqual(["版本", "身份"]);
    expect(stepLine(logs, 2)).toBeUndefined();
    expect(stepLine(logs, 3)).toBeUndefined();
    // 恰一条修法：notes 在前、修法标记、命令一行。
    expect(fixCount(logs)).toBe(1);
    expect(fixLine(logs)).toBe("party send hi --channel dev");
    expect(logs).toEqual([
      "第 0 步  版本 · 版本 过了 ✓",
      "第 1 步  身份 · 身份 没过 ✗",
      "         先知道这个",
      "         修法（做完重跑同一条 party join）：",
      "           party send hi --channel dev",
    ]);
  });

  test("不过但没给修法 ⇒ 修法退回「重跑」那条命令（rerun 可配）", async () => {
    const logs: string[] = [];
    const out = await runSteps({ steps: [bad("身份")], ctx: [], log: (l) => logs.push(l), rerun: "party recover dev" });
    expect(out.ok).toBe(false);
    expect(fixCount(logs)).toBe(1);
    expect(fixLine(logs)).toBe("party recover dev");
    expect(logs.some((l) => l.includes("重跑同一条 party recover dev"))).toBe(true);
  });

  test("run 抛异常 ⇒ 按不过处理并停（绝不因探活炸了就假定过了）", async () => {
    const ran: string[] = [];
    const logs: string[] = [];
    const boom: Step<string[]> = {
      id: "探活",
      title: "探活",
      run() {
        throw new Error("ps exploded");
      },
    };
    const out = await runSteps({ steps: [boom, ok("验证")], ctx: ran, log: (l) => logs.push(l) });
    expect(out.ok).toBe(false);
    expect(ran).toEqual([]);
    expect(stepLine(logs, 0)).toContain("ps exploded");
    expect(stepLine(logs, 0)?.endsWith("✗")).toBe(true);
    expect(stepLine(logs, 1)).toBeUndefined();
  });

  test("firstIndex 可配（recover 之类从第 1 步数起）；detail 行缩进印在步骤行下方，过/不过都印", () => {
    const lines = formatStep(3, "起一个可唤醒的会话", { ok: true, summary: "武装监听 pid 41233", detail: ["运行：party claude ludo"] }, "party join");
    expect(lines).toEqual(["第 3 步  起一个可唤醒的会话 · 武装监听 pid 41233 ✓", "         运行：party claude ludo"]);
    const failed = formatStep(3, "起一个可唤醒的会话", { ok: false, summary: "没监听", detail: ["运行：party claude ludo"], fix: { do: "party claude ludo" } }, "party join");
    expect(failed[1]).toBe("         运行：party claude ludo");
    expect(failed.filter((l) => l.includes("修法（")).length).toBe(1);
  });
});

// ── 2. party join 装配出来的五步 ───────────────────────────────────────────────

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
const configPath = () => join(tmp, ".agentparty", "agents", "agentparty-bot-dev.json");
const opts = (over: Parameters<typeof baseJoinOpts>[1] = {}) => baseJoinOpts(mock.url, over);

/** 停在第 n 步的通用断言：退出码 1、无 ✅、第 n 步 ✗、第 n+1 步没印、恰一条修法、收尾提示。 */
function expectStoppedAt(code: number, logs: string[], n: number): void {
  const out = logs.join("\n");
  expect(code).toBe(1);
  expect(out).not.toContain("✅");
  expect(stepLine(logs, n)?.endsWith("✗")).toBe(true);
  expect(stepLine(logs, n + 1)).toBeUndefined();
  expect(fixCount(logs)).toBe(1);
  expect(out).toContain(`接入停在第 ${n} 步`);
  expect(out).toContain("别人只会以为你在忙");
}

describe("party join 引导 —— 每一步失败都停在该步、只印一条修法（#988）", () => {
  test("第 0 步 版本：插件旧版且 update 失败 ⇒ 停在第 0 步，修法是 plugin update，身份那步不跑（config 不写）", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const code = await runJoin(opts({ yes: true }), joinDeps(tmp, [], { installedPluginVersion: "0.2.203", failPluginUpdate: true }, logs));
    expectStoppedAt(code, logs, 0);
    expect(stepLine(logs, 0)).toContain("plugin_version_mismatch");
    expect(fixLine(logs)).toBe(`claude plugin update ${PLUGIN}`);
    expect(existsSync(configPath())).toBe(false);
    expect(mock.requests.some((r) => r.method === "POST")).toBe(false);
  });

  test("第 1 步 身份：服务端不认 token（/api/me 401，身份解析不出）⇒ 停在第 1 步，修法指向 token / server，后面不跑", async () => {
    mock = startRestMock((req) => (req.path === "/api/me" ? Response.json({ error: { code: "unauthorized", message: "bad token" } }, { status: 401 }) : undefined));
    const logs: string[] = [];
    const chosen: string[] = [];
    const d = joinDeps(tmp, [], {}, logs);
    d.chooseReceiveMode = async () => {
      chosen.push("asked");
      return "interactive";
    };
    const code = await runJoin(opts(), d);
    expectStoppedAt(code, logs, 1);
    expect(stepLine(logs, 1)).toContain("服务端没确认身份");
    expect(fixLine(logs)).toContain("AGENTPARTY_TOKEN");
    expect(chosen).toEqual([]); // 第 2 步没跑到，也就没问
    // 身份没确认就不报到——别往频道里发一条无名的 👋。
    expect(mock.requests.some((r) => r.method === "POST" && /\/messages$/.test(r.path))).toBe(false);
  });

  // pr_agent on #998：TTY 下 Ctrl+C / 关闭输入不能被当成「无 TTY 按默认」继续往下跑——那是用户要停。
  test("第 2 步 接收方式：用户取消（Ctrl+C / 输入关闭）⇒ 停在第 2 步，不替人选，第 3 步不跑", async () => {
    mock = startRestMock(() => undefined);
    const logs: string[] = [];
    const d = joinDeps(tmp, [], {}, logs);
    let probed = 0;
    d.chooseReceiveMode = async () => "cancelled";
    const origProbe = d.claudeArmedListener;
    d.claudeArmedListener = () => {
      probed += 1;
      return origProbe();
    };
    const code = await runJoin(opts(), d);
    expectStoppedAt(code, logs, 2);
    expect({ probed, cancelled: stepLine(logs, 2)?.includes("已取消") ?? false, fix: fixLine(logs) ?? "" }).toEqual({
      probed: 0,
      cancelled: true,
      fix: expect.stringContaining("--yes"),
    });
  });

  test("第 1 步 身份：报到 500 ⇒ 停在第 1 步，修法是 party send", async () => {
    mock = startRestMock((req) => {
      if (req.method === "POST" && /^\/api\/channels\/[^/]+\/messages$/.test(req.path)) {
        return Response.json({ error: { code: "boom", message: "boom" } }, { status: 500 });
      }
      return undefined;
    });
    const logs: string[] = [];
    const code = await runJoin(opts({ yes: true }), joinDeps(tmp, [], {}, logs));
    expectStoppedAt(code, logs, 1);
    expect(fixLine(logs)).toBe('party send "👋 bot 报到" --channel dev');
  });

  test("第 2 步 接收方式（codex）：hook 信任闸 disabled ⇒ 停在第 2 步，唤醒层那步不拉起", async () => {
    mock = startRestMock();
    const codexHome = join(tmp, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const hooksJson = join(codexHome, "hooks.json");
    writeFileSync(hooksJson, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "party hook codex-stop", timeout: 10 }] }] } }));
    writeFileSync(`${codexHome}/config.toml`, `[hooks.state."${hooksJson}:stop:0:0"]\ntrusted_hash = "deadbeef"\nenabled = false\n`);
    const logs: string[] = [];
    const d = joinDeps(tmp, [], {}, logs);
    d.hookRun = async () => 0; // 非交互、没批准：信任状态原样留在盘上
    let started = false;
    d.startCodexWakeLayer = async () => {
      started = true;
      return { action: "start", channel: "dev", cwd: process.cwd(), args: [] };
    };
    const code = await runJoin(opts({ harnessFlag: "codex" }), d);
    expectStoppedAt(code, logs, 2);
    expect(stepLine(logs, 2)).toContain("Stop hook 没到位");
    expect(started).toBe(false);
    expect(logs.join("\n")).not.toContain("dangerously-bypass-hook-trust");
  });

  test("第 3 步 起会话（claude）：只有蛰伏档 ⇒ 停在第 3 步，修法就是那条 party claude dev，第 4 步不跑", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const d = joinDeps(tmp, [], {}, logs);
    d.claudeArmedListener = () => ({ live: null, sessions: 2 });
    let verified = false;
    d.verifyWake = () => {
      verified = true;
      return { ok: true, summary: "不该跑到" };
    };
    const code = await runJoin(opts({ yes: true }), d);
    expectStoppedAt(code, logs, 3);
    expect(stepLine(logs, 3)).toContain("2 个 claude 会话全是蛰伏档");
    expect(fixLine(logs)).toBe("party claude dev");
    expect(verified).toBe(false);
    // 要跑的命令印全了：party claude 展开成 claudeLaunchPlan 的最终 argv（#995：dev-channels flag）。
    expect(logs.join("\n")).toContain("展开：AGENTPARTY_CHANNEL=dev claude --dangerously-load-development-channels plugin:agentparty@agentparty");
  });

  test("第 3 步 起会话（codex）：唤醒层拉不起 ⇒ 停在第 3 步，修法是 party serve dev --runner codex", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const d = joinDeps(tmp, [], {}, logs);
    d.startCodexWakeLayer = async () => ({ action: "start-failed", channel: "dev", detail: "spawn 没返回 pid" });
    d.codexWakeLayerLive = async () => null;
    const code = await runJoin(opts({ harnessFlag: "codex", yes: true }), d);
    expectStoppedAt(code, logs, 3);
    expect(fixLine(logs)).toBe("party serve dev --runner codex");
  });

  test("第 4 步 验证：注入的往返验证不过 ⇒ 停在第 4 步，用它给的修法，不印 ✅", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const d = joinDeps(tmp, [], {}, logs);
    const seen: unknown[] = [];
    d.verifyWake = (input) => {
      seen.push(input);
      return { ok: false, summary: "@agent ping → 10s 没回执（插件层没通）", fix: { do: "party wake check dev" } };
    };
    const code = await runJoin(opts({ yes: true }), d);
    expectStoppedAt(code, logs, 4);
    expect(fixLine(logs)).toBe("party wake check dev");
    // 第 4 步拿到的是第 3 步探到的那个进程（#990 按它判「谁收到了」）。
    expect(seen).toEqual([{
      channel: "dev",
      identity: "agent",
      harness: "claude",
      listener: { pid: 5150, description: "由 party claude / party bridge claude 起的 Claude 会话（武装监听 party claude-channel，pid 5150）" },
    }]);
  });
});

describe("party join 引导 —— --yes 无 TTY 全流程（#988）", () => {
  test("claude 档：五步逐行打印、不交互、✅ 写明 pid 与起法；第 4 步标明真实往返随 #990 接入", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const d = joinDeps(tmp, [], {}, logs);
    let asked = false;
    d.chooseReceiveMode = async () => {
      asked = true;
      return "serve";
    };
    d.claudeDefaultArgs = () => ({ args: ["--dangerously-skip-permissions"], source: "config", origin: "/x/claude-default-args.json" });
    const code = await runJoin(opts({ yes: true }), d);
    const out = logs.join("\n");
    expect(code).toBe(0);
    // --yes：压根不问。
    expect(asked).toBe(false);
    // 五步按序、全 ✓。
    const steps = logs.filter((l) => l.startsWith("第 ")).map((l) => l.slice(0, 5));
    expect(steps).toEqual(["第 0 步", "第 1 步", "第 2 步", "第 3 步", "第 4 步"]);
    for (const l of logs.filter((x) => x.startsWith("第 "))) expect(l.endsWith("✓")).toBe(true);
    expect(stepLine(logs, 0)).toContain(`CLI ${RUNNING_VERSION} · claude 插件 ${RUNNING_VERSION} 版本与 CLI 一致`);
    expect(stepLine(logs, 1)).toContain("#dev 上以 agent 报到");
    expect(stepLine(logs, 2)).toContain("你选：交互式 Claude 会话");
    expect(out).toContain("--yes：不交互，按 claude 档默认选了交互式会话");
    expect(out).toContain("运行：party claude dev        （已自动带 dev-channels；默认参数：--dangerously-skip-permissions（来自 /x/claude-default-args.json））");
    expect(out).toContain("展开：AGENTPARTY_CHANNEL=dev claude --dangerously-load-development-channels plugin:agentparty@agentparty --dangerously-skip-permissions");
    expect(stepLine(logs, 3)).toContain("武装监听 party claude-channel，pid 5150）在接 @");
    expect(stepLine(logs, 4)).toContain(STUB_WAKE_VERIFY_SUMMARY("agent"));
    expect(fixCount(logs)).toBe(0);
    const verdict = logs.find((l) => l.startsWith("✅"));
    expect(verdict).toBe("✅ 接入完成：现在 @ agent，这台机器上由 party claude / party bridge claude 起的 Claude 会话（武装监听 party claude-channel，pid 5150）就能被唤醒来协作。");
  });

  test("codex 档：✅ 写明唤醒层 pid", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const code = await runJoin(opts({ harnessFlag: "codex", yes: true }), joinDeps(tmp, [], {}, logs));
    expect(code).toBe(0);
    expect(logs.filter((l) => l.startsWith("第 ")).length).toBe(5);
    expect(stepLine(logs, 2)).toContain("Stop hook 已装、已批准");
    expect(logs.find((l) => l.startsWith("✅"))).toBe("✅ 接入完成：现在 @ agent，这台机器上唤醒层 party serve dev --runner codex（pid 4242）就能被唤醒来协作。");
  });

  test("other 档：没有唤醒层，只跑到第 2 步，✅ 说清收消息靠 CLI", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const code = await runJoin(opts({ harnessFlag: "other", yes: true }), joinDeps(tmp, [], {}, logs));
    expect(code).toBe(0);
    expect(logs.filter((l) => l.startsWith("第 ")).length).toBe(3);
    expect(stepLine(logs, 2)).toContain("party watch dev");
    expect(logs.find((l) => l.startsWith("✅"))).toContain("没有唤醒层");
  });

  test("有 TTY 且未 --yes：第 2 步问一句，选常驻 ⇒ 第 3 步印/修法都是 party serve dev --runner claude", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const d = joinDeps(tmp, [], {}, logs);
    const askedFor: string[] = [];
    d.chooseReceiveMode = async (channel) => {
      askedFor.push(channel);
      return "serve";
    };
    d.claudeArmedListener = () => ({ live: null, sessions: 0 });
    const code = await runJoin(opts({ yes: false }), d);
    expect(askedFor).toEqual(["dev"]);
    expect(stepLine(logs, 2)).toContain("你选：常驻 party serve dev --runner claude");
    expect(logs.join("\n")).not.toContain("不交互");
    expectStoppedAt(code, logs, 3);
    expect(fixLine(logs)).toBe("party serve dev --runner claude");
    expect(logs.join("\n")).toContain("运行：party serve dev --runner claude");
  });

  test("无 TTY 且未 --yes：问不了（null）⇒ 按 claude 档默认（交互式）并印出所选", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const d = joinDeps(tmp, [], {}, logs); // fixture 默认 chooseReceiveMode 返回 null
    const code = await runJoin(opts({ yes: false }), d);
    expect(code).toBe(0);
    expect(stepLine(logs, 2)).toContain("你选：交互式 Claude 会话");
    expect(logs.join("\n")).toContain("无 TTY：不交互，按 claude 档默认选了交互式会话");
  });
});

// ── 第 3 步 claude 档探不到武装监听时的起法（#989）───────────────────────────────
//
// 变异自检（写这份测试时做过）：把 waitForClaudeArmedListener 的轮询循环删掉（只探一次）⇒ 「第 2 次轮询变 live」
// 那条红（停在第 3 步而不是继续到第 4 步）；把 runJoin 里「launchAfterJoin 就不跑第 4 步」删掉 ⇒ 「选 2」那条红。
describe("party join 引导 —— 第 3 步 claude 档：探不到武装监听时怎么起（#989）", () => {
  /** 有 TTY 的 claude 档：第 2 步真的问到了人（选交互式），第 3 步一开始探不到武装监听。 */
  function interactiveDeps(logs: string[], probes: ClaudeArmedListenerProbe[]) {
    const d = joinDeps(tmp, [], {}, logs);
    d.chooseReceiveMode = async () => "interactive";
    const record = { probeCalls: 0, sleeps: [] as number[], asked: [] as string[][], launched: [] as string[][], verified: false };
    d.claudeArmedListener = () => {
      const next = probes[Math.min(record.probeCalls, probes.length - 1)]!;
      record.probeCalls++;
      return next;
    };
    const sleep = d.sleep;
    d.sleep = async (ms) => {
      record.sleeps.push(ms);
      await sleep(ms);
    };
    d.chooseLaunchMode = async (channel, command) => {
      record.asked.push([channel, command]);
      return "self";
    };
    d.launchClaudeSession = async (channel, firstPrompt) => {
      record.launched.push([channel, firstPrompt]);
      logs.push("<launch>");
      return 0;
    };
    d.verifyWake = ({ identity }) => {
      record.verified = true;
      return { ok: true, summary: STUB_WAKE_VERIFY_SUMMARY(identity) };
    };
    return { d, record };
  }
  const dormant: ClaudeArmedListenerProbe = { live: null, sessions: 1 };
  const armed: ClaudeArmedListenerProbe = { live: { pid: 6161, launch: "claude-channel" }, sessions: 1 };

  test("选 1（自己另开终端跑）：探活在第 2 次轮询变 live ⇒ 印「等待武装监听…」、每 3s 探一次、第 3 步 ✓ 带 pid，继续到第 4 步并 ✅", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    // 第 1 次：本步探；第 2、3 次：轮询——第 2 次轮询才有。
    const { d, record } = interactiveDeps(logs, [dormant, dormant, armed]);
    const code = await runJoin(opts({ yes: false }), d);
    const out = logs.join("\n");
    expect(code).toBe(0);
    expect(record.asked).toEqual([["dev", "party claude dev"]]);
    expect(record.sleeps).toEqual([3_000, 3_000]);
    expect(record.probeCalls).toBe(3);
    expect(out).toContain("等待武装监听…（在另一个终端跑：party claude dev；最多等 90s，每 3s 探一次）");
    expect(stepLine(logs, 3)).toContain("武装监听 party claude-channel，pid 6161）在接 @ ✓");
    expect(out).toContain("等了 6s，武装监听到位");
    expect(record.verified).toBe(true);
    expect(stepLine(logs, 4)).toContain(STUB_WAKE_VERIFY_SUMMARY("agent"));
    expect(fixCount(logs)).toBe(0);
    expect(logs.find((l) => l.startsWith("✅"))).toContain("pid 6161");
    expect(record.launched).toEqual([]);
  });

  test("选 1 但 90s 内一直没武装 ⇒ 轮询到超时（30 次）后停在第 3 步，摘要说清等了 90s，修法还是 party claude dev，第 4 步不跑", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const { d, record } = interactiveDeps(logs, [dormant]);
    const code = await runJoin(opts({ yes: false }), d);
    expectStoppedAt(code, logs, 3);
    expect(record.sleeps.length).toBe(30);
    expect(record.sleeps.every((ms) => ms === 3_000)).toBe(true);
    expect(stepLine(logs, 3)).toContain("等了 90s 仍本机没有会接 @ 的 Claude 会话——本机在 #dev 入册的 1 个 claude 会话全是蛰伏档");
    expect(fixLine(logs)).toBe("party claude dev");
    expect(record.verified).toBe(false);
    expect(record.launched).toEqual([]);
  });

  test("选 2（现在就在这个终端起）：第 3 步记成待办 ✓、第 4 步不在 join 里跑、结论含 party wake verify dev、印完才调起会话桩，退出码跟会话", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const { d, record } = interactiveDeps(logs, [dormant]);
    d.chooseLaunchMode = async (channel, command) => {
      record.asked.push([channel, command]);
      return "here";
    };
    d.launchClaudeSession = async (channel, firstPrompt) => {
      record.launched.push([channel, firstPrompt]);
      logs.push("<launch>");
      return 7;
    };
    const code = await runJoin(opts({ yes: false }), d);
    const out = logs.join("\n");
    expect(code).toBe(7);
    expect(record.asked).toEqual([["dev", "party claude dev"]]);
    // 不等、不轮询：起会话是前台交互，join 不能同步等它。
    expect(record.sleeps).toEqual([]);
    expect(stepLine(logs, 3)).toBe("第 3 步  起一个可唤醒的会话 · 本机还没有会接 @ 的 Claude 会话——join 结束后在本终端起 party claude dev ✓");
    expect(out).toContain("第 4 步（真发一条 @ 验证）改在新会话里跑：party wake verify dev");
    // 第 4 步没跑：没有那一行、注入的验证桩没被调。
    expect(stepLine(logs, 4)).toBeUndefined();
    expect(record.verified).toBe(false);
    // 结论：不是 ✅（还没验证），说清在哪完成、跑哪条。
    expect(out).not.toContain("✅");
    const verdictAt = logs.findIndex((l) => l.startsWith("接入将在你起的会话里完成验证"));
    expect(verdictAt).toBeGreaterThan(-1);
    expect(logs[verdictAt]).toContain("party claude dev");
    expect(logs[verdictAt]).toContain("Loading development channels");
    expect(logs[verdictAt + 1]).toContain("party wake verify dev");
    // 起会话桩被调了一次，在结论之后；首轮提示让新会话自己跑第 4 步。
    expect(record.launched.length).toBe(1);
    expect(record.launched[0]![0]).toBe("dev");
    expect(record.launched[0]![1]).toContain("party wake verify dev");
    expect(logs.indexOf("<launch>")).toBeGreaterThan(verdictAt + 1);
    expect(fixCount(logs)).toBe(0);
    expect(out).not.toContain("接入停在");
  });

  test("--yes：不问怎么起、不等、不起 ⇒ 印命令 + 停在第 3 步（现状）", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const { d, record } = interactiveDeps(logs, [dormant, armed]);
    const code = await runJoin(opts({ yes: true }), d);
    expectStoppedAt(code, logs, 3);
    expect(record.asked).toEqual([]);
    expect(record.sleeps).toEqual([]);
    expect(record.probeCalls).toBe(1);
    expect(record.launched).toEqual([]);
    expect(fixLine(logs)).toBe("party claude dev");
    expect(logs.join("\n")).not.toContain("等待武装监听");
  });

  test("无 TTY（第 2 步没问到人）且未 --yes：同样不问、不等 ⇒ 停在第 3 步", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const { d, record } = interactiveDeps(logs, [dormant, armed]);
    d.chooseReceiveMode = async () => null; // 无 TTY
    const code = await runJoin(opts({ yes: false }), d);
    expectStoppedAt(code, logs, 3);
    expect(record.asked).toEqual([]);
    expect(record.sleeps).toEqual([]);
    expect(record.launched).toEqual([]);
  });

  test("第 3 步那一问被取消（Ctrl+C）⇒ 停在第 3 步、不替人起、不等", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const { d, record } = interactiveDeps(logs, [dormant, armed]);
    d.chooseLaunchMode = async () => "cancelled";
    const code = await runJoin(opts({ yes: false }), d);
    expectStoppedAt(code, logs, 3);
    expect(stepLine(logs, 3)).toContain("已取消");
    expect(record.sleeps).toEqual([]);
    expect(record.launched).toEqual([]);
    expect(fixLine(logs)).toBe("party claude dev");
  });

  test("第 2 步选了常驻：第 3 步不问起法（serve 是常驻进程，没有「在这个终端起」），有 TTY 直接等 party serve 武装", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const { d, record } = interactiveDeps(logs, [dormant, { live: { pid: 777, launch: "serve" }, sessions: 0 }]);
    d.chooseReceiveMode = async () => "serve";
    const code = await runJoin(opts({ yes: false }), d);
    expect(code).toBe(0);
    expect(record.asked).toEqual([]);
    expect(record.sleeps).toEqual([3_000]);
    expect(logs.join("\n")).toContain("等待武装监听…（在另一个终端跑：party serve dev --runner claude；");
    expect(stepLine(logs, 3)).toContain("pid 777");
    expect(record.launched).toEqual([]);
  });

  test("第 3 步的命令说明：dev-channels 确认框会弹一次；配了默认参数就说会带上，没配就说只带这些", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const d = joinDeps(tmp, [], {}, logs);
    d.claudeDefaultArgs = () => ({ args: ["--dangerously-skip-permissions"], source: "config", origin: "/x/claude-default-args.json" });
    expect(await runJoin(opts({ yes: true }), d)).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("启动时 Claude 会弹一次「Loading development channels」确认框，选「I am using this for local development」；上面的本机默认参数会一并带上。");
    expect(out).toContain("默认参数：--dangerously-skip-permissions（来自 /x/claude-default-args.json）");

    const logs2: string[] = [];
    expect(await runJoin(opts({ yes: true }), joinDeps(tmp, [], {}, logs2))).toBe(0);
    expect(logs2.join("\n")).toContain("确认框，选「I am using this for local development」；本机没配默认参数，只带上面这些。");
  });
});

// 第 4 步的真实实现（#990 的 verifyWakeRoundTrip）→ 一步的适配：往返结果的 detail 当摘要、fix 当修法。
// 往返本体（判层、修法文案）在 verify-wake.test.ts 里测；这里只测适配层没把信息弄丢、没重复打 ✓/✗。
describe("roundTripWakeVerifier —— 第 4 步接 #990 的往返（#988）", () => {
  function frame(over: Partial<WakeTestFrame["phases"]> = {}, result: WakeTestFrame["result"] = "timeout"): WakeTestFrame {
    return {
      type: "wake_test",
      channel: "dev",
      target: "agent",
      result,
      generated_at: 1,
      timeout_sec: 30,
      presence: { state: "waiting", residency: "supervised", wake_kind: "serve", wake_verified_at: null, last_seen: 1 },
      phases: {
        mention_delivered: { ok: true, seq: 42, evidence: "message accepted by channel history" },
        wake_invoked: { ok: null, status: "broadcast_pending", adapter: "serve", evidence: "serve broadcast delivered for mention #42" },
        agent_resumed: { ok: false, seq: null, evidence: null },
        ...over,
      },
      reason: "timed out waiting for linked reply_to/status.summary_seq",
    } as WakeTestFrame;
  }
  function verifyDeps(f: WakeTestFrame, probed: unknown[] = []): VerifyWakeDeps {
    let t = 1_000;
    return {
      probe: async (o) => {
        probed.push(o);
        t += 3_200;
        return f;
      },
      localEvidence: () => ({ listener: { live: null, sessions: 1 }, claimed: false, journaled: false, runnerTask: false }),
      now: () => t,
    };
  }

  test("收到回执 ⇒ 第 4 步 ✓，摘要是「@agent ping → 3.2s 收到回执」，探针用的是 join 写的 config 里的 server/token", async () => {
    mock = startRestMock();
    const probed: unknown[] = [];
    const logs: string[] = [];
    const d = joinDeps(tmp, [], {}, logs);
    d.verifyWake = roundTripWakeVerifier(verifyDeps(frame({ agent_resumed: { ok: true, seq: 43, evidence: "reply_to" } }, "healthy"), probed));
    const code = await runJoin(opts({ yes: true }), d);
    expect(code).toBe(0);
    expect(stepLine(logs, 4)).toBe("第 4 步  真发一条 @ 验证 · @agent ping → 3.2s 收到回执（回帖 #43） ✓");
    expect(probed).toHaveLength(1);
    const o = probed[0] as { server: string; token: string; channel: string; target: string };
    expect(o.server).toBe(new URL(mock.url).origin);
    expect(o.token).toBe("ap_bot_secret");
    expect(o.channel).toBe("dev");
    expect(o.target).toBe("agent");
  });

  test("超时（服务端已投递、本机没收到）⇒ 停在第 4 步，摘要说清哪一层没通，修法是 #990 给的那一条", async () => {
    mock = startRestMock();
    const logs: string[] = [];
    const d = joinDeps(tmp, [], {}, logs);
    d.verifyWake = roundTripWakeVerifier(verifyDeps(frame({ wake_invoked: { ok: true, status: "invoked", adapter: "serve", evidence: "claimed" } })));
    const code = await runJoin(opts({ yes: true }), d);
    expectStoppedAt(code, logs, 4);
    const step4 = stepLine(logs, 4)!;
    expect(step4).toContain("30s 未收到：服务端已投递、本机监听未收到");
    // 不重复打 ✗：往返结果自带的「✗ 」被适配层去掉，行尾只有步骤机补的那个。
    expect(step4.split("✗").length).toBe(2);
    expect(fixLine(logs)).toContain("party claude dev");
  });
});

describe("party join 引导 —— 幂等（#988）", () => {
  test("同一状态重跑两次输出逐行相同", async () => {
    mock = startRestMock();
    // 「同一状态」：MCP 已注册、crossSessionInbound 已是 accept、插件同版——第二次跑时盘上什么都没变。
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "settings.json"), JSON.stringify({ crossSessionInbound: "accept" }));
    const first: string[] = [];
    const second: string[] = [];
    expect(await runJoin(opts({ yes: true }), joinDeps(tmp, [], { mcpAlreadyRegistered: true }, first))).toBe(0);
    expect(await runJoin(opts({ yes: true }), joinDeps(tmp, [], { mcpAlreadyRegistered: true }, second))).toBe(0);
    expect(second).toEqual(first);
    expect(first.filter((l) => l.startsWith("第 ")).length).toBe(5);
  });

  test("首跑后重跑不叠加副作用（MCP 只 add 一次、插件不重复 update、报到是新的一条而不是报错）", async () => {
    mock = startRestMock();
    const record: string[][] = [];
    const first: string[] = [];
    const second: string[] = [];
    // 第一跑：mcp get 探到未注册 → add；第二跑：已注册 → 跳过 add。桩按 mcpAlreadyRegistered 分别配。
    // verbose：这里断言的是「✓ 跳过重复添加」这类子项本身，缺省已不印（#1073 收篇幅）。
    expect(await runJoin(opts({ yes: true, verbose: true }), joinDeps(tmp, record, {}, first))).toBe(0);
    expect(await runJoin(opts({ yes: true, verbose: true }), joinDeps(tmp, record, { mcpAlreadyRegistered: true }, second))).toBe(0);
    expect(second.join("\n")).toContain("跳过重复添加");
    expect(second.join("\n")).toContain("crossSessionInbound 已是 accept（跳过）");
    expect(record.filter((r) => r[0] === "claude" && r[1] === "mcp" && r[2] === "add").length).toBe(1);
    expect(record.some((r) => r[0] === "claude" && r[1] === "plugin" && r[2] === "update")).toBe(false);
    // 两次都是完整五步、都 ✅。
    expect(second.filter((l) => l.startsWith("第 ")).length).toBe(5);
    expect(second.find((l) => l.startsWith("✅"))).toBe(first.find((l) => l.startsWith("✅")));
  });

  test("停在某一步后修好再跑 ⇒ 同一条 join 从第 0 步重来并走完", async () => {
    mock = startRestMock();
    const logs1: string[] = [];
    const d1 = joinDeps(tmp, [], {}, logs1);
    d1.claudeArmedListener = () => ({ live: null, sessions: 1 });
    expect(await runJoin(opts({ yes: true }), d1)).toBe(1);
    expect(fixLine(logs1)).toBe("party claude dev");
    // 「做完修法」＝本机起了 party claude dev（锁被持有）。
    const logs2: string[] = [];
    const d2 = joinDeps(tmp, [], { mcpAlreadyRegistered: true }, logs2);
    expect(await runJoin(opts({ yes: true }), d2)).toBe(0);
    expect(logs2.filter((l) => l.startsWith("第 ")).length).toBe(5);
    expect(logs2.find((l) => l.startsWith("✅"))).toContain("pid 5150");
  });
});


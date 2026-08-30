// party join 测试共用的桩（join.test.ts / onboarding-steps.test.ts）。
//
// 只桩 claude/codex 二进制（spawnSync）与几个探活注入点；init / hook / send 走**真实**实现打到
// rest-mock，收尾判定读**真实盘状态**——反假绿纪律：桩得越少，测试越接近真机。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JoinDeps, JoinOptions } from "../src/commands/join";
import { run as initRun } from "../src/commands/init";
import { run as hookRun } from "../src/commands/hook";
import { run as sendRun } from "../src/commands/send";
import { inspectClaudePluginShell, parseClaudePluginList } from "../src/commands/doctor";
import { buildWakeChecklist } from "../src/wake-checklist";
import { diagnoseCodexWake } from "../src/wake-diagnosis";
import { RUNNING_VERSION } from "../src/upgrade";

export const PLUGIN = "agentparty@agentparty";

// 只读 .error / .status（插件相关再读 .stdout）的最小 spawnSync 桩。record 记下每次调用，便于断言
// MCP 注册 / 插件 update 确实发生。
export interface SpawnBehavior {
  noBinary?: boolean; // 二进制不存在（ENOENT）
  mcpAlreadyRegistered?: boolean; // mcp get 返回 0（已注册）
  failMcpAdd?: boolean; // mcp add 返回非 0
  /**
   * 本机已装的 claude 插件版本（#961）：省略＝与 CLI 同版；null＝没装；"0.2.203" 这类＝旧版。
   * 桩是**有状态**的，照真机行为走：`plugin install` 对已装的只回 already installed（**不升级**），
   * 只有 `plugin update` 才把版本换成当前 CLI 的。
   */
  installedPluginVersion?: string | null;
  failPluginUpdate?: boolean; // plugin update 返回非 0
  /**
   * `marketplace add` / `plugin install` / `plugin enable` 返回非 0（真机常见：已加过 marketplace、
   * 已装过插件时就会这样），但 update 照样把版本对齐——用来钉「按最终事实判成败，不按退出码」。
   */
  noisyPluginSubcommands?: boolean;
  /** `plugin install` 真的失败：返回非 0 **且没装上**（区别于 noisy 那种「已装过所以非 0」）。 */
  failPluginInstall?: boolean;
  /**
   * `plugin update` 退出非 0 **但版本其实已经换好**（真机常见）。用来钉「按装好的版本判，
   * 不按退出码」——否则上层会以为没更新过，结论丢掉「差一次重开」，而另一处探测读到新版本
   * 又打出「版本与 CLI 一致」的假绿。
   */
  pluginUpdateNoisyButWorks?: boolean;
  /**
   * update 之后的头 N 次 `plugin list` 读不出来（真机偶发）。用来钉「换没换版本」这个事实
   * 不能挂在单次重读上——读失败时上层必须用权威壳探测兜底，否则又是「版本与 CLI 一致」的假绿。
   */
  pluginListFailsAfterUpdate?: number;
  /** 一开始的头 N 次 `plugin list` 读不出来：连「之前是什么版本」都不知道。 */
  pluginListFailsAtStart?: number;
}
/** 只比数字段，够桩用（"0.2.222" vs "0.2.221"）。 */
function compareSemverLoose(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

interface PluginState {
  installed: string | null;
  /** 还要让多少次 `plugin list` 读失败（pluginListFailsAfterUpdate 用）。 */
  listFailuresLeft?: number;
}
export function fakeSpawn(record: string[][], behavior: SpawnBehavior, state: PluginState): JoinDeps["spawn"] {
  if (behavior.pluginListFailsAtStart !== undefined && state.listFailuresLeft === undefined) {
    state.listFailuresLeft = behavior.pluginListFailsAtStart;
  }
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
    if (cmd === "claude" && args[0] === "--version") return { ...base, status: 0, stdout: "2.1.200 (Claude Code)\n" };
    if (cmd === "claude" && args[0] === "plugin" && args[1] === "list") {
      if ((state.listFailuresLeft ?? 0) > 0) {
        state.listFailuresLeft = (state.listFailuresLeft ?? 0) - 1;
        return { ...base, status: 1 };
      }
      const rows = state.installed === null
        ? []
        : [{ id: PLUGIN, version: state.installed, enabled: true, installPath: "/nowhere/agentparty" }];
      return { ...base, status: 0, stdout: `${JSON.stringify(rows)}\n` };
    }
    if (cmd === "claude" && args[0] === "plugin" && args[1] === "install") {
      if (behavior.failPluginInstall) return { ...base, status: 1 }; // 真失败：没装上
      // 真机行为：已装就只回 "already installed"，版本原地不动。
      if (state.installed === null) state.installed = RUNNING_VERSION;
      return { ...base, status: behavior.noisyPluginSubcommands ? 1 : 0 };
    }
    if (cmd === "claude" && args[0] === "plugin" && (args[1] === "marketplace" || args[1] === "enable")) {
      return { ...base, status: behavior.noisyPluginSubcommands ? 1 : 0 };
    }
    if (cmd === "claude" && args[0] === "plugin" && args[1] === "update") {
      if (behavior.failPluginUpdate) return { ...base, status: 1 };
      // 真机行为二则（桩不能比真机宽容，否则会掩盖真缺陷）：
      //  1) 没装过时 `plugin update` 直接失败，**不会顺手装上**（那是 install 的活）；
      //  2) update 只把插件带到 marketplace 上的版本，**不会降级**——本机插件比 CLI 新
      //     （CLI 还没升）时跑它等于没动，正是 owner 截图那种 0.2.222 插件 / 0.2.221 CLI。
      if (state.installed === null) return { ...base, status: 1 };
      const newer = compareSemverLoose(state.installed, RUNNING_VERSION) > 0;
      if (!newer) state.installed = RUNNING_VERSION;
      if (behavior.pluginListFailsAfterUpdate !== undefined) state.listFailuresLeft = behavior.pluginListFailsAfterUpdate;
      return { ...base, status: behavior.pluginUpdateNoisyButWorks ? 1 : 0 };
    }
    return { ...base, status: 0 };
  }) as unknown as JoinDeps["spawn"];
}

const ENV_KEYS = ["AGENTPARTY_HOME", "AGENTPARTY_CONFIG", "AGENTPARTY_TOKEN", "CODEX_HOME", "HOME"];

/** 每个用例一个干净 HOME：AGENTPARTY_HOME / CODEX_HOME / HOME 全指进临时目录。 */
export function joinEnv(): { setup: () => string; teardown: () => void } {
  const saved: Record<string, string | undefined> = {};
  let tmp = "";
  return {
    setup() {
      for (const k of ENV_KEYS) saved[k] = process.env[k];
      tmp = mkdtempSync(join(tmpdir(), "party-join-"));
      process.env.HOME = tmp;
      process.env.AGENTPARTY_HOME = join(tmp, ".agentparty");
      process.env.CODEX_HOME = join(tmp, ".codex");
      delete process.env.AGENTPARTY_CONFIG;
      delete process.env.AGENTPARTY_TOKEN;
      return tmp;
    },
    teardown() {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

export function joinDeps(tmp: string, record: string[][], behavior: SpawnBehavior, logs: string[]): JoinDeps {
  const state: PluginState = {
    installed: behavior.installedPluginVersion === undefined ? RUNNING_VERSION : behavior.installedPluginVersion,
  };
  const spawn = fakeSpawn(record, behavior, state);
  const clock = { t: 1_000_000 };
  return {
    spawn,
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
    // claude 插件壳检查（#961）：走**真的** inspectClaudePluginShell（版本比对逻辑不另写一份），
    // 只把 claude 二进制换成上面那个有状态桩、把读盘的包检查换成恒 valid。
    claudePluginShell: () =>
      inspectClaudePluginShell({
        claudeVersion: () => {
          const r = spawn("claude", ["--version"], { encoding: "utf8" });
          return r.error === undefined && r.status === 0 ? String(r.stdout).trim() : null;
        },
        claudePlugins: () => {
          const r = spawn("claude", ["plugin", "list", "--json"], { encoding: "utf8" });
          return r.error === undefined && r.status === 0 ? parseClaudePluginList(String(r.stdout)) : null;
        },
        inspectBundle: () => ({ valid: true, launcherExecutable: true }),
      }),
    // claude 武装监听（#979）：默认假装本机有 party claude 起的会话在接 @（happy path）；蛰伏档用例逐个覆盖。
    claudeArmedListener: () => ({ live: { pid: 5150, launch: "claude-channel" }, sessions: 1 }),
    // codex 唤醒层（#957）：默认假装拉起成功且进程在（happy path）；失败用例逐个覆盖。
    startCodexWakeLayer: async () => ({ action: "start", channel: "dev", cwd: process.cwd(), args: [] }),
    codexWakeLayerLive: async () => ({ pid: 4242, source: "serve-lock" }),
    codexAncestorPid: () => null,
    codexSessionId: () => null,
    codexNativeBrokerMcp: () => ({
      name: "agentparty_native",
      command: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
      args: [join(tmp, ".agentparty", "codex-native-broker", "broker.cjs"), "--mcp", join(tmp, ".agentparty")],
    }),
    installCodexNativeBroker: () => {},
    // 第 2 步（#988）：默认「没法问」（无 TTY）——按 harness 默认走；交互用例逐个覆盖。
    chooseReceiveMode: async () => null,
    // 第 3 步（#988）：本机没配 party claude 默认参数；有默认参数的用例逐个覆盖。
    claudeDefaultArgs: () => ({ args: [], source: "none", origin: join(tmp, ".agentparty", "claude-default-args.json") }),
    // 第 3 步（#989）：默认「没法问」（无 TTY）；起会话的桩绝不该在默认用例里被调到（调到就是 join 想接管终端了）。
    chooseLaunchMode: async () => null,
    launchClaudeSession: async (channel) => {
      throw new Error(`launchClaudeSession(${channel}) 不该被调到：这个用例没选「在这个终端起」`);
    },
    // 假时钟：sleep 只拨表不真等，now 读表——第 3 步的 90s 等待在测试里是瞬时的。
    sleep: async (ms) => {
      clock.t += ms;
    },
    now: () => clock.t,
    // 第 4 步（#988）：往返验证桩——真实的 roundTripWakeVerifier（#990）要发真帧、等 30s，单测不跑它；
    // 适配层（往返结果 → 一步）在 onboarding-steps.test.ts 里单独用假 probe 测。
    verifyWake: ({ identity }) => ({ ok: true, summary: STUB_WAKE_VERIFY_SUMMARY(identity) }),
  };
}

export const STUB_WAKE_VERIFY_SUMMARY = (identity: string) => `@${identity} ping → 0.1s 收到回执（测试桩）`;

/** 「修法（做完重跑同一条 party join）：」下面那一行——引导给出的唯一修法命令。 */
export function fixLine(logs: string[]): string | undefined {
  const i = logs.findIndex((l) => l.includes("修法（"));
  return i === -1 ? undefined : logs[i + 1]?.trim();
}

/** 输出里印了几条修法（每个停下的步骤恰一条；全部过了是 0）。 */
export function fixCount(logs: string[]): number {
  return logs.filter((l) => l.includes("修法（")).length;
}

/** 「第 N 步」那一行。 */
export function stepLine(logs: string[], n: number): string | undefined {
  return logs.find((l) => l.startsWith(`第 ${n} 步`));
}

export function baseJoinOpts(server: string, over: Partial<JoinOptions>): JoinOptions {
  return {
    server,
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

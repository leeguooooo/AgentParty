// claude 档「武装监听」探活（issue #979）。
//
// 普通 `claude` 起的会话按 #615 设计是 local-only：插件在每个会话里都会拉起
// `party claude-channel --require-launch-opt-in`，但没有 AGENTPARTY_CLAUDE_CHANNEL_OPT_IN=1 它就走
// 蛰伏档——只宣告在线、绝不认领投递、**不抢 serve 锁**。真正会接 @ 的只有三种进程：
//   - `party claude <chan>` 起的会话（设了 opt-in，claude-channel 走 armed 档）；
//   - `party bridge claude <chan>` 起的会话（自带 claude-channel，不带 --require-launch-opt-in）；
//   - `party serve <chan> --runner claude` 常驻。
// 三者**都会抢同一把 "serve" 实例锁**（claude-channel.ts 的注释：serve 与 live-session adapter 是同一
// 身份/频道的两个投递消费者，绝不能并存）。所以「本机有没有会接 @ 的 Claude 监听」的判据就是
// 这把锁有没有活着的持有者——进程事实，不是开关，与 #957 的 probeCodexWakeLayer 同一形状。
// 锁持有者的命令行（ps）只用来**说清是谁**（pid / 起法），不参与判定。
//
// 蛰伏档留下的唯一本机痕迹是会话注册表（claude-sessions/，SessionStart 入册）。它只用来把
// 「为什么不在线」说清楚：本机明明有 N 个 claude 会话在这个频道入册，但全是蛰伏档。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  listClaudeSessions,
  normalizeSessionRegistryIdentity,
  sessionEntryMatchesIdentity,
  sessionEntryMatchesServer,
  type ClaudeSessionRegistryEntry,
} from "./claude-session-registry";
import { localAgentConfigsForChannel } from "./config";
import { defaultInstanceLockDir, instanceLockHolderPid, instanceLockTarget } from "./instance-lock";
import { healServerUrl } from "./validation";

/** 武装监听是谁起的：`party claude`/`bridge claude` 的 claude-channel、`party serve` 常驻、或认不出。 */
export type ClaudeArmedListenerLaunch = "claude-channel" | "serve" | "unknown";

export interface ClaudeArmedListenerLiveness {
  pid: number;
  launch: ClaudeArmedListenerLaunch;
}

export interface ClaudeArmedListenerProbe {
  /** 持有 serve 锁的活进程；null ＝ 本机此刻没有任何会接 @ 的 Claude 监听。 */
  live: ClaudeArmedListenerLiveness | null;
  /** 本机在该频道、该实例、该身份下入册且还活着的 claude 会话数。live===null 时它们全是蛰伏档。 */
  sessions: number;
}

/** 两条修法命令——结论句里必须原样印出（#979）。 */
export function claudeArmCommand(channel: string): string {
  return `party claude ${channel}`;
}
export function claudeServeCommand(channel: string): string {
  return `party serve ${channel} --runner claude`;
}

/** 读某 pid 的完整命令行；读不到（Windows / ps 不可用 / 进程没了）→ null。 */
export function processCommandLine(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000 });
    if (r.error !== undefined || r.status !== 0) return null;
    const line = r.stdout.trim();
    return line === "" ? null : line;
  } catch {
    return null;
  }
}

/** 从命令行认出起法。只认我们自己的两个子命令名；认不出就 unknown，绝不猜。 */
export function classifyListenerCommand(command: string | null): ClaudeArmedListenerLaunch {
  if (command === null) return "unknown";
  if (/\bclaude-channel\b/.test(command)) return "claude-channel";
  if (/\bserve\b/.test(command)) return "serve";
  return "unknown";
}

interface ProbeConfig {
  server?: unknown;
  token?: unknown;
  identity?: { name?: unknown } | null;
}

function lockTargetOf(config: ProbeConfig | null, channel: string): string | null {
  if (config === null) return null;
  const { server, token } = config;
  if (typeof server !== "string" || typeof token !== "string" || token === "") return null;
  const healed = healServerUrl(server);
  return healed === null ? null : instanceLockTarget(healed, token, channel);
}

function countSessions(
  entries: ClaudeSessionRegistryEntry[],
  channel: string,
  server: unknown,
  identity: unknown,
): number {
  const serverStr = typeof server === "string" ? server : null;
  const identityStr = typeof identity === "string" ? identity : null;
  return entries.filter((e) =>
    e.channel === channel && sessionEntryMatchesServer(e, serverStr) && sessionEntryMatchesIdentity(e, identityStr)
  ).length;
}

/**
 * 本机该 (server, token, channel) 有没有会接 @ 的 Claude 监听——serve 锁的活持有者（#979）。
 * 与 probeCodexWakeLayer 对等：判据是进程真的在（pid + 出生时间，instanceLockHolderPid 内部核对），
 * 不是插件装没装、不是 opt-in 开关。config 没有 agent token ⇒ 谈不上监听 ⇒ null。
 */
export function probeClaudeArmedListener(input: {
  lockDir?: string;
  config: ProbeConfig | null;
  channel: string;
  /** 注入点：锁持有者 pid（测试不写真锁时用）。缺省读锁文件 + 探活。 */
  lockHolder?: (target: string, lockDir: string) => number | null;
  /** 注入点：pid → 命令行。缺省 ps。 */
  commandOf?: (pid: number) => string | null;
  /** 注入点：会话注册表。缺省 listClaudeSessions()。 */
  sessions?: () => ClaudeSessionRegistryEntry[];
}): ClaudeArmedListenerProbe {
  const lockDir = input.lockDir ?? defaultInstanceLockDir();
  const target = lockTargetOf(input.config, input.channel);
  let sessions = 0;
  try {
    sessions = countSessions(
      (input.sessions ?? listClaudeSessions)(),
      input.channel,
      input.config?.server,
      input.config?.identity?.name,
    );
  } catch {
    sessions = 0;
  }
  if (target === null) return { live: null, sessions };
  const holder = (input.lockHolder ?? ((t, d) => instanceLockHolderPid("serve", t, d)))(target, lockDir);
  if (holder === null) return { live: null, sessions };
  const launch = classifyListenerCommand((input.commandOf ?? processCommandLine)(holder));
  return { live: { pid: holder, launch }, sessions };
}

/** ✅ 句里「就能被唤醒」指的是谁——按 pid / 起法说清（#979 修法 3）。 */
export function describeClaudeArmedListener(live: ClaudeArmedListenerLiveness, channel: string): string {
  switch (live.launch) {
    case "claude-channel":
      return `由 party claude / party bridge claude 起的 Claude 会话（武装监听 party claude-channel，pid ${live.pid}）`;
    case "serve":
      return `常驻的 party serve ${channel} --runner claude（pid ${live.pid}）`;
    case "unknown":
      return `持有 #${channel} 监听锁的进程（pid ${live.pid}）`;
  }
}

/** 没有武装监听时对「本机有哪些 claude 会话」的一句说明。 */
export function describeDormantClaudeSessions(sessions: number, channel: string): string {
  return sessions > 0
    ? `本机在 #${channel} 入册的 ${sessions} 个 claude 会话全是蛰伏档（普通 claude 起的，不接频道消息）`
    : `本机没有任何 claude 会话在 #${channel} 入册`;
}

/** 降级结论（#979 修法 2）：不印 ✅，两条命令原样印出。 */
export function claudeNoArmedListenerLines(identity: string, channel: string, sessions: number): string[] {
  return [
    `⚠ 已绑定身份 ${identity}，但这台机现在没有会接 @ 的 Claude 会话。`,
    `普通 \`claude\` 起的会话不接频道消息（local-only）；要能被 @ 唤醒，用 ${claudeArmCommand(channel)} 起一个会话` +
      `（或 ${claudeServeCommand(channel)} 常驻）。`,
    `  ${claudeArmCommand(channel)}`,
    `  ${claudeServeCommand(channel)}`,
    `  ${describeDormantClaudeSessions(sessions, channel)}`,
  ];
}

// ── party who 那一侧（#979 修法 4）────────────────────────────────────────────

export interface ClaudeDormantDiagnosis {
  channel: string;
  /** 频道身份（config.identity.name 原样）。 */
  identity: string;
  /** 本机在该频道入册、属于这个身份的存活 claude 会话数（全是蛰伏档）。 */
  sessions: number;
}

/**
 * 本机在 #channel 有蛰伏档 claude 会话、却没有武装监听的身份列表。纯本地：扫 agents/ 下
 * 绑到该频道的 config → 每个身份看注册表里有没有活会话、serve 锁有没有活持有者。
 * 有锁持有者（`party claude` / serve 在跑）的身份不列——它不是「只有蛰伏档」。
 */
export function diagnoseClaudeDormantSessions(
  channel: string,
  server: string,
  deps: {
    home?: string;
    lockDir?: string;
    sessions?: () => ClaudeSessionRegistryEntry[];
    lockHolder?: (target: string, lockDir: string) => number | null;
    readToken?: (path: string) => string | null;
  } = {},
): ClaudeDormantDiagnosis[] {
  const wantedServer = healServerUrl(server);
  const entries = (deps.sessions ?? listClaudeSessions)();
  if (entries.length === 0) return [];
  const readToken = deps.readToken ?? ((path: string) => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown };
      return typeof parsed.token === "string" && parsed.token !== "" ? parsed.token : null;
    } catch {
      return null;
    }
  });
  const out: ClaudeDormantDiagnosis[] = [];
  const seen = new Set<string>();
  for (const hint of localAgentConfigsForChannel(channel, null, deps.home)) {
    if (healServerUrl(hint.server) !== wantedServer) continue;
    const key = normalizeSessionRegistryIdentity(hint.name);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    const token = readToken(hint.path);
    const probe = probeClaudeArmedListener({
      ...(deps.lockDir === undefined ? {} : { lockDir: deps.lockDir }),
      config: { server: hint.server, token, identity: { name: hint.name } },
      channel,
      ...(deps.lockHolder === undefined ? {} : { lockHolder: deps.lockHolder }),
      sessions: () => entries,
    });
    if (probe.live !== null || probe.sessions === 0) continue;
    out.push({ channel, identity: hint.name, sessions: probe.sessions });
  }
  return out;
}

/** who 的行里已经在线 / 可唤醒的身份不用再解释——只对「不在线」的那些说为什么。 */
export function claudeDormantToSurface(
  diags: ClaudeDormantDiagnosis[],
  rows: { name: string; tier: string }[],
): ClaudeDormantDiagnosis[] {
  const reachable = new Set<string>();
  for (const r of rows) {
    if (r.tier !== "online" && r.tier !== "wakeable") continue;
    const key = normalizeSessionRegistryIdentity(r.name);
    if (key !== null) reachable.add(key);
  }
  return diags.filter((d) => {
    const key = normalizeSessionRegistryIdentity(d.identity);
    return key === null || !reachable.has(key);
  });
}

export function formatClaudeDormantDiagnosis(d: ClaudeDormantDiagnosis): string[] {
  return [
    `wake (claude): #${d.channel} 上 ${d.identity} 不在线——${describeDormantClaudeSessions(d.sessions, d.channel)}，` +
      "普通 `claude` 起的会话不接频道消息（local-only）",
    `  要能被 @ 唤醒: ${claudeArmCommand(d.channel)}   （或常驻: ${claudeServeCommand(d.channel)}）`,
  ];
}

// party agents — 对齐 Claude Code ListAgents 的统一可达性视图（#835）：一条命令列出所有可直达目标，
// 名字即地址（NAME 可直接 party send --mention）。与 party who 的区别：who 回答「谁在频道里、状态如何」，
// agents 回答「此刻 @ 谁真的能收到」——REACH 是真实可达性判定，不是最后心跳：
//   · online(serve)  serve/watch/daemon runner 有活 WS 连接、runner 没连败、delivery 租约没在过期
//                    （listening != deaf）。对本机自己的 serve 还叠加 health.json 交叉验证：pid 真活着
//                    且 WS 帧仍新鲜——避免 busy 全绿但 runner 挂死还显示 online（memory: observability-traps）。
//   · local-direct   本机 Claude cross-session 会话（服务端 runtime topology 比对出的 claude_sessions，
//                    candidate_ref 非空 = 当前唯一可寻址）。走 Claude 官方 ListAgents/SendMessage 链路。
//   · wake(webhook)  离线但服务端持有 webhook 端点、自己 POST 投递——服务端可验证的唤醒通道。
//   · stale          其余一切。包括「连接活着但 runner 连败 / 不吃投喂」——那正是要暴露的假在线。
import {
  autoWakeReachable,
  wakeableState,
  type PresenceEntry,
  type RuntimePeerDiscovery,
  type WakeKind,
} from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { readHealthCache, type HealthCache } from "../health-cache";
import { resolveAuth } from "../oidc-cli";
import { fetchPresence, fetchReadCursors, fetchRuntimePeers, handleRestError } from "../rest";
import { buildRuntimeTopology } from "../runtime-topology";
import { sanitizeSingleLine } from "../format";
import { isSlug } from "../validation";

const AGENTS_FLAGS = ["channel", "json"];
const HELP = `usage: party agents [channel|--channel C] [--json]

Unified reachability view (Claude ListAgents-style): every row is a directly
addressable target — the NAME is the address (party send "@NAME …" --mention NAME,
or Claude SendMessage for claude-session rows).

Columns:
  NAME     the address
  KIND     channel-member | claude-session | codex
  REACH    online(serve)  runner truly alive: live WS + runner not failing +
                          deliveries being consumed (+ local pid/frame cross-check
                          for this workspace's own serve) — NOT just a heartbeat
           local-direct   local Claude cross-session peer (official SendMessage path)
           wake(webhook)  offline but server-delivered webhook wake is verified
           stale          everything else, including a live socket whose runner is
                          dead/failing — the honest label for false-online
  CHANNEL  channel slug, or (bridge) for local claude sessions

Options:
  --channel C   read channel C instead of the bound channel
  --json        one JSON object per line
                (name/kind/reach/channel/reach_reason/wake/busy/read_seq/behind/age_ms)`;

const STALE_MS = 60_000; // 与 DO presence 扫描 / who.ts 一致
const DEAD_MS = 14 * 24 * 60 * 60 * 1000; // 幽灵线，与 who.ts 一致
// 本机 health.json 的帧新鲜度阈值：serve 按 ping 心跳（~25s）节奏写 last_frame_at，
// 超过约 5 个心跳周期没有任何服务端帧 = socket 僵死或进程被 kill 后的残留记录。
export const LOCAL_FRAME_STALE_MS = 120_000;

export type AgentReach = "online(serve)" | "local-direct" | "wake(webhook)" | "stale";
export type AgentKind = "channel-member" | "claude-session" | "codex";

export interface AgentRow {
  name: string;
  kind: AgentKind;
  reach: AgentReach;
  channel: string;
  /** 为什么不是更高一档——只在 stale 且能说清原因时带出（诚实留白）。 */
  reach_reason?: string;
  wake?: WakeKind;
  busy?: true;
  read_seq?: number;
  behind?: number;
  age_ms?: number;
}

export interface LocalHealthProbe {
  cache: HealthCache | null;
  /** pid 探活注入点（单测可替换）；默认 process.kill(pid, 0)。 */
  pidAlive?: (pid: number) => boolean;
  now?: number;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 本机交叉验证（#254 探针的消费端）：presence 说 online 只证明「服务端看得到一条活连接」，
 * 不证明 runner 进程还活着。对本 workspace 自己的 serve，读 health.json 再验三件事：
 * pid 真活着、WS 自报 connected、最近仍在收服务端帧。任一不成立 → 返回失败原因（降级 stale）。
 * 没有 health 记录（serve 不在本机跑）→ null = 无从交叉验证，不否决。
 */
export function localServeFailure(probe: LocalHealthProbe): string | null {
  const h = probe.cache;
  if (h === null) return null;
  const pidAlive = probe.pidAlive ?? defaultPidAlive;
  const now = probe.now ?? Date.now();
  if (!pidAlive(h.pid)) return `local runner pid ${h.pid} is dead`;
  if (!h.ws_connected) return "local runner ws disconnected";
  if (h.last_frame_at === null || now - h.last_frame_at > LOCAL_FRAME_STALE_MS) {
    return "local runner ws frames stale";
  }
  return null;
}

const SERVE_LIKE = new Set<WakeKind>(["serve", "watch", "daemon"]);

export function memberKind(e: PresenceEntry): AgentKind {
  const harness = e.agent_session?.harness;
  if (harness === "codex" || harness === "codex-sdk") return "codex";
  if (e.status?.context?.reception_runner === "codex") return "codex";
  return "channel-member";
}

/**
 * 真实可达性判定。取舍（vs 单看最后心跳）：
 * ① online(serve) 需要活 WS（live=true 或新鲜）+ serve 型 wake layer；
 * ② 服务端已经看出 runner 不行（runner_health 连败 / listening=deaf 投喂了不吃）→ 直接 stale，
 *    这正是「busy 全绿但 runner 挂死」的两个服务端信号；
 * ③ 对本机自己的 serve 叠加 health.json 的 pid/帧交叉验证（localFailure 非 null → stale）——
 *    kill 掉 runner 不解注册时，presence 的 live 可能要等租约过期才翻转，本地探针立刻翻转；
 * ④ 读游标落后不否决 online：忙碌 runner 合法落后，落后量作为 behind 字段如实带出，让调用方自己看；
 * ⑤ webhook 由服务端投递、可服务端验证，离线也算可达；serve/watch 声明而不新鲜的一律 stale。
 */
export function memberReach(
  e: PresenceEntry,
  now: number,
  localFailure: string | null = null,
): { reach: AgentReach; reason?: string } {
  const seen = e.last_seen ?? e.ts ?? 0;
  const age = now - seen;
  const live = e.state !== "offline" && (e.live === true || age < STALE_MS);
  const wakeKind = e.wake?.kind;
  if (e.paused === true) return { reach: "stale", reason: "reception paused" };
  if (live && wakeKind !== undefined && SERVE_LIKE.has(wakeKind)) {
    if (e.runner_health !== undefined && !e.runner_health.ok) {
      return { reach: "stale", reason: `runner failing x${e.runner_health.consecutive_failures}` };
    }
    if (e.listening === "deaf") {
      return { reach: "stale", reason: "deliveries expiring (connected but not consuming)" };
    }
    if (localFailure !== null) return { reach: "stale", reason: localFailure };
    return { reach: "online(serve)" };
  }
  // webhook：服务端持有端点自己 POST，离线也真能唤醒；不越过幽灵线。
  if (
    wakeKind === "webhook" &&
    age <= DEAD_MS &&
    autoWakeReachable(e, now, STALE_MS) &&
    wakeableState(e, now) === "wakeable_verified"
  ) {
    return { reach: "wake(webhook)" };
  }
  if (live) return { reach: "stale", reason: "live connection but no serve runner" };
  return { reach: "stale" };
}

/** 把 presence + 本机 claude 会话发现拼成统一行。导出仅为单测。 */
export function buildAgentRows(
  channel: string,
  presence: PresenceEntry[],
  now: number,
  opts: {
    discovery?: RuntimePeerDiscovery;
    cursorOf?: Map<string, number>;
    lastSeq?: number;
    localHealth?: LocalHealthProbe;
  } = {},
): AgentRow[] {
  const rows: AgentRow[] = [];
  const localFailure = opts.localHealth === undefined ? null : localServeFailure(opts.localHealth);
  for (const e of presence) {
    if (e.name === "system") continue;
    if (e.kind === "human") continue; // agents 只列可编程直达目标；人类看 party who
    const seen = e.last_seen ?? e.ts ?? 0;
    const age = now - seen;
    if (age > DEAD_MS) continue; // 幽灵不列
    // 本机交叉验证只适用于「本 workspace 自己的 serve」那一行（discovery.self）；
    // 别拿本地 health.json 去否决别人机器上的 runner。
    const isSelf = opts.discovery !== undefined && opts.discovery.self === e.name;
    const { reach, reason } = memberReach(e, now, isSelf ? localFailure : null);
    const readSeq = opts.cursorOf?.get(e.name);
    const behind =
      readSeq !== undefined && opts.lastSeq !== undefined && opts.lastSeq > readSeq
        ? opts.lastSeq - readSeq
        : undefined;
    rows.push({
      name: e.name,
      kind: memberKind(e),
      reach,
      channel,
      ...(reason !== undefined ? { reach_reason: reason } : {}),
      ...(e.wake?.kind !== undefined && e.wake.kind !== "none" ? { wake: e.wake.kind } : {}),
      ...(e.busy === true ? { busy: true as const } : {}),
      ...(readSeq !== undefined ? { read_seq: readSeq } : {}),
      ...(behind !== undefined ? { behind } : {}),
      age_ms: age,
    });
  }
  // 本机 Claude cross-session 会话：服务端 runtime topology 比对出的 claude_sessions 提示。
  // candidate_ref 非空 = 当前唯一可寻址（可走官方 ListAgents/SendMessage 链路）→ local-direct；
  // 为空 = 不可唯一寻址，如实列为 stale 并说明原因，而不是假装它不存在。
  for (const peer of opts.discovery?.peers ?? []) {
    for (const session of peer.claude_sessions) {
      const addressable = session.candidate_ref !== null;
      rows.push({
        name: session.display_name,
        kind: "claude-session",
        reach: addressable ? "local-direct" : "stale",
        channel: "(bridge)",
        ...(addressable ? {} : { reach_reason: "not uniquely addressable (no candidate_ref)" }),
      });
    }
  }
  const rank: Record<AgentReach, number> = {
    "online(serve)": 0,
    "local-direct": 1,
    "wake(webhook)": 2,
    stale: 3,
  };
  return rows.sort((a, b) => rank[a.reach] - rank[b.reach] || a.name.localeCompare(b.name));
}

export function renderAgentTable(rows: AgentRow[]): string[] {
  const header = ["NAME", "KIND", "REACH", "CHANNEL"];
  const cells = rows.map((r) => [
    sanitizeSingleLine(r.name),
    r.kind,
    r.reach + (r.busy === true ? " ⏳" : ""),
    sanitizeSingleLine(r.channel),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]): string => c.map((v, i) => v.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(header), ...cells.map((c, idx) => {
    const reason = rows[idx]!.reach_reason;
    return line(c) + (reason !== undefined ? `  · ${sanitizeSingleLine(reason)}` : "");
  })];
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["json"] });
  const unknown = unknownFlagError(flags, AGENTS_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const channel = resolveChannel(str(flags.channel) ?? positionals[0]);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  try {
    const presence = await fetchPresence(cfg.server, cfg.token, channel);
    let discovery: RuntimePeerDiscovery | undefined;
    const topology = buildRuntimeTopology(cfg.server);
    if (topology !== undefined) {
      try {
        discovery = await fetchRuntimePeers(cfg.server, cfg.token, channel, topology, "topology_advisory");
      } catch {
        // 老 worker / 可选发现失败：没有 claude-session 行，成员可达性照常。
      }
    }
    let cursorOf = new Map<string, number>();
    let lastSeq = 0;
    try {
      const rc = await fetchReadCursors(cfg.server, cfg.token, channel);
      lastSeq = rc.last_seq;
      cursorOf = new Map(rc.cursors.map((c) => [c.name, c.last_seen_seq]));
    } catch {
      /* 端点不存在：不标注游标 */
    }
    const rows = buildAgentRows(channel, presence, Date.now(), {
      discovery,
      cursorOf,
      lastSeq,
      localHealth: { cache: readHealthCache(process.cwd(), channel) },
    });
    if (flags.json === true) {
      for (const r of rows) console.log(JSON.stringify(r));
      return 0;
    }
    if (rows.length === 0) {
      console.log(`no addressable agents in ${channel} yet`);
      return 0;
    }
    for (const line of renderAgentTable(rows)) console.log(line);
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}

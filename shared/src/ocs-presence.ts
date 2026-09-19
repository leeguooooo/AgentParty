// 本机 ocs 会话上报（#1113，#1104 的网页侧）：浏览器跑不了 `ocs who`，所以 CLI（serve / mcp）
// 周期性把本机 ocs 会话摘要经已认证的 WS 上报给 ChannelDO，DO 按身份挂着、带过期、断线即清，
// 再按观看者身份裁剪后扇出给网页。三端（CLI / worker / web）共用的契约都在这里：
// 线格式、上界常量、清洗、可见性裁剪、校验。
//
// 可见性（服务端执行，不信客户端）：cwd / label / status 属于本机隐私，只给「上报者本人」与
// 「频道 owner」看；其他成员只拿到 harness + 短地址 + 是否同项目 + 宿主类别（+ 已在频道里的 party 身份）。

export type OcsHarness = "claude" | "codex" | "pi";
/** 宿主类别：terminal = 有 tty 的终端会话；desktop = 桌面应用内的任务；process = 只知道 pid；unknown。 */
export type OcsHostKind = "terminal" | "desktop" | "process" | "unknown";

export const OCS_HARNESSES: readonly OcsHarness[] = ["claude", "codex", "pi"];
export const OCS_HOST_KINDS: readonly OcsHostKind[] = ["terminal", "desktop", "process", "unknown"];

/** CLI 上报周期。 */
export const OCS_ROSTER_REPORT_INTERVAL_MS = 60_000;
/** DO 保留一次上报的时长；超过即视为过期（上报方卡死/睡眠也不会留僵值）。 */
export const OCS_ROSTER_TTL_MS = 3 * OCS_ROSTER_REPORT_INTERVAL_MS;
/** 单次上报最多携带的会话数。 */
export const OCS_ROSTER_MAX_SESSIONS = 50;
export const OCS_ADDR_MAX = 128;
export const OCS_LABEL_MAX = 120;
export const OCS_CWD_MAX = 512;
export const OCS_STATUS_MAX = 40;
export const OCS_SESSION_KEY_MAX = 128;

/** CLI → DO 的单条会话。session_key 只供 DO 匹配频道内 party 身份，匹配完即丢，绝不扇出。 */
export interface OcsSessionReport {
  addr: string;
  harness: OcsHarness;
  label?: string;
  cwd?: string | null;
  same_project: boolean;
  host_kind: OcsHostKind;
  status?: string;
  /** 这条就是上报者自己所在的会话。 */
  self?: boolean;
  session_key?: string;
}

/** CLI → DO。发送者身份由连接决定；sessions 为空 = 本机没有会话（也用于主动清除）。 */
export interface OcsRosterClientFrame {
  type: "ocs_roster";
  sessions: OcsSessionReport[];
}

/** 扇出给观看者的单条会话。cwd / label / status 仅 full 视图才有。 */
export interface OcsSessionView {
  addr: string;
  harness: OcsHarness;
  same_project: boolean;
  host_kind: OcsHostKind;
  self?: boolean;
  /** 该会话在本频道里的 party 身份（DO 按 presence.agent_session 匹配）；有它才可 @。 */
  party_name?: string;
  cwd?: string | null;
  label?: string;
  status?: string;
}

/** DO → 观看者。sessions 为空 = 该身份的本机会话已清除（断线/过期/移除）。 */
export interface OcsRosterFrame {
  type: "ocs_roster";
  /** 上报者的 party 身份（来自连接认证）。 */
  name: string;
  sessions: OcsSessionView[];
  /** 服务端收到上报的时刻。 */
  ts: number;
  /** 过期时刻；观看者过了这个点应自行隐藏。 */
  expires_at: number;
  /** 本观看者拿到的是否为完整视图（上报者本人 / 频道 owner）。 */
  full: boolean;
}

// ---- 清洗 ----

const ch = (code: number): string => String.fromCharCode(code);
const CONTROL_RANGES: Array<[number, number]> = [
  [0, 31],
  [127, 159],
  [8232, 8238],
  [8294, 8297],
];
const CONTROL_PATTERN = new RegExp(`[${CONTROL_RANGES.map(([a, b]) => `${ch(a)}-${ch(b)}`).join("")}]`, "g");

/** 单行纯文本：去控制字符/双向覆盖字符、压空白、截断。返回空串表示无有效内容。 */
export function sanitizeOcsText(value: string, max: number): string {
  const cleaned = value.replace(CONTROL_PATTERN, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = sanitizeOcsText(value, max);
  return s === "" ? undefined : s;
}

function parseReport(raw: unknown): OcsSessionReport | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.harness !== "string" || !(OCS_HARNESSES as readonly string[]).includes(raw.harness)) return null;
  if (typeof raw.addr !== "string") return null;
  const addr = sanitizeOcsText(raw.addr, OCS_ADDR_MAX);
  // 地址会被拼进可复制的 shell 命令：截断过的地址不是有效地址，整条丢掉而不是给一条错命令。
  // 含控制字符的原始地址同样不是 ocs 给得出的地址（可能是注入），整条丢。
  if (addr === "" || addr !== raw.addr || addr.endsWith("…")) return null;
  const hostKind = typeof raw.host_kind === "string" && (OCS_HOST_KINDS as readonly string[]).includes(raw.host_kind)
    ? (raw.host_kind as OcsHostKind)
    : "unknown";
  const label = optText(raw.label, OCS_LABEL_MAX);
  const status = optText(raw.status, OCS_STATUS_MAX);
  const cwd = raw.cwd === null ? null : optText(raw.cwd, OCS_CWD_MAX) ?? null;
  const key = typeof raw.session_key === "string" &&
      raw.session_key.length > 0 &&
      raw.session_key.length <= OCS_SESSION_KEY_MAX &&
      /^[A-Za-z0-9._:-]+$/.test(raw.session_key)
    ? raw.session_key
    : undefined;
  return {
    addr,
    harness: raw.harness as OcsHarness,
    ...(label === undefined ? {} : { label }),
    cwd,
    same_project: raw.same_project === true,
    host_kind: hostKind,
    ...(status === undefined ? {} : { status }),
    ...(raw.self === true ? { self: true } : {}),
    ...(key === undefined ? {} : { session_key: key }),
  };
}

/**
 * 校验并清洗 CLI 上报帧。整帧形状不对返回 null（静默丢弃）；单条脏会话只丢那一条。
 * 超上限只保留前 OCS_ROSTER_MAX_SESSIONS 条（CLI 已按相关度排好序）。服务端必须再跑一遍。
 */
export function parseOcsRosterClientFrame(input: unknown): OcsRosterClientFrame | null {
  if (!isRecord(input) || input.type !== "ocs_roster" || !Array.isArray(input.sessions)) return null;
  const sessions: OcsSessionReport[] = [];
  const seen = new Set<string>();
  for (const raw of input.sessions.slice(0, OCS_ROSTER_MAX_SESSIONS)) {
    const s = parseReport(raw);
    if (s === null || seen.has(s.addr)) continue;
    seen.add(s.addr);
    sessions.push(s);
  }
  return { type: "ocs_roster", sessions };
}

/** 在 presence 里找与该 ocs 会话同一个 harness session 的 party 身份（CLI 与 DO 同口径）。 */
export function matchOcsPartyName(
  harness: OcsHarness,
  sessionKey: string | null | undefined,
  presence: ReadonlyArray<{ name: string; agent_session?: { harness: string; session_id: string } }>,
): string | undefined {
  if (sessionKey === null || sessionKey === undefined || sessionKey === "") return undefined;
  const key = sessionKey.toLowerCase();
  for (const e of presence) {
    const s = e.agent_session;
    if (s === undefined) continue;
    const sid = s.session_id.toLowerCase();
    if (harness === "claude" && s.harness === "claude" && sid.startsWith(key)) return e.name;
    if (harness === "codex" && (s.harness === "codex" || s.harness === "codex-sdk") && sid === key) return e.name;
  }
  return undefined;
}

/**
 * 可见性裁剪（#1113）：服务端对每个观看者各跑一次。full=false 时只留
 * harness / 短地址 / 同项目 / 宿主类别 / self / party 身份——cwd、label、status 一律不出服务端。
 * session_key 无论谁看都不下发。
 */
export function viewOcsSessions(
  sessions: ReadonlyArray<OcsSessionReport & { party_name?: string }>,
  full: boolean,
): OcsSessionView[] {
  return sessions.map((s) => ({
    addr: s.addr,
    harness: s.harness,
    same_project: s.same_project,
    host_kind: s.host_kind,
    ...(s.self === true ? { self: true } : {}),
    ...(s.party_name === undefined ? {} : { party_name: s.party_name }),
    ...(full
      ? {
          cwd: s.cwd ?? null,
          ...(s.label === undefined ? {} : { label: s.label }),
          ...(s.status === undefined ? {} : { status: s.status }),
        }
      : {}),
  }));
}

function isSessionView(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.addr === "string" &&
    value.addr.length > 0 &&
    typeof value.harness === "string" &&
    (OCS_HARNESSES as readonly string[]).includes(value.harness) &&
    typeof value.same_project === "boolean" &&
    typeof value.host_kind === "string" &&
    (OCS_HOST_KINDS as readonly string[]).includes(value.host_kind) &&
    (value.self === undefined || value.self === true) &&
    (value.party_name === undefined || typeof value.party_name === "string") &&
    (value.cwd === undefined || value.cwd === null || typeof value.cwd === "string") &&
    (value.label === undefined || typeof value.label === "string") &&
    (value.status === undefined || typeof value.status === "string");
}

/** 服务端广播帧的结构校验（web 用；CLI client.ts 另有逐字镜像）。 */
export function isOcsRosterFrame(value: unknown): value is OcsRosterFrame {
  return isRecord(value) &&
    value.type === "ocs_roster" &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    Array.isArray(value.sessions) &&
    value.sessions.every(isSessionView) &&
    typeof value.ts === "number" &&
    Number.isFinite(value.ts) &&
    typeof value.expires_at === "number" &&
    Number.isFinite(value.expires_at) &&
    typeof value.full === "boolean";
}

/** 可复制的介入命令：与 CLI `party who` 的 intervene 同口径（安全字符不加引号，否则单引号包起来）。 */
export function ocsDmCommand(addr: string): string {
  const quoted = /^[A-Za-z0-9._:@/-]+$/.test(addr) ? addr : `'${addr.replace(/'/g, `'\\''`)}'`;
  return `ocs dm ${quoted} "…"`;
}

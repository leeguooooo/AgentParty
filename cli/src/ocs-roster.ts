// #1104：把 `ocs who` 列出的本机活会话并进 party who / party agents / MCP party_who，
// 给出可直接执行的介入地址。数据源就是 `ocs who --json`——不重写 ocs 的发现逻辑。
//
// 两个地址空间不混：ocs 短地址（codex-<8hex> / pi-<8hex> / claude 名字）只能 `ocs dm`，
// 服务端解析不了，绝不当成频道 @mention。只有当该会话在本频道 presence 里有 party 身份
// （agent_session.session_id 对得上）时，才额外给出 `party send --mention <name>`。
import { spawnSync } from "node:child_process";
import { matchOcsPartyName, type OcsHostKind, type OcsSessionReport, type PresenceEntry } from "@agentparty/shared";
import { sanitizeSingleLine } from "./format";

export const OCS_INSTALL_HINT =
  "ocs not installed — local agents outside the channel are hidden. install: curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh (then: ocs doctor)";

export type OcsWake = "ocs_dm" | "party_mention" | "unreachable";

export interface OcsRow {
  source: "ocs";
  addr: string;
  harness: "claude" | "codex" | "pi";
  /** ocs 给的可读名（claude 会话名 / pi 名 / codex 摘要），纯展示。 */
  label?: string;
  cwd: string | null;
  same_project: boolean;
  /** 宿主，口径同 `ocs who`：queue pid · 应用 · tty / desktop / pid。 */
  host: string | null;
  /** 宿主类别（#1113 网页上报用的粗粒度口径）。 */
  host_kind: OcsHostKind;
  status?: string;
  self: boolean;
  wake: OcsWake[];
  /** 本频道里的 party 身份（仅在 session id 对得上时有）。 */
  party_name?: string;
  intervene: string;
  mention?: string;
}

export type OcsRosterResult =
  | { status: "ok"; rows: OcsRow[] }
  | { status: "missing"; hint: string }
  | { status: "error"; hint: string };

interface RawEntry {
  kind?: unknown;
  [k: string]: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function samePath(a: string | null, b: string): boolean {
  if (a === null) return false;
  const norm = (p: string): string => p.replace(/\/+$/, "");
  return norm(a) === norm(b);
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9._:@\/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

interface ParsedEntry {
  harness: OcsRow["harness"];
  addr: string;
  label: string | null;
  host: string | null;
  hostKind: OcsHostKind;
  status: string | null;
  sessionKey: string | null;
  cwd: string | null;
  self: boolean;
}

/** 单条 `ocs who --json` entry → 结构化字段；cmux 面板等无会话身份的返回 null。 */
function parseEntry(e: RawEntry): ParsedEntry | null {
  let harness: OcsRow["harness"];
  let addr: string | null;
  let label: string | null = null;
  let host: string | null = null;
  let hostKind: OcsHostKind = "unknown";
  let status: string | null = null;
  let sessionKey: string | null = null;
  const cwd = str(e.cwd);
  if (e.kind === "claude") {
    harness = "claude";
    // 与 `ocs who` 文本口径一致：ocs rename 名 > workspace 别名 > 会话名；不变短 id 做兜底。
    addr = str(e.ocsName) ?? str(e.workspaceAlias) ?? str(e.name) ?? str(e.id);
    label = str(e.id) !== null && str(e.id) !== addr ? str(e.id) : null;
    const pid = num(e.pid);
    host = pid === null ? null : `pid ${pid}`;
    hostKind = pid === null ? "unknown" : "process";
    status = str(e.status);
    sessionKey = str(e.id)?.replace(/^claude-/, "") ?? null;
  } else if (e.kind === "codex-task") {
    harness = "codex";
    addr = str(e.ocsName) ?? str(e.target);
    label = str(e.summary);
    const pid = num(e.livePid);
    host = pid === null
      ? "desktop"
      : ["queue pid " + pid, str(e.hostApp), str(e.tty)].filter((x) => x !== null).join(" · ");
    hostKind = pid === null ? "desktop" : str(e.tty) !== null ? "terminal" : "process";
    sessionKey = str(e.threadId);
  } else if (e.kind === "pi") {
    harness = "pi";
    addr = str(e.ocsName) ?? str(e.target);
    label = str(e.name);
    const pid = num(e.pid);
    host = pid === null ? null : `pid ${pid}`;
    hostKind = pid === null ? "unknown" : "process";
    sessionKey = str(e.sessionId);
  } else {
    return null; // cmux 面板没有会话身份/cwd，不列
  }
  if (addr === null) return null;
  return { harness, addr, label, host, hostKind, status, sessionKey, cwd, self: e.self === true };
}

/** 把 `ocs who --json` 的 entries 转成介入行。导出供单测。 */
export function buildOcsRows(
  entries: RawEntry[],
  opts: { cwd: string; presence?: PresenceEntry[]; channel?: string },
): OcsRow[] {
  const presence = opts.presence ?? [];
  const rows: OcsRow[] = [];
  for (const e of entries) {
    const p = parseEntry(e);
    if (p === null) continue;
    const { harness, addr, label, host, status, sessionKey, cwd } = p;
    const partyName = matchOcsPartyName(harness, sessionKey, presence);
    const wake: OcsWake[] = ["ocs_dm"];
    if (partyName !== undefined) wake.push("party_mention");
    const intervene = `ocs dm ${shellQuote(addr)} "…"`;
    rows.push({
      source: "ocs",
      addr,
      harness,
      ...(label === null ? {} : { label }),
      cwd,
      same_project: samePath(cwd, opts.cwd),
      host,
      host_kind: p.hostKind,
      ...(status === null ? {} : { status }),
      self: p.self,
      wake,
      ...(partyName === undefined ? {} : { party_name: partyName }),
      intervene,
      ...(partyName === undefined
        ? {}
        : { mention: `party send "@${partyName} …" --mention ${partyName}${opts.channel ? ` --channel ${opts.channel}` : ""}` }),
    });
  }
  // 当前项目 → 已有 party 身份（频道内可唤醒）→ 其他；self 沉到同组末尾。
  const rank = (r: OcsRow): number => (r.same_project ? 0 : 2) + (r.wake.includes("party_mention") ? 0 : 1);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || Number(a.r.self) - Number(b.r.self) || a.i - b.i)
    .map(({ r }) => r);
}

/**
 * #1113：把 `ocs who --json` 的 entries 转成上报给频道的会话摘要（网页 Presence 的「本机可介入」）。
 * 带 session_key 供服务端匹配 party 身份；服务端裁剪 cwd/label/status 的可见性，这里不做取舍。
 */
export function buildOcsReports(entries: RawEntry[], cwd: string): OcsSessionReport[] {
  const out: OcsSessionReport[] = [];
  for (const e of entries) {
    const p = parseEntry(e);
    if (p === null) continue;
    out.push({
      addr: p.addr,
      harness: p.harness,
      ...(p.label === null ? {} : { label: p.label }),
      cwd: p.cwd,
      same_project: samePath(p.cwd, cwd),
      host_kind: p.hostKind,
      ...(p.status === null ? {} : { status: p.status }),
      ...(p.self ? { self: true } : {}),
      ...(p.sessionKey === null ? {} : { session_key: p.sessionKey }),
    });
  }
  // 当前项目在前（服务端按上限截断时保留最相关的）。
  return out.map((r, i) => ({ r, i })).sort((a, b) => Number(b.r.same_project) - Number(a.r.same_project) || a.i - b.i).map(({ r }) => r);
}

/** 解析 `ocs who --json` 的 stdout；形状不对返回 null。 */
export function parseOcsEntries(stdout: string): RawEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const entries = (parsed as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return null;
  return entries.filter((x): x is RawEntry => typeof x === "object" && x !== null);
}

export type OcsExec = () => { missing: boolean; status: number | null; stdout: string; timedOut?: boolean };

// `ocs who` 要 lsof + ps 判活，本机负载高时实测 4–5s；给足余量，超时单独说清。
const OCS_TIMEOUT_MS = 15_000;

function defaultExec(): ReturnType<OcsExec> {
  const res = spawnSync(process.env.AGENTPARTY_OCS_BIN ?? "ocs", ["who", "--json"], { encoding: "utf8", timeout: OCS_TIMEOUT_MS });
  const err = res.error as NodeJS.ErrnoException | undefined;
  if (err?.code === "ENOENT") return { missing: true, status: null, stdout: "" };
  if (err?.code === "ETIMEDOUT") return { missing: false, status: null, stdout: "", timedOut: true };
  return { missing: false, status: res.status, stdout: res.stdout ?? "" };
}

/** 读本机 ocs 花名册。永不抛：没装 → missing + 修法；读不了 → error + 一句提示。 */
export function readOcsRoster(opts: {
  cwd?: string;
  presence?: PresenceEntry[];
  channel?: string;
  exec?: OcsExec;
}): OcsRosterResult {
  let res;
  try {
    res = (opts.exec ?? defaultExec)();
  } catch {
    return { status: "error", hint: "ocs who failed — local agents hidden (try: ocs doctor)" };
  }
  if (res.missing) return { status: "missing", hint: OCS_INSTALL_HINT };
  if (res.timedOut === true) return { status: "error", hint: `ocs who timed out after ${OCS_TIMEOUT_MS / 1000}s — local agents hidden (try: ocs doctor)` };
  if (res.status !== 0) return { status: "error", hint: "ocs who failed — local agents hidden (try: ocs doctor)" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { status: "error", hint: "ocs who --json returned unreadable output — local agents hidden (try: ocs doctor)" };
  }
  const entries = (parsed as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) {
    return { status: "error", hint: "ocs who --json returned no entries list — local agents hidden (try: ocs doctor)" };
  }
  return {
    status: "ok",
    rows: buildOcsRows(entries.filter((x): x is RawEntry => typeof x === "object" && x !== null), {
      cwd: opts.cwd ?? process.cwd(),
      ...(opts.presence === undefined ? {} : { presence: opts.presence }),
      ...(opts.channel === undefined ? {} : { channel: opts.channel }),
    }),
  };
}

function shortenHome(p: string): string {
  const home = process.env.HOME;
  return home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p;
}

/** 文本渲染：每行先 sanitizeSingleLine 再拼（本模块不上色）。 */
export function renderOcsSection(result: OcsRosterResult): string[] {
  if (result.status !== "ok") return [sanitizeSingleLine(result.hint)];
  if (result.rows.length === 0) return ["local agents (ocs): none running"];
  const lines = [`local agents (ocs) — ${result.rows.length} on this machine:`];
  for (const r of result.rows) {
    const parts = [
      sanitizeSingleLine(r.addr),
      r.harness,
      ...(r.status !== undefined ? [sanitizeSingleLine(r.status)] : []),
      ...(r.host !== null ? [`[${sanitizeSingleLine(r.host)}]`] : []),
      r.cwd === null ? "cwd ?" : sanitizeSingleLine(shortenHome(r.cwd)),
      ...(r.label !== undefined ? [sanitizeSingleLine(r.label).slice(0, 50)] : []),
      ...(r.same_project ? ["[current project]"] : []),
      ...(r.party_name !== undefined ? [`= @${sanitizeSingleLine(r.party_name)}`] : []),
      ...(r.self ? ["(you)"] : []),
    ];
    lines.push("  ◇ " + parts.join("  "));
    if (!r.self) {
      lines.push("      ↳ " + sanitizeSingleLine(r.intervene) + (r.mention !== undefined ? "  ·  " + sanitizeSingleLine(r.mention) : ""));
    }
  }
  return lines;
}

/** JSON 模式：ocs 行照常一行一个 JSON（source:"ocs"）；缺 ocs 时 stdout 保持干净，修法走 stderr。 */
export function emitOcsJson(ocs: OcsRosterResult): void {
  if (ocs.status === "ok") {
    for (const r of ocs.rows) console.log(JSON.stringify(r));
  } else {
    console.error(ocs.hint);
  }
}

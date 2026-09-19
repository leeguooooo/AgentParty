// Live session output（#1103）：runner（party serve --runner claude|codex）把本轮模型输出、
// tool/shell 调用、stdout/stderr 片段经已有 WS 连接上报给 ChannelDO，DO 按频道扇出只读帧，
// 并为晚到的观看者保留一个有界环形缓冲。这里是三端（CLI / worker / web）共用的契约：
// 线格式、上界常量、脱敏与校验。任何一端都不得绕过 sanitize 直接转发原文。

export type SessionOutputKind = "text" | "tool" | "stdout" | "stderr" | "system";
export type SessionOutputState = "running" | "done" | "blocked" | "failed" | "disconnected";

export const SESSION_OUTPUT_KINDS: readonly SessionOutputKind[] = ["text", "tool", "stdout", "stderr", "system"];
export const SESSION_OUTPUT_STATES: readonly SessionOutputState[] = [
  "running",
  "done",
  "blocked",
  "failed",
  "disconnected",
];

/** 单行上限（字符）。超出截断并加 … 标记。 */
export const SESSION_OUTPUT_LINE_MAX_CHARS = 2_000;
/** 单帧最多携带的行数。 */
export const SESSION_OUTPUT_LINES_PER_FRAME = 50;
/** DO 为每个 agent 保留的最近行数（晚到者回放用）。 */
export const SESSION_OUTPUT_RING_LINES = 300;
/** session_id 长度上限。 */
export const SESSION_OUTPUT_SESSION_ID_MAX = 128;

export interface SessionOutputLine {
  kind: SessionOutputKind;
  text: string;
  /** 行产生时刻（epoch ms，runner 本地钟；仅作展示，不用于定序）。 */
  ts: number;
}

/** runner → DO。发送者身份由连接决定，帧里不带 name，杜绝冒名。 */
export interface SessionOutputClientFrame {
  type: "session_output";
  /** 本轮运行会话的标识（runner 生成；同一轮所有帧同一个 id）。 */
  session_id: string;
  /** 触发这一轮的消息 seq；未知为 null。 */
  task_seq: number | null;
  state: SessionOutputState;
  lines: SessionOutputLine[];
}

/** DO → 频道所有观看者。只读；不携带任何 token / 路径以外的连接私有信息。 */
export interface SessionOutputFrame {
  type: "session_output";
  /** agent 身份名（来自连接认证，不来自 runner 自报）。 */
  name: string;
  session_id: string;
  task_seq: number | null;
  state: SessionOutputState;
  lines: SessionOutputLine[];
  /** 服务端落地时刻。 */
  ts: number;
  /** hello 时从环形缓冲回放的快照帧：lines 为该 session 的完整保留尾部（替换而非追加）。 */
  replay?: true;
}

// ---- 脱敏 ----

const REDACTED = "[redacted]";

// 顺序有意义：先抹具体已知格式，再抹通用 key=value / Bearer。
const SECRET_PATTERNS: RegExp[] = [
  /\bap_[A-Za-z0-9_-]{8,}/g, // AgentParty 机器 token
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, // Anthropic / OpenAI 风格
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// key=value / key: value / "key": "value"，key 名里含敏感词。
const KEY_VALUE_PATTERN =
  /((?:["']?)[A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|credential)[A-Za-z0-9_.-]*(?:["']?)\s*[:=]\s*)(["']?)[^\s"',;}]{4,}\2/gi;
// URL 里的 userinfo：https://user:pass@host
const URL_USERINFO_PATTERN = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(BEARER_PATTERN, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(KEY_VALUE_PATTERN, (_m, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`);
  out = out.replace(URL_USERINFO_PATTERN, (_m, scheme: string) => `${scheme}${REDACTED}@`);
  return out;
}

// ANSI CSI/OSC 与除 \t \n 外的控制字符：终端视图是纯文本，绝不把转义序列交给浏览器/下游终端解释。
const ch = (code: number): string => String.fromCharCode(code);
const ESC = ch(27);
const BEL = ch(7);
const ANSI_PATTERN = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
  "g",
);
const CONTROL_RANGES: Array<[number, number]> = [
  [0, 8],
  [11, 31],
  [127, 159],
  [8232, 8238],
  [8294, 8297],
];
const CONTROL_PATTERN = new RegExp(`[${CONTROL_RANGES.map(([a, b]) => `${ch(a)}-${ch(b)}`).join("")}]`, "g");

/** 单行清洗：去 ANSI/控制字符、\r\n 归一、脱敏、截断。换行保留（一个 line 可以是多行片段）。 */
export function sanitizeSessionOutputText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
  // 先截到略大于上限再脱敏，避免超长输入上跑正则；脱敏后再按上限截断。
  const bounded = normalized.length > SESSION_OUTPUT_LINE_MAX_CHARS * 2
    ? normalized.slice(0, SESSION_OUTPUT_LINE_MAX_CHARS * 2)
    : normalized;
  const redacted = redactSecrets(bounded);
  return redacted.length > SESSION_OUTPUT_LINE_MAX_CHARS
    ? `${redacted.slice(0, SESSION_OUTPUT_LINE_MAX_CHARS - 1)}…`
    : redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLine(raw: unknown): SessionOutputLine | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.kind !== "string" || !(SESSION_OUTPUT_KINDS as readonly string[]).includes(raw.kind)) return null;
  if (typeof raw.text !== "string") return null;
  if (typeof raw.ts !== "number" || !Number.isFinite(raw.ts) || raw.ts < 0) return null;
  const text = sanitizeSessionOutputText(raw.text);
  if (text.trim() === "") return null;
  return { kind: raw.kind as SessionOutputKind, text, ts: Math.floor(raw.ts) };
}

/**
 * 校验并清洗 runner 上报帧。脏帧整帧返回 null（静默丢弃）；单行脏值只丢那一行。
 * 行数超上限只保留最后 SESSION_OUTPUT_LINES_PER_FRAME 行（最新输出更有价值）。
 * 服务端必须再跑一遍——不信任客户端已经脱敏。
 */
export function parseSessionOutputClientFrame(input: unknown): SessionOutputClientFrame | null {
  if (!isRecord(input) || input.type !== "session_output") return null;
  const sessionId = input.session_id;
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.length > SESSION_OUTPUT_SESSION_ID_MAX ||
    !/^[A-Za-z0-9._:-]+$/.test(sessionId)
  ) {
    return null;
  }
  const taskSeq = input.task_seq;
  if (taskSeq !== null && !(typeof taskSeq === "number" && Number.isInteger(taskSeq) && taskSeq > 0)) return null;
  if (typeof input.state !== "string" || !(SESSION_OUTPUT_STATES as readonly string[]).includes(input.state)) return null;
  // disconnected 只能由服务端判定（连接断了），runner 自报无意义。
  if (input.state === "disconnected") return null;
  if (!Array.isArray(input.lines)) return null;
  const tail = input.lines.slice(-SESSION_OUTPUT_LINES_PER_FRAME);
  const lines: SessionOutputLine[] = [];
  for (const raw of tail) {
    const line = parseLine(raw);
    if (line !== null) lines.push(line);
  }
  return {
    type: "session_output",
    session_id: sessionId,
    task_seq: taskSeq as number | null,
    state: input.state as SessionOutputState,
    lines,
  };
}

/** 服务端广播帧的结构校验（CLI client.ts 与 web 共用口径；client.ts 另有逐字镜像）。 */
export function isSessionOutputFrame(value: unknown): value is SessionOutputFrame {
  if (!isRecord(value) || value.type !== "session_output") return false;
  return (
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.session_id === "string" &&
    value.session_id.length > 0 &&
    (value.task_seq === null || (typeof value.task_seq === "number" && Number.isInteger(value.task_seq) && value.task_seq > 0)) &&
    typeof value.state === "string" &&
    (SESSION_OUTPUT_STATES as readonly string[]).includes(value.state) &&
    Array.isArray(value.lines) &&
    value.lines.every(
      (line) =>
        isRecord(line) &&
        typeof line.kind === "string" &&
        (SESSION_OUTPUT_KINDS as readonly string[]).includes(line.kind) &&
        typeof line.text === "string" &&
        typeof line.ts === "number",
    ) &&
    typeof value.ts === "number" &&
    (value.replay === undefined || value.replay === true)
  );
}

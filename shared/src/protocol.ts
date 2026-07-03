// agentparty wire protocol — worker 与 cli 的单一事实来源

// ---- 常量 ----

export const BODY_LIMIT = 100_000;
export const RATE_LIMIT_PER_MIN = 30;
export const LOOP_GUARD_N = 30;
// party 模式（spec §3）：多 agent 头脑风暴/分工频道，loop guard 放宽
export const LOOP_GUARD_PARTY_N = 200;
export const RETAIN_N = 10_000;
export const PRESENCE_TIMEOUT_MS = 60_000;
// temp 频道最后一条消息后闲置多久自动归档（spec §6）
export const TEMP_IDLE_ARCHIVE_MS = 14 * 24 * 60 * 60 * 1000;
// outbound webhook（spec §15）：短超时 + 1/4/16 分钟退避重试
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_RETRIES = 3;
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 240_000, 960_000] as const;
export const MAX_WEBHOOKS_PER_CHANNEL = 20;
export const MAX_WEBHOOK_QUEUE_ROWS = 200;
export const WEBHOOK_RETRY_BATCH_SIZE = 25;

// cli 退出码
export const EXIT_TIMEOUT = 2;
export const EXIT_AUTH = 3;
export const EXIT_LOOP_GUARD = 4;
export const EXIT_ARCHIVED = 5;

// ---- 基础类型 ----

export type SenderKind = "agent" | "human";
export type TokenRole = "agent" | "human" | "readonly";
export type ChannelKind = "standing" | "temp";
export type ChannelMode = "normal" | "party";
export type MessageKind = "message" | "status";
export type WebhookFilter = "mentions" | "all";

export type StatusState = "working" | "waiting" | "blocked" | "done";
export type PresenceState = StatusState | "offline";

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "rate_limited"
  | "too_large"
  | "loop_guard"
  | "archived"
  | "not_found";

export type RestErrorCode = ErrorCode | "conflict" | "unavailable";

export interface Sender {
  name: string;
  kind: SenderKind;
}

export interface PresenceEntry {
  name: string;
  state: PresenceState;
  note: string | null;
  ts: number;
}

// ---- 客户端 → 服务端帧 ----

export interface HelloFrame {
  type: "hello";
  since: number;
}

export interface SendMessageFrame {
  type: "send";
  kind: "message";
  body: string;
  mentions: string[];
  reply_to: number | null;
}

export interface SendStatusFrame {
  type: "send";
  kind: "status";
  state: StatusState;
  note: string;
}

export type SendFrame = SendMessageFrame | SendStatusFrame;

export interface PingFrame {
  type: "ping";
}

export type ClientFrame = HelloFrame | SendFrame | PingFrame;

// ---- 服务端 → 客户端帧 ----

export interface WelcomeFrame {
  type: "welcome";
  channel: string;
  self: string;
  mode?: ChannelMode;
  /** 连接方 token 的角色；web 据此在首帧就隐藏 readonly 的输入框（spec §9），旧客户端忽略即可 */
  role?: TokenRole;
  participants: Sender[];
  last_seq: number;
  presence: PresenceEntry[];
}

export interface ParticipantsFrame {
  type: "participants";
  participants: Sender[];
}

export interface MsgFrame {
  type: "msg";
  seq: number;
  sender: Sender;
  kind: MessageKind;
  body: string;
  mentions: string[];
  reply_to: number | null;
  state: StatusState | null;
  note: string | null;
  ts: number;
}

export interface SentFrame {
  type: "sent";
  seq: number;
}

export interface PresenceFrame {
  type: "presence";
  name: string;
  state: PresenceState;
  note: string | null;
  ts: number;
}

export interface ErrorFrame {
  type: "error";
  code: ErrorCode;
  message: string;
}

export interface PongFrame {
  type: "pong";
}

export type ServerFrame =
  | WelcomeFrame
  | ParticipantsFrame
  | MsgFrame
  | SentFrame
  | PresenceFrame
  | ErrorFrame
  | PongFrame;

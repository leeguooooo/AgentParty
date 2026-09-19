// Live session output（#1103）的 DO 侧状态：每个 agent 一条最近 session 的有界环形缓冲 + 每连接限速。
// 纯内存、不落 SQLite：这是观测流而不是账本；DO 被驱逐后晚到者看不到旧输出，下一帧起恢复——
// 与「只读 live 视图」的承诺一致（结束/断线的最后一屏在 DO 存活期间可回看）。
import {
  SESSION_OUTPUT_RING_LINES,
  type SessionOutputClientFrame,
  type SessionOutputFrame,
  type SessionOutputLine,
  type SessionOutputState,
} from "@agentparty/shared";

/** 同时跟踪的 agent 上限；超出按最久未更新淘汰。 */
export const SESSION_OUTPUT_MAX_AGENTS = 64;
/** 每连接令牌桶：容量与每秒回填。终态帧不受限。 */
export const SESSION_OUTPUT_BUCKET_CAPACITY = 20;
export const SESSION_OUTPUT_BUCKET_REFILL_PER_SEC = 4;

interface SessionEntry {
  name: string;
  sessionId: string;
  taskSeq: number | null;
  state: SessionOutputState;
  lines: SessionOutputLine[];
  connectionId: string;
  updatedAt: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class SessionOutputRing {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly buckets = new Map<string, Bucket>();

  /**
   * 应用一帧 runner 上报（已由 parseSessionOutputClientFrame 清洗）。返回要广播的增量帧；
   * 被限速丢弃或无意义（非终态且无新行）时返回 null。
   */
  apply(name: string, connectionId: string, frame: SessionOutputClientFrame, now: number): SessionOutputFrame | null {
    const terminal = frame.state !== "running";
    if (!terminal && !this.take(connectionId, now)) return null;
    let entry = this.sessions.get(name);
    if (entry === undefined || entry.sessionId !== frame.session_id) {
      entry = {
        name,
        sessionId: frame.session_id,
        taskSeq: frame.task_seq,
        state: frame.state,
        lines: [],
        connectionId,
        updatedAt: now,
      };
      this.sessions.delete(name);
      this.sessions.set(name, entry);
      this.evict();
    } else if (entry.state !== "running") {
      // 已终态的 session 不再接收新行（防止终态后迟到帧改写最后一屏）。
      return null;
    }
    if (!terminal && frame.lines.length === 0 && entry.lines.length > 0) return null;
    entry.lines.push(...frame.lines);
    if (entry.lines.length > SESSION_OUTPUT_RING_LINES) entry.lines.splice(0, entry.lines.length - SESSION_OUTPUT_RING_LINES);
    entry.state = frame.state;
    entry.taskSeq = frame.task_seq ?? entry.taskSeq;
    entry.connectionId = connectionId;
    entry.updatedAt = now;
    return {
      type: "session_output",
      name,
      session_id: entry.sessionId,
      task_seq: entry.taskSeq,
      state: entry.state,
      lines: frame.lines,
      ts: now,
    };
  }

  /** 上报连接断开：该连接拥有的 running session 标 disconnected，返回广播帧。 */
  disconnect(connectionId: string, now: number): SessionOutputFrame[] {
    this.buckets.delete(connectionId);
    const out: SessionOutputFrame[] = [];
    for (const entry of this.sessions.values()) {
      if (entry.connectionId !== connectionId || entry.state !== "running") continue;
      entry.state = "disconnected";
      entry.updatedAt = now;
      out.push({
        type: "session_output",
        name: entry.name,
        session_id: entry.sessionId,
        task_seq: entry.taskSeq,
        state: "disconnected",
        lines: [],
        ts: now,
      });
    }
    return out;
  }

  /** 晚到者回放：每个 agent 一帧完整快照（replay:true，替换而非追加）。 */
  snapshot(): SessionOutputFrame[] {
    return [...this.sessions.values()].map((entry) => ({
      type: "session_output",
      name: entry.name,
      session_id: entry.sessionId,
      task_seq: entry.taskSeq,
      state: entry.state,
      lines: entry.lines.slice(),
      ts: entry.updatedAt,
      replay: true,
    }));
  }

  /** 成员被移除时清掉它的输出，不让已移除身份的最后一屏继续对外展示。 */
  forget(name: string): void {
    this.sessions.delete(name);
  }

  /** 只清某条连接上报的 session（stale principal 被替换时用；同名新连接的输出保留）。 */
  forgetConnection(name: string, connectionId: string): void {
    const entry = this.sessions.get(name);
    if (entry !== undefined && entry.connectionId === connectionId) this.sessions.delete(name);
    this.buckets.delete(connectionId);
  }

  private take(connectionId: string, now: number): boolean {
    const bucket = this.buckets.get(connectionId) ?? { tokens: SESSION_OUTPUT_BUCKET_CAPACITY, at: now };
    const elapsed = Math.max(0, now - bucket.at) / 1000;
    bucket.tokens = Math.min(SESSION_OUTPUT_BUCKET_CAPACITY, bucket.tokens + elapsed * SESSION_OUTPUT_BUCKET_REFILL_PER_SEC);
    bucket.at = now;
    this.buckets.set(connectionId, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private evict(): void {
    while (this.sessions.size > SESSION_OUTPUT_MAX_AGENTS) {
      let oldest: SessionEntry | null = null;
      for (const entry of this.sessions.values()) {
        if (oldest === null || entry.updatedAt < oldest.updatedAt) oldest = entry;
      }
      if (oldest === null) break;
      this.sessions.delete(oldest.name);
    }
  }
}

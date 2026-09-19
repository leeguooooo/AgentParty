// Live session output（#1103）的 DO 侧状态：每个 agent 一条最近 session 的有界环形缓冲 + 每连接限速。
// 环形缓冲经 SessionOutputStore 落 DO 内建 SQLite（有界：每 agent 最多 SESSION_OUTPUT_RING_LINES 行，
// 最多 SESSION_OUTPUT_MAX_AGENTS 个 agent），DO 被驱逐后晚到者仍能回放最后一屏；成员移除时一并删除。
// 令牌桶仍是纯内存（限速状态丢了只意味着多给一桶，无害）。存储失败一律吞掉：观测流绝不影响频道。
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

export interface SessionEntry {
  name: string;
  sessionId: string;
  taskSeq: number | null;
  state: SessionOutputState;
  lines: SessionOutputLine[];
  connectionId: string;
  updatedAt: number;
}

/** 最小 SQL 面（DO 的 ctx.storage.sql 满足它；测试可注入内存实现）。 */
export interface SessionOutputSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** 环形缓冲的持久化。 */
export interface SessionOutputStore {
  loadAll(): SessionEntry[];
  /** 新 session：清掉该 name 的旧行再写入元数据。 */
  reset(entry: SessionEntry): void;
  /** 追加新行并截到上限，同时更新元数据。 */
  append(entry: SessionEntry, lines: SessionOutputLine[]): void;
  updateMeta(entry: SessionEntry): void;
  remove(name: string): void;
}

export function createSqlSessionOutputStore(sql: SessionOutputSql): SessionOutputStore {
  sql.exec(`CREATE TABLE IF NOT EXISTS session_output_sessions (
    name TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_seq INTEGER,
    state TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS session_output_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS session_output_lines_name ON session_output_lines(name, id)");
  const upsertMeta = (entry: SessionEntry) => {
    sql.exec(
      `INSERT INTO session_output_sessions (name, session_id, task_seq, state, connection_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET session_id = excluded.session_id, task_seq = excluded.task_seq,
         state = excluded.state, connection_id = excluded.connection_id, updated_at = excluded.updated_at`,
      entry.name,
      entry.sessionId,
      entry.taskSeq,
      entry.state,
      entry.connectionId,
      entry.updatedAt,
    );
  };
  return {
    loadAll() {
      const metas = sql.exec(
        "SELECT name, session_id, task_seq, state, connection_id, updated_at FROM session_output_sessions",
      ).toArray();
      const out: SessionEntry[] = [];
      for (const row of metas) {
        const name = String(row.name);
        const lines = sql.exec(
          "SELECT kind, text, ts FROM session_output_lines WHERE name = ? ORDER BY id DESC LIMIT ?",
          name,
          SESSION_OUTPUT_RING_LINES,
        ).toArray().reverse().map((line) => ({
          kind: String(line.kind) as SessionOutputLine["kind"],
          text: String(line.text),
          ts: Number(line.ts),
        }));
        out.push({
          name,
          sessionId: String(row.session_id),
          taskSeq: row.task_seq === null || row.task_seq === undefined ? null : Number(row.task_seq),
          state: String(row.state) as SessionOutputState,
          lines,
          connectionId: String(row.connection_id),
          updatedAt: Number(row.updated_at),
        });
      }
      return out;
    },
    reset(entry) {
      sql.exec("DELETE FROM session_output_lines WHERE name = ?", entry.name);
      upsertMeta(entry);
    },
    append(entry, lines) {
      for (const line of lines) {
        sql.exec(
          "INSERT INTO session_output_lines (name, kind, text, ts) VALUES (?, ?, ?, ?)",
          entry.name,
          line.kind,
          line.text,
          line.ts,
        );
      }
      if (lines.length > 0) {
        sql.exec(
          `DELETE FROM session_output_lines WHERE name = ? AND id NOT IN
             (SELECT id FROM session_output_lines WHERE name = ? ORDER BY id DESC LIMIT ?)`,
          entry.name,
          entry.name,
          SESSION_OUTPUT_RING_LINES,
        );
      }
      upsertMeta(entry);
    },
    updateMeta: upsertMeta,
    remove(name) {
      sql.exec("DELETE FROM session_output_lines WHERE name = ?", name);
      sql.exec("DELETE FROM session_output_sessions WHERE name = ?", name);
    },
  };
}

interface Bucket {
  tokens: number;
  at: number;
}

export class SessionOutputRing {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly buckets = new Map<string, Bucket>();
  private loaded = false;

  constructor(private readonly store: SessionOutputStore | null = null) {}

  /** 懒加载：DO 重建后第一次用到时从存储恢复。 */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.store === null) return;
    try {
      const entries = this.store.loadAll().sort((a, b) => a.updatedAt - b.updatedAt);
      for (const entry of entries) this.sessions.set(entry.name, entry);
    } catch {
      // 读不出来就当空环：下一帧起恢复
    }
  }

  private persist(fn: (store: SessionOutputStore) => void): void {
    if (this.store === null) return;
    try {
      fn(this.store);
    } catch {
      // 观测流：存储失败不影响广播
    }
  }

  /**
   * 应用一帧 runner 上报（已由 parseSessionOutputClientFrame 清洗）。返回要广播的增量帧；
   * 被限速丢弃或无意义（非终态且无新行）时返回 null。
   */
  apply(name: string, connectionId: string, frame: SessionOutputClientFrame, now: number): SessionOutputFrame | null {
    this.ensureLoaded();
    const terminal = frame.state !== "running";
    if (!terminal && !this.take(connectionId, now)) return null;
    let entry = this.sessions.get(name);
    let fresh = false;
    if (entry === undefined || entry.sessionId !== frame.session_id) {
      fresh = true;
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
    const persisted = entry;
    this.persist((store) => {
      if (fresh) store.reset(persisted);
      store.append(persisted, frame.lines);
    });
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
    this.ensureLoaded();
    this.buckets.delete(connectionId);
    const out: SessionOutputFrame[] = [];
    for (const entry of this.sessions.values()) {
      if (entry.connectionId !== connectionId || entry.state !== "running") continue;
      entry.state = "disconnected";
      entry.updatedAt = now;
      this.persist((store) => store.updateMeta(entry));
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
  snapshot(liveConnectionIds?: ReadonlySet<string>, now: number = Date.now()): SessionOutputFrame[] {
    this.ensureLoaded();
    // 从存储恢复的 running session，其上报连接若已不在（DO 驱逐期间断的，close 回调没机会跑），
    // 按断线处理——绝不让观看者永远停在「running」。
    if (liveConnectionIds !== undefined) {
      for (const entry of this.sessions.values()) {
        if (entry.state !== "running" || liveConnectionIds.has(entry.connectionId)) continue;
        entry.state = "disconnected";
        entry.updatedAt = now;
        this.persist((store) => store.updateMeta(entry));
      }
    }
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
    this.ensureLoaded();
    this.sessions.delete(name);
    this.persist((store) => store.remove(name));
  }

  /** 只清某条连接上报的 session（stale principal 被替换时用；同名新连接的输出保留）。 */
  forgetConnection(name: string, connectionId: string): void {
    this.ensureLoaded();
    const entry = this.sessions.get(name);
    if (entry !== undefined && entry.connectionId === connectionId) {
      this.sessions.delete(name);
      this.persist((store) => store.remove(name));
    }
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
      const evicted = oldest.name;
      this.persist((store) => store.remove(evicted));
    }
  }
}

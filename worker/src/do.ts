// channel durable object — seq 分配 / 广播 / presence / 补拉 / 各类熔断
import {
  BODY_LIMIT,
  LOOP_GUARD_N,
  RATE_LIMIT_PER_MIN,
  RETAIN_N,
  type ErrorCode,
  type MsgFrame,
  type PresenceEntry,
  type PresenceFrame,
  type SendFrame,
  type SenderKind,
  type ServerFrame,
  type StatusState,
  type TokenRole,
} from "@agentparty/shared";
import { Server, type Connection, type ConnectionContext, type WSMessage } from "partyserver";

interface ConnState {
  name: string;
  kind: SenderKind;
  role: TokenRole;
  archived: boolean;
}

interface Identity {
  name: string;
  kind: SenderKind;
  role: TokenRole;
}

type SendOutcome =
  | { ok: true; seq: number; frames: ServerFrame[] }
  | { ok: false; code: ErrorCode; message: string };

export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthorized: 403,
  rate_limited: 429,
  too_large: 413,
  loop_guard: 409,
  archived: 410,
};

const STATUS_STATES: readonly string[] = ["working", "waiting", "blocked", "done"];

// rest body 与 ws send 帧共用的校验（rest 侧无 type 字段）
function parseSendFrame(input: unknown): SendFrame | null {
  if (typeof input !== "object" || input === null) return null;
  const f = input as Record<string, unknown>;
  if (f.kind === "message") {
    if (typeof f.body !== "string") return null;
    const mentions = Array.isArray(f.mentions)
      ? f.mentions.filter((m): m is string => typeof m === "string")
      : [];
    const reply_to = typeof f.reply_to === "number" ? f.reply_to : null;
    return { type: "send", kind: "message", body: f.body, mentions, reply_to };
  }
  if (f.kind === "status") {
    if (typeof f.state !== "string" || !STATUS_STATES.includes(f.state)) return null;
    const note = typeof f.note === "string" ? f.note : "";
    return { type: "send", kind: "status", state: f.state as StatusState, note };
  }
  return null;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

function toInt(value: string | null, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export class ChannelDO extends Server<Env> {
  static options = { hibernate: true };

  onStart() {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY,
      sender_name TEXT NOT NULL,
      sender_kind TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      mentions_json TEXT NOT NULL DEFAULT '[]',
      reply_to INTEGER,
      state TEXT,
      note TEXT,
      ts INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS presence (
      name TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      note TEXT,
      updated_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS rate (
      name TEXT NOT NULL,
      bucket INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (name, bucket)
    )`);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
  }

  onConnect(connection: Connection<ConnState>, ctx: ConnectionContext) {
    const h = ctx.request.headers;
    const state: ConnState = {
      name: h.get("x-ap-name") ?? "",
      kind: h.get("x-ap-kind") === "agent" ? "agent" : "human",
      role: (h.get("x-ap-role") ?? "readonly") as TokenRole,
      archived: h.get("x-ap-archived") === "1",
    };
    connection.setState(state);
    if (state.archived) {
      this.sendFrame(connection, { type: "error", code: "archived", message: "channel is archived" });
      connection.close(1008, "archived");
      return;
    }
    this.sendFrame(connection, {
      type: "welcome",
      channel: this.name,
      self: state.name,
      last_seq: this.lastSeq(),
      presence: this.presenceList(),
    });
  }

  onMessage(connection: Connection<ConnState>, message: WSMessage) {
    if (typeof message !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      return;
    }
    if (typeof raw !== "object" || raw === null) return;
    const frame = raw as Record<string, unknown>;
    const st = connection.state;
    if (!st) return;

    if (frame.type === "ping") {
      // setWebSocketAutoResponse 只匹配字面 '{"type":"ping"}'，这里兜底其余序列化
      this.sendFrame(connection, { type: "pong" });
      return;
    }
    if (frame.type === "hello") {
      const since = typeof frame.since === "number" && frame.since > 0 ? Math.floor(frame.since) : 0;
      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM messages WHERE seq > ? ORDER BY seq", since)
        .toArray();
      for (const row of rows) this.sendFrame(connection, this.rowToFrame(row));
      return;
    }
    if (frame.type === "send") {
      if (st.archived) {
        this.sendFrame(connection, { type: "error", code: "archived", message: "channel is archived" });
        return;
      }
      const send = parseSendFrame(frame);
      if (!send) return;
      const out = this.handleSend({ name: st.name, kind: st.kind, role: st.role }, send);
      if (!out.ok) {
        this.sendFrame(connection, { type: "error", code: out.code, message: out.message });
        return;
      }
      // sent 先于广播到达发送方，客户端先推进游标再看到自己的回声
      this.sendFrame(connection, { type: "sent", seq: out.seq });
      for (const f of out.frames) this.broadcast(JSON.stringify(f));
    }
  }

  onClose(connection: Connection<ConnState>) {
    const st = connection.state;
    if (!st || !st.name || st.archived) return;
    for (const other of this.getConnections<ConnState>()) {
      if (other.id !== connection.id && other.state?.name === st.name) return;
    }
    const ts = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO presence (name, state, note, updated_at) VALUES (?, 'offline', NULL, ?)
       ON CONFLICT(name) DO UPDATE SET state = 'offline', updated_at = excluded.updated_at`,
      st.name,
      ts,
    );
    const frame: PresenceFrame = { type: "presence", name: st.name, state: "offline", note: null, ts };
    this.broadcast(JSON.stringify(frame));
  }

  // worker 转发来的内部 rest
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/messages" && request.method === "GET") {
      const since = Math.max(toInt(url.searchParams.get("since"), 0), 0);
      const limit = Math.min(Math.max(toInt(url.searchParams.get("limit"), 100), 1), 1000);
      const rows = this.ctx.storage.sql
        .exec("SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?", since, limit)
        .toArray();
      return Response.json({ messages: rows.map((r) => this.rowToFrame(r)) });
    }
    if (url.pathname === "/internal/messages" && request.method === "POST") {
      const identity: Identity = {
        name: request.headers.get("x-ap-name") ?? "",
        kind: request.headers.get("x-ap-kind") === "agent" ? "agent" : "human",
        role: (request.headers.get("x-ap-role") ?? "readonly") as TokenRole,
      };
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return Response.json({ error: { code: "bad_request", message: "invalid json" } }, { status: 400 });
      }
      const send = parseSendFrame(raw);
      if (!send) {
        return Response.json({ error: { code: "bad_request", message: "invalid send payload" } }, { status: 400 });
      }
      const out = this.handleSend(identity, send);
      if (!out.ok) {
        return Response.json(
          { error: { code: out.code, message: out.message } },
          { status: ERROR_STATUS[out.code] },
        );
      }
      for (const f of out.frames) this.broadcast(JSON.stringify(f));
      return Response.json({ seq: out.seq });
    }
    if (url.pathname === "/internal/reset-guard" && request.method === "POST") {
      this.setMeta("agent_streak", "0");
      return Response.json({ ok: true });
    }
    if (url.pathname === "/internal/archive" && request.method === "POST") {
      // 存活连接的 archived 是连接时快照，归档后统一告知并关闭
      for (const connection of this.getConnections<ConnState>()) {
        const st = connection.state;
        if (st) connection.setState({ ...st, archived: true });
        this.sendFrame(connection, { type: "error", code: "archived", message: "channel is archived" });
        connection.close(1008, "archived");
      }
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }

  // 校验 → 分配 seq → 落库 → 修剪/presence，返回待广播帧
  private handleSend(identity: Identity, frame: SendFrame): SendOutcome {
    if (identity.role === "readonly") {
      return { ok: false, code: "unauthorized", message: "readonly token cannot send" };
    }
    const payload = frame.kind === "message" ? frame.body : frame.note;
    if (byteLength(payload) > BODY_LIMIT) {
      return { ok: false, code: "too_large", message: `body exceeds ${BODY_LIMIT} bytes` };
    }
    if (identity.kind === "agent" && this.agentStreak() >= LOOP_GUARD_N) {
      return {
        ok: false,
        code: "loop_guard",
        message: `${LOOP_GUARD_N} consecutive agent messages, waiting for a human`,
      };
    }
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const bucket = Math.floor(now / 60_000);
    sql.exec("DELETE FROM rate WHERE bucket < ?", bucket - 1);
    const used = sql
      .exec("SELECT count FROM rate WHERE name = ? AND bucket = ?", identity.name, bucket)
      .toArray();
    if (used.length > 0 && Number(used[0]!.count) >= RATE_LIMIT_PER_MIN) {
      return {
        ok: false,
        code: "rate_limited",
        message: `over ${RATE_LIMIT_PER_MIN} messages per minute`,
      };
    }
    sql.exec(
      `INSERT INTO rate (name, bucket, count) VALUES (?, ?, 1)
       ON CONFLICT(name, bucket) DO UPDATE SET count = count + 1`,
      identity.name,
      bucket,
    );

    const seq = this.lastSeq() + 1;
    const sender = { name: identity.name, kind: identity.kind };
    const msg: MsgFrame =
      frame.kind === "message"
        ? {
            type: "msg",
            seq,
            sender,
            kind: "message",
            body: frame.body,
            mentions: frame.mentions,
            reply_to: frame.reply_to,
            state: null,
            note: null,
            ts: now,
          }
        : {
            type: "msg",
            seq,
            sender,
            kind: "status",
            body: frame.note,
            mentions: [],
            reply_to: null,
            state: frame.state,
            note: frame.note,
            ts: now,
          };
    sql.exec(
      `INSERT INTO messages (seq, sender_name, sender_kind, kind, body, mentions_json, reply_to, state, note, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      seq,
      identity.name,
      identity.kind,
      msg.kind,
      msg.body,
      JSON.stringify(msg.mentions),
      msg.reply_to,
      msg.state,
      msg.note,
      now,
    );
    this.setMeta("agent_streak", String(identity.kind === "agent" ? this.agentStreak() + 1 : 0));
    if (seq % 100 === 0) {
      sql.exec("DELETE FROM messages WHERE seq <= ?", seq - RETAIN_N);
    }

    const frames: ServerFrame[] = [msg];
    if (frame.kind === "status") {
      sql.exec(
        `INSERT INTO presence (name, state, note, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET state = excluded.state, note = excluded.note, updated_at = excluded.updated_at`,
        identity.name,
        frame.state,
        frame.note,
        now,
      );
      frames.push({ type: "presence", name: identity.name, state: frame.state, note: frame.note, ts: now });
    }
    return { ok: true, seq, frames };
  }

  private sendFrame(connection: Connection, frame: ServerFrame) {
    connection.send(JSON.stringify(frame));
  }

  private lastSeq(): number {
    const row = this.ctx.storage.sql.exec("SELECT COALESCE(MAX(seq), 0) AS last FROM messages").one();
    return Number(row.last);
  }

  private agentStreak(): number {
    return Number(this.getMeta("agent_streak") ?? "0");
  }

  private getMeta(key: string): string | null {
    const rows = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows.length > 0 ? String(rows[0]!.value) : null;
  }

  private setMeta(key: string, value: string) {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private presenceList(): PresenceEntry[] {
    return this.ctx.storage.sql
      .exec("SELECT name, state, note, updated_at FROM presence ORDER BY name")
      .toArray()
      .map((r) => ({
        name: String(r.name),
        state: String(r.state) as PresenceEntry["state"],
        note: r.note === null ? null : String(r.note),
        ts: Number(r.updated_at),
      }));
  }

  private rowToFrame(r: Record<string, unknown>): MsgFrame {
    return {
      type: "msg",
      seq: Number(r.seq),
      sender: { name: String(r.sender_name), kind: String(r.sender_kind) as SenderKind },
      kind: String(r.kind) as MsgFrame["kind"],
      body: String(r.body),
      mentions: JSON.parse(String(r.mentions_json ?? "[]")) as string[],
      reply_to: r.reply_to === null ? null : Number(r.reply_to),
      state: r.state === null ? null : (String(r.state) as StatusState),
      note: r.note === null ? null : String(r.note),
      ts: Number(r.ts),
    };
  }
}

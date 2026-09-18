// Live session output 上报（#1103）：serve 把 runner 这一轮的模型输出 / tool 调用 / stdout/stderr
// 片段攒成有界、脱敏、限速的 session_output 帧，经已有 WS 连接发给 ChannelDO。
//
// 设计约束：
//  - 永远不阻塞 runner：push 只入内存队列，定时 flush；发送失败即丢（这是观测流，不是账本）。
//  - 有界：部分行缓冲、待发队列、单帧行数、单行长度都有上限；超出丢最老的并记一条 system 行。
//  - 限速：最多每 flushIntervalMs 一帧；终态帧（done/blocked/failed）不受限速，立即发。
//  - 脱敏在这里做一遍（sanitizeSessionOutputText），服务端再做一遍，谁都不信任对方。
import {
  SESSION_OUTPUT_LINE_MAX_CHARS,
  SESSION_OUTPUT_LINES_PER_FRAME,
  sanitizeSessionOutputText,
  type SessionOutputClientFrame,
  type SessionOutputKind,
  type SessionOutputLine,
  type SessionOutputState,
} from "@agentparty/shared";

export const SESSION_OUTPUT_FLUSH_INTERVAL_MS = 500;
/** 本地待发队列上限（行）；runner 喷得比限速快时丢最老的。 */
export const SESSION_OUTPUT_PENDING_MAX = 400;

export interface SessionOutputReporterOptions {
  send: (frame: SessionOutputClientFrame) => void;
  now?: () => number;
  flushIntervalMs?: number;
  /** 生成 session id；测试注入确定值。 */
  newSessionId?: () => string;
  /** 定时器注入（测试用假时钟）。 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type StreamName = "stdout" | "stderr";

export class SessionOutputReporter {
  private readonly send: (frame: SessionOutputClientFrame) => void;
  private readonly now: () => number;
  private readonly flushIntervalMs: number;
  private readonly newSessionId: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private sessionId: string | null = null;
  private taskSeq: number | null = null;
  private pending: SessionOutputLine[] = [];
  private partial: Record<StreamName, string> = { stdout: "", stderr: "" };
  private dropped = 0;
  private timer: unknown = null;
  private lastTool: string | null = null;

  constructor(opts: SessionOutputReporterOptions) {
    this.send = opts.send;
    this.now = opts.now ?? (() => Date.now());
    this.flushIntervalMs = opts.flushIntervalMs ?? SESSION_OUTPUT_FLUSH_INTERVAL_MS;
    this.newSessionId = opts.newSessionId ?? (() => `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    this.setTimer = opts.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      if (typeof (handle as { unref?: () => void }).unref === "function") (handle as { unref: () => void }).unref();
      return handle;
    });
    this.clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get activeSessionId(): string | null {
    return this.sessionId;
  }

  /** 新一轮开始：换新 session id，立即发一帧 running（让观看者马上看到「开始了」）。 */
  begin(taskSeq: number | null, note: string): string {
    if (this.sessionId !== null) this.end("failed", "superseded by a new run");
    this.sessionId = this.newSessionId();
    this.taskSeq = taskSeq;
    this.pending = [];
    this.partial = { stdout: "", stderr: "" };
    this.dropped = 0;
    this.lastTool = null;
    this.enqueue("system", note);
    this.flush("running");
    return this.sessionId;
  }

  /** 进程原始输出块：按换行切，残行缓存到下一块。 */
  chunk(stream: StreamName, text: string): void {
    if (this.sessionId === null || text === "") return;
    const combined = this.partial[stream] + text;
    const parts = combined.split(/\r?\n/);
    let rest = parts.pop() ?? "";
    // 没有换行的超长输出（进度条、单行 JSON）不能无限攒：到上限就当一行切出去。
    while (rest.length >= SESSION_OUTPUT_LINE_MAX_CHARS) {
      parts.push(rest.slice(0, SESSION_OUTPUT_LINE_MAX_CHARS));
      rest = rest.slice(SESSION_OUTPUT_LINE_MAX_CHARS);
    }
    this.partial[stream] = rest;
    for (const part of parts) this.enqueue(stream, part);
  }

  /** 一段完整文本（模型最终输出等）。 */
  line(kind: SessionOutputKind, text: string): void {
    if (this.sessionId === null) return;
    this.enqueue(kind, text);
  }

  /** tool 活动（来自 hook 落盘）：只在工具名变化时记一行，避免心跳重复刷。 */
  tool(name: string | null): void {
    if (this.sessionId === null || name === null || name === this.lastTool) return;
    this.lastTool = name;
    this.enqueue("tool", `▸ ${name}`);
  }

  /** 本轮结束：冲掉残行，发终态帧（不受限速），然后清空。 */
  end(state: Exclude<SessionOutputState, "running" | "disconnected">, note?: string): void {
    if (this.sessionId === null) return;
    for (const stream of ["stdout", "stderr"] as const) {
      if (this.partial[stream] !== "") this.enqueue(stream, this.partial[stream]);
      this.partial[stream] = "";
    }
    if (note !== undefined && note !== "") this.enqueue("system", note);
    this.flush(state);
    this.sessionId = null;
    this.taskSeq = null;
  }

  private enqueue(kind: SessionOutputKind, raw: string): void {
    const text = sanitizeSessionOutputText(raw);
    if (text.trim() === "") return;
    this.pending.push({ kind, text, ts: this.now() });
    if (this.pending.length > SESSION_OUTPUT_PENDING_MAX) {
      const over = this.pending.length - SESSION_OUTPUT_PENDING_MAX;
      this.pending.splice(0, over);
      this.dropped += over;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.sessionId !== null && (this.pending.length > 0 || this.dropped > 0)) this.flush("running");
    }, this.flushIntervalMs);
  }

  private flush(state: SessionOutputState): void {
    if (this.sessionId === null) return;
    if (this.dropped > 0) {
      this.pending.unshift({ kind: "system", text: `… ${this.dropped} line(s) dropped (output rate limit)`, ts: this.now() });
      this.dropped = 0;
    }
    // 限速：一次定时 flush 只发一帧；剩余的留给下一拍。终态帧则把剩余全部分帧发完。
    const terminal = state !== "running";
    do {
      const batch = this.pending.splice(0, SESSION_OUTPUT_LINES_PER_FRAME);
      const last = this.pending.length === 0;
      try {
        this.send({
          type: "session_output",
          session_id: this.sessionId,
          task_seq: this.taskSeq,
          state: terminal && !last ? "running" : state,
          lines: batch,
        });
      } catch {
        // 连接没就绪：观测流丢一帧无妨，runner 不受影响。
      }
      if (!terminal) break;
    } while (this.pending.length > 0);
    if (terminal) {
      if (this.timer !== null) {
        this.clearTimer(this.timer);
        this.timer = null;
      }
    } else if (this.pending.length > 0) {
      this.schedule();
    }
  }
}

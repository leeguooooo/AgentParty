// #1103 item 2：claude `-p --output-format stream-json --verbose --include-partial-messages` 的增量解析。
// stdout 是一行一个 JSON 事件：stream_event（text_delta 增量）、assistant（整条消息）、result（终态）。
// 这里把模型正文按行增量交给 live session 汇，同时保留最终 result 事件供 runner 按原口径解析。
// 只流正文（text）；工具调用由 hook 事件逐条上报（item 3），这里不重复。

export interface ClaudeStreamTextSink {
  line(kind: "text", text: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 从 claude stdout 取出「最终结果」对象：
 *  - 旧 `--output-format json`：整个 stdout 是一个 JSON 对象；
 *  - `stream-json`：取最后一个 `type:"result"` 的行。
 * 都没有返回 null。
 */
export function claudeResultBody(stdout: string): Record<string, unknown> | null {
  try {
    const whole = JSON.parse(stdout) as unknown;
    if (isRecord(whole)) return whole;
  } catch {
    // 不是单个 JSON：按 stream-json 逐行找
  }
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]!.trim();
    if (!raw.startsWith("{")) continue;
    try {
      const event = JSON.parse(raw) as unknown;
      if (isRecord(event) && event.type === "result") return event;
    } catch {
      // 半行/脏行跳过
    }
  }
  return null;
}

/** 增量解析器：feed(stdout 块)，end() 冲掉残行。回调抛错被吞（观测流不影响 runner）。 */
export class ClaudeStreamJsonParser {
  private buffer = "";
  private text = "";
  /** 已经用 text_delta 流过正文的消息 id：其 assistant 整条消息不再重复输出。 */
  private readonly streamedMessages = new Set<string>();
  private currentMessage: string | null = null;

  constructor(private readonly sink: ClaudeStreamTextSink) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    for (const part of parts) this.handleLine(part);
    // 防御：没有换行的超大残行不无限攒（单个事件不会这么大；超了就丢）。
    if (this.buffer.length > 4 * 1024 * 1024) this.buffer = "";
  }

  end(): void {
    if (this.buffer.trim() !== "") this.handleLine(this.buffer);
    this.buffer = "";
    this.flushText(true);
  }

  private emit(text: string): void {
    if (text.trim() === "") return;
    try {
      this.sink.line("text", text);
    } catch {
      // observation only
    }
  }

  private flushText(all: boolean): void {
    const pieces = this.text.split("\n");
    const rest = all ? "" : pieces.pop() ?? "";
    for (const piece of pieces) this.emit(piece);
    this.text = rest;
  }

  private handleLine(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) return;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    if (event.type === "stream_event" && isRecord(event.event)) {
      const inner = event.event;
      if (inner.type === "message_start" && isRecord(inner.message) && typeof inner.message.id === "string") {
        this.currentMessage = inner.message.id;
      } else if (inner.type === "content_block_delta" && isRecord(inner.delta) && inner.delta.type === "text_delta") {
        if (typeof inner.delta.text === "string") {
          if (this.currentMessage !== null) this.streamedMessages.add(this.currentMessage);
          this.text += inner.delta.text;
          this.flushText(false);
        }
      } else if (inner.type === "content_block_stop" || inner.type === "message_stop") {
        this.flushText(true);
      }
      return;
    }
    if (event.type === "assistant" && isRecord(event.message)) {
      // 没有 partial 事件（旧版 claude 忽略 --include-partial-messages）时，按整条消息输出正文。
      const id = typeof event.message.id === "string" ? event.message.id : null;
      if (id !== null && this.streamedMessages.has(id)) return;
      const content = Array.isArray(event.message.content) ? event.message.content : [];
      for (const block of content) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          for (const piece of block.text.split("\n")) this.emit(piece);
        }
      }
    }
  }
}

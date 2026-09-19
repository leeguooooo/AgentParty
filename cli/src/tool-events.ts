// #1103 item 3：工具调用逐条上报。serve 托管的 claude runner 里，`party hook report` 每次
// PreToolUse / PostToolUseFailure 都往 `<activity file>.tools.jsonl` 追加一行（只含工具名，入参正文
// 绝不落盘，与 activity 同口径）；serve 在本轮运行期间短间隔 tail 这个文件，把每一条都交给
// live session 流——不再只靠 15s 心跳采样，短工具调用不会漏。
import { appendFileSync, closeSync, fstatSync, openSync, readSync, rmSync, statSync } from "node:fs";

/** 单文件上限：超过就不再追加（一轮里几千次工具调用已远超观看价值；防失控写盘）。 */
export const TOOL_EVENTS_MAX_BYTES = 512 * 1024;
/** serve tail 间隔。 */
export const TOOL_EVENTS_POLL_MS = 250;

export type ToolEventStatus = "start" | "failed";

export interface ToolEvent {
  tool: string;
  status: ToolEventStatus;
  ts: number;
}

export function toolEventsFile(activityFile: string): string {
  return `${activityFile}.tools.jsonl`;
}

/** hook payload → 工具事件；非工具事件返回 null。 */
export function toolEventFromHook(payload: Record<string, unknown>, now: number): ToolEvent | null {
  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const tool = typeof payload.tool_name === "string" ? payload.tool_name.slice(0, 64).trim() : "";
  if (tool === "") return null;
  if (event === "PreToolUse") return { tool, status: "start", ts: now };
  if (event === "PostToolUseFailure") return { tool, status: "failed", ts: now };
  return null;
}

/** hook 侧追加（失败让它抛，调用方统一静默吞）。 */
export function appendToolEvent(path: string, event: ToolEvent): void {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    // 不存在
  }
  if (size >= TOOL_EVENTS_MAX_BYTES) return;
  appendFileSync(path, JSON.stringify(event) + "\n", { mode: 0o600 });
}

export function clearToolEvents(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // TTL 之外没有别的兜底需要：新一轮 tailer 从当前末尾读起
  }
}

function parseToolEvent(raw: string): ToolEvent | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.tool !== "string" || value.tool.trim() === "") return null;
    if (value.status !== "start" && value.status !== "failed") return null;
    if (typeof value.ts !== "number" || !Number.isFinite(value.ts)) return null;
    return { tool: value.tool.slice(0, 64), status: value.status, ts: value.ts };
  } catch {
    return null;
  }
}

/** serve 侧增量读取：记住偏移，只返回新完整行；文件被截短/替换时从头读。 */
export class ToolEventTail {
  private offset = 0;
  private partial = "";

  constructor(private readonly path: string) {}

  read(): ToolEvent[] {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return [];
    }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        this.offset = 0;
        this.partial = "";
      }
      if (size === this.offset) return [];
      const length = Math.min(size - this.offset, TOOL_EVENTS_MAX_BYTES);
      const buf = Buffer.alloc(length);
      const n = readSync(fd, buf, 0, length, this.offset);
      this.offset += n;
      const text = this.partial + buf.toString("utf8", 0, n);
      const lines = text.split("\n");
      this.partial = lines.pop() ?? "";
      const out: ToolEvent[] = [];
      for (const line of lines) {
        const event = parseToolEvent(line);
        if (event !== null) out.push(event);
      }
      return out;
    } finally {
      closeSync(fd);
    }
  }
}

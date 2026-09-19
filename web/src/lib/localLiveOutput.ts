// #1103 item 1：桌面端本机 runner 的只读 live 输出。serve 经 AGENTPARTY_SESSION_OUTPUT_FILE 把本轮
// 最近 300 行（已脱敏）写成本机文件；桌面壳 desktop_agent_live_output 只读返回它。这里校验形状并
// 再清洗一遍（不信任磁盘上的内容），产出与频道 WS 流同形的 LiveSession，复用 LiveSessionView。
import {
  SESSION_OUTPUT_KINDS,
  SESSION_OUTPUT_RING_LINES,
  SESSION_OUTPUT_STATES,
  sanitizeSessionOutputText,
  type SessionOutputKind,
  type SessionOutputLine,
  type SessionOutputState,
} from "@agentparty/shared";
import type { LiveSession } from "../state";

export type LocalLiveTarget = { kind: "instance" | "duty"; id: string };

export type LocalLiveInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 磁盘快照 → LiveSession；形状不对返回 null。每行重新 sanitize（去控制字符 + 脱敏 + 截断）。 */
export function parseLocalLiveOutput(value: unknown, name: string): LiveSession | null {
  if (!isRecord(value)) return null;
  const sessionId = value.session_id;
  if (typeof sessionId !== "string" || sessionId === "" || sessionId.length > 128) return null;
  const state = value.state;
  if (typeof state !== "string" || !(SESSION_OUTPUT_STATES as readonly string[]).includes(state)) return null;
  const taskSeq = value.task_seq;
  if (taskSeq !== null && !(typeof taskSeq === "number" && Number.isInteger(taskSeq) && taskSeq > 0)) return null;
  if (!Array.isArray(value.lines)) return null;
  const lines: SessionOutputLine[] = [];
  for (const raw of value.lines.slice(-SESSION_OUTPUT_RING_LINES)) {
    if (!isRecord(raw)) continue;
    if (typeof raw.kind !== "string" || !(SESSION_OUTPUT_KINDS as readonly string[]).includes(raw.kind)) continue;
    if (typeof raw.text !== "string" || typeof raw.ts !== "number" || !Number.isFinite(raw.ts)) continue;
    const text = sanitizeSessionOutputText(raw.text);
    if (text.trim() === "") continue;
    lines.push({ kind: raw.kind as SessionOutputKind, text, ts: raw.ts });
  }
  const updatedAt = value.updated_at;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < 0) return null;
  return {
    name,
    session_id: sessionId,
    task_seq: taskSeq as number | null,
    state: state as SessionOutputState,
    lines,
    updated_at: updatedAt,
  };
}

/** 调桌面壳只读命令。没有快照（还没跑过 / 旧常驻没配 tap）返回 null。 */
export async function readLocalLiveOutput(
  invoke: LocalLiveInvoker,
  target: LocalLiveTarget,
  name: string,
): Promise<LiveSession | null> {
  const value = await invoke<unknown>("desktop_agent_live_output", { kind: target.kind, id: target.id });
  return value === null || value === undefined ? null : parseLocalLiveOutput(value, name);
}

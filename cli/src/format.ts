// 消息打印格式："[seq] name(kind): body 首行"，多行缩进跟随
import type { MsgFrame } from "@agentparty/shared";

export function formatMsg(m: MsgFrame): string {
  const prefix = `[${m.seq}] ${m.sender.name}(${m.sender.kind}): `;
  if (m.kind === "status") {
    const parts = [m.note, m.status?.scope.length ? `scope=${m.status.scope.join(",")}` : null];
    if (m.status?.blocked_reason) parts.push(`blocked=${m.status.blocked_reason}`);
    if (m.status?.summary_seq !== null && m.status?.summary_seq !== undefined) parts.push(`summary=#${m.status.summary_seq}`);
    const detail = parts.filter((part): part is string => typeof part === "string" && part !== "").join(" · ");
    return `${prefix}[${m.state}]${detail ? ` ${detail}` : ""}`;
  }
  const lines = (m.body ?? "").split("\n");
  const rest = lines.slice(1).map((l) => "    " + l);
  return [prefix + (lines[0] ?? ""), ...rest].join("\n");
}

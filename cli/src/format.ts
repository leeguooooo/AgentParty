// 消息打印格式："[seq] name(kind): body 首行"，多行缩进跟随
import type { AgentContext, MsgFrame } from "@agentparty/shared";

// #372 安全：远端可控字段（body/name/owner/context/attachment 文件名/note 等）会被原样打进终端。
// 攻击者发一条含终端转义序列的消息，就能在每个 watch/history 该频道的 agent 终端上注入 OSC52
// 剪贴板写入、用光标/清屏序列伪造或隐藏输出。剥离 C0（保留 \t\n，去掉含 ESC/BEL/CR 在内的其余）、
// DEL、C1，把注入序列降级为可见文本。换行是 formatMsg 自己的结构，逐行清洗后再拼接。
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;
// CSI 颜色/光标序列先整段移除；其他控制序列至少会在 TERMINAL_CONTROL 阶段失去 ESC/BEL，无法执行。
const ANSI_CSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;
export function stripTerminalControls(text: string): string {
  return text.replace(ANSI_CSI, "").replace(TERMINAL_CONTROL, "");
}

function formatSender(m: MsgFrame): string {
  const owner = m.sender.owner && m.sender.owner !== m.sender.name ? ` owner=${m.sender.owner}` : "";
  const lineage = m.sender.lineage ? ` parent=${m.sender.lineage.parent_agent} team=${m.sender.lineage.team_id}` : "";
  return `${m.sender.name}(${m.sender.kind}${owner}${lineage})`;
}

function formatContext(ctx: AgentContext | undefined): string[] {
  if (ctx === undefined) return [];
  return [
    ctx.worktree_label ? `worktree=${ctx.worktree_label}` : null,
    ctx.workspace_label ? `workspace=${ctx.workspace_label}` : null,
    ctx.config_kind ? `config=${ctx.config_kind}` : null,
    ctx.config_fingerprint ? `fingerprint=${ctx.config_fingerprint}` : null,
  ].filter((part): part is string => part !== null);
}

function formatWorkflow(status: MsgFrame["status"]): string[] {
  const workflow = status?.workflow;
  if (workflow === undefined) return [];
  return [
    `workflow=${workflow.workflow_id}`,
    `workflow_kind=${workflow.kind}`,
    workflow.run_id !== null ? `run=${workflow.run_id}` : null,
    workflow.step_id !== null ? `step=${workflow.step_id}` : null,
    workflow.parent_summary_seq !== null ? `parent_summary=#${workflow.parent_summary_seq}` : null,
  ].filter((part): part is string => part !== null);
}

function formatAttachments(m: MsgFrame): string[] {
  return (m.attachments ?? []).map(
    (attachment) =>
      `[attachment: ${attachment.filename} · ${attachment.content_type} · ${attachment.size} bytes · auth GET ${attachment.url}]`,
  );
}

// 唯一出口：任何远端字段拼进来后，整串统一剥离终端控制字符（#372）。逐行结构用的 \n/\t 保留。
export function formatMsg(m: MsgFrame): string {
  return stripTerminalControls(formatMsgRaw(m));
}

function formatMsgRaw(m: MsgFrame): string {
  const badges = [
    m.completion_artifact !== undefined ? "completion" : null,
    m.edited ? "edited" : null,
    m.retracted ? "retracted" : null,
    m.supersedes !== undefined ? `supersedes #${m.supersedes}` : null,
    m.superseded_by !== undefined ? `superseded by #${m.superseded_by}` : null,
  ].filter((part): part is string => part !== null);
  const suffix = badges.length > 0 ? ` {${badges.join("; ")}}` : "";
  const prefix = `[${m.seq}] ${formatSender(m)}${suffix}: `;
  if (m.kind === "status") {
    const parts = [
      m.note,
      ...formatContext(m.status?.context),
      ...formatWorkflow(m.status),
      m.status?.scope.length ? `scope=${m.status.scope.join(",")}` : null,
    ];
    if (m.status?.blocked_reason) parts.push(`blocked=${m.status.blocked_reason}`);
    if (m.status?.summary_seq !== null && m.status?.summary_seq !== undefined) parts.push(`summary=#${m.status.summary_seq}`);
    const detail = parts.filter((part): part is string => typeof part === "string" && part !== "").join(" · ");
    return `${prefix}[${m.state}]${detail ? ` ${detail}` : ""}`;
  }
  if (m.retracted) return `${prefix}[retracted]`;
  const lines = (m.body ?? "").split("\n");
  const attachments = formatAttachments(m);
  if (lines.length === 1 && lines[0] === "" && attachments.length > 0) lines.splice(0, 1);
  lines.push(...attachments);
  if (m.completion_artifact !== undefined) {
    const a = m.completion_artifact;
    const meta = [
      `kickoff=#${a.kickoff_seq}`,
      `replies=${a.replies_count}`,
      `timeout=${a.timeout}`,
      a.related_issues.length > 0 ? `issues=${a.related_issues.map((n) => `#${n}`).join(",")}` : null,
      a.related_prs.length > 0 ? `prs=${a.related_prs.map((n) => `#${n}`).join(",")}` : null,
    ].filter((part): part is string => part !== null);
    lines.push(`[completion: ${meta.join(" · ")}]`);
  }
  const rest = lines.slice(1).map((l) => "    " + l);
  return [prefix + (lines[0] ?? ""), ...rest].join("\n");
}

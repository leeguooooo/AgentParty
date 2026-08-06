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

// #652 单行字段清理：stripTerminalControls 特意保留了 \t\n（formatMsg 的多行结构靠它们），但渲染成
// 「一行一条」的 list/table 行时，服务端可控自由文本里的 \n 能伪造整行、\t 能伪造列。这些字段必须先
// 过本函数把残留 TAB/换行折叠成单个空格，再和可信的结构分隔符（列 TAB、换行）拼接。多行消息体仍用
// 纯 stripTerminalControls，不要在那里折叠换行。
export function sanitizeSingleLine(text: string): string {
  return stripTerminalControls(text).replace(/[\t\n]+/g, " ");
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

export const DEFAULT_HEADER_PREVIEW = 120;

// #819：agent 每轮重建上下文都要拉一次 history，而频道里贴 SQL/实测数据的长消息很常见，
// 一次 10 条就是两三万字符——其中九成是上一轮已经读过的。轻量视图只给「有没有新的、谁发的、
// 大概讲什么」，需要哪条再按 seq 精确拉全文。省的不是钱，是 agent 还能在频道里待多久。
export interface MsgHeader {
  seq: number;
  ts: number;
  sender: string;
  kind: MsgFrame["kind"];
  state?: string;
  mentions: string[];
  reply_to: number | null;
  chars: number;
  preview: string;
  truncated: boolean;
  attachments?: number;
  retracted?: boolean;
  edited?: boolean;
}

// 正文的单行摘要：status 帧取 note（正文常为空），普通消息取 body 首行起的前 N 字符。
function headerPreviewSource(m: MsgFrame): string {
  if (m.retracted) return "[retracted]";
  if (m.kind === "status") return m.note ?? "";
  return m.body ?? "";
}

export function msgHeader(m: MsgFrame, previewChars = DEFAULT_HEADER_PREVIEW): MsgHeader {
  const source = headerPreviewSource(m);
  // preview 要占一行，所以折叠换行/TAB（sanitizeSingleLine），再按字符数截断。
  const flat = sanitizeSingleLine(source).trim();
  const truncated = flat.length > previewChars;
  return {
    seq: m.seq,
    ts: m.ts,
    sender: m.sender.name,
    kind: m.kind,
    ...(m.kind === "status" && m.state ? { state: m.state } : {}),
    mentions: m.mentions ?? [],
    reply_to: m.reply_to ?? null,
    // chars 报的是完整正文长度，agent 据此判断「值不值得展开」。
    chars: source.length,
    preview: truncated ? flat.slice(0, previewChars) : flat,
    truncated,
    ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments.length } : {}),
    ...(m.retracted ? { retracted: true } : {}),
    ...(m.edited ? { edited: true } : {}),
  };
}

// 人类可读的一行：[seq] sender(kind) @mentions ↩#reply · 1832ch: preview…
export function formatMsgHeader(m: MsgFrame, previewChars = DEFAULT_HEADER_PREVIEW): string {
  const h = msgHeader(m, previewChars);
  const parts = [
    h.kind === "status" ? `[${h.state ?? "status"}]` : null,
    h.mentions.length > 0 ? `@${h.mentions.join(",@")}` : null,
    h.reply_to !== null ? `↩#${h.reply_to}` : null,
    h.attachments !== undefined ? `📎${h.attachments}` : null,
    h.retracted === true ? "retracted" : null,
    `${h.chars}ch`,
  ].filter((part): part is string => part !== null);
  return stripTerminalControls(
    `[${h.seq}] ${h.sender}(${m.sender.kind}) ${parts.join(" ")}: ${h.preview}${h.truncated ? "…" : ""}`,
  );
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

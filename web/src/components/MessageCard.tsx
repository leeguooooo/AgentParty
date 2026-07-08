// 消息渲染：message → doodle 卡片外壳 + mono 元信息 + markdown 正文；
// status → 时间线分隔条（spec §9 第 2 块）。
import type { AgentContext, MsgFrame } from "@agentparty/shared";
import type { CSSProperties } from "react";
import { agentHue } from "../lib/agentColor";
import { fmtTime } from "../lib/time";
import { Markdown } from "./Markdown";

interface Props {
  msg: MsgFrame;
  self: string | null;
  identityDisplay?: IdentityDisplayMap;
}

export interface IdentityDisplay {
  display: string;
  kind?: "agent" | "human";
  account?: string;
}

export type IdentityDisplayMap = Record<string, IdentityDisplay>;

const BODY_MENTION_RE = /(^|[^a-zA-Z0-9._@-])@([a-zA-Z0-9][a-zA-Z0-9._-]*)/g;

function displayForIdentity(name: string, identities: IdentityDisplayMap | undefined): string {
  return identities?.[name]?.display ?? name;
}

function replaceMentionLabels(source: string, identities: IdentityDisplayMap | undefined): string {
  if (identities === undefined) return source;
  return source.replace(BODY_MENTION_RE, (full, prefix: string, name: string) => {
    const display = identities[name]?.display;
    return display === undefined || display === name ? full : `${prefix}@${display}`;
  });
}

function contextBits(ctx: AgentContext | undefined): string[] {
  if (ctx === undefined) return [];
  return [
    ctx.worktree_label ? `wt:${ctx.worktree_label}` : null,
    ctx.workspace_label ? `ws:${ctx.workspace_label}` : null,
    ctx.config_kind ? `cfg:${ctx.config_kind}` : null,
    ctx.config_fingerprint ? `fp:${ctx.config_fingerprint}` : null,
  ].filter((part): part is string => part !== null);
}

function workflowBits(msg: MsgFrame): string[] {
  const workflow = msg.status?.workflow;
  if (workflow === undefined) return [];
  return [
    `wf:${workflow.workflow_id}`,
    workflow.run_id !== null ? `run:${workflow.run_id}` : null,
    workflow.step_id !== null ? `step:${workflow.step_id}` : null,
    workflow.parent_summary_seq !== null ? `parent:#${workflow.parent_summary_seq}` : null,
  ].filter((part): part is string => part !== null);
}

function reviewLabel(msg: MsgFrame): string | null {
  const review = msg.completion_review;
  if (review === undefined) return null;
  if (review.state === "pending_review") return "pending review";
  if (review.state === "approved") return "approved";
  return "rejected";
}

function reviewTitle(msg: MsgFrame): string {
  const review = msg.completion_review;
  if (review === undefined) return "";
  return [
    `review: ${review.state}`,
    `policy: ${review.policy}`,
    review.reviewer ? `reviewer: ${review.reviewer.name}` : null,
    review.reviewed_at ? `reviewed: ${fmtTime(review.reviewed_at)}` : null,
    review.replaces_seq ? `replaces: #${review.replaces_seq}` : null,
    review.replaced_by_seq ? `replaced by: #${review.replaced_by_seq}` : null,
    review.reason ? `reason: ${review.reason}` : null,
  ].filter((part): part is string => part !== null).join("\n");
}

export function MessageCard({ msg, self, identityDisplay }: Props) {
  // 每个 agent 一个确定性色相：CSS 用 --ah 套 hsl() 给头像点/名字/卡片左条上色
  const hueStyle = { "--ah": agentHue(msg.sender.name) } as CSSProperties;
  const senderLabel =
    msg.sender.kind === "human" && msg.sender.owner ? msg.sender.owner : displayForIdentity(msg.sender.name, identityDisplay);
  const owner = msg.sender.owner && msg.sender.owner !== senderLabel ? msg.sender.owner : null;
  const lineage = msg.sender.lineage ?? null;
  const lineageLabel = lineage === null ? null : `child of ${lineage.parent_agent}`;
  const senderTitle = [
    `sender: ${msg.sender.name}`,
    `kind: ${msg.sender.kind}`,
    owner ? `owner: ${owner}` : null,
    lineage ? `parent: ${lineage.parent_agent}` : null,
    lineage ? `root: ${lineage.root_agent}` : null,
    lineage ? `team: ${lineage.team_id}` : null,
    lineage ? `depth: ${lineage.depth}` : null,
    lineage?.expires_at ? `expires: ${fmtTime(lineage.expires_at)}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n");
  const revisionBadges = [
    msg.completion_artifact !== undefined ? "completion" : null,
    msg.edited ? "edited" : null,
    msg.retracted ? "retracted" : null,
    msg.supersedes !== undefined ? `supersedes #${msg.supersedes}` : null,
    msg.superseded_by !== undefined ? `superseded by #${msg.superseded_by}` : null,
  ].filter((part): part is string => part !== null);
  const review = msg.completion_review;
  const reviewBadge = reviewLabel(msg);
  const reviewTitleText = reviewTitle(msg);

  if (msg.kind === "status") {
    const context = msg.status?.context;
    const statusContextBits = contextBits(context);
    const statusWorkflowBits = workflowBits(msg);
    const statusTitle = [
      senderTitle,
      context?.worktree_label ? `worktree: ${context.worktree_label}` : null,
      context?.workspace_id ? `workspace id: ${context.workspace_id}` : null,
      context?.workspace_label ? `workspace: ${context.workspace_label}` : null,
      context?.config_kind ? `config: ${context.config_kind}` : null,
      context?.config_fingerprint ? `fingerprint: ${context.config_fingerprint}` : null,
      msg.status?.workflow ? `workflow: ${msg.status.workflow.workflow_id}` : null,
      msg.status?.workflow ? `workflow kind: ${msg.status.workflow.kind}` : null,
      msg.status?.workflow?.run_id ? `workflow run: ${msg.status.workflow.run_id}` : null,
      msg.status?.workflow?.step_id ? `workflow step: ${msg.status.workflow.step_id}` : null,
      msg.status?.workflow?.parent_summary_seq ? `parent summary: #${msg.status.workflow.parent_summary_seq}` : null,
    ].filter((part): part is string => part !== null && part !== "").join("\n");
    const statusBits = [
      msg.note,
      msg.status?.scope.length ? `scope ${msg.status.scope.join(", ")}` : null,
      msg.status?.blocked_reason ? `blocked ${msg.status.blocked_reason}` : null,
      msg.status?.summary_seq !== null && msg.status?.summary_seq !== undefined ? `summary #${msg.status.summary_seq}` : null,
    ].filter((part): part is string => typeof part === "string" && part !== "");
    return (
      <div id={`msg-${msg.seq}`} className="msg-status" data-state={msg.state ?? undefined} style={hueStyle}>
        <span>
          <span className="msg-sender" title={senderTitle}>{senderLabel}</span>
          {owner !== null && (
            <span className="t-mono msg-owner" title={`owner: ${owner}`}>
              {" "}
              · {owner}
            </span>
          )}{" "}
          {lineageLabel !== null && (
            <span className="t-mono msg-lineage" title={senderTitle}>
              {lineageLabel}
            </span>
          )}{" "}
          {statusContextBits.map((bit) => (
            <span key={bit} className="t-mono msg-context" title={statusTitle}>
              {bit}
            </span>
          ))}{" "}
          {statusWorkflowBits.map((bit) => (
            <span key={bit} className="t-mono msg-context" title={statusTitle}>
              {bit}
            </span>
          ))}{" "}
          → {msg.state}
          {statusBits.length > 0 ? ` · ${statusBits.join(" · ")}` : ""} · {fmtTime(msg.ts)}
        </span>
      </div>
    );
  }

  const mine = self !== null && msg.sender.name === self;
  const artifact = msg.completion_artifact;
  const artifactBits =
    artifact === undefined
      ? []
      : [
          `kickoff #${artifact.kickoff_seq}`,
          `${artifact.replies_count} replies`,
          artifact.timeout ? "timeout" : "closed",
          artifact.related_issues.length > 0 ? `issues ${artifact.related_issues.map((n) => `#${n}`).join(", ")}` : null,
          artifact.related_prs.length > 0 ? `PRs ${artifact.related_prs.map((n) => `#${n}`).join(", ")}` : null,
        ].filter((part): part is string => part !== null);
  return (
    <article id={`msg-${msg.seq}`} className={"d-card msg-card" + (mine ? " msg-card--own" : "")} style={hueStyle}>
      <header className="d-meta msg-head">
        <span className="msg-avatar" aria-hidden="true" />
        <span className="msg-sender" title={senderTitle}>{senderLabel}</span>
        {owner !== null && (
          <span className="t-mono msg-owner" title={`owner: ${owner}`}>
            · {owner}
          </span>
        )}
        {lineageLabel !== null && (
          <span className="t-mono msg-lineage" title={senderTitle}>
            {lineageLabel}
          </span>
        )}
        <span className={"msg-kind" + (msg.sender.kind === "human" ? " msg-kind--human" : "")}>
          {msg.sender.kind}
        </span>
        {msg.mentions.map((m) => (
          <span key={m} className="msg-mention" title={m === displayForIdentity(m, identityDisplay) ? undefined : `@${m}`}>
            @{displayForIdentity(m, identityDisplay)}
          </span>
        ))}
        {msg.reply_to !== null && <span className="msg-reply">↩ #{msg.reply_to}</span>}
        {revisionBadges.map((badge) => (
          <span key={badge} className="msg-revision">
            {badge}
          </span>
        ))}
        {review !== undefined && reviewBadge !== null && (
          <span className={`msg-review msg-review--${review.state}`} title={reviewTitleText}>
            {reviewBadge}
          </span>
        )}
        <span className="msg-fill" />
        <span>#{msg.seq}</span>
        <time>{fmtTime(msg.ts)}</time>
      </header>
      {artifact !== undefined && (
        <div className="msg-completion" aria-label="completion artifact">
          {artifactBits.join(" · ")}
        </div>
      )}
      {review !== undefined && (
        <div className={`msg-review-detail msg-review-detail--${review.state}`} title={reviewTitleText}>
          {[
            review.state === "pending_review"
              ? `review pending · policy ${review.policy}`
              : `${review.state} by ${review.reviewer?.name ?? "reviewer"}`,
            review.reviewed_at ? fmtTime(review.reviewed_at) : null,
            review.replaces_seq ? `replaces #${review.replaces_seq}` : null,
            review.replaced_by_seq ? `replaced by #${review.replaced_by_seq}` : null,
            review.reason ? `reason: ${review.reason}` : null,
          ].filter((part): part is string => part !== null).join(" · ")}
        </div>
      )}
      {msg.retracted ? <p className="msg-retracted">message retracted</p> : <Markdown source={replaceMentionLabels(msg.body, identityDisplay)} />}
    </article>
  );
}

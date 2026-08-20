// #853：`repo ⎇ branch · worktree` 上下文 chip 文案。MessageCard 消息头与 PresenceBar 常规行共用。
// 纯 advisory 展示：字段由服务端白名单校验过，这里只负责拼接，不做授权判定。
import type { AgentContext } from "@agentparty/shared";

/**
 * 返回单行 chip 文案；repo 与 branch 都缺席时返回 null（不渲染）。
 * worktree 段有才拼在尾部；CSS 端到端 ellipsis 截断时它最先被截，保住 repo+branch。
 */
export function gitContextChip(ctx: AgentContext | undefined | null): string | null {
  if (ctx === undefined || ctx === null) return null;
  const repo = ctx.repo;
  const branch = ctx.branch;
  if (repo === undefined && branch === undefined) return null;
  const head = repo !== undefined && branch !== undefined
    ? `${repo} ⎇ ${branch}`
    : repo !== undefined
      ? repo
      : `⎇ ${branch}`;
  const worktree = ctx.worktree_label;
  return worktree !== undefined && worktree !== "" ? `${head} · ${worktree}` : head;
}

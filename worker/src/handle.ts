import { RESERVED_NAMES } from "@agentparty/shared";

export const HANDLE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/;

export function validateHandleFormat(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const h = input.trim();
  return HANDLE_RE.test(h) ? h : null;
}

// 冲突检查：撞保留名 / 撞任意 token 名 / 撞 agent 昵称 / 已被别的账号占用 / 撞 pending 外部邀请
// 的预设昵称。无冲突返回 null。
// #165：handle 与 agent 昵称共用同一套 @ 命名空间，故反向也要挡住撞已存在 agent 昵称。
// #593：外部邀请生成时即为 preset_handle 占坑（撞 pending 邀请报 invite_pending），保证被邀请人
// 兑换时昵称一定还在；兑换流程本身用 excludeInviteCode 跳过自己那条占坑记录。
export async function handleConflict(
  db: D1Database,
  handle: string,
  forAccount: string | null,
  opts?: { excludeInviteCode?: string },
): Promise<"reserved" | "token_name" | "nickname" | "taken" | "invite_pending" | null> {
  if (RESERVED_NAMES.includes(handle)) return "reserved";
  const tok = await db.prepare("SELECT 1 FROM tokens WHERE name = ? COLLATE NOCASE").bind(handle).first();
  if (tok) return "token_name";
  const nick = await db
    .prepare("SELECT 1 FROM agent_nicknames WHERE nickname = ? COLLATE NOCASE")
    .bind(handle)
    .first();
  if (nick) return "nickname";
  const owner = await db
    .prepare("SELECT account FROM account_profiles WHERE handle = ?")
    .bind(handle)
    .first<{ account: string }>();
  if (owner && owner.account !== forAccount) return "taken";
  const invite = await db
    .prepare(
      `SELECT code FROM instance_invites
        WHERE preset_handle = ? COLLATE NOCASE
          AND revoked_at IS NULL AND redeemed_by IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
        LIMIT 1`,
    )
    .bind(handle, Date.now())
    .first<{ code: string }>();
  if (invite && invite.code !== opts?.excludeInviteCode) return "invite_pending";
  return null;
}

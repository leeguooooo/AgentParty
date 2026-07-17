-- #593: 实例邀请制。INSTANCE_INVITE_ONLY 开启后，human 账号会话必须在 instance_members
-- 册上才能过 API；外部协作者经频道邀请面板生成的一次性邀请码入册（同时预设昵称 + 入频道）。
CREATE TABLE instance_members (
  account  TEXT PRIMARY KEY,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL
);

-- 回填：既有 human 账号一律入册，开闸瞬间谁都不能被锁在门外。
-- 来源并集 = 带 owner 的 human token 归属 ∪ 频道成员 ∪ 已设 handle 的账号。
INSERT OR IGNORE INTO instance_members (account, added_by, added_at)
SELECT owner, 'backfill', strftime('%s', 'now') * 1000 FROM tokens
 WHERE role = 'human' AND owner IS NOT NULL;
INSERT OR IGNORE INTO instance_members (account, added_by, added_at)
SELECT DISTINCT account, 'backfill', strftime('%s', 'now') * 1000 FROM channel_members;
INSERT OR IGNORE INTO instance_members (account, added_by, added_at)
SELECT account, 'backfill', strftime('%s', 'now') * 1000 FROM account_profiles;

-- 外部协作者邀请：一次性（redeemed_by 非空即失效），恒绑频道（产品拍板：一切邀请从频道发起），
-- preset_handle 生成时即校验冲突并占坑（handleConflict 会查本表 pending 行）。
CREATE TABLE instance_invites (
  code          TEXT PRIMARY KEY,
  channel_slug  TEXT NOT NULL,
  preset_handle TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  redeemed_by   TEXT,
  redeemed_at   INTEGER,
  revoked_at    INTEGER
);

CREATE INDEX idx_instance_invites_channel ON instance_invites(channel_slug, created_at DESC);
-- pending 邀请的 preset_handle 在 @ 命名空间占坑，冲突检查按 NOCASE 查
CREATE INDEX idx_instance_invites_handle ON instance_invites(preset_handle COLLATE NOCASE);

-- 审计动作扩列：SQLite 不能原地扩 CHECK，重建保留全部行/索引（与 0036 同工艺）。
CREATE TABLE management_audit_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cursor_token TEXT NOT NULL,
  actor_account TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin', 'human', 'agent')),
  action TEXT NOT NULL CHECK (action IN (
    'token.issue',
    'token.revoke',
    'agent.nickname.update',
    'agent.reception.pause',
    'agent.reception.resume',
    'channel.create',
    'channel.permissions.update',
    'channel.visibility.update',
    'channel.member.add',
    'channel.member.remove',
    'channel.role.assign',
    'channel.role.remove',
    'channel.join_link.create',
    'channel.join_link.revoke',
    'channel.join_request.approve',
    'channel.join_request.reject',
    'channel.project_agent.invite',
    'channel.project_agent.remove',
    'channel.external_invite.create',
    'channel.external_invite.revoke',
    'channel.external_invite.redeem',
    'instance.member.add',
    'channel.guard.update',
    'channel.guard.reset',
    'channel.webhook.add',
    'channel.webhook.remove',
    'channel.webhook.redeliver',
    'channel.archive',
    'channel.identity.erase',
    'channel.export',
    'channel.retention.update',
    'membership.set'
  )),
  resource TEXT NOT NULL,
  channel TEXT,
  result TEXT NOT NULL CHECK (result = 'success'),
  timestamp INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json) AND length(metadata_json) <= 4096)
);

INSERT INTO management_audit_new (
  id, cursor_token, actor_account, actor_kind, action, resource, channel, result, timestamp, metadata_json
)
SELECT id, cursor_token, actor_account, actor_kind, action, resource, channel, result, timestamp, metadata_json
  FROM management_audit;

DROP TABLE management_audit;
ALTER TABLE management_audit_new RENAME TO management_audit;

CREATE UNIQUE INDEX idx_management_audit_cursor_token ON management_audit(cursor_token);
CREATE INDEX idx_management_audit_timestamp ON management_audit(id DESC);
CREATE INDEX idx_management_audit_channel ON management_audit(channel, id DESC);

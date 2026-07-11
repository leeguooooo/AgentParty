-- #137 可观测性：补齐敏感管理操作的审计动作枚举。
-- 0025 的 action CHECK 只列了 9 个动作，连代码里早已记录的 channel.webhook.redeliver 都不在内
-- （越界值被 CHECK 拒绝，bestEffortRecordManagementAudit 静默吞掉——审计悄悄丢行）。
-- 本次把频道创建 / 角色增删 / join-link 增删 / project-agent 邀请撤销 / guard 配置与重置 /
-- 会员开通等敏感管理动作纳入枚举。SQLite 无法 ALTER 一个 CHECK，只能重建表、搬数据、换名。
CREATE TABLE management_audit_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cursor_token TEXT NOT NULL,
  actor_account TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin', 'human', 'agent')),
  action TEXT NOT NULL CHECK (action IN (
    'token.issue',
    'token.revoke',
    'channel.create',
    'channel.permissions.update',
    'channel.visibility.update',
    'channel.member.add',
    'channel.member.remove',
    'channel.role.assign',
    'channel.role.remove',
    'channel.join_link.create',
    'channel.join_link.revoke',
    'channel.project_agent.invite',
    'channel.project_agent.remove',
    'channel.guard.update',
    'channel.guard.reset',
    'channel.webhook.add',
    'channel.webhook.remove',
    'channel.webhook.redeliver',
    'channel.archive',
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

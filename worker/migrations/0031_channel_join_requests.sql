-- #366: human accounts can apply through a live channel-scoped readonly watch token.
CREATE TABLE channel_join_requests (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  account TEXT NOT NULL,
  requester_display TEXT NOT NULL,
  requester_profile_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(requester_profile_json) AND length(requester_profile_json) <= 4096),
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected')),
  note TEXT,
  source_token_name TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT,
  review_reason TEXT,
  UNIQUE (slug, account)
);

CREATE INDEX idx_channel_join_requests_pending
  ON channel_join_requests(slug, state, requested_at DESC);

-- Add explicit audit actions for the moderator decisions introduced above.
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
    'channel.join_request.approve',
    'channel.join_request.reject',
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

-- #165：agent 全局唯一昵称（可 @中文昵称 唤醒）。与人类 handle（0014 account_profiles）共用 @ 命名空间。
-- 按 token name 存（per-identity）——agent 与 human 共享 account，不能像 handle 那样 per-account。
-- nickname 是显示 + 被@检测别名，不授予任何权限。唯一性大小写不敏感（COLLATE NOCASE，与 handle 一致）。
CREATE TABLE agent_nicknames (
  name       TEXT PRIMARY KEY,
  nickname   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_agent_nicknames_nickname ON agent_nicknames(nickname COLLATE NOCASE);

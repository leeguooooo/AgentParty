-- #1067 第三层：同一个人的多个账号串对齐。
-- 登录回调按「有邮箱走 lark-email:<邮箱>、无邮箱走 lark:<open_id>」构造 account，
-- 而目录入册/桌面端一律 lark:<provider_user_id>——同一个人经不同路径进来会拿到不同 account，
-- 名单与看板里就变成两个人。这张表把别名账号指到规范账号，读侧统一解析，历史行一律不改写。
CREATE TABLE IF NOT EXISTS account_aliases (
  alias_account     TEXT PRIMARY KEY,
  canonical_account TEXT NOT NULL,
  provider          TEXT,
  linked_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_aliases_canonical ON account_aliases(canonical_account);

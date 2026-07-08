-- 人类全局唯一 handle（可@昵称，spec 2026-07-08）。handle 是显示+被@检测别名，不授予权限。
CREATE TABLE account_profiles (
  account    TEXT PRIMARY KEY,
  handle     TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_account_profiles_handle ON account_profiles(handle);

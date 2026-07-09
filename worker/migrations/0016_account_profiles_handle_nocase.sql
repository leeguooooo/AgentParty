-- handle 唯一性改为大小写不敏感（Option A：允许大写显示 + 不分大小写唯一，防 race 下 "Evan"/"evan" 并存）。
-- 现有数据均为小写（旧 HANDLE_RE 限制），无 case 变体冲突，可安全建索引。列级 BINARY UNIQUE 保留，NOCASE 更严格、生效为准。
CREATE UNIQUE INDEX idx_account_profiles_handle_nocase ON account_profiles(handle COLLATE NOCASE);

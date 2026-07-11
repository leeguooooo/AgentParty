-- task 加可选外部引用键 external_ref（如 gh:owner/repo#96），承载「外部系统 → task 看板」
-- 同步的幂等锚点（#141，同类根因参照 #98 消息幂等键）。
-- 唯一索引按 channel 内 scope：同一 channel 内 external_ref 不可重复，跨 channel 允许复用同一 ref。
-- NULL 不参与冲突判定（SQLite 标准行为：UNIQUE 索引里 NULL 互不相等），多条未带 external_ref
-- 的 task 可以正常共存，不影响今天「无 ref 每次都新建」的默认路径。
ALTER TABLE channel_tasks ADD COLUMN external_ref TEXT;

CREATE UNIQUE INDEX idx_channel_tasks_channel_external_ref
  ON channel_tasks(channel_slug, external_ref);

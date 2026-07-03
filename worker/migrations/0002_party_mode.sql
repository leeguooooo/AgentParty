-- party 模式（spec §3/§6）：频道分 normal | party，party 频道 loop guard 放宽到 200
ALTER TABLE channels ADD COLUMN mode TEXT NOT NULL DEFAULT 'normal';

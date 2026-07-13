-- 每个任务最多一个频道可见方案附件（#464）。
-- blob 仍走频道鉴权的 R2 附件端点；这里只保存单个 Attachment 引用 JSON。
ALTER TABLE channel_tasks ADD COLUMN solution_attachment_json TEXT;

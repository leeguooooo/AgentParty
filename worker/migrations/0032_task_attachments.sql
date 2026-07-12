-- task 加可选附件引用 attachments_json（#369，#271 遗留的「新建任务表单上传图片/文件」后端半）。
-- 与消息附件同构：R2 上传由 /api/channels/:slug/attachments 完成，任务只存 N 个引用的 JSON
-- （key/filename/content_type/size/url）。可空，老行 NULL = 无附件；校验/上限见 worker/src/attachments.ts。
ALTER TABLE channel_tasks ADD COLUMN attachments_json TEXT;

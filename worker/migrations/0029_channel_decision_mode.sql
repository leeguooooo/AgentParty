-- 频道人类决策协议（#284）：频道级决策模式。
-- approval（默认）：decision_request 挂起，等人类/moderator 在频道内审批或选项回答。
-- unattended（无人值守）：服务端落库即自动放行第一项，agent 不必等人。
ALTER TABLE channels ADD COLUMN decision_mode TEXT NOT NULL DEFAULT 'approval';

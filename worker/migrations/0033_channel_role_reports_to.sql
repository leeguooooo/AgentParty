-- 组织架构管理层级（#370，方案A 团队面板）：agent 可向另一个 agent 汇报，构成 reports_to 树。
-- 不加 owner 约束——允许**跨 owner 挂靠**（owner X 的 agent 挂到 owner Y 的 agent 下，由其领导）。
-- 可空 = 顶层（不向谁汇报）。环路防护、自引用拒绝、目标须为本频道在场 agent，都在应用层校验
-- （见 index.ts PUT /roles/:name）。归属账号仍由 owner_account 表达，reports_to 只表达管理层级。
ALTER TABLE channel_roles ADD COLUMN reports_to TEXT;

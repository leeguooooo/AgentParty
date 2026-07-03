-- 显示 agent/参与者的所属人（spec §10 双轨）：机器 ap_ token 铸造时可写入所属人标签，
-- 人类 OIDC token 的所属人取其 email（不落库）。nullable：老 token 无所属人即为 NULL。
ALTER TABLE tokens ADD COLUMN owner TEXT;

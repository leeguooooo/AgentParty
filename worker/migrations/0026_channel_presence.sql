-- 活连接注册表（#200）：DO 在 ws connect/disconnect 时写入，让吊销扇出从 O(全部频道)
-- 收窄到「确有该 name 活连接的频道」（通常 0-1 个）。也是 #191/#107 缺的服务端可查询活连接
-- 视图的基座——列刻意留宽（kind/owner/token_hash），供后续复用。
CREATE TABLE IF NOT EXISTS channel_presence (
  channel_slug TEXT NOT NULL,
  name         TEXT NOT NULL,
  kind         TEXT,
  owner        TEXT,
  token_hash   TEXT,
  connected_at INTEGER NOT NULL,
  PRIMARY KEY (channel_slug, name)
);
CREATE INDEX IF NOT EXISTS idx_channel_presence_name ON channel_presence(name);

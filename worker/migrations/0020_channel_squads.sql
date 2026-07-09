CREATE TABLE IF NOT EXISTS channel_squads (
  channel_slug TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  description TEXT,
  leader_name TEXT,
  members_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_by_kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_slug, name)
);

CREATE INDEX IF NOT EXISTS idx_channel_squads_channel
  ON channel_squads(channel_slug, updated_at DESC);

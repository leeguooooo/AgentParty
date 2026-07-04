-- Authoritative soft collaboration roles for a channel.
-- These are display/workflow roles (host/worker/reviewer/observer), not access-control owners.
CREATE TABLE channel_roles (
  channel_slug TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  role TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (channel_slug, agent_name)
);

CREATE INDEX idx_channel_roles_channel ON channel_roles(channel_slug, agent_name);

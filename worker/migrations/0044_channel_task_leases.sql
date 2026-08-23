-- Server-side (identity, channel, task) claim lease — issue #936.
--
-- #885 put the gate at the claim moment, but only as a file lock under
-- $AGENTPARTY_HOME/task-leases: the same identity on two machines both won.
-- This table is that same lease, moved to the one place both machines can see.
--
-- Shape follows #99's serve_lease: among several execution runtimes of ONE
-- identity, exactly one holds; the others are told who holds and until when.
-- The difference is the carrier — serve_lease hangs off a live WebSocket (a
-- disconnect implicitly releases it), while a task claim is a one-shot HTTP call
-- that exits immediately. With no connection to hang on, the lease must be
-- durable and must expire on its own, or a dead executor would pin the task
-- forever (#908 already paid for one orphan-lock deadlock).
--
-- Identity is the SERVER's notion of identity, never anything the client says:
--   identity_name      = the token's agent/human name
--   identity_principal = owner account, or token-sha256:<hash> for legacy tokens
-- (identical to do.ts identityDeliveryPrincipal, so a revoked-and-reminted token
-- under a new owner never inherits the old owner's lease).
--
-- executor_id is the ONLY client-supplied part, and it lives strictly INSIDE a
-- row already scoped by the three server-derived columns. It can distinguish two
-- runtimes of one identity; it can never reach another identity's row.
--
-- The server dimension (#865: one machine talking to two production instances
-- that both have a #agentparty) is structural here — each deployment has its own
-- D1, so two instances cannot collide by construction.
CREATE TABLE IF NOT EXISTS channel_task_leases (
  channel_slug TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  identity_name TEXT NOT NULL,
  identity_principal TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  taken_over_from TEXT,
  PRIMARY KEY (channel_slug, task_id, identity_name, identity_principal),
  FOREIGN KEY (channel_slug) REFERENCES channels(slug) ON DELETE CASCADE
);

-- Opportunistic reclaim sweep: "everything in this channel that has already
-- lapsed". Expiry is the only self-healing path, so it must stay cheap enough to
-- run on every claim.
CREATE INDEX IF NOT EXISTS idx_channel_task_leases_expiry
  ON channel_task_leases(channel_slug, expires_at);

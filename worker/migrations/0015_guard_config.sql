-- Channel-level guard configuration. Defaults are unlimited/off so agents do not wake up blocked by stale counters.
ALTER TABLE channels ADD COLUMN loop_guard_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN loop_guard_limit INTEGER;

UPDATE channels SET workflow_guard_enabled = 0;

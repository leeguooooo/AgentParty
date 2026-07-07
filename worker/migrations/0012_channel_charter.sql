-- Channel charter / "用前必读" (#36).
ALTER TABLE channels ADD COLUMN charter TEXT;
ALTER TABLE channels ADD COLUMN charter_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN charter_updated_at INTEGER;
ALTER TABLE channels ADD COLUMN charter_updated_by TEXT;

-- Review-gated completion (#34): channel-level gate defaults off for zero behavior change.
ALTER TABLE channels ADD COLUMN completion_gate TEXT NOT NULL DEFAULT 'off';
ALTER TABLE channels ADD COLUMN completion_review_policy TEXT NOT NULL DEFAULT 'sender';

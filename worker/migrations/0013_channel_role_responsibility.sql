-- Human-readable responsibility text attached to authoritative channel roles.
-- `role` stays machine-readable (host/worker/reviewer/observer); this field is for
-- charter/UI hover details and should not drive workflow decisions.
ALTER TABLE channel_roles ADD COLUMN responsibility TEXT;

-- Production desktop Device Flow. Every credential is stored as an HMAC or S256 challenge;
-- plaintext user/device codes, verifiers, device secrets, and tokens never enter D1.
CREATE TABLE desktop_pairings (
  id                      TEXT PRIMARY KEY,
  device_code_hash        TEXT UNIQUE NOT NULL,
  user_code_hash          TEXT UNIQUE NOT NULL,
  code_challenge          TEXT NOT NULL,
  device_secret_challenge TEXT NOT NULL,
  device_name             TEXT NOT NULL,
  device_platform         TEXT,
  device_app_version      TEXT,
  status                  TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  account                 TEXT,
  approved_by             TEXT,
  proof_failures          INTEGER NOT NULL DEFAULT 0,
  poll_interval_sec       INTEGER NOT NULL DEFAULT 3,
  next_poll_at            INTEGER NOT NULL DEFAULT 0,
  created_ip_hash         TEXT NOT NULL,
  created_at              INTEGER NOT NULL,
  expires_at              INTEGER NOT NULL,
  approved_at             INTEGER,
  denied_at               INTEGER,
  consumed_at             INTEGER
);

CREATE INDEX idx_desktop_pairings_expires_at ON desktop_pairings(expires_at);

CREATE TABLE desktop_sessions (
  id                      TEXT PRIMARY KEY,
  pairing_id              TEXT UNIQUE NOT NULL REFERENCES desktop_pairings(id),
  account                 TEXT NOT NULL,
  device_name             TEXT NOT NULL,
  device_platform         TEXT,
  device_app_version      TEXT,
  device_secret_challenge TEXT NOT NULL,
  access_hash             TEXT UNIQUE NOT NULL,
  access_expires_at       INTEGER NOT NULL,
  refresh_hash            TEXT UNIQUE NOT NULL,
  refresh_expires_at      INTEGER NOT NULL,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  last_used_at            INTEGER NOT NULL,
  revoked_at              INTEGER
);

CREATE INDEX idx_desktop_sessions_account ON desktop_sessions(account, revoked_at, created_at);

CREATE TABLE desktop_refresh_history (
  refresh_hash TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES desktop_sessions(id),
  rotated_at   INTEGER NOT NULL
);

CREATE INDEX idx_desktop_refresh_history_session ON desktop_refresh_history(session_id);

CREATE TABLE desktop_rate_limits (
  scope             TEXT NOT NULL,
  key_hash          TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  count             INTEGER NOT NULL,
  blocked_until     INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (scope, key_hash)
);

CREATE TABLE desktop_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event        TEXT NOT NULL,
  pairing_id   TEXT,
  session_id   TEXT,
  account_hash TEXT,
  ip_hash      TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_desktop_audit_pairing ON desktop_audit(pairing_id, created_at);
CREATE INDEX idx_desktop_audit_session ON desktop_audit(session_id, created_at);

-- Bounded response-loss recovery for a consumed desktop device grant.
-- ciphertext contains the original token response under an HKDF-derived AES-256-GCM key.
-- No plaintext access token, refresh token, device code, verifier, or device secret is stored.
CREATE TABLE desktop_token_recoveries (
  pairing_id      TEXT PRIMARY KEY REFERENCES desktop_pairings(id),
  session_id      TEXT UNIQUE NOT NULL REFERENCES desktop_sessions(id),
  device_code_hash TEXT NOT NULL,
  nonce           TEXT NOT NULL,
  ciphertext      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

CREATE INDEX idx_desktop_token_recoveries_expires_at
  ON desktop_token_recoveries(expires_at);

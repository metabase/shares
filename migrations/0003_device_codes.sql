-- `share login` device flow. The CLI holds the device code and
-- polls with it; the person types or opens the user code on the app host.
-- A row lives until the CLI picks up its token or it expires (10 min).
CREATE TABLE device_codes (
  device_hash TEXT PRIMARY KEY,             -- sha256 of the device code, hex
  user_code   TEXT NOT NULL UNIQUE,         -- 8 letters, shown as XXXX-XXXX
  name        TEXT NOT NULL,                -- name of the token to create
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  approved_by TEXT,                         -- email of the approver
  denied      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX device_codes_expires ON device_codes(expires_at);

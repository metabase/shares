-- R2 + D1 store (decision replatform-r2-d1). File bytes live in R2 under
-- blobs/<sha256>; D1 holds everything else. Times are ms since the epoch.
-- One migration for the whole chapter: SHR-4 (publish), SHR-6/SHR-13
-- (tokens), SHR-9 (public), SHR-12 (collections, metadata) use these tables
-- as they are.

CREATE TABLE users (
  email         TEXT PRIMARY KEY,           -- lowercase
  name          TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE collections (
  slug       TEXT PRIMARY KEY,
  title      TEXT,
  owner      TEXT NOT NULL REFERENCES users(email),
  meta       TEXT NOT NULL DEFAULT '{}',    -- JSON object
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX collections_owner ON collections(owner);

CREATE TABLE shares (
  slug            TEXT PRIMARY KEY,
  owner           TEXT NOT NULL REFERENCES users(email),
  title           TEXT,
  collection      TEXT REFERENCES collections(slug) ON DELETE SET NULL,
  -- version that readers see; NULL until the first publish completes
  current_version INTEGER,
  -- readable without login when PUBLIC_SHARING is on (SHR-9)
  public          INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX shares_owner ON shares(owner, updated_at);
CREATE INDEX shares_collection ON shares(collection, updated_at);

-- A publish writes a pending version and its files, then one batch sets
-- state = 'complete' and shares.current_version: readers never see a
-- partial upload.
CREATE TABLE versions (
  share       TEXT NOT NULL REFERENCES shares(slug) ON DELETE CASCADE,
  version     INTEGER NOT NULL,             -- 1, 2, ... per share
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'complete')),
  created_by  TEXT NOT NULL REFERENCES users(email),
  created_at  INTEGER NOT NULL,
  file_count  INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  message     TEXT,
  PRIMARY KEY (share, version)
);
CREATE INDEX versions_created_by ON versions(created_by, created_at);

CREATE TABLE files (
  share        TEXT NOT NULL,
  version      INTEGER NOT NULL,
  path         TEXT NOT NULL,               -- relative to the share, no leading /
  sha256       TEXT NOT NULL,               -- R2 key blobs/<sha256>
  size         INTEGER NOT NULL,
  content_type TEXT,
  PRIMARY KEY (share, version, path),
  FOREIGN KEY (share, version) REFERENCES versions(share, version) ON DELETE CASCADE
);
-- blob garbage collection: is a sha256 still referenced
CREATE INDEX files_sha256 ON files(sha256);

-- free-form metadata per share, queried by the JSON API (SHR-12)
CREATE TABLE share_meta (
  share TEXT NOT NULL REFERENCES shares(slug) ON DELETE CASCADE,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,                      -- JSON value
  PRIMARY KEY (share, key)
);
CREATE INDEX share_meta_key ON share_meta(key, value);

-- CLI and service tokens (SHR-6, SHR-13). The secret is shown once; only
-- its sha256 is stored.
CREATE TABLE tokens (
  id           TEXT PRIMARY KEY,            -- public id, part of the token
  hash         TEXT NOT NULL UNIQUE,        -- sha256 of the secret, hex
  name         TEXT NOT NULL,
  owner        TEXT NOT NULL REFERENCES users(email),
  kind         TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'service')),
  scopes       TEXT NOT NULL DEFAULT '[]',  -- JSON array of scope names
  -- service tokens: the user whose shares the token writes as
  on_behalf_of TEXT REFERENCES users(email),
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at   INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX tokens_owner ON tokens(owner);

CREATE TABLE views (
  share   TEXT NOT NULL REFERENCES shares(slug) ON DELETE CASCADE,
  email   TEXT NOT NULL,
  n       INTEGER NOT NULL DEFAULT 1,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (share, email)
);

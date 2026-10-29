-- Audit log of security-relevant changes (SHR-9: public on/off). Rows are
-- only added, never changed. Times are ms since the epoch.
CREATE TABLE audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  actor  TEXT NOT NULL,                     -- email
  action TEXT NOT NULL,                     -- e.g. 'public.on', 'public.off'
  share  TEXT,                              -- slug; no FK, rows outlive the share
  detail TEXT                               -- JSON or NULL
);
CREATE INDEX audit_at ON audit(at);
CREATE INDEX audit_share ON audit(share, at);

-- Live-testing task (batch 2), Part 12: hard delete (privacy/Law 25).
-- Purely additive -- records WHEN a hard-delete became eligible so the
-- 15-day unlock delay survives a Worker restart/redeploy; the actual
-- unlock time is computed from leagues.deactivated_at (already present),
-- so no new "requested_at" column is needed. This table exists only to
-- log completed hard deletes for support/audit purposes -- the deleted
-- league's own row (and every other row about it) is gone by the time a
-- row lands here, by design ("no local retention" of the deleted data
-- itself; this log keeps no PII, just ids and counts).
CREATE TABLE IF NOT EXISTS league_hard_delete_log (
  league_id TEXT NOT NULL,
  league_name TEXT NOT NULL,
  deleted_by_user_id TEXT,
  deleted_via TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  rows_deleted INTEGER NOT NULL,
  users_deleted INTEGER NOT NULL
);

-- Live-testing task (batch 2), Part 11: super-admin layer + capability
-- flags. plan_tier is a stored LABEL only (Gratuit/Solo/Ligue+) -- no
-- billing/pricing wiring, no automatic enforcement tied to it yet
-- (explicitly deferred, "later-follow-up presets" per the task spec).
-- Every league defaults to 'gratuit' so nothing changes for any
-- existing league.
ALTER TABLE leagues ADD COLUMN plan_tier TEXT NOT NULL DEFAULT 'gratuit';

-- Capability-flag mechanism: a row's ABSENCE means "not explicitly
-- overridden" -- callers (hasCapability, super_admin.js) treat a missing
-- row as enabled=1 for every flag, so introducing this table changes no
-- existing league's behavior until a super-admin explicitly disables a
-- flag for a specific league.
CREATE TABLE IF NOT EXISTS league_capability_flags (
  league_id TEXT NOT NULL REFERENCES leagues(id),
  flag_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (league_id, flag_key)
);

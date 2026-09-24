-- SMBHL attendance — schema v1
--
-- *** TEST-ONLY FIXTURE. DO NOT RUN THIS AGAINST ANY LIVE OR REMOTE
-- *** DATABASE, EVER. IT OPENS WITH DROP TABLE AND WILL DESTROY REAL
-- *** DATA.
--
-- Schema-drift guard task, Part 3: this file used to live at the repo
-- root as `schema.sql`, alongside every real migrate-*.sql file, with
-- an "Apply with: npx wrangler d1 execute smbhl-rsvp --remote
-- --file=./schema.sql" comment identically phrased to every one of
-- them -- an invitation to run it against production by pattern-
-- matching the other files, which would DROP the real rsvp/events/
-- contacts tables and every row in them. Moved here and renamed
-- specifically to break that pattern-match: it no longer sits in the
-- root, no longer matches the migrate-NNN.sql naming convention, and
-- no longer carries a copy-pasteable remote-apply command.
--
-- This is genuinely still load-bearing, not dead weight to delete:
-- test/support/real_schema.js replays this file (the app's original,
-- unnumbered base schema -- contacts/events/rsvp/sheet_reviews/
-- team_messages) followed by every migrate-*.sql file, to build each
-- test's own real, fully-migrated database. The real production and
-- demo databases were built from this exact content years ago and
-- have been evolving via migrate-*.sql ever since -- this file is a
-- historical record of that starting point, consumed only by the test
-- suite and scripts/generate_schema_manifest.js, never by a deploy.

DROP TABLE IF EXISTS rsvp;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS contacts;

-- one row per person we can contact. player_id matches data.json.
CREATE TABLE contacts (
  player_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  is_sub      INTEGER NOT NULL DEFAULT 0,
  is_backup_goalie INTEGER NOT NULL DEFAULT 0,
  opted_out   INTEGER NOT NULL DEFAULT 0,
  token_salt  TEXT NOT NULL
);

-- one row per game day
CREATE TABLE events (
  id      TEXT PRIMARY KEY,          -- '2026-09-20'
  season  TEXT NOT NULL,
  week    INTEGER NOT NULL,
  date    TEXT NOT NULL,             -- human label, as in data.json
  venue   TEXT,
  state   TEXT NOT NULL DEFAULT 'open'   -- open | locked | done
);

-- one row per person per event
CREATE TABLE rsvp (
  event_id    TEXT NOT NULL REFERENCES events(id),
  player_id   TEXT,                  -- null while a sub slot is unclaimed
  guest_name  TEXT,                  -- used instead of player_id for guests
  team        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',   -- in | out | pending
  role        TEXT NOT NULL DEFAULT 'roster',    -- roster | sub | guest
  status_by   TEXT NOT NULL DEFAULT 'auto',      -- self | teammate | manager | auto
  claimed_at  TEXT,
  updated_at  TEXT NOT NULL
);

-- CORRECTED 2026-09-22 (Part 2 of the migrate-020.sql FK-bug follow-up):
-- this index was documented here as a PARTIAL unique index
-- (`WHERE player_id IS NOT NULL`), but that was never what's actually on
-- the real database -- verified with a read-only query against production
-- (`SELECT sql FROM sqlite_master WHERE tbl_name = 'rsvp'`), which returned
-- a plain, unconditional unique index with no WHERE clause. The partial
-- version in this file was undetected drift: every hand-rolled test schema
-- used an unconditional `PRIMARY KEY (event_id, player_id)` instead of
-- replaying this file, so nothing ever exercised the (wrong) partial
-- predicate written here. It matters because every `INSERT ... ON
-- CONFLICT(event_id, player_id) DO UPDATE` in src/index.js (five call
-- sites, including writeLeagueRsvpStatus) targets the unconditional form;
-- SQLite only matches an ON CONFLICT target to a partial index when the
-- target repeats that index's own WHERE clause, so the partial version
-- written here would make every one of those real, already-working writes
-- fail with "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
-- constraint" -- which is exactly what surfaced this, once schema.sql
-- started being replayed for real in the test suite instead of hand-rolled
-- per spec file. This is a correction to this file's record, not a change
-- to be applied anywhere -- the real database has always had the
-- unconditional index; this file was just wrong about it.
CREATE UNIQUE INDEX idx_rsvp_player ON rsvp(event_id, player_id);
CREATE INDEX idx_rsvp_team ON rsvp(event_id, team);

CREATE TABLE IF NOT EXISTS sheet_reviews (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  season TEXT NOT NULL,
  week INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  images_json TEXT,
  extracted_json TEXT,
  validated_json TEXT,
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_reviews_status ON sheet_reviews(status);

CREATE TABLE IF NOT EXISTS team_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  team TEXT NOT NULL,
  player_name TEXT NOT NULL,
  player_id TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_messages_event_team 
  ON team_messages (event_id, team, created_at);

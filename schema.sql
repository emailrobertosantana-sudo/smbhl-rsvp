-- SMBHL attendance — schema v1
-- Apply with:  npx wrangler d1 execute smbhl-rsvp --remote --file=./schema.sql

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

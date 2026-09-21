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

CREATE UNIQUE INDEX idx_rsvp_player ON rsvp(event_id, player_id)
  WHERE player_id IS NOT NULL;
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

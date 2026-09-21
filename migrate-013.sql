-- Migration 013: Add position to contacts and create polls / poll_votes tables
ALTER TABLE contacts ADD COLUMN position TEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  target_position TEXT,
  allow_subs INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_polls_season_state ON polls(season, state);

CREATE TABLE IF NOT EXISTS poll_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id),
  voter_id TEXT NOT NULL,
  candidate_id TEXT,
  candidate_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(poll_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_voter ON poll_votes(voter_id);


-- Migration 019: League provisioning (Part B of the multi-league accounts
-- foundation). Purely additive — no existing table is touched. Depends on
-- migrate-018.sql's users table (leagues.created_by / league_admins.user_id
-- reference it). Apply with:
--   npx wrangler d1 execute smbhl-rsvp --remote --file=./migrate-019.sql

CREATE TABLE IF NOT EXISTS leagues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  division_label TEXT,
  tracks_stats INTEGER NOT NULL DEFAULT 1,
  team_count INTEGER NOT NULL,
  team_names TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Supports multiple admin users per league from day one. No separate
-- "email_verified_league" column: Part C's isLeagueEmailVerified() derives
-- that from users.email_verified_at via this join instead, so there's a
-- single source of truth instead of a cached flag to keep in sync.
CREATE TABLE IF NOT EXISTS league_admins (
  user_id TEXT NOT NULL REFERENCES users(id),
  league_id TEXT NOT NULL REFERENCES leagues(id),
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, league_id)
);

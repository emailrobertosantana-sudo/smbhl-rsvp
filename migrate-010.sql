-- SMBHL attendance — schema migration 010: Season Costs & Expenses Tracker
-- Apply with: npx wrangler d1 execute smbhl-rsvp --remote --file=./migrate-010.sql

CREATE TABLE IF NOT EXISTS season_costs (
  id TEXT PRIMARY KEY,
  season TEXT NOT NULL,
  category TEXT NOT NULL,  -- 'rental', 'equipment', 'technology', 'other'
  description TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_season_costs_season ON season_costs(season);

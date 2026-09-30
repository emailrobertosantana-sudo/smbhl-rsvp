-- Migration 054: the finance tables keyed by league.
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --env demo --remote --file=./migrate-054.sql
--   (production: npx wrangler d1 execute smbhl-rsvp --remote --file=./migrate-054.sql)
--   Either order with the code that reads it: src/finance_store.js scopes
--   every query by league and upserts with a target-less ON CONFLICT, so
--   it runs the same against the tables before and after this migration.
--
-- migrate-020 gave season_pricing, player_dues and season_costs a
-- league_id column (every row 'smbhl'), but not a key: season_pricing was
-- keyed by season alone and player_dues by (season, player), so two
-- leagues with a season of the same name could only share one pricing row.
-- This rebuilds both tables with the league in the key:
--   season_pricing  PRIMARY KEY (league_id, season)
--   player_dues     PRIMARY KEY (league_id, season, player_id)
-- season_costs is keyed by its own id already; it gets an index on
-- (league_id, season), the way it is read.
--
-- Every column and every row is carried across unchanged (SQLite cannot
-- change a primary key in place: new table, copy, drop, rename). The
-- column order is the same as before, so SELECT * reads the same shape.
-- Check after applying (read-only):
--   SELECT 'pricing' t, league_id, COUNT(*) n FROM season_pricing GROUP BY league_id
--   UNION ALL SELECT 'dues', league_id, COUNT(*) FROM player_dues GROUP BY league_id
--   UNION ALL SELECT 'costs', league_id, COUNT(*) FROM season_costs GROUP BY league_id;
-- and compare with the same query run before.

CREATE TABLE season_pricing_054 (
  season TEXT NOT NULL,
  price_player REAL NOT NULL DEFAULT 180,
  price_goalie REAL NOT NULL DEFAULT 0,
  price_sub_player REAL NOT NULL DEFAULT 15,
  price_sub_goalie REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  etransfer_phone TEXT,
  league_id TEXT NOT NULL DEFAULT 'smbhl',
  PRIMARY KEY (league_id, season)
);
INSERT INTO season_pricing_054 (season, price_player, price_goalie, price_sub_player, price_sub_goalie, updated_at, etransfer_phone, league_id)
  SELECT season, price_player, price_goalie, price_sub_player, price_sub_goalie, updated_at, etransfer_phone, league_id FROM season_pricing;
DROP TABLE season_pricing;
ALTER TABLE season_pricing_054 RENAME TO season_pricing;
CREATE INDEX IF NOT EXISTS idx_season_pricing_league ON season_pricing(league_id);

CREATE TABLE player_dues_054 (
  season TEXT NOT NULL,
  player_id TEXT NOT NULL,
  custom_due REAL,
  adjustment REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  notes TEXT,
  updated_at TEXT NOT NULL,
  league_id TEXT NOT NULL DEFAULT 'smbhl',
  settled_nights INTEGER,
  PRIMARY KEY (league_id, season, player_id)
);
INSERT INTO player_dues_054 (season, player_id, custom_due, adjustment, amount_paid, notes, updated_at, league_id, settled_nights)
  SELECT season, player_id, custom_due, adjustment, amount_paid, notes, updated_at, league_id, settled_nights FROM player_dues;
DROP TABLE player_dues;
ALTER TABLE player_dues_054 RENAME TO player_dues;
CREATE INDEX IF NOT EXISTS idx_player_dues_season ON player_dues(season);
CREATE INDEX IF NOT EXISTS idx_player_dues_league ON player_dues(league_id);

CREATE INDEX IF NOT EXISTS idx_season_costs_league_season ON season_costs(league_id, season);

-- Migration 021: capture existing, previously-untracked production schema
-- for season_pricing and player_dues.
--
-- WHAT THIS IS: neither table has a CREATE TABLE statement anywhere in this
-- repo's migration history (schema.sql or migrate-002.sql..migrate-020.sql),
-- yet both are actively read/written throughout src/index.js and
-- src/season_hub.js, and migrate-011.sql already ALTERs season_pricing
-- (ADD COLUMN etransfer_phone). They must have been created directly
-- against the real database at some point (e.g. a one-off
-- `wrangler d1 execute` with inline SQL) and never saved to a tracked
-- migration file. This migration is filling a real, pre-existing gap in
-- the migration history -- not introducing new tables. It was discovered
-- while building migrate-*.sql-driven test schema setup (Part 2 of the
-- migrate-020.sql FK-bug follow-up): running the files in order crashed at
-- migrate-011.sql with "no such table: season_pricing" against a truly
-- blank database, which is what surfaced this gap.
--
-- SOURCE OF TRUTH: the exact statements below are copied verbatim from the
-- real production database itself --
--   npx wrangler d1 execute smbhl-rsvp --remote --command \
--     "SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('season_pricing', 'player_dues')"
-- -- a read-only query, run 2026-09-22. This is the actual, current
-- production schema, not a reconstruction from application code or from
-- the test suite's own separately hand-rolled (and, it turns out, already
-- slightly drifted -- see below) approximation of these two tables.
--
-- DRIFT NOTE: test/index.spec.js's own hand-rolled season_pricing had
-- DEFAULT 170 for price_player and DEFAULT 10 for price_sub_player; the
-- real production table's actual defaults are 180 and 15. Every INSERT
-- into season_pricing in this codebase (src/index.js, src/season_hub.js,
-- and every test) explicitly specifies price_player/price_sub_player, so
-- this drift has never been exercised -- but it is genuine schema drift
-- between what tests assumed and what production actually has, exactly
-- the class of thing this migration-driven test schema exists to catch.
-- player_dues had no drift -- the hand-rolled and real definitions match.
--
-- Guarded with IF NOT EXISTS: on the real database these tables already
-- exist, so this migration is a documentation-only no-op there. It only
-- does real work when applied to a fresh database (e.g. the test suite's
-- migration-driven schema setup).
--
-- ORDERING NOTE: season_pricing's real, current column set (per the query
-- above) already includes etransfer_phone -- but migrate-011.sql
-- ("ALTER TABLE season_pricing ADD COLUMN etransfer_phone TEXT") applies
-- *after* this migration in the real replay order (see
-- test/support/real_schema.js), exactly as it did historically. So the
-- CREATE TABLE below deliberately omits etransfer_phone -- reconstructing
-- the table's shape as it stood right before migrate-011.sql, the same
-- shape the real database actually had at that point in its own history.
-- migrate-011.sql then adds the column on top, and the end result matches
-- the real production schema exactly.

CREATE TABLE IF NOT EXISTS season_pricing (
  season TEXT PRIMARY KEY,
  price_player REAL NOT NULL DEFAULT 180,
  price_goalie REAL NOT NULL DEFAULT 0,
  price_sub_player REAL NOT NULL DEFAULT 15,
  price_sub_goalie REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS player_dues (
  season TEXT NOT NULL,
  player_id TEXT NOT NULL,
  custom_due REAL,
  adjustment REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  notes TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (season, player_id)
);

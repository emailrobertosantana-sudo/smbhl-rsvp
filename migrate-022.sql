-- Migration 022: soft-delete support for leagues (Part 10 -- "deactivate
-- my league"). Purely additive, matching every prior league_id-style
-- migration in this project: a nullable column, no existing row's data
-- touched.
--
-- Apply with:
--   npx wrangler d1 execute smbhl-rsvp --remote --file=./migrate-022.sql
--
-- WHAT THIS DOES: adds `deactivated_at TEXT DEFAULT NULL` to `leagues`.
-- NULL (the default for every existing row, including SMBHL's own
-- bootstrap row from migrate-020.sql) means "active" -- unchanged,
-- zero-behavior-difference for every league that exists today. A real
-- ISO timestamp means "deactivated as of this time" -- checkLeagueAccess
-- (leagues.js) treats any non-null value as a hard access gate for that
-- league's own admins too, blocking every session-gated write/read route
-- that already goes through it, without a separate check bolted onto
-- each route individually. No row is ever deleted by this feature --
-- "soft-delete, not destructive" per the task.

ALTER TABLE leagues ADD COLUMN deactivated_at TEXT DEFAULT NULL;

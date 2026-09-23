-- Migration 024: short, human-readable league URL slugs (Part 2,
-- overnight follow-up task). Purely additive -- a nullable column plus
-- a partial unique index, no existing row's data touched or required
-- to change.
--
-- Apply with:
--   npx wrangler d1 execute smbhl-rsvp --remote --file=./migrate-024.sql
--
-- WHAT THIS DOES: adds `slug TEXT` to `leagues`, plus a unique index
-- that only applies to non-NULL values (SQLite/D1 partial index) --
-- multiple leagues can have slug = NULL (every league that exists
-- before this migration runs, and SMBHL's own bootstrap row, which
-- never gets a slug at all since it isn't part of this per-league
-- URL system), but no two leagues can ever share the same real slug.
--
-- Existing leagues (created before this column existed) do NOT get
-- backfilled by this migration file itself -- SQLite DDL/DML can't
-- express the collision-avoiding slugify-with-suffix logic this needs
-- (see leagues.js's generateUniqueSlug). Instead, leagues.js lazily
-- generates and persists a real slug for any league still missing one
-- the first time its dashboard is loaded (self-healing backfill,
-- same effect as a one-time script, no separate migration-time step
-- needed, and correctly handles collisions using the same logic new
-- leagues use).

ALTER TABLE leagues ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_leagues_slug ON leagues(slug) WHERE slug IS NOT NULL;

-- Migration 041: reusable venues (batch 6, Part 9 of the live-testing task).
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --remote --file=./migrate-041.sql
--
-- WHAT THIS DOES: adds a new `venues` table (league-scoped: name, optional
-- address, optional map_link) and an additive `venue_id` column on `events`
-- pointing at it. Both are purely additive -- no existing column, row,
-- index, or query is touched.
--
-- WHY EXISTING FREE-TEXT EVENTS KEEP WORKING UNCHANGED: `events.venue`
-- (the free-text column every render site in this codebase already reads --
-- schedule, public page, comms, reminder/confirmation emails, SMBHL's own
-- legacy admin) is completely untouched by this migration and stays the
-- single source of truth for the DISPLAYED venue name everywhere. When an
-- event is created against a saved venue (venue_id set), the app writes
-- that venue's name into events.venue too, as a denormalized snapshot --
-- so every one of those ~90 existing read sites keeps working with zero
-- code changes. venue_id is purely ADDITIVE: it only unlocks a map link
-- lookup for the surfaces that choose to show one. An event created the
-- old way (free text, no venue_id) behaves byte-for-byte as before.
--
-- Not applied to SMBHL: this table/column exist in the shared schema, but
-- every write path that could populate venue_id is league-product-only
-- (blocked for league_id = SMBHL_LEAGUE_ID, same pattern as every other
-- /league/* route) -- SMBHL's own legacy event editor never sets or reads
-- venue_id, so SMBHL's events.venue behavior is completely unaffected.

CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  map_link TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_venues_league ON venues(league_id);

ALTER TABLE events ADD COLUMN venue_id TEXT;

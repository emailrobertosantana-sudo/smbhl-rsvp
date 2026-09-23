-- Migration 027: team-structure modes (fixed | headcount | weekly_draw).
-- Purely additive -- every existing league (including SMBHL's own
-- bootstrap row) gets team_structure = 'fixed', its DEFAULT, so this
-- migration changes NOTHING about how any existing league behaves.
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --remote --env demo --file=./migrate-027.sql
--
-- WHAT THIS DOES:
-- - team_structure: chosen once at signup, never changed after (same
--   "not editable after creation" posture as the league slug -- see
--   that earlier decision's own rationale, which applies identically
--   here: changing team structure mid-season would silently
--   reinterpret every existing rsvp/roster row under a different
--   model).
-- - min_players / max_players: ONLY meaningful for 'headcount' leagues
--   (reuses the exact same minimum/maximum roster-threshold PATTERN
--   already used for fixed-mode teams -- min_skaters/skaters_per_team
--   on a season's own config -- applied pool-wide instead of
--   per-team; see getSeasonConfig's own comment). NULL for 'fixed' and
--   'weekly_draw' leagues, which don't use this field at all.

ALTER TABLE leagues ADD COLUMN team_structure TEXT NOT NULL DEFAULT 'fixed';
ALTER TABLE leagues ADD COLUMN min_players INTEGER;
ALTER TABLE leagues ADD COLUMN max_players INTEGER;

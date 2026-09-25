-- Migration 046: playoff configuration (fixed-teams leagues only,
-- league product).
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --remote --file=./migrate-046.sql
--
-- WHAT THIS DOES: adds 6 nullable/defaulted columns to `leagues` (the
-- league's own stored playoff preferences, asked once at onboarding,
-- editable later in Settings -- same "ask once, prefill from Settings
-- afterward" pattern as team_structure/min_players/max_players) and 2
-- columns to `events` (playoff placeholder metadata, read by the event
-- detail page so a playoff game reads as "awaiting seeding," not a
-- misconfigured regular-season game). Purely additive -- no existing
-- column, row, index, or query is touched.
--
-- leagues.playoffs_enabled: 0/1, defaults to 0 (no playoffs) -- matches
-- every existing league's real state (the concept didn't exist before
-- this migration).
-- leagues.playoff_format: 'single_elimination' | 'best_of_n' |
-- 'reserved_slots', NULL until playoffs_enabled is ever turned on.
-- leagues.playoff_teams: how many teams make the playoffs -- ASKED, not
-- derived (a 4-team league might send all 4, or just 2).
-- leagues.playoff_best_of: series length, only meaningful for
-- 'best_of_n'.
-- leagues.playoff_third_place: 0/1, defaults to 0.
-- leagues.playoff_reserved_slots: only meaningful for 'reserved_slots'
-- -- the admin's own direct "I need X games" number, bypassing the
-- team-count/bracket questions entirely (see handleLeagueFixtureApprove's
-- own comment for why: a template-less reservation has no bracket to
-- derive from).
--
-- events.is_playoff: 0/1, defaults to 0 -- every existing event (and
-- every new regular-season event this task's own fixture generator
-- creates) is unaffected.
-- events.playoff_meta: JSON text (role/roundOf/matchupIndexInRound/
-- seedA/seedB/gameNumber/seriesLength), NULL for every non-playoff
-- event. A structured, language-agnostic description -- the actual
-- bilingual label is derived from it at render time (this codebase's
-- own established i18n convention: store structured/stable data,
-- translate at display time, never bake one language into storage).
-- JSON-in-a-TEXT-column already has precedent here (leagues.team_names,
-- leagues.team_colors) -- reused rather than a wide multi-column
-- migration for what is purely display metadata, never queried on.
--
-- Not applied against SMBHL's production database: notreligue-demo and
-- smbhl-rsvp are two entirely separate D1 databases (wrangler.jsonc).
-- SMBHL's own season_hub.js neither reads nor writes any of these
-- columns, so it is unaffected regardless of when (or whether) this
-- migration ever reaches production.

ALTER TABLE leagues ADD COLUMN playoffs_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leagues ADD COLUMN playoff_format TEXT;
ALTER TABLE leagues ADD COLUMN playoff_teams INTEGER;
ALTER TABLE leagues ADD COLUMN playoff_best_of INTEGER;
ALTER TABLE leagues ADD COLUMN playoff_third_place INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leagues ADD COLUMN playoff_reserved_slots INTEGER;
ALTER TABLE events ADD COLUMN is_playoff INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN playoff_meta TEXT;

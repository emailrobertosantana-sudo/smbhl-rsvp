-- Migration 047: two independent tracking switches, score entry,
-- and per-player game stats (league product only).
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --remote --file=./migrate-047.sql
--
-- WHAT THIS DOES, and WHY:
--
-- leagues.tracks_results / leagues.tracks_player_stats: replace the
-- single "Track stats?" question with two independent ones (a fixed-
-- teams league may want standings and never track individuals; a
-- pickup league may want goals/assists with no meaningful standings
-- at all). Both default to 0 (every existing league, including every
-- one that already has the old tracks_stats on, would otherwise show
-- as "nothing tracked" the moment this ships) -- the very next
-- statement migrates that forward correctly:
--
--   UPDATE leagues SET tracks_results = 1, tracks_player_stats = 1
--   WHERE tracks_stats = 1 AND id != 'smbhl'
--
-- so nothing silently turns off, per the task's own explicit
-- requirement. leagues.tracks_stats itself, and the shared
-- tracksStats(config) helper (season_config.js) it feeds, are left
-- COMPLETELY UNTOUCHED -- SMBHL's own season-recap/stats-tab routes
-- still read that exact column on its own 'smbhl' row, and SMBHL
-- tracks its own stats by hand-editing data.json, a deliberate
-- choice this task does not touch. The `AND id != 'smbhl'` guard on
-- the UPDATE above is extra insurance on top of that -- SMBHL's own
-- row is never written by this migration at all, even though its
-- tracks_stats value happens to be irrelevant to these two new,
-- league-product-only columns regardless.
--
-- events.home_score / events.away_score / events.result_entered_at:
-- a final score, admin-entered (Part 2), editable afterward (re-
-- entering just overwrites). NULL/NULL/NULL for every existing event
-- and every regular-season event created by earlier work in this
-- product (fixture generator, single-event route) -- nothing reads
-- these as "0-0, played" by accident; result_entered_at is the one
-- true "has this game got a real result" signal (a legitimate 0-0 tie
-- must be distinguishable from "no score entered yet").
--
-- player_game_stats: one row per (event_id, player_id) -- goals/
-- assists for a skater, goals_against for a goalie (role column
-- distinguishes; a goalie's win/loss/tie is DERIVED from the event's
-- own score + which side they were on, never stored redundantly --
-- see handleLeaguePlayerStatsUpsert's own comment). One row per game
-- per player, not per season, so the SAME player can have a skater
-- row in one game and a goalie row in another within the same season
-- (task's own explicit requirement) -- nothing about this schema
-- prevents that; there is simply no season-level "role" anywhere.
--
-- Not applied against SMBHL's production database: notreligue-demo
-- and smbhl-rsvp are two entirely separate D1 databases
-- (wrangler.jsonc). SMBHL's own data.json-based stats tracking is
-- completely unaffected regardless of if/when this migration ever
-- reaches production.

ALTER TABLE leagues ADD COLUMN tracks_results INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leagues ADD COLUMN tracks_player_stats INTEGER NOT NULL DEFAULT 0;
UPDATE leagues SET tracks_results = 1, tracks_player_stats = 1 WHERE tracks_stats = 1 AND id != 'smbhl';

ALTER TABLE events ADD COLUMN home_score INTEGER;
ALTER TABLE events ADD COLUMN away_score INTEGER;
ALTER TABLE events ADD COLUMN result_entered_at TEXT;

CREATE TABLE IF NOT EXISTS player_game_stats (
  event_id       TEXT NOT NULL,
  player_id      TEXT NOT NULL,
  league_id      TEXT NOT NULL,
  team           TEXT,                          -- which side they played for
  role           TEXT NOT NULL DEFAULT 'skater', -- 'skater' | 'goalie'
  goals          INTEGER NOT NULL DEFAULT 0,
  assists        INTEGER NOT NULL DEFAULT 0,
  goals_against  INTEGER,                        -- goalie only
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (event_id, player_id)
);

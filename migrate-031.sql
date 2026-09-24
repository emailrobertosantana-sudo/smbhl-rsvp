-- Migration 031: optional automatic weekly-draw scheduling for
-- weekly_draw leagues (live-testing task, Part 9). Purely additive --
-- every existing league (including SMBHL, which isn't weekly_draw and
-- never reads these columns) gets auto_draw_enabled = 0 (off), so
-- nothing changes automatically for anyone who hasn't opted in.
-- Placed at the league level, matching where team_structure itself
-- lives (leagues.team_structure), not per-season -- consistent with
-- this task's own "consistent with where team_structure lives"
-- instruction.
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --remote --env demo --file=./migrate-031.sql
--
-- auto_draw_enabled: 0/1, off by default. Only meaningful for a
-- weekly_draw league; ignored otherwise.
-- auto_draw_hours_before: how many hours before an event's start_time
-- the scheduled cron should run the same random draw the admin's
-- manual "draw teams" button already runs. Defaults to 24 (a full day
-- of notice) -- only read when auto_draw_enabled = 1.

ALTER TABLE leagues ADD COLUMN auto_draw_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leagues ADD COLUMN auto_draw_hours_before INTEGER NOT NULL DEFAULT 24;

-- Idempotency log for the scheduled draw, same ON CONFLICT DO NOTHING
-- pattern as league_reminder_log -- prevents the cron from re-shuffling
-- an event's teams on every tick once it's already drawn one for that
-- event, and self-heals if a tick is ever missed (the next tick still
-- finds the event within its hours-before window and draws it late,
-- rather than silently skipping it forever).
CREATE TABLE IF NOT EXISTS league_auto_draw_log (
  event_id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL,
  drawn_at TEXT NOT NULL,
  assigned_count INTEGER NOT NULL DEFAULT 0
);

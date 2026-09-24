-- Migration 034: idempotency log for the "team assigned" follow-up
-- email (live-testing task, Part 3). Purely additive -- a new, empty
-- table changes nothing about any existing league's behavior until the
-- specific late-draw case this closes actually occurs.
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --remote --env demo --file=./migrate-034.sql
--
-- One row per (event_id, player_id) that has already received the
-- follow-up, so a player reassigned to a different team later (or the
-- random draw + a manual tweak touching the same player) is never
-- emailed twice for the same event -- same ON CONFLICT DO NOTHING
-- self-healing idempotency pattern as league_reminder_log and
-- league_auto_draw_log.

CREATE TABLE IF NOT EXISTS league_team_assigned_email_log (
  event_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (event_id, player_id)
);

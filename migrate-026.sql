-- Migration 026: per-league automated reminder/logistics settings +
-- the sent-log for the new, independent league-reminder cron.
-- Purely additive.
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --remote --env demo --file=./migrate-026.sql
--
-- WHAT THIS DOES:
-- 1. Three independent on/off toggles on `leagues`, one per reminder
--    type (72h non-responder reminder, 24h non-responder reminder,
--    12h confirmed-player logistics message). Defaulted ON (1),
--    matching this table's own existing convention (tracks_stats
--    NOT NULL DEFAULT 1, migrate-019.sql) -- these are exactly the
--    kind of "the product does the paperasse for you" feature a new
--    admin expects by default, and an admin who wants them off can
--    turn any of the three off independently from the dashboard.
-- 2. league_reminder_log: per-(event, reminder kind) sent tracking, so
--    the cron never sends the same automatic reminder twice for the
--    same event. The manual "send now" trigger deliberately does NOT
--    write to this log (see the task's own report) -- it's a pure
--    extra send, never suppresses the automatic 72h/24h reminders.
--
-- SMBHL is not part of this system: its own events never match any
-- league_id this feature's cron looks at (see runLeagueReminders'
-- own comment), and it has no rows in league_reminder_log at all.

ALTER TABLE leagues ADD COLUMN reminder_72h_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE leagues ADD COLUMN reminder_24h_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE leagues ADD COLUMN reminder_12h_enabled INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS league_reminder_log (
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- 'reminder_72h' | 'reminder_24h' | 'logistics_12h'
  league_id TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_league_reminder_log_league ON league_reminder_log(league_id);

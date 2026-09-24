-- Live-testing task (batch 3), Part 2: Comms view -- email activity
-- and cadence visibility for the league product.
--
-- Every SUCCESSFUL league-scoped send already has a real record
-- somewhere (outbox.sent_at for sub_call invites, league_reminder_log
-- for the 72h/24h/12h waves, league_team_assigned_email_log for the
-- late-draw catch-up email) -- this task reuses all three rather than
-- adding new tracking for what's already tracked, per its own
-- instruction. What was genuinely missing: a FAILED send in either
-- sendLeagueReminderKind or maybeSendTeamAssignedFollowup was only
-- ever console.error'd, never persisted anywhere -- a league admin had
-- no way to ever discover a reminder silently failed to reach someone.
-- (outbox itself doesn't need this: it already has its own `error`
-- column, written by drain()'s catch block -- sub_call failures were
-- already visible, just never surfaced in any league-facing UI until
-- this task's Comms view.)
--
-- Deliberately NOT folded into league_reminder_log/
-- league_team_assigned_email_log themselves: both tables' PRIMARY KEY
-- doubles as a dedup/"already sent" gate (a row's mere PRESENCE blocks
-- a resend) -- recording a failed attempt there would incorrectly
-- block a legitimate retry. A separate, append-only log has no such
-- constraint.
CREATE TABLE IF NOT EXISTS league_mail_failure_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id TEXT NOT NULL,
  event_id TEXT,
  player_id TEXT,
  kind TEXT NOT NULL,
  error TEXT,
  failed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_league_mail_failure_log_league ON league_mail_failure_log(league_id, failed_at);

-- Migration 028: sport_type foundation (Part 4 of a live-testing
-- task). Purely additive -- every existing league (including SMBHL's
-- own bootstrap row) gets sport_type = 'hockey', its DEFAULT, so this
-- migration changes NOTHING about how any existing league behaves.
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --remote --env demo --file=./migrate-028.sql
--
-- WHAT THIS DOES:
-- sport_type: chosen once at signup (silently -- every league today
-- gets 'hockey' with no new question asked; see the task's own
-- explicit instruction not to add any sport-selection UI yet). This is
-- foundational groundwork for other sports in a future task -- the
-- ONLY behavior gated on it today is the hockey-specific goalie axis
-- built in the very next migration/task part (min_goalies,
-- migrate-029.sql) and its own shortage/UI logic. Not editable after
-- creation (same "not editable after creation" posture as
-- team_structure/slug -- see those migrations' own rationale).

ALTER TABLE leagues ADD COLUMN sport_type TEXT NOT NULL DEFAULT 'hockey';

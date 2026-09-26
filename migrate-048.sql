-- Migration 048: organizer's note (league product only).
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --remote --file=./migrate-048.sql
--
-- leagues.organizer_note: a STANDING blurb from the league organizer,
-- shown on the public page when set, absent when empty -- no expiry,
-- no scheduling (a decision, not a weekly notice). NULL for every
-- existing league; the public page already treats an empty/null note
-- as "section absent," so this is a no-op for every league until its
-- admin sets one in Settings.

ALTER TABLE leagues ADD COLUMN organizer_note TEXT;

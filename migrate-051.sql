-- Migration 051: daily send cap (SMBHL and league product).
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --env demo --remote --file=./migrate-051.sql
--   (production: npx wrangler d1 execute smbhl-rsvp --remote --file=./migrate-051.sql)
--
-- The Resend plan caps emails per calendar day (UTC); the cap itself is
-- configuration (MAIL_DAILY_CAP, wrangler.jsonc). See src/mail_queue.js,
-- "DAILY SEND CAP".
--
--   mail_daily_count   one row per UTC day: every email Resend accepted
--                      (sent) and how many of those were sub calls. Kept
--                      in D1 so a Worker restart never resets the count.
--   outbox.defer_reason  why a row is waiting for a later day ('daily_cap'
--                      = our own budget, 'resend_quota' = Resend refused
--                      for quota); cleared when the row is sent.

CREATE TABLE IF NOT EXISTS mail_daily_count (
  day        TEXT PRIMARY KEY,
  sent       INTEGER NOT NULL DEFAULT 0,
  sub_calls  INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE outbox ADD COLUMN defer_reason TEXT;

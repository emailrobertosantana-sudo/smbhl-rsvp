-- Migration 050: outbox delivery states -- a failed send must never look
-- like a sent one (SMBHL and league product).
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --env demo --remote --file=./migrate-050.sql
--   (production: npx wrangler d1 execute smbhl-rsvp --remote --file=./migrate-050.sql)
--
-- Before this, an outbox row had only sent_at/cancelled/error. A send
-- that failed and later succeeded kept its old error next to its new
-- sent_at, so the Comms tab counted it as sent and never as failed; a
-- permanent failure was stored as cancelled + error, indistinguishable
-- from a deliberate skip; and nothing bounded how often a row retried.
-- See src/mail_queue.js for the state model and retry policy.
--
--   attempts         sends tried so far
--   next_attempt_at  earliest time a retrying row may be tried again
--   failed_at        set when a row failed PERMANENTLY (with cancelled = 1)
--   last_error       most recent failure text, kept after a later success

ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN next_attempt_at TEXT;
ALTER TABLE outbox ADD COLUMN failed_at TEXT;
ALTER TABLE outbox ADD COLUMN last_error TEXT;

-- Rows that failed and were then delivered on a later pass (sent_at AND
-- error -- e.g. the Sept 19/21/26 "Too many subrequests" rows): keep
-- the failure text as history, clear it from the live error column.
UPDATE outbox SET last_error = error, error = NULL
 WHERE sent_at IS NOT NULL AND error IS NOT NULL;

-- Historical permanent failures were stored as cancelled + error, the
-- same shape as a deliberate skip. Mark the real failures as failed so
-- the Comms tab shows them; deliberate skips (no email on file, opted
-- out, no longer confirmed in, too close to game time, season not
-- tracking stats) stay skipped.
UPDATE outbox SET failed_at = COALESCE(send_after, created_at), last_error = error
 WHERE cancelled = 1 AND sent_at IS NULL AND error IS NOT NULL
   AND (error LIKE 'resend %' OR error LIKE 'invalid email format%');

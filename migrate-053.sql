-- Migration 053: quiet hours checked at send time as well as when queued.
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --env demo --remote --file=./migrate-053.sql
--   (production: npx wrangler d1 execute smbhl-rsvp --remote --file=./migrate-053.sql)
--   Apply BEFORE deploying the code that reads it (the schema guard
--   refuses to serve until outbox.quiet_exempt exists).
--
-- drain() now holds a due row that comes due inside quiet hours (a retry,
-- a row queued before the settings changed) until the window ends. A row
-- whose sender deliberately skipped quiet hours (a real person's action
-- sent straight away, or a league's simple-model mail) is remembered here
-- so it is still sent as queued.
--
--   outbox.quiet_exempt   1 = sent regardless of quiet hours; 0 (default) =
--                         held for them at send time too.

ALTER TABLE outbox ADD COLUMN quiet_exempt INTEGER NOT NULL DEFAULT 0;

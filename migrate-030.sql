-- Migration 030: track the language a user actually signed up in, so the
-- verification email (and any resend) can be sent in that one language
-- instead of the old always-bilingual send. Purely additive -- every
-- existing user row gets the app's existing default language ('fr', same
-- default nlAuthScript already falls back to everywhere else) with no
-- behavior change for anyone who has already verified. Apply with:
--   npx wrangler d1 execute notreligue-demo --remote --env demo --file=./migrate-030.sql

ALTER TABLE users ADD COLUMN signup_lang TEXT NOT NULL DEFAULT 'fr';

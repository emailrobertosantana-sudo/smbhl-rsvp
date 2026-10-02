-- Migration 057: where a Notre Ligue league came from (ad test, 2026-10-02).
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --env demo --remote --file=./migrate-057.sql
--   (production: npx wrangler d1 execute smbhl-rsvp --remote --file=./migrate-057.sql)
--   Apply BEFORE deploying the code that reads it, on BOTH databases: the
--   schema guard checks the same manifest on both workers and refuses to
--   serve until these columns exist. Code from before this migration never
--   names them, so it runs unchanged on the new schema.
--
-- Additive only: seven nullable columns on leagues, no default, no backfill.
-- Filled once, when a league is created from a homepage link that carried
-- the parameters (src/attribution.js); a league created without them keeps
-- them all null. No IP address, no personal data.
--
--   leagues.angle             the homepage angle (?a=), e.g. remplacants
--   leagues.utm_source        e.g. facebook
--   leagues.utm_medium        e.g. paid
--   leagues.utm_campaign      e.g. test1
--   leagues.utm_content       e.g. prix-fr
--   leagues.landing_language  fr | en, the homepage's language
--   leagues.attributed_at     ISO time the league was created with them

ALTER TABLE leagues ADD COLUMN angle TEXT;
ALTER TABLE leagues ADD COLUMN utm_source TEXT;
ALTER TABLE leagues ADD COLUMN utm_medium TEXT;
ALTER TABLE leagues ADD COLUMN utm_campaign TEXT;
ALTER TABLE leagues ADD COLUMN utm_content TEXT;
ALTER TABLE leagues ADD COLUMN landing_language TEXT;
ALTER TABLE leagues ADD COLUMN attributed_at TEXT;

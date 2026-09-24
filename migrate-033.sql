-- Migration 033: public site theme picker (live-testing task, Part 2).
-- Purely additive -- every existing league (including SMBHL, which
-- never reads this column, and every league created before this task)
-- gets 'arene' -- the exact CSS/markup the public page already used
-- before this task, now just given a name and made selectable. No
-- existing league's public page changes at all until an admin
-- explicitly picks a different theme.
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --remote --env demo --file=./migrate-033.sql
--
-- Only 'arene' and 'clean' are real, tested, working themes as of this
-- migration (see handleLeaguePublicPage's own theme-branch comment for
-- which 2 of the design system's 4 defined themes are implemented, and
-- why the other 2 were deliberately deferred rather than shipped
-- half-built). The column itself allows any string so a later task can
-- add 'classic'/'warm' without a further migration; the settings
-- page's picker only ever offers the themes that actually render.

ALTER TABLE leagues ADD COLUMN public_theme TEXT NOT NULL DEFAULT 'arene';

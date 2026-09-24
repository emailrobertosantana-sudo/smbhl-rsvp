-- Migration 035: reconcile the role/goalie data model for the league
-- product's roster (live-testing task, Part 2 bug fix). The roster
-- page used to offer 'sub_goalie' as a 3rd role value for
-- 'fixed'/'weekly_draw' leagues, duplicating the independent
-- Goalie/Player axis (is_goalie) already built for headcount --
-- reported as two controls for the same thing that could disagree.
-- Fixed by retiring 'sub_goalie' as a role value across this product:
-- role is now exactly 'roster' or 'sub_skater' everywhere, and
-- is_goalie alone carries goalie-ness, for a regular or a sub, in every
-- team structure.
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --remote --env demo --file=./migrate-035.sql
--
-- SAFETY: scoped to WHERE league_id != 'smbhl' only. SMBHL's own
-- legacy admin tooling (season_hub.js and this app's own SMBHL-only
-- admin routes) still reads and writes role='sub_goalie' directly as
-- a real, load-bearing value throughout -- this migration must NEVER
-- touch SMBHL's contacts rows, and does not.
--
-- For every OTHER (real, non-SMBHL) league: a contact with
-- role='sub_goalie' is set to role='sub_skater', is_goalie=1 -- the
-- exact status quo that role value already implied (see the OLD
-- createLeagueContactRow logic this migration is undoing: `let
-- isGoalie = (role === 'sub_goalie' || position === 'G') ? 1 : 0;`),
-- so no existing non-SMBHL league's real goalie coverage or shortage
-- detection changes at all -- only how that same fact is stored.

UPDATE contacts
   SET role = 'sub_skater', is_goalie = 1
 WHERE role = 'sub_goalie' AND league_id != 'smbhl';

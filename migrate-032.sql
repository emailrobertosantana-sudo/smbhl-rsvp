-- Migration 032: per-team colours for 'fixed'/'weekly_draw' leagues
-- (live-testing task, Part 1 -- the settings page's team editor). Purely
-- additive -- every existing league (including SMBHL) gets NULL, which
-- every render site already treats as "use the existing positional
-- ROSTER_TEAM_DOTS palette", the exact same colours shown today. No
-- existing league's rendered team colours change until an admin
-- explicitly sets a custom one through the new settings page.
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --remote --env demo --file=./migrate-032.sql
--
-- Shape: a JSON array of hex strings parallel to leagues.team_names
-- (same index = same team), e.g. ["#c9152f","#2a5fa8"]. A shorter array
-- than team_names, a missing entry, or NULL for the whole column all
-- fall back to the positional default for that index -- never an error.

ALTER TABLE leagues ADD COLUMN team_colors TEXT;

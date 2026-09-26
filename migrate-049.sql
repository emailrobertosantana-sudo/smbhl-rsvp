-- Migration 049: optional address/map link for a FREE-TEXT venue
-- (league product only).
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --remote --file=./migrate-049.sql
--
-- Events polish task (C3): a saved venue (venues table, migrate-041)
-- already carries an address and map link; typing a venue as free
-- text gave a bare name with no path to either. These two columns are
-- this event's OWN one-off address/map link, only ever meaningful
-- when venue_id IS NULL (a saved venue's own record already has
-- these -- see getVenueMapLinksById, which stays the source of truth
-- for that case). NULL for every existing event.

ALTER TABLE events ADD COLUMN venue_address TEXT;
ALTER TABLE events ADD COLUMN venue_map_link TEXT;

-- Migration 052: sub dues per GAME, not per night -- settled subs kept.
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --env demo --remote --file=./migrate-052.sql
--   (production: npx wrangler d1 execute smbhl-rsvp --remote --file=./migrate-052.sql)
--   Apply BEFORE deploying the code that reads it (the schema guard
--   refuses to serve until player_dues.settled_nights exists).
--
-- Finance charged subs per event attended (one event = one night) while
-- SMBHL plays two games a night. Sub dues are now events x games per
-- night x sub rate. Subs whose dues row already records a payment are
-- settled and must not be recalculated: this snapshots how many nights
-- each of them had played when this migration ran. Those nights stay at
-- one game each; only nights after them are counted at games per night.
--
--   player_dues.settled_nights  nights already settled at the old
--                               one-game-per-night count (NULL = none)

ALTER TABLE player_dues ADD COLUMN settled_nights INTEGER;

UPDATE player_dues
   SET settled_nights = (
     SELECT count(*) FROM rsvp r JOIN events e ON e.id = r.event_id
      WHERE e.season = player_dues.season AND r.player_id = player_dues.player_id
        AND r.status = 'in' AND e.state = 'done'
   )
 WHERE amount_paid > 0
   AND player_id IN (SELECT player_id FROM contacts WHERE is_sub = 1);

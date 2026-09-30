-- Migration 055: league finance -- a pricing mode per season, and the
-- admin's "didn't show" correction on a game.
--
-- Apply with:
--   npx wrangler d1 execute notreligue-demo --env demo --remote --file=./migrate-055.sql
--   (production: npx wrangler d1 execute smbhl-rsvp --remote --file=./migrate-055.sql)
--   Apply BEFORE deploying the code that reads it (the schema guard
--   refuses to serve until both columns exist).
--
--   season_pricing.pricing_mode  'season' (default): regulars pay the
--                                season fee (price_player / price_goalie),
--                                subs pay per game (price_sub_player /
--                                price_sub_goalie) -- SMBHL's model, and
--                                every existing row;
--                                'per_game': everyone pays per game, at
--                                price_sub_player / price_sub_goalie.
--   rsvp.no_show                 1 = the player was marked in for a game
--                                that started but did not play it (the
--                                admin's correction on the game page): not
--                                a game played, not charged.

ALTER TABLE season_pricing ADD COLUMN pricing_mode TEXT NOT NULL DEFAULT 'season';
ALTER TABLE rsvp ADD COLUMN no_show INTEGER NOT NULL DEFAULT 0;

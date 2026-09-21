-- Cleanup duplicate contacts created during week 2 sheet publishing
DELETE FROM contacts WHERE player_id IN ('P0299', 'P0300', 'P0301', 'P0302', 'P0303');

-- Migrate P900x contacts to official P0xxx IDs
UPDATE contacts SET player_id = 'P0299', last_played = 'Fall 2026' WHERE player_id = 'P9001';
UPDATE contacts SET player_id = 'P0300', last_played = 'Fall 2026' WHERE player_id = 'P9004';
UPDATE contacts SET player_id = 'P0301', last_played = 'Fall 2026' WHERE player_id = 'P9007';
UPDATE contacts SET player_id = 'P0302', last_played = 'Fall 2026' WHERE player_id = 'P9005';
UPDATE contacts SET player_id = 'P0303', last_played = 'Fall 2026' WHERE player_id = 'P9006';

-- Delete duplicate sheet rsvps for 2026-09-20
DELETE FROM rsvp WHERE event_id = '2026-09-20' AND player_id IN ('P0299', 'P0300', 'P0301', 'P0302', 'P0303');

-- Update rsvp to canonical player IDs
UPDATE rsvp SET player_id = 'P0299' WHERE player_id = 'P9001';
UPDATE rsvp SET player_id = 'P0300' WHERE player_id = 'P9004';
UPDATE rsvp SET player_id = 'P0301' WHERE player_id = 'P9007';
UPDATE rsvp SET player_id = 'P0302' WHERE player_id = 'P9005';
UPDATE rsvp SET player_id = 'P0303' WHERE player_id = 'P9006';

-- Update availability to canonical player IDs
UPDATE availability SET player_id = 'P0299' WHERE player_id = 'P9001';
UPDATE availability SET player_id = 'P0300' WHERE player_id = 'P9004';
UPDATE availability SET player_id = 'P0301' WHERE player_id = 'P9007';
UPDATE availability SET player_id = 'P0302' WHERE player_id = 'P9005';
UPDATE availability SET player_id = 'P0303' WHERE player_id = 'P9006';

-- Update outbox to canonical player IDs
UPDATE outbox SET player_id = 'P0299' WHERE player_id = 'P9001';
UPDATE outbox SET player_id = 'P0300' WHERE player_id = 'P9004';
UPDATE outbox SET player_id = 'P0301' WHERE player_id = 'P9007';
UPDATE outbox SET player_id = 'P0302' WHERE player_id = 'P9005';
UPDATE outbox SET player_id = 'P0303' WHERE player_id = 'P9006';

-- Update team_messages if any
UPDATE team_messages SET player_id = 'P0299' WHERE player_id = 'P9001';
UPDATE team_messages SET player_id = 'P0300' WHERE player_id = 'P9004';
UPDATE team_messages SET player_id = 'P0301' WHERE player_id = 'P9007';
UPDATE team_messages SET player_id = 'P0302' WHERE player_id = 'P9005';
UPDATE team_messages SET player_id = 'P0303' WHERE player_id = 'P9006';


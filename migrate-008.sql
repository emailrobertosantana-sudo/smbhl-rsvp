-- SMBHL attendance — schema migration 008: Team Message Board
-- Apply with: npx wrangler d1 execute smbhl-rsvp --remote --file=./migrate-008.sql

CREATE TABLE IF NOT EXISTS team_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  team TEXT NOT NULL,
  player_name TEXT NOT NULL,
  player_id TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_messages_event_team 
  ON team_messages (event_id, team, created_at);


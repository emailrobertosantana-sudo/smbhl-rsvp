-- Migration 012: Add planned_absences table for season-long vacation / absence tracking
CREATE TABLE IF NOT EXISTS planned_absences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  date TEXT NOT NULL,
  season TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(player_id, date)
);

CREATE INDEX IF NOT EXISTS idx_planned_absences_season ON planned_absences(season, date);
CREATE INDEX IF NOT EXISTS idx_planned_absences_player ON planned_absences(player_id);


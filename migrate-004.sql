-- Step 5: availability pool and waitlist

-- a sub's answer to "are you available this week", separate from being placed
-- on a team. Waitlisted subs fill the next hole with no new email to anyone.
CREATE TABLE IF NOT EXISTS availability (
  event_id    TEXT NOT NULL,
  player_id   TEXT NOT NULL,
  need        TEXT NOT NULL,          -- goalie | skater (separate queues)
  status      TEXT NOT NULL,          -- yes | no
  answered_at TEXT NOT NULL,          -- first-answered wins the next spot
  PRIMARY KEY (event_id, player_id, need)
);
CREATE INDEX IF NOT EXISTS idx_avail_queue
  ON availability(event_id, need, status, answered_at);

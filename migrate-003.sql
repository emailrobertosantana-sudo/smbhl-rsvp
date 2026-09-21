-- Step 4 migration: outbox + job log

-- every message the system intends to send. Nothing is sent inline; the cron
-- drains this. That is what makes the 1-hour and 5-minute holds possible, and
-- it means a crash mid-send never loses or duplicates a message.
CREATE TABLE IF NOT EXISTS outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,          -- invite | chase | sub_call | assigned | released | notice | summary
  event_id    TEXT NOT NULL,
  player_id   TEXT,                   -- recipient, null for manager mail
  team        TEXT,
  dedup_key   TEXT,                   -- newer message with same key cancels the pending one
  payload     TEXT,                   -- json
  send_after  TEXT NOT NULL,          -- ISO; the hold
  sent_at     TEXT,
  cancelled   INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_due
  ON outbox(sent_at, cancelled, send_after);
CREATE INDEX IF NOT EXISTS idx_outbox_dedup
  ON outbox(dedup_key, sent_at, cancelled);

-- which scheduled jobs have already run for an event, so a cron that fires
-- every 5 minutes does not send the Thursday reminder 12 times.
CREATE TABLE IF NOT EXISTS jobs (
  event_id  TEXT NOT NULL,
  job       TEXT NOT NULL,            -- invite | chase | shortcheck | summary | lock
  ran_at    TEXT NOT NULL,
  PRIMARY KEY (event_id, job)
);

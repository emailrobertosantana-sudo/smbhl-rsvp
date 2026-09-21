-- Step 7: Scoresheet ingestion and review sessions
CREATE TABLE IF NOT EXISTS sheet_reviews (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  season TEXT NOT NULL,
  week INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | published | discarded
  images_json TEXT,                    -- JSON array of image KV keys
  extracted_json TEXT,                 -- raw parsed stats
  validated_json TEXT,                 -- processed games and validation status
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_reviews_status ON sheet_reviews(status);


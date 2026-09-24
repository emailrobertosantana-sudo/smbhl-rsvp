-- Live-testing task (batch 2), Part 10: per-league setting to disable
-- the public-facing page entirely. Default ENABLED (1) so every
-- existing league is completely unaffected -- this column only ever
-- changes behavior for a league whose admin explicitly disables it via
-- the settings page after this migration.
ALTER TABLE leagues ADD COLUMN public_page_enabled INTEGER NOT NULL DEFAULT 1;

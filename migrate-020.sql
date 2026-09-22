-- Migration 020: League data isolation, STEP 1 of 2 — additive league_id
-- columns only. Part F of the multi-league accounts foundation.
--
-- Apply with:
--   npx wrangler d1 execute smbhl-rsvp --remote --file=./migrate-020.sql
--
-- WHAT THIS DOES: adds a `league_id TEXT NOT NULL DEFAULT 'smbhl'` column to
-- every league-scoped table (see the full audit in the Part F report), and
-- gives SMBHL an actual row in `leagues` (it did not have one before — that
-- table's only writer so far is the new-signup flow in leagues.js) so the
-- default has something real to point at.
--
-- WHY THIS IS SAFE FOR FALL 2026 / SMBHL:
--   - Every ALTER TABLE below is purely additive. No existing column,
--     row, index, or query is touched.
--   - Because the new column is NOT NULL DEFAULT 'smbhl', every one of
--     SMBHL's existing rows is automatically backfilled to league_id =
--     'smbhl' as part of the ALTER TABLE itself — no separate UPDATE needed,
--     and no row's existing data changes.
--   - Because it's a DEFAULT (not just a backfill), every INSERT already in
--     this codebase that doesn't mention league_id (i.e. all of them, today)
--     keeps inserting rows that are automatically tagged league_id='smbhl',
--     with zero code changes. SMBHL's actual read/write behavior is
--     byte-for-byte unchanged by this migration on its own.
--
-- WHAT THIS DOES NOT DO (see the Part F report for why, in detail):
--   - It does NOT change a single read or write query to filter by
--     league_id. No isolation exists yet after this migration alone — it
--     only makes isolation *possible* to build next. Until the query layer
--     (step 2) is done, this column is inert.
--   - It does NOT touch `events.id` or `contacts.player_id`, both of which
--     are app-generated, non-league-scoped identifiers with real collision/
--     overwrite risk once a second league can create its own events/
--     contacts (events.id is literally the calendar date, and existing code
--     does `INSERT ... ON CONFLICT(id) DO UPDATE`, which would silently
--     merge a second league's game into SMBHL's row if they ever share a
--     date). Resolving that is a prerequisite for step 2, not something this
--     migration attempts.

INSERT INTO leagues (id, name, division_label, tracks_stats, team_count, team_names, created_by, created_at)
SELECT 'smbhl', 'SMBHL', NULL, 1, 0, '[]', 'system', '2026-01-01T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM leagues WHERE id = 'smbhl');

ALTER TABLE contacts         ADD COLUMN league_id TEXT NOT NULL DEFAULT 'smbhl';
ALTER TABLE events           ADD COLUMN league_id TEXT NOT NULL DEFAULT 'smbhl';
ALTER TABLE rsvp             ADD COLUMN league_id TEXT NOT NULL DEFAULT 'smbhl';
ALTER TABLE sheet_reviews    ADD COLUMN league_id TEXT NOT NULL DEFAULT 'smbhl';
ALTER TABLE team_messages    ADD COLUMN league_id TEXT NOT NULL DEFAULT 'smbhl';
ALTER TABLE settings         ADD COLUMN league_id TEXT NOT NULL DEFAULT 'smbhl';
ALTER TABLE outbox           ADD COLUMN league_id TEXT NOT NULL DEFAULT 'smbhl';
ALTER TABLE jobs             ADD COLUMN league_id TEXT NOT NULL DEFAULT 'smbhl';
ALTER TABLE availability     ADD COLUMN league_id TEXT NOT NULL DEFAULT 'smbhl';
ALTER TABLE season_costs     ADD COLUMN league_id TEXT NOT NULL DEFAULT 'smbhl';
ALTER TABLE season_pricing   ADD COLUMN league_id TEXT NOT NULL DEFAULT 'smbhl';
ALTER TABLE player_dues      ADD COLUMN league_id TEXT NOT NULL DEFAULT 'smbhl';
ALTER TABLE planned_absences ADD COLUMN league_id TEXT NOT NULL DEFAULT 'smbhl';
ALTER TABLE polls            ADD COLUMN league_id TEXT NOT NULL DEFAULT 'smbhl';
ALTER TABLE poll_votes       ADD COLUMN league_id TEXT NOT NULL DEFAULT 'smbhl';

CREATE INDEX IF NOT EXISTS idx_contacts_league         ON contacts(league_id);
CREATE INDEX IF NOT EXISTS idx_events_league           ON events(league_id);
CREATE INDEX IF NOT EXISTS idx_rsvp_league             ON rsvp(league_id);
CREATE INDEX IF NOT EXISTS idx_sheet_reviews_league    ON sheet_reviews(league_id);
CREATE INDEX IF NOT EXISTS idx_team_messages_league    ON team_messages(league_id);
CREATE INDEX IF NOT EXISTS idx_settings_league         ON settings(league_id);
CREATE INDEX IF NOT EXISTS idx_outbox_league           ON outbox(league_id);
CREATE INDEX IF NOT EXISTS idx_jobs_league             ON jobs(league_id);
CREATE INDEX IF NOT EXISTS idx_availability_league     ON availability(league_id);
CREATE INDEX IF NOT EXISTS idx_season_costs_league     ON season_costs(league_id);
CREATE INDEX IF NOT EXISTS idx_season_pricing_league   ON season_pricing(league_id);
CREATE INDEX IF NOT EXISTS idx_player_dues_league      ON player_dues(league_id);
CREATE INDEX IF NOT EXISTS idx_planned_absences_league ON planned_absences(league_id);
CREATE INDEX IF NOT EXISTS idx_polls_league            ON polls(league_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_league       ON poll_votes(league_id);

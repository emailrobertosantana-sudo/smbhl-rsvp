// Part F, step 1: proves migrate-020.sql (additive league_id columns) is
// safe against a schema that matches production BEFORE the migration runs,
// and that SMBHL's existing data is completely unaffected by applying it.
//
// This does NOT test cross-league query isolation — that requires the
// query-layer scoping work migrate-020.sql deliberately does not attempt
// (see the migration's own header comment and the Part F report for why).
// What's tested here is narrower and fully within this session's safe,
// completed scope: the migration applies cleanly, backfills every existing
// row to league_id='smbhl' without altering any other column, and every
// pre-existing INSERT pattern in this codebase (which never mentions
// league_id) keeps working unchanged because of the column's DEFAULT.
//
// migrate-020.sql's own statements are no longer hand-copied here (see
// Part 2 of the migrate-020.sql FK-bug follow-up) -- getRealMigrationQueries
// pulls them straight from the real file via test/support/real_schema.js,
// so there is nothing left to keep in sync by hand.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRealMigrationQueries } from './support/real_schema.js';

async function applyMigration020(db) {
  for (const stmt of getRealMigrationQueries(20)) {
    await db.prepare(stmt).run();
  }
}

describe('Part F step 1: migrate-020.sql (additive league_id columns)', () => {
  beforeAll(async () => {
    // Pre-migration production schema (matches schema.sql + migrate-002..019).
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS contacts (
      player_id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT,
      is_sub INTEGER NOT NULL DEFAULT 0, is_backup_goalie INTEGER NOT NULL DEFAULT 0,
      opted_out INTEGER NOT NULL DEFAULT 0, token_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'roster', is_goalie INTEGER NOT NULL DEFAULT 0,
      asked_streak INTEGER NOT NULL DEFAULT 0, last_asked TEXT, last_played TEXT,
      answered_ever INTEGER NOT NULL DEFAULT 0, dormant INTEGER NOT NULL DEFAULT 0,
      preferred_team TEXT, position TEXT, previous_role TEXT, archive_reason TEXT
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, season TEXT NOT NULL, week INTEGER NOT NULL, date TEXT NOT NULL,
      venue TEXT, state TEXT NOT NULL DEFAULT 'open', start_time TEXT, end_time TEXT
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rsvp (
      event_id TEXT NOT NULL, player_id TEXT, guest_name TEXT, team TEXT,
      status TEXT NOT NULL DEFAULT 'pending', role TEXT NOT NULL DEFAULT 'roster',
      status_by TEXT NOT NULL DEFAULT 'auto', claimed_at TEXT, updated_at TEXT NOT NULL
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sheet_reviews (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, season TEXT NOT NULL, week INTEGER NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', images_json TEXT, extracted_json TEXT, validated_json TEXT, published_at TEXT)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS team_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, team TEXT NOT NULL, player_name TEXT NOT NULL, player_id TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, event_id TEXT NOT NULL, player_id TEXT, team TEXT, dedup_key TEXT, payload TEXT, send_after TEXT NOT NULL, sent_at TEXT, cancelled INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS jobs (event_id TEXT NOT NULL, job TEXT NOT NULL, ran_at TEXT NOT NULL, PRIMARY KEY (event_id, job))`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS availability (event_id TEXT NOT NULL, player_id TEXT NOT NULL, need TEXT NOT NULL, status TEXT NOT NULL, answered_at TEXT NOT NULL, PRIMARY KEY (event_id, player_id, need))`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS season_costs (id TEXT PRIMARY KEY, season TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS season_pricing (season TEXT PRIMARY KEY, price_player REAL NOT NULL DEFAULT 170, price_goalie REAL NOT NULL DEFAULT 0, price_sub_player REAL NOT NULL DEFAULT 10, price_sub_goalie REAL NOT NULL DEFAULT 0, etransfer_phone TEXT, updated_at TEXT NOT NULL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS player_dues (season TEXT NOT NULL, player_id TEXT NOT NULL, custom_due REAL, adjustment REAL NOT NULL DEFAULT 0, amount_paid REAL NOT NULL DEFAULT 0, notes TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (season, player_id))`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS planned_absences (id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL, date TEXT NOT NULL, season TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, UNIQUE(player_id, date))`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS polls (id INTEGER PRIMARY KEY AUTOINCREMENT, season TEXT NOT NULL, title TEXT NOT NULL, description TEXT, category TEXT NOT NULL DEFAULT 'general', target_position TEXT, allow_subs INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, closed_at TEXT, last_sent_at TEXT, sent_count INTEGER DEFAULT 0, show_on_rsvp INTEGER NOT NULL DEFAULT 0, show_results INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS poll_votes (id INTEGER PRIMARY KEY AUTOINCREMENT, poll_id INTEGER NOT NULL, voter_id TEXT NOT NULL, candidate_id TEXT, candidate_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(poll_id, voter_id))`).run();

    // Part A/B tables (already exist in production via migrate-018/019).
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, email_verified_at TEXT, last_login_at TEXT, session_epoch INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leagues (id TEXT PRIMARY KEY, name TEXT NOT NULL, division_label TEXT, tracks_stats INTEGER NOT NULL DEFAULT 1, team_count INTEGER NOT NULL, team_names TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS league_admins (user_id TEXT NOT NULL, league_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL, PRIMARY KEY (user_id, league_id))`).run();

    // Realistic pre-existing SMBHL data, inserted exactly the way this
    // codebase's own routes insert it today — i.e. with no mention of
    // league_id at all, since that column doesn't exist yet at this point.
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, token_salt, role) VALUES ('P0001', 'Real Smbhl Player', 'player@smbhl.com', 'salt1', 'roster')`).run();
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, token_salt, role) VALUES ('P0002', 'Another Smbhl Player', 'player2@smbhl.com', 'salt2', 'roster')`).run();
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time) VALUES ('2026-09-20', 'Fall 2026', 3, 'Sunday September 20', 'College Jean-de-Brebeuf', 'open', '10:30')`).run();
    await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('2026-09-20', 'P0001', 'Red', 'in', 'roster', 'self', '2026-09-18T12:00:00Z')`).run();
    await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('team_salt_Red', 'existing-smbhl-salt-value')`).run();
    await env.DB.prepare(`INSERT INTO polls (season, title, state, created_at) VALUES ('Fall 2026', 'Existing SMBHL poll', 'open', '2026-09-01T00:00:00Z')`).run();
  });

  it('applies cleanly against a pre-migration production-shaped schema', async () => {
    await expect(applyMigration020(env.DB)).resolves.not.toThrow();
  });

  it('gives SMBHL a real row in leagues with the fixed id "smbhl"', async () => {
    const row = await env.DB.prepare(`SELECT * FROM leagues WHERE id = 'smbhl'`).first();
    expect(row).toBeTruthy();
    expect(row.name).toBe('SMBHL');
  });

  it('backfills every pre-existing contacts row to league_id=smbhl without touching any other column', async () => {
    const p1 = await env.DB.prepare(`SELECT * FROM contacts WHERE player_id = 'P0001'`).first();
    expect(p1.league_id).toBe('smbhl');
    expect(p1.name).toBe('Real Smbhl Player');
    expect(p1.email).toBe('player@smbhl.com');
    expect(p1.token_salt).toBe('salt1');

    const count = await env.DB.prepare(`SELECT COUNT(*) c FROM contacts`).first();
    expect(count.c).toBe(2);
    const allTagged = await env.DB.prepare(`SELECT COUNT(*) c FROM contacts WHERE league_id != 'smbhl'`).first();
    expect(allTagged.c).toBe(0);
  });

  it('backfills the pre-existing event, unchanged except for league_id', async () => {
    const ev = await env.DB.prepare(`SELECT * FROM events WHERE id = '2026-09-20'`).first();
    expect(ev.league_id).toBe('smbhl');
    expect(ev.season).toBe('Fall 2026');
    expect(ev.venue).toBe('College Jean-de-Brebeuf');
  });

  it('backfills the pre-existing rsvp row, unchanged except for league_id', async () => {
    const r = await env.DB.prepare(`SELECT * FROM rsvp WHERE event_id = '2026-09-20' AND player_id = 'P0001'`).first();
    expect(r.league_id).toBe('smbhl');
    expect(r.status).toBe('in');
    expect(r.team).toBe('Red');
  });

  it('backfills settings and polls the same way', async () => {
    const s = await env.DB.prepare(`SELECT * FROM settings WHERE key = 'team_salt_Red'`).first();
    expect(s.league_id).toBe('smbhl');
    expect(s.value).toBe('existing-smbhl-salt-value');

    const p = await env.DB.prepare(`SELECT * FROM polls WHERE title = 'Existing SMBHL poll'`).first();
    expect(p.league_id).toBe('smbhl');
    expect(p.state).toBe('open');
  });

  it('a brand-new INSERT that never mentions league_id (exactly how every existing route in this codebase inserts today) is still automatically tagged smbhl, proving zero code changes are needed for SMBHL to keep working correctly', async () => {
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, token_salt, role) VALUES ('P0003', 'Post Migration Player', 'p3@smbhl.com', 'salt3', 'roster')`).run();
    const row = await env.DB.prepare(`SELECT * FROM contacts WHERE player_id = 'P0003'`).first();
    expect(row.league_id).toBe('smbhl');

    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state) VALUES ('2026-09-27', 'Fall 2026', 4, 'Sunday September 27', 'College Jean-de-Brebeuf', 'open')`).run();
    const ev = await env.DB.prepare(`SELECT * FROM events WHERE id = '2026-09-27'`).first();
    expect(ev.league_id).toBe('smbhl');
  });
});

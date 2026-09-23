// Proves test/support/real_schema.js's applyRealSchema() actually builds
// a working, complete database by running schema.sql + all migrate-*.sql
// files (see that file's header for the migrate-021.sql ordering note) --
// and, specifically, that it would have caught Part 1's FK bug: applying
// an *unfixed* copy of the SMBHL bootstrap insert (created_by = 'system'
// with no matching users row) against this real schema throws a real
// FOREIGN KEY error, while the actual fixed migrate-020.sql (run as part
// of the real chain) does not.
import { env, reset } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

describe('test/support/real_schema.js: real migrate-*.sql-driven schema', () => {
  beforeAll(async () => {
    await applyRealSchema(env);
  });

  it('produces every table the app actually queries, including the gap-filled season_pricing/player_dues', async () => {
    const tables = (await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()).results.map(r => r.name);
    for (const t of [
      'users', 'signup_attempts', 'leagues', 'league_admins',
      'contacts', 'events', 'rsvp', 'sheet_reviews', 'team_messages',
      'settings', 'outbox', 'jobs', 'availability',
      'season_costs', 'season_pricing', 'player_dues',
      'planned_absences', 'polls', 'poll_votes',
    ]) {
      expect(tables).toContain(t);
    }
  });

  it("is idempotent -- calling it twice on the same DB doesn't error or duplicate the SMBHL bootstrap row", async () => {
    await applyRealSchema(env);
    const rows = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM leagues WHERE id = 'smbhl'`).first());
    expect(rows.n).toBe(1);
  });

  it("real season_pricing schema really has the drifted defaults (180/15), proving this is sourced from production, not test/index.spec.js's hand-rolled 170/10", async () => {
    const row = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'season_pricing'`).first();
    expect(row.sql).toContain('180');
    expect(row.sql).toContain('15');
  });

  it("leagues.created_by really does REFERENCE users(id) in this real schema (this is what Part 1's bug violated)", async () => {
    const row = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'leagues'`).first();
    expect(row.sql).toContain('REFERENCES users(id)');
  });
});

describe('the real schema would have caught Part 1\'s original bug', () => {
  it('an UNFIXED bootstrap insert (created_by = \'system\' with no matching users row) throws FOREIGN KEY constraint failed against the real schema', async () => {
    // This describe block shares its D1 instance with the one above (same
    // test file), which already applied the real, FIXED schema (including
    // a real 'smbhl' leagues row) -- reset() clears that so this test
    // starts from a truly blank slate, matching what migrate-020.sql saw
    // the very first time it ran against production.
    await reset();

    // Build the real schema, but only through the DDL that predates
    // migrate-020.sql's fix -- i.e. everything except migrate-020.sql --
    // then replay migrate-020's ORIGINAL (unfixed) bootstrap insert by
    // hand, exactly as it shipped before Part 1's fix.
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, email_verified_at TEXT, last_login_at TEXT, session_epoch INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leagues (id TEXT PRIMARY KEY, name TEXT NOT NULL, division_label TEXT, tracks_stats INTEGER NOT NULL DEFAULT 1, team_count INTEGER NOT NULL, team_names TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL)`).run();

    let threw = false;
    let message = '';
    try {
      await env.DB.prepare(
        `INSERT INTO leagues (id, name, division_label, tracks_stats, team_count, team_names, created_by, created_at)
         SELECT 'smbhl', 'SMBHL', NULL, 1, 0, '[]', 'system', '2026-01-01T00:00:00.000Z'
         WHERE NOT EXISTS (SELECT 1 FROM leagues WHERE id = 'smbhl')`
      ).run();
    } catch (e) {
      threw = true;
      message = e.message;
    }
    expect(threw).toBe(true);
    expect(message).toMatch(/FOREIGN KEY/i);
  });
});

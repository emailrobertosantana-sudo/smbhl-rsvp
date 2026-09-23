// Investigation finding: migrate-020.sql's original SMBHL bootstrap row
// (`INSERT INTO leagues (..., created_by, ...) SELECT ..., 'system', ...`)
// failed against the real demo D1 database with
// "FOREIGN KEY constraint failed" -- leagues.created_by REFERENCES
// users(id) (migrate-019.sql), and no row with id 'system' existed in
// users. The test suite never caught this because every spec file's
// inline `leagues` table (including this file, historically) hand-rolls
// its own schema and had silently dropped the REFERENCES clause --
// see Part 2 of the follow-up task for that gap.
//
// Fix (Option C from the investigation): migrate-020.sql now inserts a
// real, inert 'system' user before the leagues insert. This spec proves
// the fix works against the REAL FK-enforcing schema (copied verbatim
// from migrate-018.sql/migrate-019.sql, not the loosened inline schema
// every other spec in this suite uses), and proves the sentinel
// password_hash is provably unusable to log in.
//
// These two INSERT statements are copied verbatim from migrate-020.sql
// (cloudflare:test's workerd isolate has no filesystem access, so the
// file itself can't be read at test time) -- keep them in sync if
// migrate-020.sql's bootstrap inserts ever change.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { verifyPassword } from '../src/auth.js';

const SYSTEM_USER_INSERT = `
  INSERT INTO users (id, email, password_hash, created_at)
  SELECT 'system', 'system@smbhl-rsvp.internal.invalid', 'not-a-valid-hash:system-bootstrap-user-no-login', '2026-01-01T00:00:00.000Z'
  WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 'system')
`;

const SMBHL_LEAGUE_INSERT = `
  INSERT INTO leagues (id, name, division_label, tracks_stats, team_count, team_names, created_by, created_at)
  SELECT 'smbhl', 'SMBHL', NULL, 1, 0, '[]', 'system', '2026-01-01T00:00:00.000Z'
  WHERE NOT EXISTS (SELECT 1 FROM leagues WHERE id = 'smbhl')
`;

describe('migrate-020.sql: SMBHL bootstrap no longer violates the FK on leagues.created_by', () => {
  beforeAll(async () => {
    // Real schema, copied verbatim from migrate-018.sql / migrate-019.sql --
    // FK enforced, unlike every other spec file's loosened inline schema.
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      email_verified_at TEXT,
      last_login_at TEXT,
      session_epoch INTEGER NOT NULL DEFAULT 0
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leagues (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      division_label TEXT,
      tracks_stats INTEGER NOT NULL DEFAULT 1,
      team_count INTEGER NOT NULL,
      team_names TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    )`).run();
  });

  it("applies migrate-020.sql's bootstrap inserts cleanly against the real FK-enforcing schema (no FOREIGN KEY constraint failure)", async () => {
    await expect(env.DB.prepare(SYSTEM_USER_INSERT).run()).resolves.toBeTruthy();
    await expect(env.DB.prepare(SMBHL_LEAGUE_INSERT).run()).resolves.toBeTruthy();

    const league = await env.DB.prepare(
      `SELECT l.id, l.created_by, u.id AS user_id FROM leagues l JOIN users u ON u.id = l.created_by WHERE l.id = 'smbhl'`
    ).first();
    expect(league.created_by).toBe('system');
    expect(league.user_id).toBe('system'); // the JOIN succeeded: the FK reference is real and satisfied
  });

  it('is idempotent, matching the WHERE NOT EXISTS guard already used for the leagues row (safe to re-run)', async () => {
    await env.DB.prepare(SYSTEM_USER_INSERT).run();
    await env.DB.prepare(SMBHL_LEAGUE_INSERT).run();
    await env.DB.prepare(SYSTEM_USER_INSERT).run();
    await env.DB.prepare(SMBHL_LEAGUE_INSERT).run();

    const userCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE id = 'system'`).first();
    const leagueCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM leagues WHERE id = 'smbhl'`).first();
    expect(userCount.n).toBe(1);
    expect(leagueCount.n).toBe(1);
  });

  it('the sentinel password_hash is provably unusable -- verifyPassword rejects it for any password, without throwing', async () => {
    const row = await env.DB.prepare(`SELECT password_hash FROM users WHERE id = 'system'`).first();
    expect(row.password_hash).toBe('not-a-valid-hash:system-bootstrap-user-no-login');

    // Not a well-formed 'pbkdf2$<iterations>$<salt>$<hash>' string, so
    // verifyPassword's format check rejects it before ever deriving
    // anything -- fails closed, never throws, for any input.
    await expect(verifyPassword('', row.password_hash)).resolves.toBe(false);
    await expect(verifyPassword('password123', row.password_hash)).resolves.toBe(false);
    await expect(verifyPassword('not-a-valid-hash:system-bootstrap-user-no-login', row.password_hash)).resolves.toBe(false);
  });

  it("the sentinel email can never collide with a real signup's email column", async () => {
    const row = await env.DB.prepare(`SELECT email FROM users WHERE id = 'system'`).first();
    expect(row.email).toBe('system@smbhl-rsvp.internal.invalid');
    // .invalid is a reserved TLD (RFC 2606) that can never be installed in
    // the real DNS root -- no real /auth/signup could ever legitimately
    // produce an address ending in it.
    expect(row.email.endsWith('.invalid')).toBe(true);
  });
});

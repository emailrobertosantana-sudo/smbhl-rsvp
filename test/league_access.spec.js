// Authorization-layer plumbing (leagues.js: checkLeagueAccess,
// leagueAccessResponse) plus its one proof-of-concept route,
// GET /league/contacts. This does NOT touch any existing /admin/*
// (ADMIN_KEY-gated) route — see the task report for the rollout plan for
// those ~500+ call sites. What's tested here: (1) checkLeagueAccess itself
// correctly allows/denies, and (2) two real leagues' contacts are genuinely
// isolated through the one route that's actually wired up to it.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { checkLeagueAccess } from '../src/leagues.js';

const AUTH_SECRET = 'test-league-access-secret';

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

async function signupAndCreateLeague(email, ip, leagueName, teamNames) {
  const signupRes = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const signupJson = await signupRes.json();
  const cookie = extractCookie(signupRes);

  const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: leagueName, teamNames, tracksStats: true })
  });
  const leagueJson = await leagueRes.json();

  return { userId: signupJson.userId, cookie, leagueId: leagueJson.league.id };
}

describe('leagues.js: checkLeagueAccess() and the /league/contacts proof of concept', () => {
  let leagueA, leagueB, cookieA, cookieB;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, email_verified_at TEXT, last_login_at TEXT, session_epoch INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS signup_attempts (ip TEXT PRIMARY KEY, window_start TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leagues (id TEXT PRIMARY KEY, name TEXT NOT NULL, division_label TEXT, tracks_stats INTEGER NOT NULL DEFAULT 1, team_count INTEGER NOT NULL, team_names TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS league_admins (user_id TEXT NOT NULL, league_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL, PRIMARY KEY (user_id, league_id))`).run();
    // Post-migrate-020.sql shape: contacts carries its own league_id.
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS contacts (player_id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, role TEXT NOT NULL DEFAULT 'roster', token_salt TEXT NOT NULL DEFAULT '', league_id TEXT NOT NULL DEFAULT 'smbhl')`).run();

    // Two real, independently-created leagues via the actual Part A/B
    // signup + league-creation flow -- not fixtures, real data.
    const a = await signupAndCreateLeague('league.a.admin@example.com', '203.0.113.201', 'League A Hockey', ['Red', 'Blue']);
    const b = await signupAndCreateLeague('league.b.admin@example.com', '203.0.113.202', 'League B Hockey', ['Gold', 'Silver']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    cookieB = b.cookie;

    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, token_salt, league_id) VALUES (?, ?, ?, ?, ?)`)
      .bind(`${leagueA}:P0001`, 'League A Player One', 'a1@example.com', 'salt-a1', leagueA).run();
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, token_salt, league_id) VALUES (?, ?, ?, ?, ?)`)
      .bind(`${leagueA}:P0002`, 'League A Player Two', 'a2@example.com', 'salt-a2', leagueA).run();
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, token_salt, league_id) VALUES (?, ?, ?, ?, ?)`)
      .bind(`${leagueB}:P0001`, 'League B Player One', 'b1@example.com', 'salt-b1', leagueB).run();
  });

  describe('checkLeagueAccess()', () => {
    it('returns "ok" for a user who IS linked to the league', async () => {
      const req = new Request('http://example.com/whatever', { headers: { cookie: cookieA } });
      expect(await checkLeagueAccess(req, env, leagueA)).toBe('ok');
    });

    it('returns "forbidden" for a valid, logged-in user who is NOT linked to that league', async () => {
      const req = new Request('http://example.com/whatever', { headers: { cookie: cookieA } });
      expect(await checkLeagueAccess(req, env, leagueB)).toBe('forbidden');
    });

    it('returns "unauthenticated" for a request with no valid session at all', async () => {
      const req = new Request('http://example.com/whatever');
      expect(await checkLeagueAccess(req, env, leagueA)).toBe('unauthenticated');

      const tampered = new Request('http://example.com/whatever', { headers: { cookie: 'user_session=garbage.not.real' } });
      expect(await checkLeagueAccess(tampered, env, leagueA)).toBe('unauthenticated');
    });

    it('returns "forbidden" when leagueId itself is missing/blank', async () => {
      const req = new Request('http://example.com/whatever', { headers: { cookie: cookieA } });
      expect(await checkLeagueAccess(req, env, '')).toBe('forbidden');
      expect(await checkLeagueAccess(req, env, null)).toBe('forbidden');
    });
  });

  describe('GET /league/contacts — proof-of-concept isolation', () => {
    it('is rejected for an unauthenticated request', async () => {
      const res = await SELF.fetch('http://example.com/league/contacts');
      expect(res.status).toBe(401);
    });

    it("with no ?league_id=, defaults to the caller's own league (matching the dashboard's existing convention) and returns only that league's contacts", async () => {
      const res = await SELF.fetch('http://example.com/league/contacts', { headers: { cookie: cookieA } });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.league_id).toBe(leagueA);
      expect(json.contacts.length).toBe(2);
      expect(json.contacts.every(c => c.name.startsWith('League A'))).toBe(true);
    });

    it("League B's admin reading their own contacts via the same route sees only League B's data", async () => {
      const res = await SELF.fetch('http://example.com/league/contacts', { headers: { cookie: cookieB } });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.league_id).toBe(leagueB);
      expect(json.contacts.length).toBe(1);
      expect(json.contacts[0].name).toBe('League B Player One');
    });

    it("League A's admin explicitly requesting League B's league_id is rejected -- SMBHL-equivalent data is NOT reachable across leagues, not just absent by default", async () => {
      const res = await SELF.fetch(`http://example.com/league/contacts?league_id=${encodeURIComponent(leagueB)}`, {
        headers: { cookie: cookieA }
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it("and the reverse: League B's admin explicitly requesting League A's league_id is also rejected", async () => {
      const res = await SELF.fetch(`http://example.com/league/contacts?league_id=${encodeURIComponent(leagueA)}`, {
        headers: { cookie: cookieB }
      });
      expect(res.status).toBe(403);
    });
  });
});

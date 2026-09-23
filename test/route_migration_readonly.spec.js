// Read-only route migration, batch 1: GET /admin/schedule/data and
// GET /admin/people/data now accept EITHER a valid ADMIN_KEY (full,
// unscoped access — see admin_auth.js's design-decision comment) OR a
// valid session+league_id (league_id-filtered). This file proves:
//   1. The ADMIN_KEY design decision (a) explicitly: ADMIN_KEY reads
//      across every league's data, not just one.
//   2. Each migrated route: ADMIN_KEY access is unchanged (200, same
//      shape), a session-authenticated league admin sees only their own
//      league's data, and cannot see another league's data through the
//      same route.
// No /admin/* write route and no other read route were touched.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { checkAdminAuth } from '../src/admin_auth.js';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-route-migration-secret';
const ADMIN_KEY = 'test-route-migration-admin-key';

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(', ');
  const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
  return csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
}

async function signupAndCreateLeague(email, ip, leagueName, teamNames) {
  const signupRes = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const signupJson = await signupRes.json();
  const cookie = extractCookie(signupRes);
  const csrfToken = extractCsrfToken(signupRes);

  const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name: leagueName, teamNames, tracksStats: true })
  });
  const leagueJson = await leagueRes.json();

  return { userId: signupJson.userId, cookie, csrfToken, leagueId: leagueJson.league.id };
}

describe('Read-only route migration batch 1: /admin/schedule/data and /admin/people/data', () => {
  let leagueA, leagueB, cookieA, cookieB;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.ADMIN_KEY = ADMIN_KEY;
    env.RSVP_SECRET = env.RSVP_SECRET || 'test-rsvp-secret-route-migration';

    await applyRealSchema(env);

    const a = await signupAndCreateLeague('routemig.a@example.com', '203.0.113.211', 'Route Migration League A', ['Red', 'Blue']);
    const b = await signupAndCreateLeague('routemig.b@example.com', '203.0.113.212', 'Route Migration League B', ['Gold', 'Silver']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    cookieB = b.cookie;

    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, token_salt, league_id) VALUES (?, ?, ?, ?, ?)`)
      .bind(`${leagueA}:P0001`, 'League A Contact', 'a@example.com', 'salt-a', leagueA).run();
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, token_salt, league_id) VALUES (?, ?, ?, ?, ?)`)
      .bind(`${leagueB}:P0001`, 'League B Contact', 'b@example.com', 'salt-b', leagueB).run();

    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, league_id) VALUES (?, 'League A Season', 1, ?, 'League A Venue', 'open', ?)`)
      .bind(`${leagueA}:2026-10-04`, '2026-10-04', leagueA).run();
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, league_id) VALUES (?, 'League B Season', 1, ?, 'League B Venue', 'open', ?)`)
      .bind(`${leagueB}:2026-10-11`, '2026-10-11', leagueB).run();
  });

  describe('ADMIN_KEY design decision (a): superuser, not league-scoped', () => {
    it('checkAdminAuth succeeds for a valid key with no notion of leagueId at all -- it is never even passed one', () => {
      const req = new Request('http://example.com/admin/schedule/data', { headers: { 'x-admin': ADMIN_KEY } });
      expect(checkAdminAuth(req, env)).toBe('ok');
    });

    it('a request with only ADMIN_KEY (no session, no league_id) sees BOTH leagues\' events through /admin/schedule/data', async () => {
      const res = await SELF.fetch('http://example.com/admin/schedule/data', { headers: { 'x-admin': ADMIN_KEY } });
      expect(res.status).toBe(200);
      const json = await res.json();
      const ids = json.events.map(e => e.id);
      expect(ids).toContain(`${leagueA}:2026-10-04`);
      expect(ids).toContain(`${leagueB}:2026-10-11`);
    });
  });

  describe('GET /admin/schedule/data', () => {
    it('ADMIN_KEY access is unchanged: still 200 via the original handleScheduleData path', async () => {
      const res = await SELF.fetch('http://example.com/admin/schedule/data', { headers: { 'x-admin': ADMIN_KEY } });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.events)).toBe(true);
    });

    it('a wrong/missing ADMIN_KEY and no session is rejected exactly as before (403)', async () => {
      const res = await SELF.fetch('http://example.com/admin/schedule/data');
      expect(res.status).toBe(403);
    });

    it("a session-authenticated league admin sees only their own league's events by default", async () => {
      const res = await SELF.fetch('http://example.com/admin/schedule/data', { headers: { cookie: cookieA } });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.league_id).toBe(leagueA);
      expect(json.events.length).toBe(1);
      expect(json.events[0].id).toBe(`${leagueA}:2026-10-04`);
    });

    it("League A's admin explicitly requesting League B's league_id is rejected (403), not just absent", async () => {
      const res = await SELF.fetch(`http://example.com/admin/schedule/data?league_id=${encodeURIComponent(leagueB)}`, {
        headers: { cookie: cookieA }
      });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /admin/people/data', () => {
    it('ADMIN_KEY access is unchanged: still 200 via the original peopleData path', async () => {
      const res = await SELF.fetch('http://example.com/admin/people/data', { headers: { 'x-admin': ADMIN_KEY } });
      expect(res.status).toBe(200);
    });

    it("a session-authenticated league admin sees only their own league's contacts by default", async () => {
      const res = await SELF.fetch('http://example.com/admin/people/data', { headers: { cookie: cookieB } });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.league_id).toBe(leagueB);
      expect(json.contacts.length).toBe(1);
      expect(json.contacts[0].name).toBe('League B Contact');
    });

    it("League B's admin explicitly requesting League A's league_id is rejected (403)", async () => {
      const res = await SELF.fetch(`http://example.com/admin/people/data?league_id=${encodeURIComponent(leagueA)}`, {
        headers: { cookie: cookieB }
      });
      expect(res.status).toBe(403);
    });

    it('an unauthenticated request (no key, no session) is rejected exactly as the underlying ADMIN_KEY gate always has', async () => {
      const res = await SELF.fetch('http://example.com/admin/people/data');
      expect(res.status).toBe(403);
    });

    it('/admin/people/search (not migrated in this batch) remains strictly ADMIN_KEY-only, unaffected by a valid session', async () => {
      const res = await SELF.fetch('http://example.com/admin/people/search?q=al', { headers: { cookie: cookieA } });
      expect(res.status).toBe(403);
    });
  });
});

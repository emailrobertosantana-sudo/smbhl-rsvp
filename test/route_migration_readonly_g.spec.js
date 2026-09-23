// Part G: read-only route migration batch 2 — GET /admin/board/data,
// GET /admin/subs/data, GET /admin/outbox. Same dual-auth pattern as the
// prior batch (schedule/data, people/data) and the teams/data proof of
// concept: ADMIN_KEY path unchanged, session path new/additive and
// league_id-scoped.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-route-migration-g-secret';
const ADMIN_KEY = 'test-route-migration-g-admin-key';

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

describe('Part G: /admin/board/data, /admin/subs/data, /admin/outbox', () => {
  let leagueA, leagueB, cookieA, cookieB;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.ADMIN_KEY = ADMIN_KEY;
    env.RSVP_SECRET = env.RSVP_SECRET || 'test-rsvp-secret-route-migration-g';

    await applyRealSchema(env);

    const a = await signupAndCreateLeague('routemig.g.a@example.com', '203.0.113.231', 'Route Migration G League A', ['Red', 'Blue']);
    const b = await signupAndCreateLeague('routemig.g.b@example.com', '203.0.113.232', 'Route Migration G League B', ['Gold', 'Silver']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    cookieB = b.cookie;

    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, token_salt, league_id) VALUES (?, ?, ?, ?, ?)`)
      .bind(`${leagueA}:P0001`, 'League A Contact', 'a@example.com', 'salt-a', leagueA).run();
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, token_salt, league_id) VALUES (?, ?, ?, ?, ?)`)
      .bind(`${leagueB}:P0001`, 'League B Contact', 'b@example.com', 'salt-b', leagueB).run();

    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, league_id) VALUES (?, 'League A Season', 1, '2026-10-04', 'League A Venue', 'open', ?)`)
      .bind(`${leagueA}:2026-10-04`, leagueA).run();
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, league_id) VALUES (?, 'League B Season', 1, '2026-10-11', 'League B Venue', 'open', ?)`)
      .bind(`${leagueB}:2026-10-11`, leagueB).run();

    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, send_after, created_at, league_id) VALUES ('invite', ?, ?, 'Red', ?, ?, ?)`)
      .bind(`${leagueA}:2026-10-04`, `${leagueA}:P0001`, new Date().toISOString(), new Date().toISOString(), leagueA).run();
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, send_after, created_at, league_id) VALUES ('invite', ?, ?, 'Gold', ?, ?, ?)`)
      .bind(`${leagueB}:2026-10-11`, `${leagueB}:P0001`, new Date().toISOString(), new Date().toISOString(), leagueB).run();
  });

  describe('GET /admin/board/data', () => {
    it('ADMIN_KEY access is unchanged: still 200 via the original boardData path', async () => {
      const res = await SELF.fetch('http://example.com/admin/board/data', { headers: { 'x-admin': ADMIN_KEY } });
      expect(res.status).toBe(200);
    });

    it('a wrong/missing ADMIN_KEY and no session is rejected exactly as before (403)', async () => {
      const res = await SELF.fetch('http://example.com/admin/board/data');
      expect(res.status).toBe(403);
    });

    it("a session-authenticated league admin sees only their own league's event", async () => {
      const res = await SELF.fetch('http://example.com/admin/board/data', { headers: { cookie: cookieA } });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.league_id).toBe(leagueA);
      expect(json.event.id).toBe(`${leagueA}:2026-10-04`);
      expect(json.events.length).toBe(1);
    });

    it("League A's admin explicitly requesting League B's league_id is rejected (403)", async () => {
      const res = await SELF.fetch(`http://example.com/admin/board/data?league_id=${encodeURIComponent(leagueB)}`, {
        headers: { cookie: cookieA }
      });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /admin/subs/data', () => {
    it('ADMIN_KEY access is unchanged: still 200 via the original subsData path', async () => {
      const res = await SELF.fetch('http://example.com/admin/subs/data', { headers: { 'x-admin': ADMIN_KEY } });
      expect(res.status).toBe(200);
    });

    it('a wrong/missing ADMIN_KEY and no session is rejected exactly as before (403)', async () => {
      const res = await SELF.fetch('http://example.com/admin/subs/data');
      expect(res.status).toBe(403);
    });

    it("a session-authenticated league admin sees only their own league's event and contacts", async () => {
      const res = await SELF.fetch('http://example.com/admin/subs/data', { headers: { cookie: cookieB } });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.league_id).toBe(leagueB);
      expect(json.event.id).toBe(`${leagueB}:2026-10-11`);
      expect(json.contacts.length).toBe(1);
      expect(json.contacts[0].name).toBe('League B Contact');
    });

    it("League B's admin explicitly requesting League A's league_id is rejected (403)", async () => {
      const res = await SELF.fetch(`http://example.com/admin/subs/data?league_id=${encodeURIComponent(leagueA)}`, {
        headers: { cookie: cookieB }
      });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /admin/outbox', () => {
    it('ADMIN_KEY access is unchanged: still returns the unscoped rows list exactly as before', async () => {
      const res = await SELF.fetch('http://example.com/admin/outbox', { headers: { 'x-admin': ADMIN_KEY } });
      expect(res.status).toBe(200);
      const json = await res.json();
      const eventIds = json.rows.map(r => r.event_id);
      expect(eventIds).toContain(`${leagueA}:2026-10-04`);
      expect(eventIds).toContain(`${leagueB}:2026-10-11`);
    });

    it('a wrong/missing ADMIN_KEY and no session is rejected exactly as before (403)', async () => {
      const res = await SELF.fetch('http://example.com/admin/outbox');
      expect(res.status).toBe(403);
    });

    it("a session-authenticated league admin sees only their own league's outbox rows", async () => {
      const res = await SELF.fetch('http://example.com/admin/outbox', { headers: { cookie: cookieA } });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.league_id).toBe(leagueA);
      expect(json.rows.length).toBe(1);
      expect(json.rows[0].event_id).toBe(`${leagueA}:2026-10-04`);
    });

    it("League A's admin explicitly requesting League B's league_id is rejected (403)", async () => {
      const res = await SELF.fetch(`http://example.com/admin/outbox?league_id=${encodeURIComponent(leagueB)}`, {
        headers: { cookie: cookieA }
      });
      expect(res.status).toBe(403);
    });
  });
});

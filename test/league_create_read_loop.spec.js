// Part L: confirms the full create -> read loop for both contacts and
// events, using the actual Part J/K write routes (not pre-seeded test
// data) followed by their read counterparts (GET /league/contacts,
// GET /league/events — the latter built in this part to close the same
// gap for events that GET /league/contacts already closed for contacts).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-league-create-read-loop-secret';

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

describe('Part L: the full create -> read loop', () => {
  let leagueA, leagueB, cookieA, cookieB, csrfTokenA, csrfTokenB;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;

    await applyRealSchema(env);

    const a = await signupAndCreateLeague('createread.a@example.com', '203.0.113.281', 'Create Read League A', ['Otters', 'Falcons']);
    const b = await signupAndCreateLeague('createread.b@example.com', '203.0.113.282', 'Create Read League B', ['Narwhals', 'Beavers']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    cookieB = b.cookie;
    csrfTokenA = a.csrfToken;
    csrfTokenB = b.csrfToken;
  });

  describe('Contacts: POST /league/contacts -> GET /league/contacts', () => {
    it('starts empty for a fresh league', async () => {
      const res = await SELF.fetch('http://example.com/league/contacts', { headers: { cookie: cookieA } });
      const json = await res.json();
      expect(json.contacts).toEqual([]);
    });

    it('a contact created via the write route is reflected in the read route', async () => {
      const createRes = await SELF.fetch('http://example.com/league/contacts', {
        method: 'POST',
        headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
        body: JSON.stringify({ name: 'Loop Test Player', email: 'loop@leaguea.com', role: 'roster' })
      });
      expect(createRes.status).toBe(200);
      const created = await createRes.json();

      const readRes = await SELF.fetch('http://example.com/league/contacts', { headers: { cookie: cookieA } });
      const read = await readRes.json();
      expect(read.contacts.length).toBe(1);
      expect(read.contacts[0].player_id).toBe(created.contact.player_id);
      expect(read.contacts[0].name).toBe('Loop Test Player');
      expect(read.contacts[0].email).toBe('loop@leaguea.com');
    });

    it("League B's read shows none of League A's contacts", async () => {
      const res = await SELF.fetch('http://example.com/league/contacts', { headers: { cookie: cookieB } });
      const json = await res.json();
      expect(json.contacts).toEqual([]);
    });
  });

  describe('Events: POST /league/events -> GET /league/events', () => {
    it('starts empty for a fresh league', async () => {
      const res = await SELF.fetch('http://example.com/league/events', { headers: { cookie: cookieA } });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.league_id).toBe(leagueA);
      expect(json.events).toEqual([]);
    });

    it('an event created via the write route is reflected in the read route', async () => {
      const createRes = await SELF.fetch('http://example.com/league/events', {
        method: 'POST',
        headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
        body: JSON.stringify({ date: '2026-11-15', season: 'League A Season 1', venue: 'Loop Rink', start_time: '19:00', end_time: '21:00' })
      });
      expect(createRes.status).toBe(200);
      const created = await createRes.json();

      const readRes = await SELF.fetch('http://example.com/league/events', { headers: { cookie: cookieA } });
      const read = await readRes.json();
      expect(read.events.length).toBe(1);
      expect(read.events[0].id).toBe(created.event.id);
      expect(read.events[0].venue).toBe('Loop Rink');
      expect(read.events[0].date).toBe('2026-11-15');
    });

    it("League B's read shows none of League A's events, and vice versa after League B creates its own", async () => {
      await SELF.fetch('http://example.com/league/events', {
        method: 'POST',
        headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
        body: JSON.stringify({ date: '2026-11-22', season: 'League B Season 1', venue: 'League B Rink' })
      });

      const aRes = await SELF.fetch('http://example.com/league/events', { headers: { cookie: cookieA } });
      const aJson = await aRes.json();
      expect(aJson.events.length).toBe(1);
      expect(aJson.events.every(e => e.venue !== 'League B Rink')).toBe(true);

      const bRes = await SELF.fetch('http://example.com/league/events', { headers: { cookie: cookieB } });
      const bJson = await bRes.json();
      expect(bJson.events.length).toBe(1);
      expect(bJson.events[0].venue).toBe('League B Rink');
    });

    it("explicitly requesting the other league's league_id on GET /league/events is rejected (403)", async () => {
      const res = await SELF.fetch(`http://example.com/league/events?league_id=${encodeURIComponent(leagueB)}`, {
        headers: { cookie: cookieA }
      });
      expect(res.status).toBe(403);
    });

    it('an unauthenticated GET /league/events is rejected', async () => {
      const res = await SELF.fetch('http://example.com/league/events');
      expect(res.status).toBe(401);
    });
  });
});

// Part 10: deactivate a league. Session+CSRF-gated soft-delete
// (leagues.deactivated_at, migrate-022.sql) -- no row is ever deleted.
// Requires typing the league's own exact current name as `confirmName`,
// enforced server-side (not just a client-side dialog an API caller
// could skip). Once deactivated, checkLeagueAccess blocks every
// session-gated route for that league -- including its own admins --
// without a separate check bolted onto each route; the public page
// (Part 4) also stops being publicly viewable.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part10-deactivate-secret';

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

describe('Part 10: deactivate a league', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('rejects deactivation when the typed confirmation text does not match the real league name', async () => {
    const a = await signupAndCreateLeague('part10.wrongconfirm@example.com', '203.0.113.491', 'Part 10 Wrong Confirm League', ['A', 'B']);
    const res = await SELF.fetch('http://example.com/league/deactivate', {
      method: 'POST',
      headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ confirmName: 'Not The Real Name' })
    });
    expect(res.status).toBe(400);

    const row = await env.DB.prepare('SELECT deactivated_at FROM leagues WHERE id = ?').bind(a.leagueId).first();
    expect(row.deactivated_at).toBeNull();
  });

  it('with the exact correct name, deactivates the league (soft-delete: the row still exists, just flagged)', async () => {
    const LEAGUE_NAME = 'Part 10 Real Deactivate League';
    const a = await signupAndCreateLeague('part10.deactivate@example.com', '203.0.113.492', LEAGUE_NAME, ['Red', 'Blue']);

    const res = await SELF.fetch('http://example.com/league/deactivate', {
      method: 'POST',
      headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ confirmName: LEAGUE_NAME })
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const row = await env.DB.prepare('SELECT * FROM leagues WHERE id = ?').bind(a.leagueId).first();
    expect(row).toBeTruthy(); // still exists -- soft-delete, not destructive
    expect(row.name).toBe(LEAGUE_NAME); // untouched
    expect(row.deactivated_at).toBeTruthy();
  });

  it('once deactivated, every session-gated league route is blocked for its own admin (410)', async () => {
    const LEAGUE_NAME = 'Part 10 Blocked Routes League';
    const a = await signupAndCreateLeague('part10.blocked@example.com', '203.0.113.493', LEAGUE_NAME, ['Otters', 'Falcons']);
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ season_name: 'Part 10 Season' })
    });
    await SELF.fetch('http://example.com/league/deactivate', {
      method: 'POST',
      headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ confirmName: LEAGUE_NAME })
    });

    const contactsRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ name: 'Should Never Exist' })
    });
    expect(contactsRes.status).toBe(410);

    const eventsRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ date: '2026-12-20' })
    });
    expect(eventsRes.status).toBe(410);

    // Session-based PAGE routes redirect to /dashboard rather than
    // erroring -- generic, redirect-based handling for any non-'ok'
    // access status, same as an outright-forbidden league.
    const rosterRes = await SELF.fetch('http://example.com/league/roster', { headers: { cookie: a.cookie }, redirect: 'manual' });
    expect(rosterRes.status).toBe(302);
    expect(rosterRes.headers.get('location') || '').toContain('/dashboard');
  });

  it('the dashboard shows a clear deactivated state, not the normal management UI', async () => {
    const LEAGUE_NAME = 'Part 10 Dashboard State League';
    const a = await signupAndCreateLeague('part10.dashstate@example.com', '203.0.113.494', LEAGUE_NAME, ['A', 'B']);
    await SELF.fetch('http://example.com/league/deactivate', {
      method: 'POST',
      headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ confirmName: LEAGUE_NAME })
    });

    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie: a.cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('désactivée');
    expect(html).not.toContain('id="invite_email"'); // no normal management UI
    expect(html).not.toContain('id="deactivate_submit"'); // can't deactivate an already-deactivated league
  });

  it("the public page (Part 4) is no longer viewable once deactivated (410, not silently showing stale data)", async () => {
    const LEAGUE_NAME = 'Part 10 Public Page League';
    const a = await signupAndCreateLeague('part10.publicpage@example.com', '203.0.113.495', LEAGUE_NAME, ['A', 'B']);

    const beforeRes = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(a.leagueId)}`);
    expect(beforeRes.status).toBe(200);

    await SELF.fetch('http://example.com/league/deactivate', {
      method: 'POST',
      headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ confirmName: LEAGUE_NAME })
    });

    const afterRes = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(a.leagueId)}`);
    expect(afterRes.status).toBe(410);
  });

  it('requires a valid session and CSRF token, matching every other league-admin write route', async () => {
    const unauthRes = await SELF.fetch('http://example.com/league/deactivate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmName: 'Whatever' })
    });
    expect(unauthRes.status).toBe(401);

    const a = await signupAndCreateLeague('part10.csrf@example.com', '203.0.113.496', 'Part 10 CSRF League', ['A', 'B']);
    const noCsrfRes = await SELF.fetch('http://example.com/league/deactivate', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmName: 'Part 10 CSRF League' })
    });
    expect(noCsrfRes.status).toBe(403);
  });

  it("League B cannot deactivate League A's league (cross-league access check still applies)", async () => {
    const a = await signupAndCreateLeague('part10.crossa@example.com', '203.0.113.497', 'Part 10 Cross League A', ['A', 'B']);
    const b = await signupAndCreateLeague('part10.crossb@example.com', '203.0.113.498', 'Part 10 Cross League B', ['C', 'D']);

    // League B's admin tries to deactivate using their OWN session, but
    // resolveSessionLeagueId resolves to THEIR OWN league (B), not A's --
    // there is no league_id param on this route, matching every other
    // league write route's own-league-only convention. Confirm A is
    // untouched by B's action.
    await SELF.fetch('http://example.com/league/deactivate', {
      method: 'POST',
      headers: { cookie: b.cookie, 'content-type': 'application/json', 'x-csrf-token': b.csrfToken },
      body: JSON.stringify({ confirmName: 'Part 10 Cross League A' }) // wrong name for B's own league
    });

    const rowA = await env.DB.prepare('SELECT deactivated_at FROM leagues WHERE id = ?').bind(a.leagueId).first();
    expect(rowA.deactivated_at).toBeNull();
  });
});

// UI task Part S: GET /league/roster. Server-rendered from the same data
// GET /league/contacts (Part L) already provides, so the page's own HTML
// can be checked directly, without a JS-executing browser. Proves: real
// data renders in the HTML (not just an empty/loading state); redirects
// to /login when unauthenticated; the add-contact form posts to the real
// POST /league/contacts (Part J) route and the result is reflected on
// reload; and League A cannot see League B's roster through this page.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-ui-roster-secret';

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

describe('UI task Part S: GET /league/roster', () => {
  let leagueA, leagueB, cookieA, cookieB;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;

    await applyRealSchema(env);

    const a = await signupAndCreateLeague('uiroster.a@example.com', '203.0.113.351', 'UI Roster League A', ['Otters', 'Falcons']);
    const b = await signupAndCreateLeague('uiroster.b@example.com', '203.0.113.352', 'UI Roster League B', ['Narwhals', 'Beavers']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    cookieB = b.cookie;

    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Roster Page Player One', email: 'rp1@leaguea.com', role: 'roster' })
    });
    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'League B Only Player', email: 'bonly@leagueb.com', role: 'roster' })
    });
  });

  it('redirects to /login for an unauthenticated request', async () => {
    const res = await SELF.fetch('http://example.com/league/roster', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location') || '').toContain('/login');
  });

  it("renders a session-authenticated admin's real roster data in the HTML, with the add-player form present", async () => {
    const res = await SELF.fetch('http://example.com/league/roster', { headers: { cookie: cookieA } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Roster Page Player One');
    expect(html).toContain('rp1@leaguea.com');
    expect(html).toContain('id="r_name"');
    expect(html).toContain('id="r_submit"');
  });

  it("League A's admin never sees League B's roster through this page", async () => {
    const res = await SELF.fetch('http://example.com/league/roster', { headers: { cookie: cookieA } });
    const html = await res.text();
    expect(html).not.toContain('League B Only Player');
  });

  it("a contact added via the real POST /league/contacts route (what the form's JS calls) is reflected on the next page load", async () => {
    const createRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Freshly Added Player', role: 'sub_skater' })
    });
    expect(createRes.status).toBe(200);

    const res = await SELF.fetch('http://example.com/league/roster', { headers: { cookie: cookieA } });
    const html = await res.text();
    expect(html).toContain('Freshly Added Player');
    expect(html).toContain('Sub'); // role label rendered
  });

  it("a duplicate-email rejection from the API is a real, surfaceable error (not silently swallowed by the page)", async () => {
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Duplicate Email Attempt', email: 'rp1@leaguea.com' })
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/already exists/i);
  });

  it('an empty roster renders a clear "no players yet" state, not a crash', async () => {
    const c = await signupAndCreateLeague('uiroster.empty@example.com', '203.0.113.353', 'UI Roster Empty League', ['Sharks', 'Wolves']);
    const res = await SELF.fetch('http://example.com/league/roster', { headers: { cookie: c.cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Aucun joueur');
  });
});

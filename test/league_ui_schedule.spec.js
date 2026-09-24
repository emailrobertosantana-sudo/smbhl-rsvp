// UI task Part T: GET /league/schedule. Server-rendered from the same
// query GET /league/events (Part L) uses. Proves: real event data renders
// in the HTML; redirects to /login when unauthenticated; the create-event
// form posts to the real POST /league/events (Part K) route and the
// result is reflected on reload; each event links to its detail/status
// page; and League A cannot see League B's schedule through this page.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-ui-schedule-secret';

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

describe('UI task Part T: GET /league/schedule', () => {
  let leagueA, leagueB, cookieA, cookieB, csrfTokenA, csrfTokenB, eventA;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;

    await applyRealSchema(env);

    const a = await signupAndCreateLeague('uischedule.a@example.com', '203.0.113.361', 'UI Schedule League A', ['Otters', 'Falcons']);
    const b = await signupAndCreateLeague('uischedule.b@example.com', '203.0.113.362', 'UI Schedule League B', ['Narwhals', 'Beavers']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    csrfTokenA = a.csrfToken;
    cookieB = b.cookie;
    csrfTokenB = b.csrfToken;

    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ season_name: 'UI Schedule Season A' })
    });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ season_name: 'UI Schedule Season B' })
    });

    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ date: '2026-12-06', venue: 'Schedule Page Rink' })
    });
    eventA = (await eventRes.json()).event.id;

    await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ date: '2026-12-07', venue: 'League B Only Rink' })
    });
  });

  it('redirects to /login for an unauthenticated request', async () => {
    const res = await SELF.fetch('http://example.com/league/schedule', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location') || '').toContain('/login');
  });

  it("renders a session-authenticated admin's real events in the HTML, each linking to its detail page", async () => {
    const res = await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: cookieA } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Schedule Page Rink');
    // Superseded by live-testing task (batch 2), Part 6: dates now
    // render in the design system's own format -- 2026-12-06 is a
    // Sunday, so "Dim 6 déc" replaces the old raw ISO assertion.
    expect(html).toContain('Dim 6 déc');
    expect(html).toContain(`/league/events/detail?e=${encodeURIComponent(eventA)}`);
    expect(html).toContain('id="e_date"');
    expect(html).toContain('id="e_submit"');
  });

  it("League A's admin never sees League B's schedule through this page", async () => {
    const res = await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: cookieA } });
    const html = await res.text();
    expect(html).not.toContain('League B Only Rink');
  });

  it('an event created via the real POST /league/events route is reflected on the next page load', async () => {
    const createRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ date: '2026-12-13', venue: 'Freshly Created Venue' })
    });
    expect(createRes.status).toBe(200);

    const res = await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: cookieA } });
    const html = await res.text();
    expect(html).toContain('Freshly Created Venue');
  });

  it('a duplicate-date rejection from the API is a real, surfaceable error', async () => {
    const res = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ date: '2026-12-06' }) // already used above
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/already exists/i);
  });

  it('an empty schedule renders a clear "no events yet" state, not a crash', async () => {
    const c = await signupAndCreateLeague('uischedule.empty@example.com', '203.0.113.363', 'UI Schedule Empty League', ['Sharks', 'Wolves']);
    const res = await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: c.cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Aucun match');
  });
});

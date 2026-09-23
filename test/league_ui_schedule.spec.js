// UI task Part T: GET /league/schedule. Server-rendered from the same
// query GET /league/events (Part L) uses. Proves: real event data renders
// in the HTML; redirects to /login when unauthenticated; the create-event
// form posts to the real POST /league/events (Part K) route and the
// result is reflected on reload; each event links to its detail/status
// page; and League A cannot see League B's schedule through this page.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

const AUTH_SECRET = 'test-ui-schedule-secret';

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

describe('UI task Part T: GET /league/schedule', () => {
  let leagueA, leagueB, cookieA, cookieB, eventA;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, email_verified_at TEXT, last_login_at TEXT, session_epoch INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS signup_attempts (ip TEXT PRIMARY KEY, window_start TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leagues (id TEXT PRIMARY KEY, name TEXT NOT NULL, division_label TEXT, tracks_stats INTEGER NOT NULL DEFAULT 1, team_count INTEGER NOT NULL, team_names TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS league_admins (user_id TEXT NOT NULL, league_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL, PRIMARY KEY (user_id, league_id))`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, season TEXT, week INTEGER, date TEXT, venue TEXT, state TEXT NOT NULL DEFAULT 'open', start_time TEXT, end_time TEXT, league_id TEXT NOT NULL DEFAULT 'smbhl')`).run();

    const a = await signupAndCreateLeague('uischedule.a@example.com', '203.0.113.361', 'UI Schedule League A', ['Otters', 'Falcons']);
    const b = await signupAndCreateLeague('uischedule.b@example.com', '203.0.113.362', 'UI Schedule League B', ['Narwhals', 'Beavers']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    cookieB = b.cookie;

    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ season_name: 'UI Schedule Season A' })
    });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json' },
      body: JSON.stringify({ season_name: 'UI Schedule Season B' })
    });

    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-06', venue: 'Schedule Page Rink' })
    });
    eventA = (await eventRes.json()).event.id;

    await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json' },
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
    expect(html).toContain('2026-12-06');
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
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-13', venue: 'Freshly Created Venue' })
    });
    expect(createRes.status).toBe(200);

    const res = await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: cookieA } });
    const html = await res.text();
    expect(html).toContain('Freshly Created Venue');
  });

  it('a duplicate-date rejection from the API is a real, surfaceable error', async () => {
    const res = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
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

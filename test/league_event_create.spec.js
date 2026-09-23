// Part K: POST /league/events — league-scoped event creation.
// Session+checkLeagueAccess-gated only, no ADMIN_KEY door. Proves: the
// write is unreachable via ADMIN_KEY-without-session; it only ever writes
// rows tagged with the calling league's own league_id (SMBHL's events
// re-verified unchanged after a second league creates one); ids use
// league_ids.js's collision-safe makeEventId; and basic validation.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

const AUTH_SECRET = 'test-league-event-create-secret';
const ADMIN_KEY = 'test-league-event-create-admin-key';

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

async function publishSeason(cookie, seasonName) {
  return SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ season_name: seasonName })
  });
}

describe('Part K: POST /league/events', () => {
  let leagueA, leagueB, cookieA, cookieB;
  let smbhlEventsSnapshot;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.ADMIN_KEY = ADMIN_KEY;

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, email_verified_at TEXT, last_login_at TEXT, session_epoch INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS signup_attempts (ip TEXT PRIMARY KEY, window_start TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leagues (id TEXT PRIMARY KEY, name TEXT NOT NULL, division_label TEXT, tracks_stats INTEGER NOT NULL DEFAULT 1, team_count INTEGER NOT NULL, team_names TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS league_admins (user_id TEXT NOT NULL, league_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL, PRIMARY KEY (user_id, league_id))`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, season TEXT, week INTEGER, date TEXT, venue TEXT, state TEXT NOT NULL DEFAULT 'open', start_time TEXT, end_time TEXT, league_id TEXT NOT NULL DEFAULT 'smbhl')`).run();

    // SMBHL's real, existing events.
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time) VALUES ('2026-09-20', 'Fall 2026', 3, '2026-09-20', 'College Jean-de-Brebeuf', 'open', '10:30')`).run();

    const a = await signupAndCreateLeague('eventcreate.a@example.com', '203.0.113.271', 'Event Create League A', ['Otters', 'Falcons']);
    const b = await signupAndCreateLeague('eventcreate.b@example.com', '203.0.113.272', 'Event Create League B', ['Narwhals', 'Beavers']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    cookieB = b.cookie;

    await publishSeason(cookieA, 'League A Season 1');
    await publishSeason(cookieB, 'League B Season 1');

    smbhlEventsSnapshot = (await env.DB.prepare(
      `SELECT id, season, week, date, venue, state FROM events WHERE league_id = 'smbhl' ORDER BY id`
    ).all()).results;
  });

  it('ADMIN_KEY alone, with no valid session, cannot use this route at all', async () => {
    const res = await SELF.fetch('http://example.com/league/events', {
      method: 'POST',
      headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-11-01' })
    });
    expect(res.status).toBe(401);
  });

  it('an unauthenticated request is rejected', async () => {
    const res = await SELF.fetch('http://example.com/league/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-11-01' })
    });
    expect(res.status).toBe(401);
  });

  it('a session-authenticated league admin can create an event for their own league, on the same calendar date SMBHL already has a game', async () => {
    const res = await SELF.fetch('http://example.com/league/events', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-09-20', venue: 'League A Rink', start_time: '18:00', end_time: '20:00' })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.league_id).toBe(leagueA);
    expect(json.event.id).toBe(`${leagueA}:2026-09-20`);
    expect(json.event.season).toBe('League A Season 1');
    expect(json.event.week).toBe(1);
    expect(json.event.venue).toBe('League A Rink');

    const row = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(json.event.id).first();
    expect(row.league_id).toBe(leagueA);
    expect(row.date).toBe('2026-09-20');
  });

  it('the SAME-date event did NOT collide with or overwrite SMBHL\'s own event on that date -- both rows coexist', async () => {
    const smbhlRow = await env.DB.prepare(`SELECT * FROM events WHERE id = '2026-09-20'`).first();
    expect(smbhlRow.venue).toBe('College Jean-de-Brebeuf'); // unchanged
    const leagueARow = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(`${leagueA}:2026-09-20`).first();
    expect(leagueARow.venue).toBe('League A Rink');
  });

  it('this write ONLY touched League A\'s own rows -- SMBHL\'s events are provably still exactly what they were', async () => {
    const current = (await env.DB.prepare(
      `SELECT id, season, week, date, venue, state FROM events WHERE league_id = 'smbhl' ORDER BY id`
    ).all()).results;
    expect(current).toEqual(smbhlEventsSnapshot);
  });

  it('week auto-increments per league+season when not given', async () => {
    const res = await SELF.fetch('http://example.com/league/events', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-09-27' })
    });
    const json = await res.json();
    expect(json.event.week).toBe(2); // second event for League A Season 1
  });

  it('season defaults to the league\'s own current_season when not given', async () => {
    const res = await SELF.fetch('http://example.com/league/events', {
      method: 'POST',
      headers: { cookie: cookieB, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-10-04' })
    });
    const json = await res.json();
    expect(json.event.season).toBe('League B Season 1');
  });

  it('rejects a missing/malformed date', async () => {
    const res1 = await SELF.fetch('http://example.com/league/events', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(res1.status).toBe(400);

    const res2 = await SELF.fetch('http://example.com/league/events', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ date: 'not-a-date' })
    });
    expect(res2.status).toBe(400);
  });

  it('rejects a malformed start_time', async () => {
    const res = await SELF.fetch('http://example.com/league/events', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-01', start_time: '6pm' })
    });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate date within the SAME league', async () => {
    const res = await SELF.fetch('http://example.com/league/events', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-09-20' })
    });
    expect(res.status).toBe(409);
  });

  it('the SAME date is allowed for a DIFFERENT league (collision-safe ids per league_ids.js)', async () => {
    const res = await SELF.fetch('http://example.com/league/events', {
      method: 'POST',
      headers: { cookie: cookieB, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-09-20' })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.event.id).toBe(`${leagueB}:2026-09-20`);
  });
});

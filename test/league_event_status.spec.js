// Part O: shortage detection scoped to a second league. Reuses the exact
// same shared logic SMBHL's own pages use (teamState/openSpots via
// GET /league/events/status), just parameterized with that league's own
// config (getLeagueSeasonConfig) instead of SMBHL's data_json. Proves:
// a league can set its own roster-size numbers at season/publish time,
// distinct from DEFAULT_SEASON_CONFIG; shortage math is correct for real
// rsvp data; and the route is session-gated/isolated like every other
// league-scoped route.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

const AUTH_SECRET = 'test-league-event-status-secret';

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

describe('Part O: GET /league/events/status', () => {
  let leagueA, leagueB, cookieA, cookieB, eventA;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, email_verified_at TEXT, last_login_at TEXT, session_epoch INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS signup_attempts (ip TEXT PRIMARY KEY, window_start TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leagues (id TEXT PRIMARY KEY, name TEXT NOT NULL, division_label TEXT, tracks_stats INTEGER NOT NULL DEFAULT 1, team_count INTEGER NOT NULL, team_names TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS league_admins (user_id TEXT NOT NULL, league_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL, PRIMARY KEY (user_id, league_id))`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS contacts (player_id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, role TEXT NOT NULL DEFAULT 'roster', is_goalie INT DEFAULT 0, is_backup_goalie INT DEFAULT 0, preferred_team TEXT, position TEXT, token_salt TEXT NOT NULL DEFAULT '', league_id TEXT NOT NULL DEFAULT 'smbhl')`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, season TEXT, week INTEGER, date TEXT, venue TEXT, state TEXT NOT NULL DEFAULT 'open', start_time TEXT, end_time TEXT, league_id TEXT NOT NULL DEFAULT 'smbhl')`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rsvp (event_id TEXT, player_id TEXT, guest_name TEXT, team TEXT, status TEXT NOT NULL DEFAULT 'pending', role TEXT NOT NULL DEFAULT 'roster', status_by TEXT NOT NULL DEFAULT 'auto', updated_at TEXT, league_id TEXT NOT NULL DEFAULT 'smbhl', PRIMARY KEY (event_id, player_id))`).run();

    const a = await signupAndCreateLeague('eventstatus.a@example.com', '203.0.113.311', 'Event Status League A', ['Otters', 'Falcons']);
    const b = await signupAndCreateLeague('eventstatus.b@example.com', '203.0.113.312', 'Event Status League B', ['Narwhals', 'Beavers']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    cookieB = b.cookie;

    // A tight, custom roster-size config -- deliberately NOT
    // DEFAULT_SEASON_CONFIG's 1 goalie / 8 skaters / 5-skater minimum.
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ season_name: 'League A Season 1', goalies_per_team: 1, skaters_per_team: 3, min_skaters: 2 })
    });

    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-27', season: 'League A Season 1' })
    });
    eventA = (await eventRes.json()).event.id;

    // Two skaters and one goalie confirmed IN for Otters -- meets the
    // custom min_skaters:2 but this league's target is skaters_per_team:3.
    const p1 = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Skater One' })
    });
    const p2 = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Skater Two' })
    });
    const p1Id = (await p1.json()).contact.player_id;
    const p2Id = (await p2.json()).contact.player_id;
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, 'Otters', 'in', 'roster', 'self', ?, ?)`)
      .bind(eventA, p1Id, now, leagueA).run();
    await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, 'Otters', 'in', 'roster', 'self', ?, ?)`)
      .bind(eventA, p2Id, now, leagueA).run();
  });

  it('an unauthenticated request is rejected', async () => {
    const res = await SELF.fetch(`http://example.com/league/events/status?e=${encodeURIComponent(eventA)}`);
    expect(res.status).toBe(401);
  });

  it("a league admin sees their own event's shortage status, using THEIR OWN roster-size config (not DEFAULT_SEASON_CONFIG's 8-skater/1-goalie target)", async () => {
    const res = await SELF.fetch(`http://example.com/league/events/status?e=${encodeURIComponent(eventA)}`, {
      headers: { cookie: cookieA }
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.league_id).toBe(leagueA);
    const otters = json.teams.find(t => t.team === 'Otters');
    expect(otters).toBeTruthy();
    expect(otters.skaters).toBe(2);
    // skaters_per_team is 3 for this league -> 1 open spot, and short
    // because 2 < 3 (even though 2 >= this league's own min_skaters of 2,
    // "short" is measured against the target, matching teamState's
    // existing semantics -- unchanged, just fed this league's own cfg).
    expect(otters.openSkaters).toBe(1);

    const falcons = json.teams.find(t => t.team === 'Falcons');
    expect(falcons.skaters).toBe(0);
    expect(falcons.short).toBe(true);
  });

  it("League B's admin cannot see League A's event status (404 -- not their event)", async () => {
    const res = await SELF.fetch(`http://example.com/league/events/status?e=${encodeURIComponent(eventA)}`, {
      headers: { cookie: cookieB }
    });
    expect(res.status).toBe(404);
  });

  it('a missing e param is rejected', async () => {
    const res = await SELF.fetch('http://example.com/league/events/status', { headers: { cookie: cookieA } });
    expect(res.status).toBe(400);
  });

  it("a league with NO custom roster config falls back to the generic default (not crashing, not SMBHL's live data)", async () => {
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json' },
      body: JSON.stringify({ season_name: 'League B Season 1' }) // no roster config given
    });
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-28', season: 'League B Season 1' })
    });
    const eventBId = (await eventRes.json()).event.id;

    const res = await SELF.fetch(`http://example.com/league/events/status?e=${encodeURIComponent(eventBId)}`, {
      headers: { cookie: cookieB }
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    // Narwhals/Beavers, generic default target (8 skaters), all short/empty.
    const narwhals = json.teams.find(t => t.team === 'Narwhals');
    expect(narwhals.skaters).toBe(0);
    expect(narwhals.short).toBe(true);
  });
});

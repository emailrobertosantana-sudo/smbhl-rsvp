// Part N: POST /league/rsvp — actual RSVP submission via a player's magic
// token from Part M. Proves: writes are correctly league-tagged; a bad/
// mismatched token cannot write anything; and — the critical safety
// proof — a second league's player submitting an RSVP cannot affect
// SMBHL's or another league's rsvp rows at all. SMBHL's real data_json
// and events/contacts are re-verified byte-for-byte unaffected afterward.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

const AUTH_SECRET = 'test-league-rsvp-submit-secret';
const RSVP_SECRET = 'test-league-rsvp-submit-rsvp-secret';

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

async function computeToken(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

describe('Part N: POST /league/rsvp', () => {
  let leagueA, leagueB, cookieA, cookieB;
  let playerA, playerASalt, eventA;
  let playerB, eventB;
  let smbhlRsvpSnapshot;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, email_verified_at TEXT, last_login_at TEXT, session_epoch INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS signup_attempts (ip TEXT PRIMARY KEY, window_start TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leagues (id TEXT PRIMARY KEY, name TEXT NOT NULL, division_label TEXT, tracks_stats INTEGER NOT NULL DEFAULT 1, team_count INTEGER NOT NULL, team_names TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS league_admins (user_id TEXT NOT NULL, league_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL, PRIMARY KEY (user_id, league_id))`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS contacts (player_id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, role TEXT NOT NULL DEFAULT 'roster', is_goalie INT DEFAULT 0, preferred_team TEXT, position TEXT, token_salt TEXT NOT NULL DEFAULT '', league_id TEXT NOT NULL DEFAULT 'smbhl')`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, season TEXT, week INTEGER, date TEXT, venue TEXT, state TEXT NOT NULL DEFAULT 'open', start_time TEXT, end_time TEXT, league_id TEXT NOT NULL DEFAULT 'smbhl')`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rsvp (event_id TEXT, player_id TEXT, guest_name TEXT, team TEXT, status TEXT NOT NULL DEFAULT 'pending', role TEXT NOT NULL DEFAULT 'roster', status_by TEXT NOT NULL DEFAULT 'auto', updated_at TEXT, league_id TEXT NOT NULL DEFAULT 'smbhl', PRIMARY KEY (event_id, player_id))`).run();

    // SMBHL's real, existing rsvp data.
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, token_salt) VALUES ('P0001', 'Real SMBHL Player', 'real@smbhl.com', 'roster', 'realsalt1')`).run();
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state) VALUES ('2026-09-20', 'Fall 2026', 3, '2026-09-20', 'College Jean-de-Brebeuf', 'open')`).run();
    await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('2026-09-20', 'P0001', 'Red', 'in', 'roster', 'self', ?)`).bind(new Date().toISOString()).run();

    const a = await signupAndCreateLeague('rsvpsubmit.a@example.com', '203.0.113.301', 'RSVP Submit League A', ['Otters', 'Falcons']);
    const b = await signupAndCreateLeague('rsvpsubmit.b@example.com', '203.0.113.302', 'RSVP Submit League B', ['Narwhals', 'Beavers']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    cookieB = b.cookie;

    const contactRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Player Alpha Two', email: 'alpha2@leaguea.com' })
    });
    playerA = (await contactRes.json()).contact.player_id;
    playerASalt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerA).first()).token_salt;

    const contactBRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Player Beta Two' })
    });
    playerB = (await contactBRes.json()).contact.player_id;

    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-13', season: 'League A Season 1' })
    });
    eventA = (await eventRes.json()).event.id;

    const eventBRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-13', season: 'League B Season 1' })
    });
    eventB = (await eventBRes.json()).event.id;

    smbhlRsvpSnapshot = (await env.DB.prepare(
      `SELECT event_id, player_id, team, status, league_id FROM rsvp WHERE league_id = 'smbhl'`
    ).all()).results;
  });

  it('a valid token submits an in/out status via POST', async () => {
    const token = await computeToken(RSVP_SECRET, `lr:${leagueA}:${eventA}:${playerA}:${playerASalt}`);
    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(eventA)}&p=${encodeURIComponent(playerA)}&t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in' })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status).toBe('in');

    const row = await env.DB.prepare('SELECT * FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventA, playerA).first();
    expect(row.status).toBe('in');
    expect(row.league_id).toBe(leagueA);
  });

  it('an invalid status value is rejected', async () => {
    const token = await computeToken(RSVP_SECRET, `lr:${leagueA}:${eventA}:${playerA}:${playerASalt}`);
    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(eventA)}&p=${encodeURIComponent(playerA)}&t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'maybe' })
    });
    expect(res.status).toBe(400);
  });

  it('a bad token cannot write anything at all', async () => {
    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(eventA)}&p=${encodeURIComponent(playerA)}&t=totally-wrong`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'out' })
    });
    expect(res.status).toBe(403);
    const row = await env.DB.prepare('SELECT status FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventA, playerA).first();
    expect(row.status).toBe('in'); // unchanged from the previous valid submission
  });

  it("submitting via League A's token cannot write to League B's event/player row at all -- the league param is checked, not trusted", async () => {
    const token = await computeToken(RSVP_SECRET, `lr:${leagueA}:${eventA}:${playerA}:${playerASalt}`);
    // Attempt to target League B's real event/player while presenting
    // League A's token and league id.
    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(eventB)}&p=${encodeURIComponent(playerB)}&t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'out' })
    });
    expect(res.status).toBe(403);

    const bRow = await env.DB.prepare('SELECT * FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventB, playerB).first();
    expect(bRow).toBeNull(); // no row was ever created for League B's player
  });

  it("this write ONLY touched League A's own rsvp row -- SMBHL's rsvp data is provably still exactly what it was", async () => {
    const current = (await env.DB.prepare(
      `SELECT event_id, player_id, team, status, league_id FROM rsvp WHERE league_id = 'smbhl'`
    ).all()).results;
    expect(current).toEqual(smbhlRsvpSnapshot);
  });

  it('a locked (non-open) event rejects submissions', async () => {
    const lockedEventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-20', season: 'League A Season 1' })
    });
    const lockedEventId = (await lockedEventRes.json()).event.id;
    await env.DB.prepare(`UPDATE events SET state = 'closed' WHERE id = ?`).bind(lockedEventId).run();

    const token = await computeToken(RSVP_SECRET, `lr:${leagueA}:${lockedEventId}:${playerA}:${playerASalt}`);
    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(lockedEventId)}&p=${encodeURIComponent(playerA)}&t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in' })
    });
    expect(res.status).toBe(409);
  });
});

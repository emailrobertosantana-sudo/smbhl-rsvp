// Part R, safety requirement: for a second league, ONLY the player
// themselves (via their own valid magic token) or the league admin (via
// session) may change a player's RSVP status. The "teammate marks a
// DIFFERENT player out" capability SMBHL's real /rsvp + /team-rsvp has
// (a team-scoped token that can set ANY player's status on that team) is
// genuinely NOT built for a second league — this file proves that
// explicitly, and confirms SMBHL's own /team-rsvp is completely
// unaffected by anything in this task.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-no-teammate-edit-secret';
const RSVP_SECRET = 'test-no-teammate-edit-rsvp-secret';

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

describe('Part R: no teammate-marks-teammate capability for a second league', () => {
  let leagueA, cookieA, playerA1, playerA1Salt, playerA2, eventA;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;

    await applyRealSchema(env);

    const a = await signupAndCreateLeague('noteammate.a@example.com', '203.0.113.331', 'No Teammate League A', ['Otters', 'Falcons']);
    leagueA = a.leagueId;
    cookieA = a.cookie;

    const p1Res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Player A One' })
    });
    playerA1 = (await p1Res.json()).contact.player_id;
    playerA1Salt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerA1).first()).token_salt;

    const p2Res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Player A Two' })
    });
    playerA2 = (await p2Res.json()).contact.player_id;

    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-06', season: 'League A Season 1' })
    });
    eventA = (await eventRes.json()).event.id;
  });

  it("Player A1's own valid token cannot be used to set Player A2's status -- swapping the p= param invalidates the token entirely", async () => {
    const token = await computeToken(RSVP_SECRET, `lr:${leagueA}:${eventA}:${playerA1}:${playerA1Salt}`);
    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(eventA)}&p=${encodeURIComponent(playerA2)}&t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'out' })
    });
    expect(res.status).toBe(403);

    const row = await env.DB.prepare('SELECT * FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventA, playerA2).first();
    expect(row).toBeNull(); // Player A2's row was never touched
  });

  it('there is no way to smuggle a different target player into the request body either -- the route only ever reads the URL\'s own p= param', async () => {
    const token = await computeToken(RSVP_SECRET, `lr:${leagueA}:${eventA}:${playerA1}:${playerA1Salt}`);
    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(eventA)}&p=${encodeURIComponent(playerA1)}&t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Attempt to also specify a different target via the body -- ignored.
      body: JSON.stringify({ status: 'out', player_id: playerA2, target_player_id: playerA2 })
    });
    expect(res.status).toBe(200);

    const p1Row = await env.DB.prepare('SELECT * FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventA, playerA1).first();
    expect(p1Row.status).toBe('out'); // the actual (URL) player was updated

    const p2Row = await env.DB.prepare('SELECT * FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventA, playerA2).first();
    expect(p2Row).toBeNull(); // the body-smuggled "target" was never touched
  });

  it('there is no team-scoped token mechanism at all for a second league -- /league/rsvp only ever accepts a single player\'s own token, never a team token', async () => {
    // Attempting to reuse a *team*-shaped message (mirroring SMBHL's real
    // teamMsg convention) against /league/rsvp fails -- this route only
    // ever recognizes the per-player leagueRsvpMsg shape.
    const fakeTeamToken = await computeToken(RSVP_SECRET, `t:League A Season 1:Otters:some-salt`);
    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(eventA)}&p=${encodeURIComponent(playerA2)}&t=${fakeTeamToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'out' })
    });
    expect(res.status).toBe(403);
  });

  it("SMBHL's own /rsvp and /team-rsvp routes (which correctly support teammate-marks-teammate) are completely unaffected", async () => {
    await env.DB.prepare(`INSERT OR REPLACE INTO events (id, season, week, date, state) VALUES ('2026-09-20', 'Fall 2026', 3, '2026-09-20', 'open')`).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt) VALUES ('P0001', 'Real SMBHL Player', 'p1@smbhl.com', 'roster', 'smbhl-salt-1')`).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt) VALUES ('P0002', 'Real SMBHL Teammate', 'p2@smbhl.com', 'roster', 'smbhl-salt-2')`).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('2026-09-20', 'P0001', 'Red', 'pending', 'roster', 'auto', ?)`).bind(new Date().toISOString()).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('2026-09-20', 'P0002', 'Red', 'pending', 'roster', 'auto', ?)`).bind(new Date().toISOString()).run();

    // A real SMBHL team token lets a teammate mark a DIFFERENT player
    // (P0002) via /team-rsvp -- exactly the capability confirmed absent
    // for a second league above. teamSalt's real key format is
    // `teamsalt:<season>:<team>` (index.js's own teamSalt()).
    const teamSaltKey = 'teamsalt:Fall 2026:Red';
    await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, 'smbhl-team-salt')`).bind(teamSaltKey).run();
    const teamToken = await computeToken(RSVP_SECRET, `t:Fall 2026:Red:smbhl-team-salt`);

    const res = await SELF.fetch(`http://example.com/team-rsvp?s=${encodeURIComponent('Fall 2026')}&team=Red&t=${teamToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ player_id: 'P0002', status: 'out' })
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(`SELECT * FROM rsvp WHERE event_id = '2026-09-20' AND player_id = 'P0002'`).first();
    expect(row.status).toBe('out'); // SMBHL's teammate-marks-teammate still works, unchanged
  });
});

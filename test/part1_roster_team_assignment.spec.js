// Part 1 fix (found via live testing): the /league/roster "add a player"
// form had no team selector at all -- POST /league/contacts never
// accepted or stored a team, so every team on the event status/shortage
// page always showed 0 confirmed players regardless of real roster size
// (writeLeagueRsvpStatus/maybeInviteSubsForShortage both read the team
// from contact.preferred_team, which was always null).
//
// Proves: POST /league/contacts now accepts and validates a `team` field
// against the league's own real team names; GET /league/roster offers a
// real team selector and shows each player's team ("Non assigné" for a
// team-less player, not a silent default); and, end to end, a player who
// is assigned a team and then really RSVPs 'in' via the actual magic-link
// flow shows up as a real confirmed skater on the shortage page.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part1-roster-team-secret';
const RSVP_SECRET = 'test-part1-roster-team-rsvp-secret';

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

describe('Part 1: roster team assignment', () => {
  let leagueA, cookieA;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    await applyRealSchema(env);

    const a = await signupAndCreateLeague('part1.roster@example.com', '203.0.113.401', 'Part 1 Roster League', ['Otters', 'Falcons']);
    leagueA = a.leagueId;
    cookieA = a.cookie;
  });

  it('POST /league/contacts accepts a team name from the league\'s own real team list and stores it', async () => {
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Otters Player One', team: 'Otters' })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.contact.team).toBe('Otters');

    const row = await env.DB.prepare('SELECT preferred_team FROM contacts WHERE player_id = ?').bind(json.contact.player_id).first();
    expect(row.preferred_team).toBe('Otters');
  });

  it('rejects a team name that is not one of the league\'s real teams', async () => {
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bad Team Player', team: 'Not A Real Team' })
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Otters');
  });

  it('a player with no team stays genuinely unassigned (null), not a silent default', async () => {
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'No Team Player' })
    });
    const json = await res.json();
    expect(json.contact.team).toBeNull();
    const row = await env.DB.prepare('SELECT preferred_team FROM contacts WHERE player_id = ?').bind(json.contact.player_id).first();
    expect(row.preferred_team).toBeNull();
  });

  it('GET /league/roster offers a real team selector populated with the league\'s own teams, and shows each player\'s team (or "Non assigné/Unassigned")', async () => {
    const res = await SELF.fetch('http://example.com/league/roster', { headers: { cookie: cookieA } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="r_team"');
    expect(html).toContain('<option value="Otters">Otters</option>');
    expect(html).toContain('<option value="Falcons">Falcons</option>');
    expect(html).toContain('Otters Player One');
    expect(html).toContain('>Otters<'); // the assigned player's row shows the real team
    expect(html).toContain('Non assigné');
    expect(html).toContain('Unassigned');
  });

  it("end to end: a player assigned to a team who really RSVPs 'in' via the actual magic-link flow is counted as a real confirmed skater on the shortage page (not 0, the original bug)", async () => {
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ season_name: 'Part 1 E2E Season', goalies_per_team: 1, skaters_per_team: 3, min_skaters: 1 })
    });

    const contactRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Falcons Real Player', team: 'Falcons' })
    });
    const playerId = (await contactRes.json()).contact.player_id;
    const salt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerId).first()).token_salt;

    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-20', season: 'Part 1 E2E Season' })
    });
    const eventId = (await eventRes.json()).event.id;

    // The real player-facing magic-link flow -- exactly what an emailed
    // RSVP link does, not a direct DB write.
    const token = await computeToken(RSVP_SECRET, `lr:${leagueA}:${eventId}:${playerId}:${salt}`);
    const rsvpRes = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in' })
    });
    expect(rsvpRes.status).toBe(200);

    const rsvpRow = await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, playerId).first();
    expect(rsvpRow.team).toBe('Falcons'); // came from contact.preferred_team, not a param the player supplied

    const statusRes = await SELF.fetch(`http://example.com/league/events/status?e=${encodeURIComponent(eventId)}`, { headers: { cookie: cookieA } });
    const statusJson = await statusRes.json();
    const falcons = statusJson.teams.find(t => t.team === 'Falcons');
    expect(falcons.skaters).toBe(1); // the original bug: this was always 0
  });
});

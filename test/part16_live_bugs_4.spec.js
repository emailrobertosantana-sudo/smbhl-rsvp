// Bug 3 found via a real end-to-end live verification against
// notreligue.ca: a headcount league's real min/max (chosen carefully
// at signup) was silently discarded the moment the very first season
// was published through the standard/default onboarding flow (which
// only ever sends {season_name}, no min/max). The season's own config
// never got skatersPerTeam/minSkaters attached, so every downstream
// consumer (shortage math, the public page's "X/Y confirmed" figure)
// fell back to SMBHL's generic defaults (8/5) instead of the league's
// real signup-chosen numbers. Confirmed live: a real league's public
// page showed "2/8" instead of the correct "2/10" (real max_players).
import { env, SELF } from 'cloudflare:test';
import { getLeagueSeasonConfig } from '../src/leagues.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part16-live-bugs-4-secret';

function extractCookie(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(', ');
  const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
  return csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
}
async function signup(email, ip) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  return { cookie: extractCookie(res), csrfToken: extractCsrfToken(res) };
}
async function createLeague(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).league;
}
async function publishSeason(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}
async function createEvent(cookie, csrfToken, date, season) {
  return (await (await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ date, season })
  })).json()).event.id;
}
async function addPlayer(cookie, csrfToken, name, extra = {}) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, ...extra })
  });
  return (await res.json()).contact.player_id;
}
async function setStatus(cookie, csrfToken, eventId, playerId, status) {
  return SELF.fetch('http://example.com/league/rsvp/admin', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ event_id: eventId, player_id: playerId, status })
  });
}

describe('Live-testing Bug 3: headcount min/max carried into first-season-publish', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it("the plain {season_name}-only publish (the real onboarding flow's own shape) still correctly attaches the league's real min/max", async () => {
    const { cookie, csrfToken } = await signup('bugs4.plainpublish@example.com', '203.0.119.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Plain Publish League', tracksStats: true, teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10 });
    // The exact body shape the dashboard's "start your first season"
    // form sends -- no min_players/max_players, no team_structure.
    const pub = await publishSeason(cookie, csrfToken, { season_name: 'Plain Publish Season' });
    expect(pub.status).toBe(200);

    const cfg = await getLeagueSeasonConfig(env, league.id, 'Plain Publish Season');
    expect(cfg.skatersPerTeam).toBe(10);
    expect(cfg.minSkaters).toBe(6);
  });

  it('reflects correctly on the public page ("X/10", not the generic "X/8")', async () => {
    const { cookie, csrfToken } = await signup('bugs4.publicpage@example.com', '203.0.119.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Public Page MinMax League', tracksStats: true, teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10 });
    await publishSeason(cookie, csrfToken, { season_name: 'Public Page MinMax Season' });
    const eventId = await createEvent(cookie, csrfToken, '2099-10-01');
    const p1 = await addPlayer(cookie, csrfToken, 'MinMax Public Player');
    await setStatus(cookie, csrfToken, eventId, p1, 'in');

    const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`);
    const html = await res.text();
    expect(html).toContain('<span class="tnum">1</span><span>/10</span>');
    expect(html).not.toContain('/8</span>');
  });

  it('reflects correctly on the event-status page (open spots computed against the real max, not 8)', async () => {
    const { cookie, csrfToken } = await signup('bugs4.eventstatus@example.com', '203.0.119.003');
    await createLeague(cookie, csrfToken, { name: 'Event Status MinMax League', tracksStats: true, teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10 });
    await publishSeason(cookie, csrfToken, { season_name: 'Event Status MinMax Season' });
    const eventId = await createEvent(cookie, csrfToken, '2099-10-08');
    const p1 = await addPlayer(cookie, csrfToken, 'MinMax Event Player');
    await setStatus(cookie, csrfToken, eventId, p1, 'in');

    const res = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } });
    const html = await res.text();
    // The pool card's meter renders one <i> per target spot
    // (Math.max(totalTarget, confirmed), totalTarget = skatersPerTeam +
    // goaliesPerTeam). Real max_players=10 -> skatersPerTeam=10, plus
    // the never-overridden goaliesPerTeam default of 1 (deliberate --
    // see handleLeagueSeasonPublish's own comment) = 11 cells, not the
    // 9 the generic SMBHL default (8 skaters + 1 goalie) would produce.
    const meterMatch = html.match(/<div class="nl-meter">((?:<i[^>]*><\/i>)+)<\/div>/);
    const cellCount = (meterMatch[1].match(/<i/g) || []).length;
    expect(cellCount).toBe(11);
  });

  it('an explicit override to headcount on a NON-headcount-default league still requires min/max in the body (no league-level fallback exists for it)', async () => {
    const { cookie, csrfToken } = await signup('bugs4.overridenolimits@example.com', '203.0.119.004');
    await createLeague(cookie, csrfToken, { name: 'Override No Limits League', teamNames: ['A', 'B'], tracksStats: true });
    const pub = await publishSeason(cookie, csrfToken, { season_name: 'Override No Limits Season', team_structure: 'headcount' });
    expect(pub.status).toBe(400);
    expect(pub.json.errorKey).toBe('HEADCOUNT_LIMITS_REQUIRED');
  });

  it('a fixed-mode league\'s plain publish is completely unaffected (no skatersPerTeam/minSkaters attached at all)', async () => {
    const { cookie, csrfToken } = await signup('bugs4.fixedunaffected@example.com', '203.0.119.005');
    const league = await createLeague(cookie, csrfToken, { name: 'Fixed Unaffected League', teamNames: ['Red', 'Blue'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'Fixed Unaffected Season' });
    const cfg = await getLeagueSeasonConfig(env, league.id, 'Fixed Unaffected Season');
    // Falls through to DEFAULT_SEASON_CONFIG's own generic numbers, same
    // as every fixed-mode league before this fix -- completely
    // untouched, since effectiveStructure is 'fixed' here, not
    // 'headcount'.
    expect(cfg.skatersPerTeam).toBe(8);
    expect(cfg.minSkaters).toBe(5);
  });

  it('an already-published season (before a would-be re-publish) is not retroactively rewritten -- only a fresh publish call gets the fix', async () => {
    const { cookie, csrfToken } = await signup('bugs4.notretroactive@example.com', '203.0.119.006');
    const league = await createLeague(cookie, csrfToken, { name: 'Not Retroactive League', tracksStats: true, teamStructure: 'headcount', minPlayers: 4, maxPlayers: 12 });
    // Simulate an already-affected season from before this fix: a real
    // season entry whose config is missing skatersPerTeam/minSkaters,
    // written directly (as the old buggy code path would have left it).
    const dataKey = `data_json:${league.id}`;
    await env.SHEETS_KV.put(dataKey, JSON.stringify({
      current_season: 'Pre-Fix Season',
      seasons: [{ name: 'Pre-Fix Season', config: { teams: ['Tous'] }, standings: [], games: 0 }],
      players: []
    }));
    const cfgBefore = await getLeagueSeasonConfig(env, league.id, 'Pre-Fix Season');
    // Still the generic SMBHL default (8/5), NOT the league's real
    // 12/4 -- untouched by this fix, as expected, since nothing
    // called the publish route again yet.
    expect(cfgBefore.skatersPerTeam).toBe(8);
    expect(cfgBefore.minSkaters).toBe(5);

    // Re-publishing (editing) that SAME season name now self-heals it.
    await publishSeason(cookie, csrfToken, { season_name: 'Pre-Fix Season' });
    const cfgAfter = await getLeagueSeasonConfig(env, league.id, 'Pre-Fix Season');
    expect(cfgAfter.skatersPerTeam).toBe(12); // league's real max_players
    expect(cfgAfter.minSkaters).toBe(4); // league's real min_players
  });
});

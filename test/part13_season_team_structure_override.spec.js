// Season-level team-structure override task: a season can override its
// own league's default team_structure (and min/max, for headcount) for
// just itself -- e.g. a fixed-teams league running one headcount
// pickup season in winter, without changing the league's permanent
// signup-time default. Proves: inheritance when no override is given
// (every pre-existing league/season's behavior), a real override
// provably scoped to just that one season (a sibling season of the
// same league is unaffected), and every call site the prior
// team-structure task touched (roster, event status, shortage
// detection/RSVP writes, per-event assignment, reminders, public page)
// correctly resolves the ACTIVE EVENT'S OWN season, not just whichever
// season happens to be "current" for the league as a whole.
import { env, SELF } from 'cloudflare:test';
import { getLeagueSeasonConfig } from '../src/leagues.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part13-season-structure-secret';
const RSVP_SECRET = 'test-part13-season-structure-rsvp-secret';

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
async function addPlayer(cookie, csrfToken, name, extra = {}) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, ...extra })
  });
  return (await res.json()).contact.player_id;
}
async function createEvent(cookie, csrfToken, date, season) {
  const res = await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ date, season })
  });
  return (await res.json()).event.id;
}
async function setStatus(cookie, csrfToken, eventId, playerId, status) {
  return SELF.fetch('http://example.com/league/rsvp/admin', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ event_id: eventId, player_id: playerId, status })
  });
}

describe('Season-level team-structure override', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    await applyRealSchema(env);
  });

  describe('inheritance -- no override given', () => {
    it('a fixed-default league\'s season with no team_structure in the request resolves "fixed", inherited', async () => {
      const { cookie, csrfToken } = await signup('season.inherit.fixed@example.com', '203.0.116.001');
      const league = await createLeague(cookie, csrfToken, { name: 'Inherit Fixed League', teamNames: ['Otters', 'Falcons'], tracksStats: true });
      const pub = await publishSeason(cookie, csrfToken, { season_name: 'Inherit Fixed Season' });
      expect(pub.status).toBe(200);
      expect(pub.json.team_structure).toBe('fixed');
      const cfg = await getLeagueSeasonConfig(env, league.id, 'Inherit Fixed Season');
      expect(cfg.teamStructure).toBe('fixed');
      expect(cfg.teams.map(t => t.name)).toEqual(['Otters', 'Falcons']);
    });

    it('a headcount-default league\'s season with no team_structure in the request resolves "headcount", inherited', async () => {
      const { cookie, csrfToken } = await signup('season.inherit.headcount@example.com', '203.0.116.002');
      const league = await createLeague(cookie, csrfToken, { name: 'Inherit Headcount League', tracksStats: true, teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10 });
      const pub = await publishSeason(cookie, csrfToken, { season_name: 'Inherit Headcount Season' });
      expect(pub.status).toBe(200);
      expect(pub.json.team_structure).toBe('headcount');
      const cfg = await getLeagueSeasonConfig(env, league.id, 'Inherit Headcount Season');
      expect(cfg.teamStructure).toBe('headcount');
    });

    // Superseded by the live-testing settings-page task: config.teamStructure
    // is now ALWAYS written (the season's real effective value, override or
    // inherited), not left unset for a plain {season_name} publish. This
    // closes a real, dormant retroactive-alteration bug -- leaving it unset
    // meant a LATER, unrelated edit to the league's own team_structure
    // (now possible via the new settings page) would silently reach back
    // and change how this already-published season resolves. Freezing the
    // real value at publish time is what makes "changing league-level
    // settings must not alter existing seasons" true by construction.
    it('a plain re-publish using only {season_name} stores its real effective team_structure, frozen at publish time', async () => {
      const { cookie, csrfToken } = await signup('season.legacy.shape@example.com', '203.0.116.003');
      const league = await createLeague(cookie, csrfToken, { name: 'Legacy Shape League', teamNames: ['A', 'B'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'Legacy Season' });
      const stored = await env.SHEETS_KV.get(`data_json:${league.id}`);
      const parsed = JSON.parse(stored);
      expect(parsed.seasons[0].config.teamStructure).toBe('fixed');
    });
  });

  describe('override -- provably scoped to just one season', () => {
    it('season A (no override) stays fixed while season B (overridden) resolves headcount, on the SAME league', async () => {
      const { cookie, csrfToken } = await signup('season.scoped.ab@example.com', '203.0.116.004');
      const league = await createLeague(cookie, csrfToken, { name: 'Scoped AB League', teamNames: ['Red', 'Blue'], tracksStats: true });
      const pubA = await publishSeason(cookie, csrfToken, { season_name: 'Season A' });
      expect(pubA.json.team_structure).toBe('fixed');
      const pubB = await publishSeason(cookie, csrfToken, {
        season_name: 'Season B', team_structure: 'headcount', min_players: 5, max_players: 9
      });
      expect(pubB.status).toBe(200);
      expect(pubB.json.team_structure).toBe('headcount');
      expect(pubB.json.teams).toEqual(['Tous']);

      const cfgA = await getLeagueSeasonConfig(env, league.id, 'Season A');
      expect(cfgA.teamStructure).toBe('fixed');
      expect(cfgA.teams.map(t => t.name)).toEqual(['Red', 'Blue']);

      const cfgB = await getLeagueSeasonConfig(env, league.id, 'Season B');
      expect(cfgB.teamStructure).toBe('headcount');
      expect(cfgB.teams.map(t => t.name)).toEqual(['Tous']);
      expect(cfgB.skatersPerTeam).toBe(9);
      expect(cfgB.minSkaters).toBe(5);

      // Re-check A again AFTER B was published -- proves publishing the
      // override didn't retroactively touch the sibling season.
      const cfgAAgain = await getLeagueSeasonConfig(env, league.id, 'Season A');
      expect(cfgAAgain.teamStructure).toBe('fixed');
      expect(cfgAAgain.teams.map(t => t.name)).toEqual(['Red', 'Blue']);
    });

    it('a weekly_draw-default league\'s season overridden to headcount uses the sentinel team, not the league\'s real team names', async () => {
      const { cookie, csrfToken } = await signup('season.scoped.weekly2headcount@example.com', '203.0.116.005');
      const league = await createLeague(cookie, csrfToken, { name: 'Weekly To Headcount League', teamNames: ['Green', 'Gold'], tracksStats: true, teamStructure: 'weekly_draw' });
      const pub = await publishSeason(cookie, csrfToken, {
        season_name: 'Pickup Season', team_structure: 'headcount', min_players: 4, max_players: 8
      });
      expect(pub.status).toBe(200);
      expect(pub.json.teams).toEqual(['Tous']);
      const cfg = await getLeagueSeasonConfig(env, league.id, 'Pickup Season');
      expect(cfg.teamStructure).toBe('headcount');
      expect(cfg.teams.map(t => t.name)).toEqual(['Tous']);
    });

    it('a headcount-default league\'s season overridden to fixed is rejected when the league has no real team names on file', async () => {
      const { cookie, csrfToken } = await signup('season.scoped.headcount2fixed@example.com', '203.0.116.006');
      await createLeague(cookie, csrfToken, { name: 'Headcount To Fixed League', tracksStats: true, teamStructure: 'headcount', minPlayers: 4, maxPlayers: 8 });
      const pub = await publishSeason(cookie, csrfToken, { season_name: 'Fixed Attempt Season', team_structure: 'fixed' });
      expect(pub.status).toBe(400);
      expect(pub.json.errorKey).toBe('NO_TEAM_NAMES');
    });

    it('rejects an invalid team_structure value', async () => {
      const { cookie, csrfToken } = await signup('season.invalid.structure@example.com', '203.0.116.007');
      await createLeague(cookie, csrfToken, { name: 'Invalid Structure League', teamNames: ['A', 'B'], tracksStats: true });
      const pub = await publishSeason(cookie, csrfToken, { season_name: 'Bad Season', team_structure: 'nonsense' });
      expect(pub.status).toBe(400);
      expect(pub.json.errorKey).toBe('INVALID_TEAM_STRUCTURE');
    });

    it('overriding to headcount without min/max is rejected', async () => {
      const { cookie, csrfToken } = await signup('season.headcount.nolimits@example.com', '203.0.116.008');
      await createLeague(cookie, csrfToken, { name: 'Headcount No Limits League', teamNames: ['A', 'B'], tracksStats: true });
      const pub = await publishSeason(cookie, csrfToken, { season_name: 'No Limits Season', team_structure: 'headcount' });
      expect(pub.status).toBe(400);
      expect(pub.json.errorKey).toBe('HEADCOUNT_LIMITS_REQUIRED');
    });

    it('overriding to headcount with max < min is rejected', async () => {
      const { cookie, csrfToken } = await signup('season.headcount.badlimits@example.com', '203.0.116.009');
      await createLeague(cookie, csrfToken, { name: 'Headcount Bad Limits League', teamNames: ['A', 'B'], tracksStats: true });
      const pub = await publishSeason(cookie, csrfToken, { season_name: 'Bad Limits Season', team_structure: 'headcount', min_players: 10, max_players: 4 });
      expect(pub.status).toBe(400);
      expect(pub.json.errorKey).toBe('HEADCOUNT_MAX_TOO_LOW');
    });
  });

  describe('call site: roster page', () => {
    it('a fixed-default league\'s CURRENT season overridden to headcount hides team controls on the roster page', async () => {
      const { cookie, csrfToken } = await signup('season.roster.override@example.com', '203.0.116.010');
      await createLeague(cookie, csrfToken, { name: 'Roster Override League', teamNames: ['Otters', 'Falcons'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'Roster Override Season', team_structure: 'headcount', min_players: 5, max_players: 9 });
      const res = await SELF.fetch('http://example.com/league/roster', { headers: { cookie } });
      const html = await res.text();
      expect(html).not.toContain('id="r_team"');
      expect(html).not.toContain('data-filter="team:');
    });

    it('a fixed-default league\'s CURRENT season with no override still shows team controls on the roster page (inherited)', async () => {
      const { cookie, csrfToken } = await signup('season.roster.inherited@example.com', '203.0.116.011');
      await createLeague(cookie, csrfToken, { name: 'Roster Inherited League', teamNames: ['Otters', 'Falcons'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'Roster Inherited Season' });
      const res = await SELF.fetch('http://example.com/league/roster', { headers: { cookie } });
      const html = await res.text();
      expect(html).toContain('id="r_team"');
    });
  });

  describe('call site: event-status page + shortage detection (per-event, per-season)', () => {
    it('two events of the SAME league, on different seasons, each render per THEIR OWN season\'s structure', async () => {
      const { cookie, csrfToken } = await signup('season.events.mixed@example.com', '203.0.116.012');
      const league = await createLeague(cookie, csrfToken, { name: 'Mixed Season Events League', teamNames: ['Red', 'Blue'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'Mixed Season A' });
      const eventA = await createEvent(cookie, csrfToken, '2099-03-01', 'Mixed Season A');
      await publishSeason(cookie, csrfToken, { season_name: 'Mixed Season B', team_structure: 'headcount', min_players: 3, max_players: 7 });
      const eventB = await createEvent(cookie, csrfToken, '2099-03-08', 'Mixed Season B');

      const resA = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventA)}`, { headers: { cookie } });
      const htmlA = await resA.text();
      expect(htmlA).toContain('>Red<');
      expect(htmlA).not.toContain('data-i18n="poolTitle"');

      const resB = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventB)}`, { headers: { cookie } });
      const htmlB = await resB.text();
      expect(htmlB).toContain('data-i18n="poolTitle"');
      expect(htmlB).not.toContain('>Red<');
    });

    it('RSVP writes tag rsvp.team correctly per event\'s own season -- headcount-override event gets the sentinel, fixed-inherited event (same league, same player) gets the real team', async () => {
      const { cookie, csrfToken } = await signup('season.rsvp.write@example.com', '203.0.116.013');
      await createLeague(cookie, csrfToken, { name: 'RSVP Write Season League', teamNames: ['Red', 'Blue'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'RSVP Write Season A' });
      const eventA = await createEvent(cookie, csrfToken, '2099-03-15', 'RSVP Write Season A');
      const p1 = await addPlayer(cookie, csrfToken, 'RSVP Write Player', { team: 'Red' });

      await publishSeason(cookie, csrfToken, { season_name: 'RSVP Write Season B', team_structure: 'headcount', min_players: 2, max_players: 6 });
      const eventB = await createEvent(cookie, csrfToken, '2099-03-22', 'RSVP Write Season B');

      await setStatus(cookie, csrfToken, eventA, p1, 'in');
      await setStatus(cookie, csrfToken, eventB, p1, 'in');

      const rowA = await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventA, p1).first();
      const rowB = await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventB, p1).first();
      expect(rowA.team).toBe('Red');
      expect(rowB.team).toBe('Tous');
    });

    it('the assign-team route (weekly_draw) works for an overridden season\'s event and is rejected for a sibling non-overridden event, same league', async () => {
      const { cookie, csrfToken } = await signup('season.assignteam.override@example.com', '203.0.116.014');
      await createLeague(cookie, csrfToken, { name: 'Assign Team Override League', teamNames: ['Red', 'Blue'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'Assign Fixed Season' });
      const fixedEvent = await createEvent(cookie, csrfToken, '2099-04-01', 'Assign Fixed Season');
      const p1 = await addPlayer(cookie, csrfToken, 'Assign Team Player', { team: 'Red' });
      await setStatus(cookie, csrfToken, fixedEvent, p1, 'in');

      await publishSeason(cookie, csrfToken, { season_name: 'Assign Weekly Season', team_structure: 'weekly_draw' });
      const weeklyEvent = await createEvent(cookie, csrfToken, '2099-04-08', 'Assign Weekly Season');
      const p2 = await addPlayer(cookie, csrfToken, 'Assign Team Player Two');
      await setStatus(cookie, csrfToken, weeklyEvent, p2, 'in');

      const rejectRes = await SELF.fetch('http://example.com/league/events/assign-team', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: fixedEvent, player_id: p1, team: 'Red' })
      });
      expect(rejectRes.status).toBe(400);
      expect((await rejectRes.json()).errorKey).toBe('NOT_WEEKLY_DRAW');

      const okRes = await SELF.fetch('http://example.com/league/events/assign-team', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: weeklyEvent, player_id: p2, team: 'Red' })
      });
      expect(okRes.status).toBe(200);
      const row = await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(weeklyEvent, p2).first();
      expect(row.team).toBe('Red');
    });
  });

  describe('call site: non-responder / reminder targeting', () => {
    it('getNonResponders correctly targets a headcount-override season\'s event using role=roster, not preferred_team', async () => {
      const { cookie, csrfToken } = await signup('season.nonresponders.override@example.com', '203.0.116.015');
      const league = await createLeague(cookie, csrfToken, { name: 'Non Responders Override League', teamNames: ['Red', 'Blue'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'NR Season B', team_structure: 'headcount', min_players: 2, max_players: 6 });
      const eventB = await createEvent(cookie, csrfToken, '2099-04-15', 'NR Season B');
      const pendingId = await addPlayer(cookie, csrfToken, 'NR Pending Player', { email: 'nrpending@example.com' });

      const { getNonResponders } = await import('../src/index.js');
      const nonResponders = await getNonResponders(env, league.id, eventB, 'NR Season B');
      expect(nonResponders.map(c => c.player_id)).toContain(pendingId);
    });
  });

  describe('call site: public page', () => {
    it('the public page reflects the CURRENT season only -- headcount aggregate figure appears only while that season is current', async () => {
      const { cookie, csrfToken } = await signup('season.public.current@example.com', '203.0.116.016');
      const league = await createLeague(cookie, csrfToken, { name: 'Public Current Season League', teamNames: ['Red', 'Blue'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'Public Season A' });

      const resFixed = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`);
      const htmlFixed = await resFixed.text();
      expect(htmlFixed).toContain('>Red<');
      expect(htmlFixed).not.toContain('data-i18n="poolConfirmed"');

      // Publishing season B makes it current_season -- the public page
      // should now reflect ITS structure, not season A's. The pool
      // aggregate figure only renders in the hero section, which needs
      // a real upcoming event.
      await publishSeason(cookie, csrfToken, { season_name: 'Public Season B', team_structure: 'headcount', min_players: 2, max_players: 6 });
      await createEvent(cookie, csrfToken, '2099-05-01', 'Public Season B');
      const resHeadcount = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`);
      const htmlHeadcount = await resHeadcount.text();
      expect(htmlHeadcount).toContain('data-i18n="poolConfirmed"');
      expect(htmlHeadcount).not.toContain('<h2 data-i18n="teams">');
    });
  });
});

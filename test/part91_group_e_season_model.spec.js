// Group E (Groups A-E UI/UX polish batch): the season model.
// DECIDED (task spec): seasons stay SEQUENTIAL, never overlapping.
// Creating a season must be deliberate and separate from editing the
// current one in place (E1); the rollover moment must be a real
// confirmation before any state changes, with an offer to move a
// closing season's still-upcoming events onto the new one (E2); a
// past season stays visible but READ-ONLY, enforced at the ROUTE
// level, not merely by the UI hiding controls (E3); a closed season
// must keep exactly the configuration it had when it closed, even
// after later edits to the (new) current season or the league's own
// defaults (E4 -- "the actual underlying bug E1-E3 are the interface
// around").
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { getLeagueDataJson } from '../src/leagues.js';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part91-group-e-season-model-secret';

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
  return { status: res.status, body: await res.json() };
}
async function moveEvents(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/season/move-events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}
async function createEvent(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).event;
}
async function addContact(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).contact;
}
async function setRsvp(cookie, csrfToken, eventId, playerId, status) {
  const res = await SELF.fetch('http://example.com/league/rsvp/admin', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ event_id: eventId, player_id: playerId, status })
  });
  return res.json();
}

describe('Group E: the season model (E1-E4)', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  describe('E1: creating a season is a deliberate, separate action from renaming the current one in place', () => {
    it('rename_current:true renames the SAME season entry (same standings/games slot), and cascades to events already stamped with the old name', async () => {
      const { cookie, csrfToken } = await signup('e1.rename@example.com', '203.0.196.001');
      const league = await createLeague(cookie, csrfToken, { name: 'E1 Rename League', teamNames: ['A', 'B'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      const ev = await createEvent(cookie, csrfToken, { date: '2099-01-01', season: 'S1' });

      const { status, body } = await publishSeason(cookie, csrfToken, { season_name: 'S1 Renamed', rename_current: true });
      expect(status).toBe(200);
      expect(body.overwritten).toBe(true);

      const data = await getLeagueDataJson(env, league.id);
      expect(data.current_season).toBe('S1 Renamed');
      expect(data.seasons.length).toBe(1); // renamed in place, not a second entry
      expect(data.seasons.map(s => s.name)).not.toContain('S1');

      const row = await env.DB.prepare('SELECT season FROM events WHERE id = ?').bind(ev.id).first();
      expect(row.season).toBe('S1 Renamed'); // event follows the rename
    });

    it('a plain publish WITHOUT rename_current (the "Démarrer une nouvelle saison" flow) creates a genuinely separate season, leaving the old one intact and closed', async () => {
      const { cookie, csrfToken } = await signup('e1.create@example.com', '203.0.196.002');
      await createLeague(cookie, csrfToken, { name: 'E1 Create League', teamNames: ['A', 'B'], tracksStats: true });
      const { body: leagueBody } = await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      const leagueId = leagueBody.league_id;

      const { status, body } = await publishSeason(cookie, csrfToken, { season_name: 'S2' });
      expect(status).toBe(200);
      expect(body.overwritten).toBe(false);
      expect(body.current_season).toBe('S2');

      const data = await getLeagueDataJson(env, leagueId);
      expect(data.current_season).toBe('S2');
      expect(data.seasons.length).toBe(2);
      expect(data.seasons.map(s => s.name).sort()).toEqual(['S1', 'S2']);
    });
  });

  describe('E2: the rollover moment -- move-events route', () => {
    async function setUpClosingLeague(emailTag, ip) {
      const { cookie, csrfToken } = await signup(emailTag, ip);
      const league = await createLeague(cookie, csrfToken, { name: `E2 League ${emailTag}`, teamNames: ['A', 'B'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'Old Season' });
      const contact = await addContact(cookie, csrfToken, { name: 'Player One', role: 'roster' });
      const future1 = await createEvent(cookie, csrfToken, { date: '2099-06-01', season: 'Old Season' });
      const future2 = await createEvent(cookie, csrfToken, { date: '2099-06-08', season: 'Old Season' });
      const past = await createEvent(cookie, csrfToken, { date: '2020-01-01', season: 'Old Season' });
      await setRsvp(cookie, csrfToken, future1.id, contact.player_id, 'in');
      return { cookie, csrfToken, league, contact, future1, future2, past };
    }

    it('moves only upcoming, non-cancelled events from the closing season onto the new current one -- past events stay behind', async () => {
      const { cookie, csrfToken, league, future1, future2, past } = await setUpClosingLeague('e2.move@example.com', '203.0.196.010');
      // Close "Old Season" by publishing a new one (not a rename) --
      // matches the real client flow (season/publish, THEN move-events).
      await publishSeason(cookie, csrfToken, { season_name: 'New Season' });

      const { status, body } = await moveEvents(cookie, csrfToken, { from_season: 'Old Season', to_season: 'New Season' });
      expect(status).toBe(200);
      expect(body.moved).toBe(2);

      const rows = await env.DB.prepare('SELECT id, season FROM events WHERE league_id = ? ORDER BY id').bind(league.id).all();
      const bySeason = Object.fromEntries(rows.results.map(r => [r.id, r.season]));
      expect(bySeason[future1.id]).toBe('New Season');
      expect(bySeason[future2.id]).toBe('New Season');
      expect(bySeason[past.id]).toBe('Old Season'); // never touched
    });

    it('when the "move" checkbox is left unchecked (the route is simply never called), events stay exactly where they were', async () => {
      const { cookie, csrfToken, league, future1 } = await setUpClosingLeague('e2.stay@example.com', '203.0.196.011');
      await publishSeason(cookie, csrfToken, { season_name: 'New Season' });
      // No call to /league/season/move-events at all.
      const row = await env.DB.prepare('SELECT season FROM events WHERE id = ? AND league_id = ?').bind(future1.id, league.id).first();
      expect(row.season).toBe('Old Season');
    });

    it('a moved event carries its RSVPs intact -- status, team, and role are untouched by the move', async () => {
      const { cookie, csrfToken, league, contact, future1 } = await setUpClosingLeague('e2.rsvpintact@example.com', '203.0.196.012');
      const before = await env.DB.prepare('SELECT status, role, team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(future1.id, contact.player_id).first();
      expect(before.status).toBe('in');

      await publishSeason(cookie, csrfToken, { season_name: 'New Season' });
      await moveEvents(cookie, csrfToken, { from_season: 'Old Season', to_season: 'New Season' });

      const after = await env.DB.prepare('SELECT status, role, team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(future1.id, contact.player_id).first();
      expect(after.status).toBe('in');
      expect(after.role).toBe(before.role);
      expect(after.team).toBe(before.team);
      // Confirm this is really the SAME rsvp row (event_id-keyed, no
      // season column) surviving the move, not a coincidence.
      const rowCount = await env.DB.prepare('SELECT COUNT(*) c FROM rsvp WHERE event_id = ?').bind(future1.id).first();
      expect(rowCount.c).toBe(1);
    });

    it('to_season must be the league\'s real current season -- moving events onto a non-current (e.g. already-closed) season is rejected', async () => {
      const { cookie, csrfToken } = await setUpClosingLeague('e2.badtarget@example.com', '203.0.196.013');
      await publishSeason(cookie, csrfToken, { season_name: 'New Season' });
      const { status, body } = await moveEvents(cookie, csrfToken, { from_season: 'Old Season', to_season: 'Old Season' });
      expect(status).toBe(400); // from_season === to_season is also rejected
      expect(body.errorKey).toBe('SEASON_MOVE_SAME');

      const { status: status2, body: body2 } = await moveEvents(cookie, csrfToken, { from_season: 'New Season', to_season: 'Old Season' });
      expect(status2).toBe(409);
      expect(body2.errorKey).toBe('SEASON_MOVE_TARGET_NOT_CURRENT');
    });
  });

  describe('E3: a closed season is read-only at the ROUTE level, not only in the UI', () => {
    it('republishing an existing CLOSED season\'s own name (without rename_current) is rejected with 409 SEASON_CLOSED, and its stored config is left untouched', async () => {
      const { cookie, csrfToken } = await signup('e3.routeguard@example.com', '203.0.196.020');
      const league = await createLeague(cookie, csrfToken, { name: 'E3 League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12, tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'S1', min_players: 8, max_players: 12 });
      await publishSeason(cookie, csrfToken, { season_name: 'S2' }); // closes S1

      const before = await getLeagueDataJson(env, league.id);
      const s1ConfigBefore = before.seasons.find(s => s.name === 'S1').config;

      const { status, body } = await publishSeason(cookie, csrfToken, { season_name: 'S1', min_players: 999, max_players: 999 });
      expect(status).toBe(409);
      expect(body.errorKey).toBe('SEASON_CLOSED');

      const after = await getLeagueDataJson(env, league.id);
      expect(after.current_season).toBe('S2'); // never reopened
      const s1ConfigAfter = after.seasons.find(s => s.name === 'S1').config;
      expect(s1ConfigAfter).toEqual(s1ConfigBefore); // rejected write left it byte-for-byte the same
    });

    it('the settings page renders a closed season read-only -- disabled inputs, no save button -- when viewed via the season picker\'s ?season= param', async () => {
      const { cookie, csrfToken } = await signup('e3.uireadonly@example.com', '203.0.196.021');
      await createLeague(cookie, csrfToken, { name: 'E3 UI League', teamNames: ['A', 'B'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      await publishSeason(cookie, csrfToken, { season_name: 'S2' });

      const closedHtml = await (await SELF.fetch('http://example.com/league/settings?season=S1', { headers: { cookie } })).text();
      expect(closedHtml).toContain('data-i18n="seasonReadOnlyBanner"');
      expect(closedHtml).toMatch(/id="season_mgmt_name"[^>]*disabled/);
      expect(closedHtml).not.toContain('id="season_mgmt_submit"');
      expect(closedHtml).not.toContain('id="section-new-season"'); // no starting a season FROM a history view

      const currentHtml = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
      expect(currentHtml).not.toContain('data-i18n="seasonReadOnlyBanner"');
      expect(currentHtml).toContain('id="season_mgmt_submit"');
      expect(currentHtml).toContain('id="section-new-season"');
    });
  });

  describe('E4: a closed season keeps the configuration it had when it closed -- no leak from later edits', () => {
    it('roster limits changed via a later season/publish on the NEW current season never alter the CLOSED season\'s own stored config', async () => {
      const { cookie, csrfToken } = await signup('e4.publish@example.com', '203.0.196.030');
      const league = await createLeague(cookie, csrfToken, { name: 'E4 Publish League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12, tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'S1', min_players: 8, max_players: 12 });
      await publishSeason(cookie, csrfToken, { season_name: 'S2', min_players: 20, max_players: 30 }); // closes S1, new limits for S2

      const data = await getLeagueDataJson(env, league.id);
      const s1 = data.seasons.find(s => s.name === 'S1').config;
      const s2 = data.seasons.find(s => s.name === 'S2').config;
      expect(s1.minSkaters).toBe(8);
      expect(s1.skatersPerTeam).toBe(12);
      expect(s2.minSkaters).toBe(20);
      expect(s2.skatersPerTeam).toBe(30);
    });

    it('the settings page itself (the actual bug) shows the CLOSED season\'s own real numbers, not the league\'s current defaults, when a later edit changes them', async () => {
      const { cookie, csrfToken } = await signup('e4.display@example.com', '203.0.196.031');
      await createLeague(cookie, csrfToken, { name: 'E4 Display League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12, tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'S1', min_players: 8, max_players: 12 });
      await publishSeason(cookie, csrfToken, { season_name: 'S2', min_players: 20, max_players: 30 });

      // Change the league's own DEFAULT (for new seasons) to something
      // else again -- a third value, to prove neither the closed S1 nor
      // the current S2 read from this mutable default column.
      await SELF.fetch('http://example.com/league/settings/structure', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ team_structure: 'headcount', min_players: 50, max_players: 60 })
      });

      const closedHtml = await (await SELF.fetch('http://example.com/league/settings?season=S1', { headers: { cookie } })).text();
      expect(closedHtml).toContain('id="season_min_players" type="number" min="1" value="8"');
      expect(closedHtml).toContain('id="season_max_players" type="number" min="1" value="12"');

      const currentHtml = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
      expect(currentHtml).toContain('id="season_min_players" type="number" min="1" value="20"');
      expect(currentHtml).toContain('id="season_max_players" type="number" min="1" value="30"');
      // "Par défaut pour les nouvelles saisons" card is the ONLY one
      // showing the league-level default (50/60) -- neither season card
      // does.
      expect(currentHtml).toContain('id="se_min_players" type="number" min="1" value="50"');
      expect(currentHtml).toContain('id="se_max_players" type="number" min="1" value="60"');
    });
  });
});

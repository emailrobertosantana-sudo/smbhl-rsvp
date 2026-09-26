// Part 5 of a live-testing task: for headcount leagues where sport_type
// is 'hockey' (all of them today -- Part 4's own foundation), add a
// second, independent Goalie/Player axis alongside the existing
// Regular/Sub one, and a minimum goalie count alongside the existing
// overall min/max players -- reusing the exact same per-role shortage
// machinery already built for fixed-team mode (config.goaliesPerTeam),
// adapted to headcount's single implicit pool instead of per-team.
// CRITICAL: every league (including every one created before this
// task) with min_goalies=0 (the default) must behave exactly as
// before -- no goalie requirement at all.
import { env, SELF } from 'cloudflare:test';
import { getLeagueSeasonConfig } from '../src/leagues.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part23-goalie-minimum-secret';

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
  const league = (await res.json()).league;
  await SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ season_name: `${body.name} Season` })
  });
  return league;
}
async function addPlayer(cookie, csrfToken, name, extra = {}) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, ...extra })
  });
  return (await res.json()).contact;
}
async function createEvent(cookie, csrfToken, date) {
  return (await (await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ date })
  })).json()).event.id;
}
async function setStatus(cookie, csrfToken, eventId, playerId, status) {
  return SELF.fetch('http://example.com/league/rsvp/admin', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ event_id: eventId, player_id: playerId, status })
  });
}

describe('Live-testing Part 5: headcount goalie minimum, independent Goalie/Player axis', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  describe('min_goalies omitted at creation: defaults to 1, not a silent 0 (4c)', () => {
    it('a headcount league created with no minGoalies at all gets min_goalies=1 in the DB', async () => {
      const { cookie, csrfToken } = await signup('goalie.omitted@example.com', '203.0.126.010');
      const res = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Goalie Omitted League', tracksStats: true, teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10 })
      });
      const json = await res.json();
      expect(json.league.minGoalies).toBe(1);
      const row = await env.DB.prepare('SELECT min_goalies FROM leagues WHERE id = ?').bind(json.league.id).first();
      expect(row.min_goalies).toBe(1);
    });
  });

  describe('min_goalies = 0 (explicit): a real, honored "no requirement" choice', () => {
    // Small-outstanding-items task (4c): the creation-time default
    // changed from a silent 0 to 1 (see handleLeagueCreate's own
    // comment) -- omitting minGoalies is covered by its own describe
    // block below now. These three tests keep testing what they always
    // tested (0 really means "no requirement", not a placeholder) by
    // sending minGoalies: 0 explicitly instead of relying on omission.
    it('a headcount league created with an explicit minGoalies: 0 gets min_goalies=0 in the DB', async () => {
      const { cookie, csrfToken } = await signup('goalie.default@example.com', '203.0.126.001');
      const res = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Goalie Default League', tracksStats: true, teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10, minGoalies: 0 })
      });
      const json = await res.json();
      expect(json.league.minGoalies).toBe(0);
      const row = await env.DB.prepare('SELECT min_goalies FROM leagues WHERE id = ?').bind(json.league.id).first();
      expect(row.min_goalies).toBe(0);
    });

    it('with min_goalies=0, the season config resolves goaliesPerTeam=0, not the generic default of 1', async () => {
      const { cookie, csrfToken } = await signup('goalie.default.cfg@example.com', '203.0.126.002');
      const league = await createLeague(cookie, csrfToken, { name: 'Goalie Default Cfg League', tracksStats: true, teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10, minGoalies: 0 });
      const cfg = await getLeagueSeasonConfig(env, league.id);
      expect(cfg.goaliesPerTeam).toBe(0);
    });

    it('the event-status page and public page show NO goalie stat line at all when min_goalies=0', async () => {
      const { cookie, csrfToken } = await signup('goalie.default.ui@example.com', '203.0.126.003');
      const league = await createLeague(cookie, csrfToken, { name: 'Goalie Default UI League', tracksStats: true, teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10, minGoalies: 0 });
      const eventId = await createEvent(cookie, csrfToken, '2099-11-01');
      const p1 = await addPlayer(cookie, csrfToken, 'Goalie Default UI Player');
      await setStatus(cookie, csrfToken, eventId, p1.player_id, 'in');

      const statusHtml = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } })).text();
      expect(statusHtml).not.toContain('data-i18n="poolGoalies"');

      const publicHtml = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
      expect(publicHtml).not.toContain('data-i18n="poolGoalies"');
    });

    // Superseded by a later live-testing task (Part 5 follow-up, see
    // part28_sport_capability_goalie_flag.spec.js): the goalie axis is
    // now available for 'fixed'/'weekly_draw' too, driven by the
    // sport's own capability rather than team_structure -- a fixed-mode
    // hockey league DOES show it now (for role 'roster'; a sub's
    // goalie-ness is still the existing sub_goalie/sub_skater role
    // choice). This test now confirms that positive case instead.
    it('the roster page shows the Goalie/Player axis for a fixed-mode hockey league too (sport capability, not team_structure)', async () => {
      const { cookie, csrfToken } = await signup('goalie.fixed.axis@example.com', '203.0.126.004');
      await createLeague(cookie, csrfToken, { name: 'Goalie Fixed Axis League', teamNames: ['A', 'B'], tracksStats: true });
      const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
      expect(html).toContain('id="r_goalie_radio"');
      expect(html).toContain('data-i18n="goalieAxis"');
    });
  });

  describe('a real min_goalies set: both thresholds enforced', () => {
    it('the roster page shows the independent Goalie/Player axis for a headcount+hockey league', async () => {
      const { cookie, csrfToken } = await signup('goalie.axis.roster@example.com', '203.0.126.005');
      await createLeague(cookie, csrfToken, { name: 'Goalie Axis Roster League', tracksStats: true, teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10, minGoalies: 1 });
      const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
      expect(html).toContain('id="r_goalie_radio"');
      expect(html).toContain('data-i18n="goalieAxis"');
      expect(html).toContain('data-i18n="axisPlayer"');
      expect(html).toContain('data-i18n="axisGoalie"');
      // Neutral terminology -- never "Skater"/"skater" as actual VISIBLE
      // text in this headcount-mode UI (Part 5's own explicit
      // requirement) -- checked against rendered text content, not
      // internal attribute values/enum strings like data-value=
      // "sub_skater" (the role radio's own real, unrelated value,
      // shared with fixed/weekly_draw's role scheme, never shown as
      // text for headcount -- see roleSub's own "Remplaçant" label).
      const htmlNoScripts = html.replace(/<script[\s\S]*?<\/script>/g, '');
      const visibleText = (htmlNoScripts.match(/>([^<]*)</g) || []).join(' ').toLowerCase();
      expect(visibleText).not.toContain('skater');
      expect(visibleText).not.toContain('patineur');
    });

    it('adding players covers all 4 real combinations: regular-goalie, regular-player, sub-goalie, sub-player', async () => {
      const { cookie, csrfToken } = await signup('goalie.axis.combos@example.com', '203.0.126.006');
      await createLeague(cookie, csrfToken, { name: 'Goalie Axis Combos League', tracksStats: true, teamStructure: 'headcount', minPlayers: 4, maxPlayers: 10, minGoalies: 1 });

      const regGoalie = await addPlayer(cookie, csrfToken, 'Regular Goalie', { role: 'roster', is_goalie: true });
      const regPlayer = await addPlayer(cookie, csrfToken, 'Regular Player', { role: 'roster', is_goalie: false });
      const subGoalie = await addPlayer(cookie, csrfToken, 'Sub Goalie', { role: 'sub_skater', is_goalie: true });
      const subPlayer = await addPlayer(cookie, csrfToken, 'Sub Player', { role: 'sub_skater', is_goalie: false });

      const rows = await env.DB.prepare('SELECT player_id, role, is_goalie FROM contacts WHERE league_id = (SELECT league_id FROM contacts WHERE player_id = ?) ORDER BY name').bind(regGoalie.player_id).all();
      const byId = Object.fromEntries(rows.results.map(r => [r.player_id, r]));
      expect(byId[regGoalie.player_id].role).toBe('roster');
      expect(byId[regGoalie.player_id].is_goalie).toBe(1);
      expect(byId[regPlayer.player_id].role).toBe('roster');
      expect(byId[regPlayer.player_id].is_goalie).toBe(0);
      expect(byId[subGoalie.player_id].role).toBe('sub_skater');
      expect(byId[subGoalie.player_id].is_goalie).toBe(1);
      expect(byId[subPlayer.player_id].role).toBe('sub_skater');
      expect(byId[subPlayer.player_id].is_goalie).toBe(0);
    });

    it('omitting is_goalie defaults to false (a regular player, not a goalie)', async () => {
      const { cookie, csrfToken } = await signup('goalie.axis.omit@example.com', '203.0.126.007');
      await createLeague(cookie, csrfToken, { name: 'Goalie Axis Omit League', tracksStats: true, teamStructure: 'headcount', minPlayers: 4, maxPlayers: 10, minGoalies: 1 });
      const p = await addPlayer(cookie, csrfToken, 'Omit Goalie Field Player');
      const row = await env.DB.prepare('SELECT is_goalie FROM contacts WHERE player_id = ?').bind(p.player_id).first();
      expect(row.is_goalie).toBe(0);
    });

    it('the season config resolves goaliesPerTeam to the real min_goalies value', async () => {
      const { cookie, csrfToken } = await signup('goalie.cfg.real@example.com', '203.0.126.008');
      const league = await createLeague(cookie, csrfToken, { name: 'Goalie Cfg Real League', tracksStats: true, teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10, minGoalies: 2 });
      const cfg = await getLeagueSeasonConfig(env, league.id);
      expect(cfg.goaliesPerTeam).toBe(2);
      expect(cfg.skatersPerTeam).toBe(10);
      expect(cfg.minSkaters).toBe(6);
    });

    it('the event-status page shows "N/M goalies confirmed" only when min_goalies > 0, alongside the existing overall count', async () => {
      const { cookie, csrfToken } = await signup('goalie.eventstatus@example.com', '203.0.126.009');
      await createLeague(cookie, csrfToken, { name: 'Goalie Event Status League', tracksStats: true, teamStructure: 'headcount', minPlayers: 4, maxPlayers: 10, minGoalies: 1 });
      const eventId = await createEvent(cookie, csrfToken, '2099-11-08');
      const goalie = await addPlayer(cookie, csrfToken, 'Event Status Goalie', { is_goalie: true });
      const player = await addPlayer(cookie, csrfToken, 'Event Status Player');
      await setStatus(cookie, csrfToken, eventId, goalie.player_id, 'in');
      await setStatus(cookie, csrfToken, eventId, player.player_id, 'in');

      const html = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } })).text();
      expect(html).toContain('data-i18n="poolGoalies"');
      expect(html).toContain('<span class="stat tnum">1/1</span>');
    });

    it('the public page shows the goalie figure only when min_goalies > 0', async () => {
      const { cookie, csrfToken } = await signup('goalie.public@example.com', '203.0.126.010');
      const league = await createLeague(cookie, csrfToken, { name: 'Goalie Public League', tracksStats: true, teamStructure: 'headcount', minPlayers: 4, maxPlayers: 10, minGoalies: 1 });
      const eventId = await createEvent(cookie, csrfToken, '2099-11-15');
      const goalie = await addPlayer(cookie, csrfToken, 'Public Goalie', { is_goalie: true });
      await setStatus(cookie, csrfToken, eventId, goalie.player_id, 'in');

      const html = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
      expect(html).toContain('data-i18n="poolGoalies"');
      expect(html).toContain('<span class="tnum">1</span><span>/1</span>');
    });

    it('a goalie going OUT and dropping below min_goalies triggers a real goalie-specific sub-invite', async () => {
      const { cookie, csrfToken } = await signup('goalie.shortage@example.com', '203.0.126.011');
      await createLeague(cookie, csrfToken, { name: 'Goalie Shortage League', tracksStats: true, teamStructure: 'headcount', minPlayers: 2, maxPlayers: 10, minGoalies: 1 });
      const eventId = await createEvent(cookie, csrfToken, '2099-11-22');
      const goalie = await addPlayer(cookie, csrfToken, 'Shortage Goalie', { is_goalie: true, email: 'shortagegoalie@example.com' });
      const player = await addPlayer(cookie, csrfToken, 'Shortage Filler Player', { email: 'shortagefiller@example.com' });
      // A sub goalie, eligible to be invited when the goalie-specific
      // shortage fires.
      await addPlayer(cookie, csrfToken, 'Shortage Sub Goalie', { role: 'sub_skater', is_goalie: true, email: 'shortagesubgoalie@example.com' });

      await setStatus(cookie, csrfToken, eventId, goalie.player_id, 'in');
      await setStatus(cookie, csrfToken, eventId, player.player_id, 'in');
      // Overall pool still has 1 confirmed (player) after this, well
      // above nothing, but the GOALIE-specific minimum (1) is now
      // unmet -- proves the goalie axis is checked independently of
      // the overall count.
      await setStatus(cookie, csrfToken, eventId, goalie.player_id, 'out');

      const subCallRow = await env.DB.prepare(`SELECT * FROM outbox WHERE event_id = ? AND kind = 'sub_call'`).bind(eventId).first();
      expect(subCallRow).toBeTruthy();
      expect(JSON.parse(subCallRow.payload).need).toBe('goalie');
    });

    it('the manual "Inviter" button (POST /league/events/invite-subs) also correctly finds a headcount goalie sub -- not the old role=sub_goalie filter, which would find zero', async () => {
      const { cookie, csrfToken } = await signup('goalie.manualinvite@example.com', '203.0.126.0125');
      await createLeague(cookie, csrfToken, { name: 'Goalie Manual Invite League', tracksStats: true, teamStructure: 'headcount', minPlayers: 2, maxPlayers: 10, minGoalies: 1 });
      const eventId = await createEvent(cookie, csrfToken, '2099-11-29');
      // A real, eligible headcount goalie sub -- role='sub_skater' (headcount
      // subs never get role='sub_goalie'), is_goalie=true.
      await addPlayer(cookie, csrfToken, 'Manual Invite Sub Goalie', { role: 'sub_skater', is_goalie: true, email: 'manualinvitesubgoalie@example.com' });

      const res = await SELF.fetch('http://example.com/league/events/invite-subs', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, team: 'Tous', need: 'goalie' })
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.invited).toBe(1);
    });

    it('an explicit override to headcount at season-publish time also carries min_goalies through', async () => {
      const { cookie, csrfToken } = await signup('goalie.override@example.com', '203.0.126.012');
      const league = await createLeague(cookie, csrfToken, { name: 'Goalie Override League', teamNames: ['A', 'B'], tracksStats: true });
      const res = await SELF.fetch('http://example.com/league/season/publish', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ season_name: 'Goalie Override Season', team_structure: 'headcount', min_players: 4, max_players: 8, min_goalies: 1 })
      });
      expect(res.status).toBe(200);
      const cfg = await getLeagueSeasonConfig(env, league.id, 'Goalie Override Season');
      expect(cfg.goaliesPerTeam).toBe(1);
    });
  });

  describe('fixed and weekly_draw leagues: completely unaffected', () => {
    it('a fixed-mode league\'s season config is unaffected by any of this (goaliesPerTeam stays the generic default)', async () => {
      const { cookie, csrfToken } = await signup('goalie.fixed.unaffected@example.com', '203.0.126.013');
      const league = await createLeague(cookie, csrfToken, { name: 'Goalie Fixed Unaffected League', teamNames: ['Red', 'Blue'], tracksStats: true });
      const cfg = await getLeagueSeasonConfig(env, league.id);
      expect(cfg.goaliesPerTeam).toBe(1); // DEFAULT_SEASON_CONFIG's own generic default, unchanged
    });

    it("SMBHL's own season config is completely unaffected", async () => {
      const { getSeasonConfig } = await import('../src/season_config.js');
      const cfg = getSeasonConfig(undefined);
      expect(cfg.goaliesPerTeam).toBe(1);
      expect(cfg.sportType).toBe('hockey');
      expect(cfg.teamStructure).toBe('fixed');
    });
  });
});

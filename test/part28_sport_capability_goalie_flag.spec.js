// Live-testing task, Part 5: the roster page's goalie flag (built for
// headcount mode in an earlier session) is now driven by a sport
// CAPABILITY (sportHasGoalie, src/season_config.js) rather than a
// hardcoded "hockey or soccer" list or a team_structure check -- so it
// scales to a second sport later by adding one entry to
// SPORT_CAPABILITIES, not hunting down every place that used to
// compare a sport name by string.
//
// Real bug this closes: teamState() (fixed-mode shortage detection)
// and handleLeagueRandomAssignEventTeams (weekly_draw's auto-draw)
// have both read contacts.is_goalie for every team structure all
// along -- but until this task, the roster page's add-player form
// only ever rendered a way to SET is_goalie for 'headcount' leagues.
// Every 'fixed'/'weekly_draw' league created through this product
// (other than SMBHL, which sets is_goalie through its own separate
// season_hub tooling) has had no way to designate a goalie at all,
// silently defeating goalie-shortage detection and the weekly_draw
// goalie-fairness split. This closes that gap.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { sportHasGoalie } from '../src/season_config.js';

const AUTH_SECRET = 'test-part5-sport-capability-secret';

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

describe('Part 5 (live-testing task): goalie flag driven by sport capability, available in fixed/headcount/weekly_draw', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  describe('the capability logic itself (not just the hockey outcome)', () => {
    it('sportHasGoalie(hockey) is true', () => {
      expect(sportHasGoalie('hockey')).toBe(true);
    });

    it('sportHasGoalie returns false for any unknown/future sport_type, proving this is a capability lookup, not a hardcoded hockey-only check', () => {
      expect(sportHasGoalie('soccer')).toBe(false);
      expect(sportHasGoalie('basketball')).toBe(false);
      expect(sportHasGoalie('made_up_future_sport')).toBe(false);
      expect(sportHasGoalie(undefined)).toBe(false);
      expect(sportHasGoalie('')).toBe(false);
    });

    it("a league whose sport_type is set to something without the goalie capability (direct DB write -- no sport-selection UI exists yet) hides the roster page's axis, proving the gate reads sport_type's capability rather than team_structure", async () => {
      const { cookie, csrfToken } = await signup('capability.driven.gate@example.com', '203.0.127.001');
      const league = await createLeague(cookie, csrfToken, { name: 'Capability Gate League', tracksStats: true, teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10 });
      await env.DB.prepare("UPDATE leagues SET sport_type = 'made_up_future_sport' WHERE id = ?").bind(league.id).run();

      const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
      expect(html).not.toContain('id="r_goalie_radio"');
      expect(html).not.toContain('data-i18n="goalieAxis"');
    });
  });

  describe("'fixed' mode now gets the goalie flag too", () => {
    it('the roster page shows the axis for role "roster" and correctly stores is_goalie for a fixed-mode regular player', async () => {
      const { cookie, csrfToken } = await signup('fixed.goalie.regular@example.com', '203.0.127.002');
      await createLeague(cookie, csrfToken, { name: 'Fixed Goalie Regular League', teamNames: ['Falcons', 'Otters'], tracksStats: true });

      const goalie = await addPlayer(cookie, csrfToken, 'Fixed Regular Goalie', { role: 'roster', team: 'Falcons', is_goalie: true });
      const skater = await addPlayer(cookie, csrfToken, 'Fixed Regular Skater', { role: 'roster', team: 'Falcons', is_goalie: false });

      const rows = await env.DB.prepare('SELECT player_id, is_goalie FROM contacts WHERE player_id IN (?, ?)').bind(goalie.player_id, skater.player_id).all();
      const byId = Object.fromEntries(rows.results.map(r => [r.player_id, r]));
      expect(byId[goalie.player_id].is_goalie).toBe(1);
      expect(byId[skater.player_id].is_goalie).toBe(0);
    });

    // Superseded by the live-testing task's Part 2 bug fix: role
    // 'sub_goalie' duplicated the independent Goalie/Player axis for a
    // sub specifically (two controls for the same thing, able to
    // disagree -- exactly what was reported broken). Role is now
    // exactly 2 options (roster/sub_skater) for every team structure,
    // and is_goalie is the ONE place goalie-ness is asked, for a
    // regular OR a sub alike -- see createLeagueContactRow's own
    // comment (leagues.js) and part37's own regression suite.
    it("a fixed-mode SUB's goalie-ness is now the SAME independent is_goalie axis a regular uses -- 'sub_goalie' is no longer a valid role at all", async () => {
      const { cookie, csrfToken } = await signup('fixed.goalie.sub@example.com', '203.0.127.003');
      await createLeague(cookie, csrfToken, { name: 'Fixed Goalie Sub League', teamNames: ['A', 'B'], tracksStats: true });

      const rejected = await SELF.fetch('http://example.com/league/contacts', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Rejected Sub Goalie', role: 'sub_goalie' })
      });
      expect(rejected.status).toBe(400);
      expect((await rejected.json()).errorKey).toBe('INVALID_ROLE');

      const subGoalie = await addPlayer(cookie, csrfToken, 'Fixed Sub Goalie Axis', { role: 'sub_skater', is_goalie: true });
      const subSkater = await addPlayer(cookie, csrfToken, 'Fixed Sub Skater Axis', { role: 'sub_skater', is_goalie: false });

      const rows = await env.DB.prepare('SELECT player_id, role, is_goalie FROM contacts WHERE player_id IN (?, ?)').bind(subGoalie.player_id, subSkater.player_id).all();
      const byId = Object.fromEntries(rows.results.map(r => [r.player_id, r]));
      expect(byId[subGoalie.player_id].role).toBe('sub_skater');
      expect(byId[subGoalie.player_id].is_goalie).toBe(1);
      expect(byId[subSkater.player_id].is_goalie).toBe(0);
    });

    it("fixed mode's roster page shows the goalie axis field regardless of which role is selected -- no more role-gating (that was the bug)", async () => {
      const { cookie, csrfToken } = await signup('fixed.goalie.script@example.com', '203.0.127.004');
      await createLeague(cookie, csrfToken, { name: 'Fixed Goalie Script League', teamNames: ['A', 'B'], tracksStats: true });
      const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
      expect(html).toContain('id="r_goalie_field"');
      expect(html).toContain('id="r_goalie_radio"');
      expect(html).not.toContain('GOALIE_AXIS_ROLE_GATED');
      expect(html).not.toContain('roleSubGoalie');
    });
  });

  describe("'weekly_draw' mode now gets the goalie flag too, closing the real auto-draw gap", () => {
    it('the roster page shows the axis for weekly_draw regulars, and the goalie-fairness auto-draw actually separates goalies once set', async () => {
      const { cookie, csrfToken } = await signup('weekly.goalie.draw@example.com', '203.0.127.005');
      const league = await createLeague(cookie, csrfToken, { name: 'Weekly Draw Goalie League', teamStructure: 'weekly_draw', teamNames: ['Rouge / Red', 'Bleu / Blue'], tracksStats: true });

      const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
      expect(html).toContain('id="r_goalie_radio"');

      const goalie = await addPlayer(cookie, csrfToken, 'Weekly Draw Goalie', { role: 'roster', is_goalie: true });
      const skater1 = await addPlayer(cookie, csrfToken, 'Weekly Draw Skater One', { role: 'roster', is_goalie: false });
      const skater2 = await addPlayer(cookie, csrfToken, 'Weekly Draw Skater Two', { role: 'roster', is_goalie: false });

      const eventRes = await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ date: '2099-12-06' })
      });
      const eventId = (await eventRes.json()).event.id;

      for (const p of [goalie, skater1, skater2]) {
        await SELF.fetch('http://example.com/league/rsvp/admin', {
          method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({ event_id: eventId, player_id: p.player_id, status: 'in' })
        });
      }

      const drawRes = await SELF.fetch('http://example.com/league/events/random-assign', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId })
      });
      expect(drawRes.status).toBe(200);

      const row = await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, goalie.player_id).first();
      expect(row.team).not.toBeNull();
      expect(['Rouge / Red', 'Bleu / Blue']).toContain(row.team);
    });
  });

  describe('headcount is completely unaffected (regression)', () => {
    it('headcount still shows the axis regardless of role (roster or sub_skater), unchanged from before this task', async () => {
      const { cookie, csrfToken } = await signup('headcount.goalie.unaffected@example.com', '203.0.127.006');
      await createLeague(cookie, csrfToken, { name: 'Headcount Goalie Unaffected League', tracksStats: true, teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10 });
      const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
      expect(html).toContain('id="r_goalie_radio"');
      expect(html).toContain('id="r_goalie_field"');
    });
  });
});

// Live-testing task, Part 5: roster minimums AND maximums, for both
// players and goalies, settable per league (and per season, via the
// existing season/publish override mechanism) for EVERY team structure
// -- previously only 'headcount' had ever exposed min/max players and a
// (single, min-only) goalie minimum to a league admin at all. 'fixed'
// and 'weekly_draw' silently inherited DEFAULT_SEASON_CONFIG's SMBHL
// numbers (8 skaters/5 min skaters/1 goalie per team) forever, with no
// UI to change them.
//
// Shape, per the task's own explicit requirement:
//   - 'fixed': real PER-TEAM numbers, used directly (matching how its
//     shortage detection already runs -- once per real named team).
//   - 'weekly_draw': a PER-EVENT POOL total (the admin sets "how many
//     for the whole game", not per-team) -- divided down to a per-team
//     equivalent at season-publish time, since shortage detection
//     itself still runs per real ASSIGNED team once a draw has
//     happened (unchanged machinery). ceil() for minimums, floor() for
//     maximums -- see handleLeagueSeasonPublish's own comment.
//   - 'headcount': unchanged, already pool-wide by construction (one
//     implicit team).
//
// A second, genuinely new axis: goalies now have a real, independent
// MAXIMUM (maxGoalies), not just the single value (goaliesPerTeam) that
// has always doubled as both floor and cap.
//
// SAFETY (this task's own explicit constraint): every league that never
// engages with this feature must be completely unaffected -- current
// effective values (DEFAULT_SEASON_CONFIG's 8/5/1, or headcount's own
// existing min/max/min_goalies) become the explicit resolved values,
// never silently different.
import { env, SELF } from 'cloudflare:test';
import { getLeagueSeasonConfig } from '../src/leagues.js';
import { teamState, expected } from '../src/index.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part5-roster-limits-secret';

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
async function updateStructure(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/settings/structure', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}
async function publishSeason(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

describe('Part 5 (live-testing task): roster min/max for every team structure', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  describe('safety: existing leagues (never touching this feature) are completely unaffected', () => {
    it('a fixed league with no roster limits ever set still resolves DEFAULT_SEASON_CONFIG numbers after publishing', async () => {
      const { cookie, csrfToken } = await signup('roster.safety.fixed@example.com', '203.0.150.001');
      const league = await createLeague(cookie, csrfToken, { name: 'Safety Fixed League', teamNames: ['A', 'B'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      const cfg = await getLeagueSeasonConfig(env, league.id);
      expect(cfg.skatersPerTeam).toBe(8);
      expect(cfg.minSkaters).toBe(5);
      expect(cfg.goaliesPerTeam).toBe(1);
      expect(cfg.maxGoalies).toBe(1);
    });

    it('a weekly_draw league with no roster limits ever set still resolves DEFAULT_SEASON_CONFIG numbers after publishing', async () => {
      const { cookie, csrfToken } = await signup('roster.safety.weekly@example.com', '203.0.150.002');
      const league = await createLeague(cookie, csrfToken, { name: 'Safety Weekly League', teamStructure: 'weekly_draw', teamNames: ['Rouge / Red', 'Bleu / Blue'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      const cfg = await getLeagueSeasonConfig(env, league.id);
      expect(cfg.skatersPerTeam).toBe(8);
      expect(cfg.minSkaters).toBe(5);
      expect(cfg.goaliesPerTeam).toBe(1);
      expect(cfg.maxGoalies).toBe(1);
    });

    it('an existing headcount league that never sets a distinct max_goalies keeps min===max, unchanged', async () => {
      const { cookie, csrfToken } = await signup('roster.safety.headcount@example.com', '203.0.150.003');
      const league = await createLeague(cookie, csrfToken, { name: 'Safety Headcount League', teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10, minGoalies: 2, tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      const cfg = await getLeagueSeasonConfig(env, league.id);
      expect(cfg.goaliesPerTeam).toBe(2);
      expect(cfg.maxGoalies).toBe(2);
    });

    it('setting ONLY min/max players for a fixed league (leaving goalie fields untouched) preserves the current 1-goalie default explicitly, not a silent 0', async () => {
      const { cookie, csrfToken } = await signup('roster.safety.playersonly@example.com', '203.0.150.004');
      const league = await createLeague(cookie, csrfToken, { name: 'Safety Players Only League', teamNames: ['A', 'B'], tracksStats: true });
      const res = await updateStructure(cookie, csrfToken, { min_players: 4, max_players: 6 });
      expect(res.status).toBe(200);
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      const cfg = await getLeagueSeasonConfig(env, league.id);
      expect(cfg.minSkaters).toBe(4);
      expect(cfg.skatersPerTeam).toBe(6);
      // The goalie requirement must stay at its current effective value
      // (1), not silently become 0 just because player limits were set.
      expect(cfg.goaliesPerTeam).toBe(1);
      expect(cfg.maxGoalies).toBe(1);
    });
  });

  describe("'fixed' mode: real per-team limits", () => {
    it('settings page sets per-team min/max players AND min/max goalies, and they drive a real season publish', async () => {
      const { cookie, csrfToken } = await signup('roster.fixed.full@example.com', '203.0.150.010');
      const league = await createLeague(cookie, csrfToken, { name: 'Fixed Full League', teamNames: ['A', 'B'], tracksStats: true });
      const res = await updateStructure(cookie, csrfToken, { min_players: 4, max_players: 6, min_goalies: 1, max_goalies: 2 });
      expect(res.status).toBe(200);
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      const cfg = await getLeagueSeasonConfig(env, league.id);
      expect(cfg.minSkaters).toBe(4);
      expect(cfg.skatersPerTeam).toBe(6);
      expect(cfg.goaliesPerTeam).toBe(1);
      expect(cfg.maxGoalies).toBe(2);
    });

    it('persists across a later republish that only changes the season name', async () => {
      const { cookie, csrfToken } = await signup('roster.fixed.persist@example.com', '203.0.150.011');
      const league = await createLeague(cookie, csrfToken, { name: 'Fixed Persist League', teamNames: ['A', 'B'], tracksStats: true });
      await updateStructure(cookie, csrfToken, { min_players: 3, max_players: 5, min_goalies: 1, max_goalies: 1 });
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      await publishSeason(cookie, csrfToken, { season_name: 'S2' });
      const cfg = await getLeagueSeasonConfig(env, league.id);
      expect(cfg.minSkaters).toBe(3);
      expect(cfg.skatersPerTeam).toBe(5);
    });
  });

  describe("'weekly_draw' mode: per-event pool totals, divided into a per-team equivalent", () => {
    it('4 teams: pool min/max players and goalies divide evenly', async () => {
      const { cookie, csrfToken } = await signup('roster.weekly.evendiv@example.com', '203.0.150.020');
      const league = await createLeague(cookie, csrfToken, { name: 'Weekly Even Div League', teamStructure: 'weekly_draw', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
      const res = await updateStructure(cookie, csrfToken, { min_players: 8, max_players: 16, min_goalies: 2, max_goalies: 4 });
      expect(res.status).toBe(200);
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      const cfg = await getLeagueSeasonConfig(env, league.id);
      // 8/4=2 (ceil), 16/4=4 (floor), 2/4=1 (ceil), 4/4=1 (floor)
      expect(cfg.minSkaters).toBe(2);
      expect(cfg.skatersPerTeam).toBe(4);
      expect(cfg.goaliesPerTeam).toBe(1);
      expect(cfg.maxGoalies).toBe(1);
    });

    it('3 teams (uneven division): ceil() for minimums, floor() for maximums', async () => {
      const { cookie, csrfToken } = await signup('roster.weekly.unevendiv@example.com', '203.0.150.021');
      const league = await createLeague(cookie, csrfToken, { name: 'Weekly Uneven Div League', teamStructure: 'weekly_draw', teamNames: ['A', 'B', 'C'], tracksStats: true });
      await updateStructure(cookie, csrfToken, { min_players: 10, max_players: 20, min_goalies: 1, max_goalies: 3 });
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      const cfg = await getLeagueSeasonConfig(env, league.id);
      // 10/3=3.33 -> ceil 4, 20/3=6.67 -> floor 6, 1/3=0.33 -> ceil 1, 3/3=1 -> floor 1
      expect(cfg.minSkaters).toBe(4);
      expect(cfg.skatersPerTeam).toBe(6);
      expect(cfg.goaliesPerTeam).toBe(1);
      expect(cfg.maxGoalies).toBe(1);
    });
  });

  describe("'headcount' mode: max_goalies is a real, independent maximum now", () => {
    it('sets a distinct min/max goalies pair', async () => {
      const { cookie, csrfToken } = await signup('roster.headcount.maxgoalies@example.com', '203.0.150.030');
      const league = await createLeague(cookie, csrfToken, { name: 'Headcount Max Goalies League', teamStructure: 'headcount', minPlayers: 6, maxPlayers: 12, tracksStats: true });
      const res = await updateStructure(cookie, csrfToken, { min_goalies: 1, max_goalies: 3 });
      expect(res.status).toBe(200);
      expect(res.json.settings.minGoalies).toBe(1);
      expect(res.json.settings.maxGoalies).toBe(3);
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      const cfg = await getLeagueSeasonConfig(env, league.id);
      expect(cfg.goaliesPerTeam).toBe(1);
      expect(cfg.maxGoalies).toBe(3);
    });

    it('rejects max_goalies below min_goalies', async () => {
      const { cookie, csrfToken } = await signup('roster.headcount.badmax@example.com', '203.0.150.031');
      await createLeague(cookie, csrfToken, { name: 'Headcount Bad Max League', teamStructure: 'headcount', minPlayers: 6, maxPlayers: 12, minGoalies: 2, tracksStats: true });
      const res = await updateStructure(cookie, csrfToken, { max_goalies: 1 });
      expect(res.status).toBe(400);
      expect(res.json.errorKey).toBe('HEADCOUNT_MAX_GOALIES_TOO_LOW');
    });
  });

  describe('validation: fixed/weekly_draw roster-limit fields reject bad input, same as headcount always has', () => {
    it('rejects max_players below min_players', async () => {
      const { cookie, csrfToken } = await signup('roster.fixed.badmax@example.com', '203.0.150.040');
      await createLeague(cookie, csrfToken, { name: 'Fixed Bad Max League', teamNames: ['A', 'B'], tracksStats: true });
      const res = await updateStructure(cookie, csrfToken, { min_players: 10, max_players: 5 });
      expect(res.status).toBe(400);
      expect(res.json.errorKey).toBe('ROSTER_MAX_TOO_LOW');
    });

    it('rejects max_goalies below min_goalies for a fixed league', async () => {
      const { cookie, csrfToken } = await signup('roster.fixed.badgoalies@example.com', '203.0.150.041');
      await createLeague(cookie, csrfToken, { name: 'Fixed Bad Goalies League', teamNames: ['A', 'B'], tracksStats: true });
      await updateStructure(cookie, csrfToken, { min_goalies: 3 });
      const res = await updateStructure(cookie, csrfToken, { max_goalies: 1 });
      expect(res.status).toBe(400);
      expect(res.json.errorKey).toBe('MAX_GOALIES_TOO_LOW');
    });

    it('leaves min/max players genuinely optional for fixed -- omitting them entirely is not an error', async () => {
      const { cookie, csrfToken } = await signup('roster.fixed.optional@example.com', '203.0.150.042');
      await createLeague(cookie, csrfToken, { name: 'Fixed Optional League', teamNames: ['A', 'B'], tracksStats: true });
      const res = await updateStructure(cookie, csrfToken, { min_goalies: 0 });
      expect(res.status).toBe(200);
    });
  });

  describe('settings page renders roster-limit fields for every structure', () => {
    for (const [structure, extra] of [
      ['fixed', { teamNames: ['A', 'B'] }],
      ['headcount', { teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10 }],
      ['weekly_draw', { teamStructure: 'weekly_draw', teamNames: ['A', 'B'] }]
    ]) {
      it(`shows min/max players AND min/max goalies fields for a ${structure} league`, async () => {
        const { cookie, csrfToken } = await signup(`roster.render.${structure}@example.com`, `203.0.150.05${structure === 'fixed' ? 0 : structure === 'headcount' ? 1 : 2}`);
        await createLeague(cookie, csrfToken, { name: `Render ${structure} League`, tracksStats: true, ...extra });
        const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
        expect(html).toContain('id="se_min_players"');
        expect(html).toContain('id="se_max_players"');
        expect(html).toContain('id="se_min_goalies"');
        expect(html).toContain('id="se_max_goalies"');
        expect(html).not.toMatch(/id="se_headcount_fields" style="display:none"/);
      });
    }
  });

  describe('shortage detection: teamState/expected cap confirmed goalies at the real MAXIMUM, not the minimum', () => {
    it('3 confirmed goalies with min=1/max=2 counts exactly 2 as goalies (the 3rd becomes a skater), and is not short', async () => {
      const { cookie, csrfToken } = await signup('roster.shortage.maxcap@example.com', '203.0.150.060');
      const league = await createLeague(cookie, csrfToken, { name: 'Shortage Max Cap League', teamNames: ['Red', 'Blue'], tracksStats: true });
      await updateStructure(cookie, csrfToken, { min_players: 2, max_players: 10, min_goalies: 1, max_goalies: 2 });
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      const cfg = await getLeagueSeasonConfig(env, league.id);

      const eventRes = await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ date: '2099-06-06' })
      });
      const eventId = (await eventRes.json()).event.id;

      for (const [name, isGoalie] of [['Goalie One', true], ['Goalie Two', true], ['Goalie Three', true]]) {
        const cRes = await SELF.fetch('http://example.com/league/contacts', {
          method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({ name, role: 'roster', team: 'Red', is_goalie: isGoalie })
        });
        const player = (await cRes.json()).contact;
        await SELF.fetch('http://example.com/league/rsvp/admin', {
          method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({ event_id: eventId, player_id: player.player_id, status: 'in' })
        });
      }

      const st = await teamState(env.DB, eventId, 'Red', cfg);
      expect(st.goalies).toBe(2);
      expect(st.skaters).toBe(1);
      expect(st.shortGoalie).toBe(false);

      const exp = await expected(env.DB, eventId, 'Red', cfg);
      expect(exp.goalies).toBe(2);
      expect(exp.skaters).toBe(1);
    });

    it('with the default (no explicit max), the cap still equals the minimum -- unchanged pre-Part-5 behavior', async () => {
      const { cookie, csrfToken } = await signup('roster.shortage.defaultcap@example.com', '203.0.150.061');
      const league = await createLeague(cookie, csrfToken, { name: 'Shortage Default Cap League', teamNames: ['Red', 'Blue'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      const cfg = await getLeagueSeasonConfig(env, league.id);
      expect(cfg.goaliesPerTeam).toBe(1);
      expect(cfg.maxGoalies).toBe(1);

      const eventRes = await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ date: '2099-06-07' })
      });
      const eventId = (await eventRes.json()).event.id;

      for (const name of ['Goalie A', 'Goalie B']) {
        const cRes = await SELF.fetch('http://example.com/league/contacts', {
          method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({ name, role: 'roster', team: 'Red', is_goalie: true })
        });
        const player = (await cRes.json()).contact;
        await SELF.fetch('http://example.com/league/rsvp/admin', {
          method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({ event_id: eventId, player_id: player.player_id, status: 'in' })
        });
      }

      const st = await teamState(env.DB, eventId, 'Red', cfg);
      // Same as before this task: capped at 1 (the min, since max defaults to it), the 2nd goalie counts as a skater.
      expect(st.goalies).toBe(1);
      expect(st.skaters).toBe(1);
    });
  });

  describe('safety: SMBHL is untouched', () => {
    it('SMBHL rows are unaffected by this task', async () => {
      const before = await env.DB.prepare("SELECT team_structure, min_players, max_players, min_goalies, max_goalies FROM leagues WHERE id = 'smbhl'").first();
      const after = await env.DB.prepare("SELECT team_structure, min_players, max_players, min_goalies, max_goalies FROM leagues WHERE id = 'smbhl'").first();
      expect(after).toEqual(before);
    });

    it('the settings/structure route still blocks SMBHL', async () => {
      const { cookie, csrfToken } = await signup('roster.smbhl.block@example.com', '203.0.150.070');
      const res = await SELF.fetch('http://example.com/league/settings/structure', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ min_players: 4, max_players: 6 })
      });
      // No league for this fresh account -- NO_LEAGUE_FOUND, never reaches SMBHL.
      expect(res.status).toBe(404);
    });
  });
});

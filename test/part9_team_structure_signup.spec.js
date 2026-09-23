// Team-structure task, Part 1: schema + signup. Three modes chosen
// once at signup -- 'fixed' (today's existing behavior, unaffected),
// 'headcount' (no teams, a single min/max player count), 'weekly_draw'
// (named teams, assigned per event rather than permanently).
import { env, SELF } from 'cloudflare:test';
import { getSeasonConfig, getTeamNames } from '../src/season_config.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part9-team-structure-secret';

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

describe('Team structure, Part 1: schema + signup', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  describe('FIXED MODE (default) -- provably unaffected', () => {
    it('a /leagues/create call with no teamStructure field at all (every existing caller) behaves exactly as before: fixed mode, real team names, no min/max', async () => {
      const { cookie, csrfToken } = await signup('ts.fixed.default@example.com', '203.0.113.971');
      const res = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Fixed Default League', teamNames: ['Otters', 'Falcons'], tracksStats: true })
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.league.teamStructure).toBe('fixed');
      expect(json.league.teamNames).toEqual(['Otters', 'Falcons']);
      expect(json.league.minPlayers).toBeNull();
      expect(json.league.maxPlayers).toBeNull();

      const row = await env.DB.prepare('SELECT team_structure, min_players, max_players FROM leagues WHERE id = ?').bind(json.league.id).first();
      expect(row.team_structure).toBe('fixed');
      expect(row.min_players).toBeNull();
      expect(row.max_players).toBeNull();
    });

    it('an explicit teamStructure: "fixed" behaves identically to omitting it', async () => {
      const { cookie, csrfToken } = await signup('ts.fixed.explicit@example.com', '203.0.113.972');
      const res = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Fixed Explicit League', teamNames: ['A', 'B'], tracksStats: true, teamStructure: 'fixed' })
      });
      const json = await res.json();
      expect(json.league.teamStructure).toBe('fixed');
    });

    it('fixed mode still requires at least 2 team names, exactly as before', async () => {
      const { cookie, csrfToken } = await signup('ts.fixed.mintest@example.com', '203.0.113.973');
      const res = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Fixed Min Test League', teamNames: ['OnlyOne'], tracksStats: true })
      });
      expect(res.status).toBe(400);
      expect((await res.json()).errorKey).toBe('MIN_TEAM_NAMES');
    });

    it("SMBHL's own config (getSeasonConfig(undefined), no season at all) still reads teamStructure: 'fixed' with its exact original numbers -- zero impact from this task", () => {
      const cfg = getSeasonConfig(undefined);
      expect(cfg.teamStructure).toBe('fixed');
      expect(cfg.minSkaters).toBe(5);
      expect(cfg.skatersPerTeam).toBe(8);
      expect(cfg.goaliesPerTeam).toBe(1);
      expect(getTeamNames(cfg)).toEqual(['Red', 'Blue', 'White', 'Black']);
    });

    it('a fixed-mode league not yet published still resolves its own real team names/thresholds through getLeagueSeasonConfig, teamStructure included', async () => {
      const { cookie, csrfToken } = await signup('ts.fixed.preseason@example.com', '203.0.113.974');
      const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Fixed Preseason League', teamNames: ['Red Team', 'Blue Team'], tracksStats: true })
      });
      const leagueId = (await leagueRes.json()).league.id;
      const { getLeagueSeasonConfig } = await import('../src/leagues.js');
      const cfg = await getLeagueSeasonConfig(env, leagueId);
      expect(cfg.teamStructure).toBe('fixed');
      expect(getTeamNames(cfg)).toEqual(['Red Team', 'Blue Team']);
      expect(cfg.minSkaters).toBe(5); // unaffected generic default, no min/max override for fixed mode
      expect(cfg.skatersPerTeam).toBe(8);
    });
  });

  describe('HEADCOUNT MODE', () => {
    it('creates successfully with no teamNames, storing the single implicit team internally and the real min/max', async () => {
      const { cookie, csrfToken } = await signup('ts.headcount.create@example.com', '203.0.113.975');
      const res = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Headcount League', tracksStats: true, teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12 })
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.league.teamStructure).toBe('headcount');
      expect(json.league.minPlayers).toBe(8);
      expect(json.league.maxPlayers).toBe(12);

      const row = await env.DB.prepare('SELECT team_structure, min_players, max_players, team_names FROM leagues WHERE id = ?').bind(json.league.id).first();
      expect(row.team_structure).toBe('headcount');
      expect(row.min_players).toBe(8);
      expect(row.max_players).toBe(12);
      expect(JSON.parse(row.team_names)).toEqual(['Tous']);
    });

    it('rejects creation with no min/max at all', async () => {
      const { cookie, csrfToken } = await signup('ts.headcount.nolimits@example.com', '203.0.113.976');
      const res = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Headcount No Limits League', tracksStats: true, teamStructure: 'headcount' })
      });
      expect(res.status).toBe(400);
      expect((await res.json()).errorKey).toBe('HEADCOUNT_LIMITS_REQUIRED');
    });

    it('rejects a max below the min', async () => {
      const { cookie, csrfToken } = await signup('ts.headcount.badrange@example.com', '203.0.113.977');
      const res = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Headcount Bad Range League', tracksStats: true, teamStructure: 'headcount', minPlayers: 10, maxPlayers: 5 })
      });
      expect(res.status).toBe(400);
      expect((await res.json()).errorKey).toBe('HEADCOUNT_MAX_TOO_LOW');
    });

    it("does NOT require teamNames even if some are mistakenly sent -- they're ignored in favor of the single implicit team", async () => {
      const { cookie, csrfToken } = await signup('ts.headcount.ignoreteams@example.com', '203.0.113.978');
      const res = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Headcount Ignore Teams League', tracksStats: true, teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10, teamNames: ['Should', 'Be', 'Ignored'] })
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.league.teamNames).toEqual(['Tous']);
    });

    it("getLeagueSeasonConfig resolves the league's OWN min/max (not the generic 5/8 default) even before any season is published", async () => {
      const { cookie, csrfToken } = await signup('ts.headcount.preseason@example.com', '203.0.113.979');
      const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Headcount Preseason League', tracksStats: true, teamStructure: 'headcount', minPlayers: 9, maxPlayers: 15 })
      });
      const leagueId = (await leagueRes.json()).league.id;
      const { getLeagueSeasonConfig } = await import('../src/leagues.js');
      const cfg = await getLeagueSeasonConfig(env, leagueId);
      expect(cfg.teamStructure).toBe('headcount');
      expect(cfg.minSkaters).toBe(9);
      expect(cfg.skatersPerTeam).toBe(15);
      expect(getTeamNames(cfg)).toEqual(['Tous']);
    });
  });

  describe('WEEKLY_DRAW MODE', () => {
    it('creates successfully with real named teams (same requirement as fixed), no min/max stored', async () => {
      const { cookie, csrfToken } = await signup('ts.weekly.create@example.com', '203.0.113.980');
      const res = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Weekly Draw League', teamNames: ['Team A', 'Team B', 'Team C'], tracksStats: true, teamStructure: 'weekly_draw' })
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.league.teamStructure).toBe('weekly_draw');
      expect(json.league.teamNames).toEqual(['Team A', 'Team B', 'Team C']);
      expect(json.league.minPlayers).toBeNull();
      expect(json.league.maxPlayers).toBeNull();

      const row = await env.DB.prepare('SELECT min_players, max_players FROM leagues WHERE id = ?').bind(json.league.id).first();
      expect(row.min_players).toBeNull();
      expect(row.max_players).toBeNull();
    });

    it('also requires at least 2 team names, same as fixed', async () => {
      const { cookie, csrfToken } = await signup('ts.weekly.mintest@example.com', '203.0.113.981');
      const res = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Weekly Min Test League', teamNames: ['OnlyOne'], tracksStats: true, teamStructure: 'weekly_draw' })
      });
      expect(res.status).toBe(400);
      expect((await res.json()).errorKey).toBe('MIN_TEAM_NAMES');
    });
  });

  describe('Signup wizard UI', () => {
    it('step 2 shows all 3 real structure options in plain language, not raw enum names', async () => {
      const { cookie } = await signup('ts.wizard.step2@example.com', '203.0.113.982');
      const res = await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie } });
      const html = await res.text();
      expect(html).toContain('name="su_structure"');
      expect(html).toContain('value="fixed"');
      expect(html).toContain('value="headcount"');
      expect(html).toContain('value="weekly_draw"');
      expect(html).toContain('Équipes fixes');
      expect(html).toContain('Aucune équipe');
      // Live-testing Part 3: title copy rewritten for clarity/voice --
      // was "Équipes chaque semaine", now "Équipes qui changent".
      expect(html).toContain('Équipes qui changent');
      expect(html).not.toContain('>fixed<');
      expect(html).not.toContain('>headcount<');
    });

    it('step 3 ships both the team-names UI and the headcount min/max UI, switched client-side by the stored choice', async () => {
      const { cookie } = await signup('ts.wizard.step3@example.com', '203.0.113.983');
      const res = await SELF.fetch('http://example.com/signup?step=3', { headers: { cookie } });
      const html = await res.text();
      expect(html).toContain('id="su_teams_section"');
      expect(html).toContain('id="su_headcount_section"');
      expect(html).toContain('id="su_min_players"');
      expect(html).toContain('id="su_max_players"');
      expect(html).toContain("leagueDraft.teamStructure === 'headcount'");
    });
  });
});

// Part H: getSeasonConfig's fallback no longer defaults a league with no
// season config to SMBHL's DEFAULT_SEASON_CONFIG (Red/Blue/White/Black) —
// it uses that league's own signup-provided team_names instead, when
// available. DEFAULT_SEASON_CONFIG itself is untouched, and remains the
// genuine last-resort fallback when there's truly nothing better (no
// season config AND no league team names to fall back to).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { getSeasonConfig, DEFAULT_SEASON_CONFIG } from '../src/season_config.js';
import { getLeagueSeasonConfig } from '../src/leagues.js';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-league-season-config-secret';

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

describe('Part H: getSeasonConfig fallback uses a league\'s own team names', () => {
  describe('getSeasonConfig() unit behavior', () => {
    it('backward compatible: called with only 2 args (every existing call site), falls back to DEFAULT_SEASON_CONFIG exactly as before', () => {
      const cfg = getSeasonConfig(null, null);
      expect(cfg.teams.map(t => t.name)).toEqual(DEFAULT_SEASON_CONFIG.teams.map(t => t.name));
    });

    it('with no season config found, but leagueTeamNames given, uses those instead of DEFAULT_SEASON_CONFIG', () => {
      const cfg = getSeasonConfig({ current_season: null, seasons: [], players: [] }, null, ['Otters', 'Falcons']);
      expect(cfg.teams.map(t => t.name)).toEqual(['Otters', 'Falcons']);
      expect(cfg.teams.map(t => t.name)).not.toEqual(DEFAULT_SEASON_CONFIG.teams.map(t => t.name));
    });

    it('a real season config (SMBHL\'s normal case) always wins over leagueTeamNames -- the fallback never even triggers', () => {
      const realData = {
        current_season: 'Fall 2026',
        seasons: [{ name: 'Fall 2026', config: { teams: ['Red', 'Blue', 'White', 'Black'] } }]
      };
      const cfg = getSeasonConfig(realData, 'Fall 2026', ['Should', 'Not', 'Appear']);
      expect(cfg.teams.map(t => t.name)).toEqual(['Red', 'Blue', 'White', 'Black']);
    });

    it('an empty leagueTeamNames array is treated the same as not passing one -- falls through to DEFAULT_SEASON_CONFIG', () => {
      const cfg = getSeasonConfig({ seasons: [] }, null, []);
      expect(cfg.teams.map(t => t.name)).toEqual(DEFAULT_SEASON_CONFIG.teams.map(t => t.name));
    });
  });

  describe('getLeagueSeasonConfig() end-to-end', () => {
    beforeAll(async () => {
      env.AUTH_SECRET = AUTH_SECRET;
      await applyRealSchema(env);
    });

    it("a brand-new league with no season data yet gets ITS OWN signup team names, not SMBHL's", async () => {
      const { leagueId } = await signupAndCreateLeague('seasoncfg.a@example.com', '203.0.113.241', 'Season Config League A', ['Narwhals', 'Beavers', 'Loons']);

      const cfg = await getLeagueSeasonConfig(env, leagueId);
      expect(cfg.teams.map(t => t.name)).toEqual(['Narwhals', 'Beavers', 'Loons']);
      expect(cfg.teams.map(t => t.name)).not.toEqual(DEFAULT_SEASON_CONFIG.teams.map(t => t.name));
    });

    it('an unknown league id (no matching leagues row) legitimately falls all the way through to DEFAULT_SEASON_CONFIG -- the documented edge case', async () => {
      const cfg = await getLeagueSeasonConfig(env, 'no-such-league-id-at-all');
      expect(cfg.teams.map(t => t.name)).toEqual(DEFAULT_SEASON_CONFIG.teams.map(t => t.name));
    });

    it("SMBHL itself is completely unaffected: it already has real season data, so this fallback path never triggers for it", async () => {
      const smbhlData = {
        current_season: 'Fall 2026',
        seasons: [{ name: 'Fall 2026', config: { teams: ['Red', 'Blue', 'White', 'Black'] } }],
        players: []
      };
      await env.SHEETS_KV.put('data_json', JSON.stringify(smbhlData));

      const cfg = await getLeagueSeasonConfig(env, 'smbhl', 'Fall 2026');
      expect(cfg.teams.map(t => t.name)).toEqual(['Red', 'Blue', 'White', 'Black']);
    });
  });
});

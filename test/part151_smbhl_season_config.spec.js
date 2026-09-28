// SMBHL's season config (src/season_config.js SMBHL_SEASON_CONFIG): the
// values the code uses for an SMBHL season that has none, written out --
// so a season carrying it behaves exactly as one without it (the SMBHL
// golden record also replays unchanged with it in data.json, part114).
// SMBHL has TWO skater minimums today: 7 for the shortfall sub call,
// minSkaters 5 for the 36-hour check, the board and the team page -- so
// the config carries shortfallMinSkaters apart from minSkaters.
//
// And the season hub's launch, which already wrote a (partial) config:
// on SMBHL's real data.json -- seasons and players are ARRAYS, newest
// season first -- it put the new season last and recorded no player's
// team, and its draft screens found no player's history.
import { describe, it, expect } from 'vitest';
import {
  SMBHL_SEASON_CONFIG, SMBHL_SHORTFALL_MIN_SKATERS, smbhlSeasonConfig, addSmbhlSeasonConfig,
  getSeasonConfig, normalizeSeasonConfig, gamesPerNight, getLeagueConfig, getTeamNames, tracksStats, DEFAULT_SEASON_CONFIG
} from '../src/season_config.js';
import { shortfallMinSkaters } from '../src/index.js';
import { publishSeasonToProduction, dataPlayer, recentPlayerSeasons } from '../src/season_hub.js';

const SEASON = 'Fall 2026';
const doc = config => ({ current_season: SEASON, seasons: [{ name: SEASON, fixtures: [], standings: [], ...(config ? { config } : {}) }], players: [] });

describe("SMBHL's season config equals what the code does without one", () => {
  const without = getSeasonConfig(doc(null), SEASON);
  const withCfg = getSeasonConfig(doc(smbhlSeasonConfig()), SEASON);

  it('every field the code reads without a config comes out the same with it', () => {
    for (const k of Object.keys(without)) expect(withCfg[k]).toEqual(without[k]);
    expect(getLeagueConfig(withCfg)).toEqual(getLeagueConfig(without));
    expect(getTeamNames(withCfg)).toEqual(['Red', 'Blue', 'White', 'Black']);
    expect(tracksStats(withCfg)).toBe(tracksStats(without));
  });

  it('two games a night, and the shortfall call still at 7 skaters while minSkaters stays 5', () => {
    expect(gamesPerNight(without, 'smbhl')).toBe(2);
    expect(gamesPerNight(withCfg, 'smbhl')).toBe(2);
    expect(shortfallMinSkaters(without, 'smbhl')).toBe(SMBHL_SHORTFALL_MIN_SKATERS);
    expect(shortfallMinSkaters(withCfg, 'smbhl')).toBe(7);
    expect(without.minSkaters).toBe(5);
    expect(withCfg.minSkaters).toBe(5);
  });

  it('carries SMBHL\'s own identity, so league-level branding can never stand in for it', () => {
    const branded = getSeasonConfig(doc(smbhlSeasonConfig()), SEASON, null, { name: 'Other', fromEmail: 'Other <other@mail.notreligue.ca>', replyToEmail: 'x@example.com' });
    expect(getLeagueConfig(branded).fromEmail).toBe(DEFAULT_SEASON_CONFIG.league.fromEmail);
    expect(getLeagueConfig(branded).name).toBe('SMBHL');
  });

  it('is frozen, and each copy is its own', () => {
    expect(Object.isFrozen(SMBHL_SEASON_CONFIG)).toBe(true);
    const a = smbhlSeasonConfig(); a.teams[0].aliases.push('x');
    expect(smbhlSeasonConfig().teams[0].aliases).toEqual(['Red Wings']);
    expect(DEFAULT_SEASON_CONFIG.teams[0].aliases).toEqual(['Red Wings']);
  });
});

describe('Leagues are unaffected', () => {
  it('a league config never gains shortfallMinSkaters; the shortfall call uses its minSkaters as before', () => {
    const six = normalizeSeasonConfig({ minSkaters: 6 });
    expect('shortfallMinSkaters' in six).toBe(false);
    expect(shortfallMinSkaters(six, 'some-league')).toBe(6);
    expect(shortfallMinSkaters(normalizeSeasonConfig({}), 'some-league')).toBe(5);
  });
});

describe('addSmbhlSeasonConfig (scripts/smbhl_season_config.mjs)', () => {
  it('adds the config to the current season, changing nothing else', () => {
    const before = { ...doc(null), seasons: [{ name: SEASON, standings: [1] }, { name: 'Winter 2026', standings: [2] }] };
    const { data, changed } = addSmbhlSeasonConfig(before);
    expect(changed).toBe(true);
    expect(data.seasons[0].config).toEqual(smbhlSeasonConfig());
    expect({ ...data.seasons[0], config: undefined }).toEqual({ ...before.seasons[0], config: undefined });
    expect(data.seasons[1]).toEqual(before.seasons[1]);
    expect(before.seasons[0].config).toBeUndefined(); // the input is not touched
  });
  it('never overwrites a config, and says so for an unknown season', () => {
    expect(addSmbhlSeasonConfig(doc({ minSkaters: 9 })).changed).toBe(false);
    expect(addSmbhlSeasonConfig(doc({ minSkaters: 9 })).data.seasons[0].config).toEqual({ minSkaters: 9 });
    expect(addSmbhlSeasonConfig(doc(null), 'Winter 2099').changed).toBe(false);
  });
});

// The minimal D1 stand-in publishSeasonToProduction needs (season_hub.spec.js's).
function hubEnv(dataJson) {
  const mockDb = {
    prepare: () => ({
      bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }),
      all: async () => ({ results: [] }), first: async () => null, run: async () => ({})
    })
  };
  const store = { data_json: JSON.stringify(dataJson) };
  return { env: { DB: mockDb, SHEETS_KV: { get: async k => store[k] || null, put: async (k, v) => { store[k] = v; } } }, store };
}

describe('Season hub launch on SMBHL\'s real data.json shape', () => {
  const realShape = () => ({
    league: 'SMBHL', current_season: SEASON,
    seasons: [{ name: SEASON, order: 42, current: true, standings: [] }, { name: 'Winter 2026', order: 41, standings: [] }],
    players: [{ id: 'P1', name: 'One', seasons: { [SEASON]: { team: 'Blue', gp: 3 } } }, { id: 'P2', name: 'Two', seasons: {} }]
  });
  const launch = async () => {
    const { env, store } = hubEnv(realShape());
    const res = await publishSeasonToProduction(env, {
      seasonName: 'Winter 2027', startDate: '2027-01-10',
      rosters: { Red: [{ playerId: 'P1', pos: 'F' }], Blue: [{ playerId: 'P2', pos: 'D' }], White: [], Black: [] },
      fixtures: [{ week: 1, date: 'Sunday Jan 10', time: '10:30 AM', home: 'Red', away: 'Blue' }],
      events: [], fees: {}
    });
    return { res, data: JSON.parse(store.data_json) };
  };

  it('puts the new season FIRST (seasons[0] is what scoresheets publish into), after the old one', async () => {
    const { res, data } = await launch();
    expect(res.ok).toBe(true);
    expect(data.seasons.map(x => x.name)).toEqual(['Winter 2027', SEASON, 'Winter 2026']);
    expect(data.seasons[0]).toMatchObject({ order: 43, current: true });
    expect(data.seasons[1].current).toBe(false);
    expect(data.current_season).toBe('Winter 2027');
  });

  it('records each rostered player\'s team for the new season', async () => {
    const { data } = await launch();
    expect(data.players.find(p => p.id === 'P1').seasons['Winter 2027'].team).toBe('Red');
    expect(data.players.find(p => p.id === 'P2').seasons['Winter 2027'].team).toBe('Blue');
    expect(data.players.find(p => p.id === 'P1').seasons[SEASON]).toEqual({ team: 'Blue', gp: 3 }); // history kept
  });

  it('writes SMBHL\'s full season config (the shortfall call stays at 7, it used to drop to 5)', async () => {
    const { data } = await launch();
    expect(data.seasons[0].config).toEqual(smbhlSeasonConfig());
    const cfg = getSeasonConfig(data, 'Winter 2027');
    expect(shortfallMinSkaters(cfg, 'smbhl')).toBe(7);
    expect(gamesPerNight(cfg, 'smbhl')).toBe(2);
  });
});

describe('Season hub draft screens read players from the real array', () => {
  const data = {
    seasons: [{ name: 'Fall 2026', order: 42 }, { name: 'Winter 2026', order: 41 }, { name: 'Fall 2025', order: 40 }, { name: 'Fall 2023', order: 36 }],
    players: [{ id: 'P1', career: { gp: 10, pts: 12 }, seasons: { 'Fall 2023': { gp: 1 }, 'Fall 2025': { gp: 3 }, 'Fall 2026': { gp: 4 }, 'Winter 2026': { gp: 2 } } }]
  };
  it('finds a player by id in the array (and in the older keyed shape)', () => {
    expect(dataPlayer(data, 'P1').career).toEqual({ gp: 10, pts: 12 });
    expect(dataPlayer({ players: { P9: { id: 'P9' } } }, 'P9')).toEqual({ id: 'P9' });
    expect(dataPlayer(data, 'nobody')).toBeNull();
  });
  it('takes the most recent seasons in the league\'s own order, not the keys\' alphabetical order', () => {
    expect(recentPlayerSeasons(data, dataPlayer(data, 'P1'), 3).map(x => x.gp)).toEqual([4, 2, 3]);
  });
});

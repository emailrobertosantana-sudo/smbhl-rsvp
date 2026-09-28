// SMBHL's season config (src/season_config.js SMBHL_SEASON_CONFIG): the
// values the code uses for an SMBHL season that has none, written out --
// so a season carrying it behaves exactly as one without it (the SMBHL
// golden record also replays unchanged with it in data.json, part114).
// SMBHL has TWO skater minimums today: 7 for the shortfall sub call,
// minSkaters 5 for the 36-hour check, the board and the team page -- so
// the config carries shortfallMinSkaters apart from minSkaters.
import { describe, it, expect } from 'vitest';
import {
  SMBHL_SEASON_CONFIG, SMBHL_SHORTFALL_MIN_SKATERS, smbhlSeasonConfig, addSmbhlSeasonConfig,
  getSeasonConfig, normalizeSeasonConfig, gamesPerNight, getLeagueConfig, getTeamNames, tracksStats, DEFAULT_SEASON_CONFIG
} from '../src/season_config.js';
import { shortfallMinSkaters } from '../src/index.js';

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

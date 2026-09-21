/**
 * season_config.js — Unified Season Configuration Engine
 * 
 * Provides dynamic season configurations (teams, colours, aliases, roster targets,
 * and playoff formats) with strict fallback to historical SMBHL defaults.
 */

export const DEFAULT_SEASON_CONFIG = {
  teams: [
    { name: 'Red', name_fr: 'Rouge', colour: '#c9152f', aliases: ['Red Wings'] },
    { name: 'Blue', name_fr: 'Bleu', colour: '#2a5fa8', aliases: ['Blues'] },
    { name: 'White', name_fr: 'Blanc', colour: '#ffffff', aliases: ['Capitals'] },
    { name: 'Black', name_fr: 'Noir', colour: '#1c1f24', aliases: ['Bruins'] }
  ],
  goaliesPerTeam: 1,
  skatersPerTeam: 8,
  minSkaters: 5,
  playoffFormat: 'top4_single_day'
};

/**
 * Normalizes a raw config object ensuring all fields conform to schema.
 */
export function normalizeSeasonConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object') {
    return { ...DEFAULT_SEASON_CONFIG };
  }

  const teams = Array.isArray(rawConfig.teams) && rawConfig.teams.length > 0
    ? rawConfig.teams.map(t => {
        if (typeof t === 'string') {
          const def = DEFAULT_SEASON_CONFIG.teams.find(x => x.name.toLowerCase() === t.toLowerCase());
          return def ? { ...def } : { name: t, name_fr: t, colour: '#64748b', aliases: [] };
        }
        const name = String(t.name || '').trim();
        return {
          name,
          name_fr: t.name_fr ? String(t.name_fr).trim() : name,
          colour: t.colour || '#64748b',
          aliases: Array.isArray(t.aliases) ? t.aliases.map(a => String(a).trim()).filter(Boolean) : []
        };
      }).filter(t => Boolean(t.name))
    : [...DEFAULT_SEASON_CONFIG.teams];

  return {
    teams,
    goaliesPerTeam: Number(rawConfig.goaliesPerTeam) || DEFAULT_SEASON_CONFIG.goaliesPerTeam,
    skatersPerTeam: Number(rawConfig.skatersPerTeam) || DEFAULT_SEASON_CONFIG.skatersPerTeam,
    minSkaters: Number(rawConfig.minSkaters) || DEFAULT_SEASON_CONFIG.minSkaters,
    playoffFormat: rawConfig.playoffFormat || DEFAULT_SEASON_CONFIG.playoffFormat
  };
}

/**
 * Resolves the configuration for a given season or data.json payload.
 * Resolution priority:
 * 1. An explicit config on the provided season object (`season.config`)
 * 2. Look up targetSeasonName in `dataJson.seasons`
 * 3. Look up `dataJson.current_season` in `dataJson.seasons`
 * 4. Fall back to DEFAULT_SEASON_CONFIG
 * 
 * @param {Object} [seasonOrData] - A season object or data.json payload
 * @param {string} [targetSeasonName] - Optional season name to resolve
 * @returns {Object} Normalized season config
 */
export function getSeasonConfig(seasonOrData, targetSeasonName = null) {
  if (!seasonOrData || typeof seasonOrData !== 'object') {
    return { ...DEFAULT_SEASON_CONFIG };
  }

  // Case 1: Direct season object carrying .config
  if (seasonOrData.config && typeof seasonOrData.config === 'object') {
    return normalizeSeasonConfig(seasonOrData.config);
  }

  // Case 2: Direct season object that has no config (e.g. historical season with standings or fixtures)
  if (seasonOrData.standings || seasonOrData.fixtures) {
    return { ...DEFAULT_SEASON_CONFIG };
  }

  // Case 3: data.json payload with .seasons
  if (seasonOrData.seasons) {
    const seasonsList = Array.isArray(seasonOrData.seasons)
      ? seasonOrData.seasons
      : Object.values(seasonOrData.seasons);

    let seasonObj = null;
    if (targetSeasonName) {
      seasonObj = seasonsList.find(s => s && s.name === targetSeasonName);
    }
    if (!seasonObj && seasonOrData.current_season) {
      seasonObj = seasonsList.find(s => s && s.name === seasonOrData.current_season);
    }
    if (!seasonObj && seasonsList.length > 0) {
      seasonObj = seasonsList[0];
    }

    if (seasonObj && seasonObj.config) {
      return normalizeSeasonConfig(seasonObj.config);
    }
  }

  return { ...DEFAULT_SEASON_CONFIG };
}

/**
 * Returns list of canonical team names for a given config.
 */
export function getTeamNames(config) {
  const cfg = config && config.teams ? config : DEFAULT_SEASON_CONFIG;
  return cfg.teams.map(t => t.name);
}

/**
 * Returns French translation for a team name in a given config.
 */
export function getTeamNameFr(config, teamName) {
  if (!teamName) return '';
  const cfg = config && config.teams ? config : DEFAULT_SEASON_CONFIG;
  const t = cfg.teams.find(x => x.name.toLowerCase() === String(teamName).toLowerCase());
  return t ? t.name_fr : String(teamName);
}

/**
 * Returns hex colour for a team in a given config.
 */
export function getTeamColour(config, teamName) {
  const cfg = config && config.teams ? config : DEFAULT_SEASON_CONFIG;
  const t = cfg.teams.find(x => x.name.toLowerCase() === String(teamName).toLowerCase());
  return t ? t.colour : '#64748b';
}

/**
 * Checks if a team is valid within a given config.
 */
export function isTeamValid(config, teamName) {
  if (!teamName) return false;
  const cfg = config && config.teams ? config : DEFAULT_SEASON_CONFIG;
  return cfg.teams.some(x => x.name.toLowerCase() === String(teamName).toLowerCase());
}

/**
 * Normalizes a raw team name against canonical names, French names, and aliases.
 */
export function normalizeTeamWithConfig(rawName, config) {
  if (!rawName) return null;
  const s = String(rawName).trim();
  const lower = s.toLowerCase();
  const cfg = config && config.teams ? config : DEFAULT_SEASON_CONFIG;

  for (const t of cfg.teams) {
    if (t.name.toLowerCase() === lower) return t.name;
    if (t.name_fr && t.name_fr.toLowerCase() === lower) return t.name;
    if (Array.isArray(t.aliases)) {
      for (const alias of t.aliases) {
        if (alias && alias.toLowerCase() === lower) return t.name;
      }
    }
  }

  // Word-boundary match fallback for aliases (e.g. "Red Wings" inside "Game 1 - Red Wings")
  for (const t of cfg.teams) {
    if (Array.isArray(t.aliases)) {
      for (const alias of t.aliases) {
        if (alias && new RegExp('\\b' + alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(s)) {
          return t.name;
        }
      }
    }
  }

  return null;
}

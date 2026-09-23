/**
 * season_config.js — Unified Season Configuration Engine
 *
 * Provides dynamic season configurations (teams, colours, aliases, roster targets,
 * playoff formats, league branding/email identity, and stats tracking) with strict
 * fallback to historical SMBHL defaults.
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
  playoffFormat: 'top4_single_day',
  // Branding/email identity. `fromEmail` is passed as-is to the mail API's `from`
  // field (RFC5322 allows either a bare address or a "Display Name <addr>" form),
  // preserved verbatim here to keep SMBHL's existing sender identity byte-for-byte.
  league: {
    name: 'SMBHL',
    // Full descriptive name shown alongside `name` in page meta/email footers
    // (e.g. "SMBHL · Sunday Morning Ball Hockey League"). Not explicitly asked
    // for, but needed so the default output stays byte-for-byte identical.
    tagline: 'Sunday Morning Ball Hockey League',
    fromEmail: 'SMBHL - Hockey <joueur@smbhl.com>',
    replyToEmail: 'info@smbhl.com',
    siteUrl: 'https://smbhl.com',
    faviconUrl: 'https://smbhl.com/img/favicon-32.svg'
  },
  // When false, standings/playoffs/awards/OCR/season-recap are disabled for this
  // season; only the attendance/RSVP/shortage/sub-invite operational core runs.
  tracksStats: true
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

  const rawLeague = (rawConfig.league && typeof rawConfig.league === 'object') ? rawConfig.league : {};
  const league = {
    name: rawLeague.name || DEFAULT_SEASON_CONFIG.league.name,
    tagline: rawLeague.tagline || DEFAULT_SEASON_CONFIG.league.tagline,
    fromEmail: rawLeague.fromEmail || DEFAULT_SEASON_CONFIG.league.fromEmail,
    replyToEmail: rawLeague.replyToEmail || DEFAULT_SEASON_CONFIG.league.replyToEmail,
    siteUrl: rawLeague.siteUrl || DEFAULT_SEASON_CONFIG.league.siteUrl,
    faviconUrl: rawLeague.faviconUrl || DEFAULT_SEASON_CONFIG.league.faviconUrl
  };

  return {
    teams,
    goaliesPerTeam: Number(rawConfig.goaliesPerTeam) || DEFAULT_SEASON_CONFIG.goaliesPerTeam,
    skatersPerTeam: Number(rawConfig.skatersPerTeam) || DEFAULT_SEASON_CONFIG.skatersPerTeam,
    minSkaters: Number(rawConfig.minSkaters) || DEFAULT_SEASON_CONFIG.minSkaters,
    playoffFormat: rawConfig.playoffFormat || DEFAULT_SEASON_CONFIG.playoffFormat,
    league,
    tracksStats: rawConfig.tracksStats === false ? false : DEFAULT_SEASON_CONFIG.tracksStats
  };
}

// Last-resort fallback when nothing in seasonOrData resolves a real config
// at all (used at both points below). `leagueTeamNames` — a league's own
// signup-provided team names (leagues.team_names in D1), NOT part of
// data.json/season shape at all — lets a league with no season config yet
// fall back to ITS OWN team names instead of DEFAULT_SEASON_CONFIG's
// SMBHL-specific Red/Blue/White/Black. `leagueBranding` is the same idea
// for the .league identity block (name/fromEmail/replyToEmail/siteUrl) —
// critical so a second league's RSVP pages and outbound emails don't
// present as SMBHL's ("SMBHL - Hockey <joueur@smbhl.com>") by accident.
// Both omitted (as every existing call site still does — this is purely
// additive), it's the exact same DEFAULT_SEASON_CONFIG fallback as before:
// SMBHL already has real season configs, so this path doesn't trigger for
// it either way, and every other existing caller's behavior is completely
// unchanged.
// Merges leagueBranding into config as a DEFAULT for its .league block —
// the season's own explicit league branding (if it ever sets one) always
// wins field-by-field, leagueBranding only fills in what's missing. This
// matters because a real, already-published season (config.teams set at
// /league/season/publish, say) has no .league block of its own at all —
// without this merge, normalizeSeasonConfig would fall back to
// DEFAULT_SEASON_CONFIG's SMBHL identity for EVERY branding field the
// instant any real season config exists, even for a league that has
// nothing to do with SMBHL. leagueBranding is null for every existing
// 2/3-arg getSeasonConfig call (SMBHL's own, unconditionally), so this is
// a no-op there — config is returned completely unchanged.
function withLeagueBrandingDefault(config, leagueBranding) {
  if (!leagueBranding || typeof leagueBranding !== 'object') return config;
  return { ...config, league: { ...leagueBranding, ...(config.league || {}) } };
}

function fallbackSeasonConfig(leagueTeamNames, leagueBranding) {
  const hasTeams = Array.isArray(leagueTeamNames) && leagueTeamNames.length > 0;
  const hasBranding = leagueBranding && typeof leagueBranding === 'object';
  if (hasTeams || hasBranding) {
    return normalizeSeasonConfig({
      ...(hasTeams ? { teams: leagueTeamNames } : {}),
      ...(hasBranding ? { league: leagueBranding } : {})
    });
  }
  return { ...DEFAULT_SEASON_CONFIG };
}

/**
 * Resolves the configuration for a given season or data.json payload.
 * Resolution priority:
 * 1. An explicit config on the provided season object (`season.config`)
 * 2. Look up targetSeasonName in `dataJson.seasons`
 * 3. Look up `dataJson.current_season` in `dataJson.seasons`
 * 4. `leagueTeamNames`, if given and non-empty (a league's own signup team names)
 * 5. Fall back to DEFAULT_SEASON_CONFIG
 *
 * @param {Object} [seasonOrData] - A season object or data.json payload
 * @param {string} [targetSeasonName] - Optional season name to resolve
 * @param {string[]} [leagueTeamNames] - A league's own team names, used only
 *   when no real season config is found anywhere else (step 4 above)
 * @param {Object} [leagueBranding] - A league's own .league identity block
 *   (name/fromEmail/replyToEmail/siteUrl/...), used the same way as
 *   leagueTeamNames — only when no real season config is found
 * @returns {Object} Normalized season config
 */
export function getSeasonConfig(seasonOrData, targetSeasonName = null, leagueTeamNames = null, leagueBranding = null) {
  if (!seasonOrData || typeof seasonOrData !== 'object') {
    return fallbackSeasonConfig(leagueTeamNames, leagueBranding);
  }

  // Case 1: Direct season object carrying .config
  if (seasonOrData.config && typeof seasonOrData.config === 'object') {
    return normalizeSeasonConfig(withLeagueBrandingDefault(seasonOrData.config, leagueBranding));
  }

  // Case 2: Direct season object that has no config (e.g. historical season with standings or fixtures).
  // This branch means real season data already exists (just without an explicit
  // .config), so it's not the "no season yet" case leagueTeamNames is for.
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
      return normalizeSeasonConfig(withLeagueBrandingDefault(seasonObj.config, leagueBranding));
    }
  }

  return fallbackSeasonConfig(leagueTeamNames, leagueBranding);
}

/**
 * Returns list of canonical team names for a given config.
 */
export function getTeamNames(config) {
  const cfg = config && config.teams ? config : DEFAULT_SEASON_CONFIG;
  return cfg.teams.map(t => t.name);
}

/**
 * Returns the branding/email-identity block for a given config, falling back to
 * SMBHL's defaults field-by-field (so a partial `league` override doesn't lose
 * the rest of the identity).
 */
export function getLeagueConfig(config) {
  const raw = (config && config.league && typeof config.league === 'object') ? config.league : {};
  return {
    name: raw.name || DEFAULT_SEASON_CONFIG.league.name,
    tagline: raw.tagline || DEFAULT_SEASON_CONFIG.league.tagline,
    fromEmail: raw.fromEmail || DEFAULT_SEASON_CONFIG.league.fromEmail,
    replyToEmail: raw.replyToEmail || DEFAULT_SEASON_CONFIG.league.replyToEmail,
    siteUrl: raw.siteUrl || DEFAULT_SEASON_CONFIG.league.siteUrl,
    faviconUrl: raw.faviconUrl || DEFAULT_SEASON_CONFIG.league.faviconUrl
  };
}

/**
 * Returns whether a season tracks stats (standings/playoffs/awards/OCR/recap).
 * Defaults to true (SMBHL's historical behavior) unless explicitly set to false.
 */
export function tracksStats(config) {
  return config && config.tracksStats === false ? false : true;
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
 * Loads the data.json payload (season configs, fixtures, standings) using the
 * same KV-first-then-origin-fetch pattern already used elsewhere in the Worker.
 */
async function loadSeasonData(env) {
  let d = null;
  try {
    const raw = env?.SHEETS_KV ? await env.SHEETS_KV.get('data_json') : null;
    if (raw) d = JSON.parse(raw);
  } catch (_) {}
  if (!d) {
    try {
      const res = await fetch(`${env?.SITE_URL || 'https://smbhl.com'}/data.json`, {
        signal: AbortSignal.timeout(2000)
      });
      if (res.ok) d = await res.json();
    } catch (_) {}
  }
  return d;
}

/**
 * Resolves the season config for a given season name, loading data.json via
 * the Worker env (KV binding, falling back to an origin fetch). Falls back to
 * SMBHL defaults when data.json or the named season isn't found.
 */
export async function getSeasonConfigFromEnv(env, seasonName) {
  const d = await loadSeasonData(env);
  return getSeasonConfig(d, seasonName);
}

/**
 * Resolves the season config for a given event. Prefers the season name if
 * already known by the caller (most call sites already have `ev.season`);
 * otherwise looks it up from the events table via env.DB.
 */
export async function getSeasonConfigForEvent(env, eventId, season) {
  let seasonName = season;
  if (!seasonName && eventId && env?.DB) {
    try {
      const row = await env.DB.prepare('SELECT season FROM events WHERE id = ?').bind(eventId).first();
      seasonName = row && row.season;
    } catch (_) {}
  }
  return getSeasonConfigFromEnv(env, seasonName);
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


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
  // Live-testing task, Part 5: the goalie roster CAP, independent from
  // goaliesPerTeam (the goalie roster FLOOR/target -- shortGoalie and
  // sub-invites still key off that field alone, unchanged). Defaults to
  // the same value as goaliesPerTeam so min=max exactly as before this
  // task for every league that never sets a real, distinct maximum --
  // see normalizeSeasonConfig's own comment for how this default is
  // actually resolved (it is NOT this hardcoded 1, except when
  // goaliesPerTeam itself is also unset).
  maxGoalies: 1,
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
    faviconUrl: 'https://smbhl.com/img/favicon-32.svg',
    // Part 4 foundation: 'both' (default) shows the real FR/EN toggle
    // exactly as it already works; 'fr'/'en' would hide it and pin
    // that one language on public/player-facing pages -- see
    // migrate-023.sql. SMBHL's own default is 'both', unchanged.
    languageMode: 'both',
    // Design system (migrate-025.sql): never actually read for SMBHL's
    // own rendering (SMBHL is explicitly out of scope for the design
    // system), kept only so this object always has every league.*
    // field defined, matching the same defensive pattern as the rest
    // of this block.
    color: '#b3122e'
  },
  // When false, standings/playoffs/awards/OCR/season-recap are disabled for this
  // season; only the attendance/RSVP/shortage/sub-invite operational core runs.
  tracksStats: true,
  // Team-structure task: SMBHL (and every league before this task) is
  // 'fixed' -- teams set once, players belong to one all season.
  teamStructure: 'fixed',
  // Part 5 (headcount goalie minimum) foundation: SMBHL and every
  // league today is 'hockey' -- see migrate-028.sql. Threaded through
  // the exact same way teamStructure already is (a league-level
  // leagues.sport_type column, not part of a season's own config
  // shape at all).
  sportType: 'hockey'
};

// Live-testing task, Part 5: which characteristics a given sport_type
// has, so callers (the roster page's goalie flag today, anything else
// sport-specific tomorrow) can ask "does this league's sport have a
// goalie role?" instead of hardcoding a list of sport names to check
// against. Only 'hockey' exists today (see migrate-028.sql -- every
// league defaults to it silently, no sport-selection UI exists yet),
// so this starts as a single entry, but adding a second sport later
// means adding one entry here, not hunting down every place that used
// to compare against 'hockey' by name.
const SPORT_CAPABILITIES = {
  hockey: { hasGoalie: true }
};

export function sportHasGoalie(sportType) {
  const caps = SPORT_CAPABILITIES[sportType];
  return !!(caps && caps.hasGoalie);
}

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
    faviconUrl: rawLeague.faviconUrl || DEFAULT_SEASON_CONFIG.league.faviconUrl,
    // Part 4 foundation: this explicit field list previously dropped
    // any field not named here (found while wiring languageMode
    // through -- leagueBranding.languageMode was being silently
    // stripped for any league that had already published a season).
    languageMode: rawLeague.languageMode || DEFAULT_SEASON_CONFIG.league.languageMode,
    // Design system (migrate-025.sql): same explicit-field-list trap --
    // added here proactively this time, before it became a live bug.
    color: rawLeague.color || DEFAULT_SEASON_CONFIG.league.color
  };

  const resolvedGoaliesPerTeam = (rawConfig.goaliesPerTeam !== undefined && rawConfig.goaliesPerTeam !== null)
    ? Number(rawConfig.goaliesPerTeam) : DEFAULT_SEASON_CONFIG.goaliesPerTeam;

  return {
    teams,
    // Part 5 (headcount goalie minimum) fix: this used to be
    // `Number(rawConfig.goaliesPerTeam) || DEFAULT...`, which silently
    // discarded an explicit, intentional 0 (0 is falsy) and fell back
    // to the generic default of 1 -- fine when nothing ever actually
    // stored a literal 0 here (every pre-existing writer only sets
    // this field when the value is > 0, so this branch was previously
    // unreachable with real data), but wrong now that a headcount
    // league's own min_goalies=0 ("no goalie requirement", a real,
    // common, intentional choice) needs to resolve to a real 0, not
    // silently become 1. Explicit undefined/null check instead --
    // every existing caller is unaffected, since none of them have
    // ever stored 0 here.
    goaliesPerTeam: resolvedGoaliesPerTeam,
    // Live-testing task, Part 5: an explicit rawConfig.maxGoalies always
    // wins; otherwise this defaults to resolvedGoaliesPerTeam (the real
    // goalie floor just resolved above), NOT DEFAULT_SEASON_CONFIG's own
    // maxGoalies constant -- a league with goaliesPerTeam=3 and no
    // explicit max must still get max=3, never silently clipped down to
    // the generic default of 1 (which would make teamState's own cap
    // contradict the very minimum it's supposed to be capping above).
    // This is what guarantees min===max, unchanged from before this
    // task, for every league that has never set a real, distinct
    // maximum.
    maxGoalies: (rawConfig.maxGoalies !== undefined && rawConfig.maxGoalies !== null)
      ? Number(rawConfig.maxGoalies) : resolvedGoaliesPerTeam,
    skatersPerTeam: Number(rawConfig.skatersPerTeam) || DEFAULT_SEASON_CONFIG.skatersPerTeam,
    minSkaters: Number(rawConfig.minSkaters) || DEFAULT_SEASON_CONFIG.minSkaters,
    playoffFormat: rawConfig.playoffFormat || DEFAULT_SEASON_CONFIG.playoffFormat,
    league,
    tracksStats: rawConfig.tracksStats === false ? false : DEFAULT_SEASON_CONFIG.tracksStats,
    // Team-structure task: 'fixed' (default, every league before this
    // task and every league that doesn't set it) | 'headcount' |
    // 'weekly_draw'. Not part of data.json/season shape at all --
    // always threaded in from the league's own leagues.team_structure
    // column (see getLeagueSeasonConfig), same mechanism as
    // leagueTeamNames/leagueBranding/leagueRosterLimits above.
    teamStructure: rawConfig.teamStructure || 'fixed',
    // Part 5 foundation: same mechanism as teamStructure above -- a
    // league-level leagues.sport_type column, threaded in via
    // getLeagueSeasonConfig, never part of a season's own config shape.
    sportType: rawConfig.sportType || 'hockey'
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
// Team-structure task: teamStructure is threaded through the SAME way
// leagueBranding already is -- a league-level property (leagues.
// team_structure), not part of data.json/season shape at all, so it
// has to be merged in here too, not just in fallbackSeasonConfig's own
// "no season yet" path. Without this, a league that HAS published a
// season would always read back teamStructure: 'fixed' regardless of
// its real value, since a published season's own .config object never
// carries it (the exact "explicit field list" trap languageMode/color
// already got caught by once each -- fixed here before it became a
// live bug instead of after).
function withLeagueBrandingDefault(config, leagueBranding, teamStructure, sportType) {
  let out = config;
  if (leagueBranding && typeof leagueBranding === 'object') {
    out = { ...out, league: { ...leagueBranding, ...(out.league || {}) } };
  }
  if (teamStructure) {
    out = { ...out, teamStructure: out.teamStructure || teamStructure };
  }
  // Part 5 foundation: same reasoning as teamStructure just above --
  // sportType is a league-level property, not part of a published
  // season's own .config object, so it has to be merged in here too.
  if (sportType) {
    out = { ...out, sportType: out.sportType || sportType };
  }
  return out;
}

// leagueRosterLimits: team-structure task -- a 'headcount' league's own
// min/max player count (leagues.min_players/max_players), used the
// same way leagueTeamNames/leagueBranding already are: only when no
// real season config exists yet, so shortage detection against a
// headcount league's OWN chosen numbers works correctly even before
// its first season is ever published, instead of silently reading
// DEFAULT_SEASON_CONFIG's generic 8/5 (SMBHL's own numbers). Reuses
// the existing skatersPerTeam/minSkaters fields rather than inventing
// parallel ones -- a headcount league has exactly one implicit "team"
// (see writeLeagueRsvpStatus's own comment), so these fields already
// mean exactly "how many people total" for it.
function fallbackSeasonConfig(leagueTeamNames, leagueBranding, leagueRosterLimits, leagueTeamStructure, leagueSportType) {
  const hasTeams = Array.isArray(leagueTeamNames) && leagueTeamNames.length > 0;
  const hasBranding = leagueBranding && typeof leagueBranding === 'object';
  const hasLimits = leagueRosterLimits && typeof leagueRosterLimits === 'object'
    && Number.isFinite(Number(leagueRosterLimits.maxPlayers)) && Number.isFinite(Number(leagueRosterLimits.minPlayers));
  // Part 5: minGoalies is optional even when hasLimits is true (0, "no
  // goalie requirement", is a valid, common, intentional headcount
  // choice) -- only included when it's a real finite number, so an
  // absent/undefined minGoalies doesn't accidentally coerce to
  // Number(undefined) = NaN downstream.
  const hasMinGoalies = hasLimits && Number.isFinite(Number(leagueRosterLimits.minGoalies));
  // Live-testing task, Part 5: maxGoalies, same optional posture as
  // minGoalies just above -- only included when it's a real finite
  // number (a league that has never set a distinct max leaves
  // normalizeSeasonConfig to default it to whatever minGoalies resolves
  // to, exactly as before this task).
  const hasMaxGoalies = hasLimits && Number.isFinite(Number(leagueRosterLimits.maxGoalies));
  if (hasTeams || hasBranding || hasLimits || leagueTeamStructure) {
    return normalizeSeasonConfig({
      ...(hasTeams ? { teams: leagueTeamNames } : {}),
      ...(hasBranding ? { league: leagueBranding } : {}),
      ...(hasLimits ? { skatersPerTeam: Number(leagueRosterLimits.maxPlayers), minSkaters: Number(leagueRosterLimits.minPlayers) } : {}),
      // normalizeSeasonConfig now correctly distinguishes an explicit 0
      // from "not provided" (Part 5's own falsy-zero fix), so this can
      // safely pass a real 0 through when that's the league's real
      // min_goalies -- no longer needs to be omitted the way it used
      // to be before that fix.
      ...(hasMinGoalies ? { goaliesPerTeam: Number(leagueRosterLimits.minGoalies) } : {}),
      ...(hasMaxGoalies ? { maxGoalies: Number(leagueRosterLimits.maxGoalies) } : {}),
      ...(leagueTeamStructure ? { teamStructure: leagueTeamStructure } : {}),
      ...(leagueSportType ? { sportType: leagueSportType } : {})
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
 * @param {Object} [leagueRosterLimits] - A 'headcount' league's own
 *   {minPlayers, maxPlayers}, used the same way — only when no real
 *   season config is found
 * @param {string} [leagueTeamStructure] - A league's own team_structure
 *   ('fixed' | 'headcount' | 'weekly_draw') — unlike the other
 *   league-level params above, this one is merged in REGARDLESS of
 *   whether a real season config exists (see withLeagueBrandingDefault's
 *   own comment for why)
 * @param {string} [leagueSportType] - A league's own sport_type
 *   ('hockey' today, always) — same "merged in regardless" treatment
 *   as leagueTeamStructure, for the same reason (Part 5 foundation)
 * @returns {Object} Normalized season config
 */
export function getSeasonConfig(seasonOrData, targetSeasonName = null, leagueTeamNames = null, leagueBranding = null, leagueRosterLimits = null, leagueTeamStructure = null, leagueSportType = null) {
  if (!seasonOrData || typeof seasonOrData !== 'object') {
    return fallbackSeasonConfig(leagueTeamNames, leagueBranding, leagueRosterLimits, leagueTeamStructure, leagueSportType);
  }

  // Case 1: Direct season object carrying .config
  if (seasonOrData.config && typeof seasonOrData.config === 'object') {
    return normalizeSeasonConfig(withLeagueBrandingDefault(seasonOrData.config, leagueBranding, leagueTeamStructure, leagueSportType));
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
      return normalizeSeasonConfig(withLeagueBrandingDefault(seasonObj.config, leagueBranding, leagueTeamStructure, leagueSportType));
    }
  }

  return fallbackSeasonConfig(leagueTeamNames, leagueBranding, leagueRosterLimits, leagueTeamStructure, leagueSportType);
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
    faviconUrl: raw.faviconUrl || DEFAULT_SEASON_CONFIG.league.faviconUrl,
    // Live-testing task (batch 3), Part 1: this narrow branding
    // projection previously dropped languageMode the same way
    // normalizeSeasonConfig once silently dropped it (see that
    // function's own comment) -- body()'s shared email switch reads it
    // from here. SMBHL's own path never has a real languageMode on its
    // KV-sourced `raw.league` (SMBHL is not part of the language_mode
    // system at all -- it's a leagues-table-only column, and SMBHL's
    // season config is read from the legacy data_json KV blob, which
    // has no such field), so this always falls through to the same
    // 'both' DEFAULT_SEASON_CONFIG already had -- SMBHL's own output is
    // provably unaffected by construction, not by a runtime check.
    languageMode: raw.languageMode || DEFAULT_SEASON_CONFIG.league.languageMode
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


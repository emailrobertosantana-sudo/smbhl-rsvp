import PostalMime from 'postal-mime';
import { checkAdminAuth, adminPageHeaders, generateReviewToken } from './admin_auth.js';
import { computeWeeklyRecap } from './highlights.js';
import { sortStandings, getRegularGoalsByTeam, updatePlayoffSchedule } from './awards.js';
import { DEFAULT_SEASON_CONFIG, getSeasonConfig, getSeasonConfigFromEnv, getTeamNames, normalizeTeamWithConfig, tracksStats, getLeagueConfig } from './season_config.js';

const STATS_DISABLED_MSG = 'Cette ligue ne suit pas de statistiques pour cette saison (tracksStats: false). / This league does not track stats for this season.';

/**
 * Normalizes a raw team string to its canonical name using the season's config
 * (team names, name_fr, and aliases). Falls back to SMBHL defaults when no
 * config is given, and to a loose substring match (e.g. "blue team") when
 * neither an exact name/name_fr nor an alias matches.
 */
export function normalizeTeam(str, config) {
  if (!str) return null;
  const cfg = config && config.teams ? config : DEFAULT_SEASON_CONFIG;
  const s = String(str).trim();

  if (getTeamNames(cfg).includes(s)) return s;

  const viaConfig = normalizeTeamWithConfig(s, cfg);
  if (viaConfig) return viaConfig;

  const lower = s.toLowerCase();
  for (const t of cfg.teams) {
    if (lower.includes(t.name.toLowerCase())) return t.name;
    if (t.name_fr && lower.includes(t.name_fr.toLowerCase())) return t.name;
  }
  return s;
}

export function cleanName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function matchPlayerName(inputName, candidateList) {
  if (!inputName || !candidateList || !candidateList.length) return null;
  const target = cleanName(inputName);
  if (!target) return null;

  // 1. Exact cleaned match
  for (const c of candidateList) {
    if (cleanName(c.name) === target) return c;
  }

  // 2. Initial + Last Name match (e.g. "Sam C." or "S. Cartwright" vs "Sam Cartwright")
  const targetParts = target.split(' ');
  for (const c of candidateList) {
    const cParts = cleanName(c.name).split(' ');
    if (targetParts.length >= 2 && cParts.length >= 2) {
      const firstTarget = targetParts[0];
      const lastTarget = targetParts[targetParts.length - 1];
      const firstC = cParts[0];
      const lastC = cParts[cParts.length - 1];

      if (firstTarget === firstC && lastTarget[0] === lastC[0]) return c;
      if (lastTarget === lastC && firstTarget[0] === firstC[0]) return c;
    }
  }

  // 3. Multi-word substring match (e.g. if middle name omitted)
  if (targetParts.length >= 2) {
    for (const c of candidateList) {
      const cClean = cleanName(c.name);
      if (cClean.includes(target) || target.includes(cClean)) {
        return c;
      }
    }
  } else if (target.length >= 4) {
    // Single-word: ONLY match if it uniquely matches exactly ONE candidate's last name
    // (Never auto-match single-word first names like "Mike" to avoid assigning stats to the wrong person)
    const matchingLastName = candidateList.filter(c => {
      const parts = cleanName(c.name).split(' ');
      return parts.length >= 2 && parts[parts.length - 1] === target;
    });
    if (matchingLastName.length === 1) {
      return matchingLastName[0];
    }
  }

  return null;
}

export function detectMime(buf, fallbackMime = 'image/jpeg') {
  if (!buf) return 'image/jpeg';
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'image/heic';
  if (fallbackMime && fallbackMime.startsWith('image/')) return fallbackMime;
  return 'image/jpeg';
}

export function bufferToBase64(buffer) {
  if (!buffer) return '';
  if (typeof buffer === 'string') return buffer;
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buffer).toString('base64');
  }
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

export function extractJsonFromText(text) {
  if (!text) throw new Error('Empty response from model');
  let s = text.trim();
  const codeBlockMatch = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    s = codeBlockMatch[1].trim();
  }
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    s = s.substring(firstBrace, lastBrace + 1);
  }
  s = s.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(s);
}

export function deduceTeamFromPlayers(sheet) {
  if (!sheet) return null;
  const direct = normalizeTeam(sheet.team);
  if (direct && ['Red', 'Blue', 'White', 'Black'].includes(direct)) return direct;

  const ROSTERS = {
    Red: ['Adam Albanese', 'Brad Mackenzie', 'François Beaucaire-Gaudreau', 'Joseph Tremonte', 'Nicola Tiberio', 'Yannick Gauthier', 'Max Latreille'],
    Blue: ['Daniel Vespa', 'Greg D\'Alesio', 'Jack Tessari', 'Joe Gallo', 'Sylvain Couturier', 'Tyler Myrans', 'Yanick Audet'],
    White: ['Carlo Russo', 'Chase Brunetti', 'David Emond', 'Guillaume Thibault', 'Michael Tremonte', 'Mike D\'Alesio', 'Roberto Santana', 'JP Flood'],
    Black: ['Anthony Coventry', 'Anthony Saragoca', 'Jerry Lalli', 'Kevin Di Lallo', 'Michael Dalla Libera', 'Richard Di Lallo', 'Roberto Lalli', 'Brandon Cummings']
  };

  const scores = { Red: 0, Blue: 0, White: 0, Black: 0 };
  const names = [
    sheet.goalie?.name,
    ...(sheet.players || []).map(p => p.name)
  ].filter(Boolean);

  for (const n of names) {
    const c = cleanName(n);
    if (!c) continue;
    for (const [team, roster] of Object.entries(ROSTERS)) {
      for (const r of roster) {
        const cr = cleanName(r);
        if (c.includes(cr) || cr.includes(c)) {
          scores[team]++;
          break;
        }
      }
    }
  }

  let topTeam = null;
  let maxScore = 0;
  for (const [t, s] of Object.entries(scores)) {
    if (s > maxScore) {
      maxScore = s;
      topTeam = t;
    }
  }

  return (topTeam && maxScore >= 2) ? topTeam : direct;
}

export async function parseSheetWithGemini(apiKey, imageBuffer, mimeType = 'image/jpeg') {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const base64Data = bufferToBase64(imageBuffer);
  const normalizedMime = detectMime(imageBuffer, mimeType);

  const prompt = `You are an expert sports scoresheet parser for SMBHL (Sunday Morning Ball Hockey League).
Analyze this scoresheet photo.
CRITICAL RULES FOR SMBHL SCORESHEETS:
1. TEAM: Identify the team name for this scoresheet (Red, Blue, White, or Black). In French, Rouge = Red, Bleu = Blue, Blanc = White, Noir = Black.
Core players for each team (use these names to determine the sheet's team even if the header is missing):
- Red: Adam Albanese, Brad Mackenzie, François Beaucaire-Gaudreau, Joseph Tremonte, Nicola Tiberio, Yannick Gauthier, Max Latreille
- Blue: Daniel Vespa, Greg D'Alesio, Jack Tessari, Joe Gallo, Sylvain Couturier, Tyler Myrans, Yanick Audet
- White: Carlo Russo, Chase Brunetti, David Emond, Guillaume Thibault, Michael Tremonte, Mike D'Alesio, Roberto Santana, JP Flood
- Black: Anthony Coventry / Saragoca, Jerry Lalli, Kevin Di Lallo, Michael Dalla Libera, Richard Di Lallo, Roberto Lalli, Brandon Cummings

2. GOALS AND ASSISTS ARE RECORDED AS VERTICAL TALLY MARKS / DASHES (e.g. '|' = 1, '||' = 2, '|||' = 3), NOT DIGITS. If a box is empty, it is 0.
CRITICAL LEAGUE RULE FOR ASSISTS: In SMBHL ball hockey, each goal scored can have at most ONE assist credited (1 goal = maximum 1 assist; no secondary assists). A team's total assists in a game can NEVER exceed its total goals scored (total assists <= total goals). Count tally marks carefully with this rule in mind.
3. ABSENT PLAYERS are crossed out (horizontal strike-through line through their name). Set absent: true. If a player is crossed out, they did not play.
4. GOALIE is listed in the goalie row (top row with 'G' or 'Goalie'). Read their name and goals against (GA) in Game 1 and Game 2.
5. SUBS are handwritten on the blank rows at the bottom. Identify their names, whether they played, and their tally marks.
6. FINAL SCORES: Read the score boxes at the bottom of the sheet for Game 1 and Game 2.

Return ONLY a valid JSON object matching this structure:
{
  "team": "Red | Blue | White | Black",
  "week": number or null,
  "date": "string or null",
  "goalie": {
    "name": "string",
    "is_sub": boolean,
    "game1_ga": number or null,
    "game2_ga": number or null
  },
  "game1": {
    "opponent": "string",
    "time": "string or null",
    "gym": "string or null",
    "team_score": number or null,
    "opponent_score": number or null
  },
  "game2": {
    "opponent": "string",
    "time": "string or null",
    "gym": "string or null",
    "team_score": number or null,
    "opponent_score": number or null
  },
  "players": [
    {
      "name": "string",
      "absent": boolean,
      "is_sub": boolean,
      "game1_goals": number,
      "game1_assists": number,
      "game2_goals": number,
      "game2_assists": number
    }
  ]
}`;

  const candidateModels = [
    'gemini-3.6-flash',
    'gemini-3.5-flash'
  ];

  let lastError = null;
  for (let i = 0; i < candidateModels.length; i++) {
    const model = candidateModels[i];
    let attempts = 0;
    const maxAttempts = 3;
    let response = null;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: normalizedMime,
                    data: base64Data
                  }
                }
              ]
            }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.1
            }
          })
        });

        // 503: High demand spike, 429: Rate limited, 500/502/504: Temporary backend glitches
        if (response.status === 429 || response.status === 503 || response.status === 500 || response.status === 502 || response.status === 504) {
          if (attempts < maxAttempts) {
            const waitMs = attempts * 3000;
            console.warn(`Gemini temporary error ${response.status} (${model}), retrying attempt ${attempts}/${maxAttempts} in ${waitMs}ms...`);
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
        }

        break;
      } catch (networkErr) {
        console.warn(`Network error calling Gemini (${model}) attempt ${attempts}/${maxAttempts}:`, networkErr);
        if (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, attempts * 2500));
          continue;
        }
        lastError = networkErr;
        break;
      }
    }

    if (!response) {
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`Gemini API error ${response.status} (${model}): ${errText.slice(0, 300)}`);
      lastError = new Error(`Gemini (${model}) ${response.status}: ${errText.slice(0, 250)}`);
      continue;
    }

    const json = await response.json();
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      lastError = new Error(`No content returned from Gemini (${model})`);
      continue;
    }

    const parsed = extractJsonFromText(text);
    if (!parsed) {
      lastError = new Error(`Failed to parse JSON from Gemini response (${model})`);
      continue;
    }

    parsed.team = deduceTeamFromPlayers(parsed) || parsed.team;
    return parsed;
  }

  throw lastError || new Error('All candidate Gemini models failed');
}

export function validateGameStats(game, options = {}) {
  const maxAssistsPerGoal = options.maxAssistsPerGoal ?? game.max_assists_per_goal ?? 1;
  const warnings = [];
  const homeGoalsSum = (game.home_players || []).reduce((acc, p) => acc + (p.absent ? 0 : (Number(p.goals) || 0)), 0);
  const awayGoalsSum = (game.away_players || []).reduce((acc, p) => acc + (p.absent ? 0 : (Number(p.goals) || 0)), 0);
  const homeAssistsSum = (game.home_players || []).reduce((acc, p) => acc + (p.absent ? 0 : (Number(p.assists) || 0)), 0);
  const awayAssistsSum = (game.away_players || []).reduce((acc, p) => acc + (p.absent ? 0 : (Number(p.assists) || 0)), 0);

  const homeScore = game.home_score !== null && game.home_score !== '' ? Number(game.home_score) : null;
  const awayScore = game.away_score !== null && game.away_score !== '' ? Number(game.away_score) : null;

  // 1. Cross-sheet reported score conflict check (e.g. Red says 6-4, White says 6-5)
  if (game.home_sheet_score && game.away_sheet_score) {
    const hHome = game.home_sheet_score.home;
    const hAway = game.home_sheet_score.away;
    const aHome = game.away_sheet_score.home;
    const aAway = game.away_sheet_score.away;

    if ((hHome !== null && aHome !== null && hHome !== aHome) ||
        (hAway !== null && aAway !== null && hAway !== aAway)) {
      warnings.push(`⚠️ Conflit entre les 2 feuilles : feuille ${game.home_team} indique ${hHome}-${hAway}, mais feuille ${game.away_team} indique ${aHome}-${aAway}`);
    }
  }

  // 2. Missing sheets check
  if (game.has_home_sheet === false && game.has_away_sheet === false) {
    warnings.push(`Feuilles non reçues pour ce match (${game.home_team} vs ${game.away_team})`);
  } else if (game.has_home_sheet === false) {
    warnings.push(`Feuille ${game.home_team} manquante (alignement & statistiques incomplets côté ${game.home_team})`);
  } else if (game.has_away_sheet === false) {
    warnings.push(`Feuille ${game.away_team} manquante (alignement & statistiques incomplets côté ${game.away_team})`);
  }

  // 3. Player goals sum vs score
  if (homeScore !== null && game.has_home_sheet !== false && homeGoalsSum !== homeScore) {
    warnings.push(`${game.home_team}: Somme des buts des joueurs (${homeGoalsSum}) ≠ Pointage final (${homeScore})`);
  }

  if (awayScore !== null && game.has_away_sheet !== false && awayGoalsSum !== awayScore) {
    warnings.push(`${game.away_team}: Somme des buts des joueurs (${awayGoalsSum}) ≠ Pointage final (${awayScore})`);
  }

  // 4. Max assists check (cannot exceed goals, max 1 assist per goal in SMBHL)
  const effectiveHomeGoals = homeScore !== null ? homeScore : homeGoalsSum;
  const effectiveAwayGoals = awayScore !== null ? awayScore : awayGoalsSum;
  const maxHomeAssists = effectiveHomeGoals * maxAssistsPerGoal;
  const maxAwayAssists = effectiveAwayGoals * maxAssistsPerGoal;

  if (game.has_home_sheet !== false && homeAssistsSum > maxHomeAssists) {
    warnings.push(`${game.home_team}: Plus de passes (${homeAssistsSum}) que de buts permises (${maxHomeAssists}). Maximum ${maxAssistsPerGoal} passe${maxAssistsPerGoal > 1 ? 's' : ''} par but.`);
  }

  if (game.has_away_sheet !== false && awayAssistsSum > maxAwayAssists) {
    warnings.push(`${game.away_team}: Plus de passes (${awayAssistsSum}) que de buts permises (${maxAwayAssists}). Maximum ${maxAssistsPerGoal} passe${maxAssistsPerGoal > 1 ? 's' : ''} par but.`);
  }

  // 5. Opposing goalie GA checks
  const homeGoalieGa = game.home_goalie?.ga !== null && game.home_goalie?.ga !== '' ? Number(game.home_goalie.ga) : null;
  const awayGoalieGa = game.away_goalie?.ga !== null && game.away_goalie?.ga !== '' ? Number(game.away_goalie.ga) : null;

  if (homeScore !== null && awayGoalieGa !== null && awayGoalieGa !== homeScore) {
    warnings.push(`Gardien ${game.away_team} (${game.away_goalie?.name || 'Gardien'}): Buts accordés (${awayGoalieGa}) ≠ Buts ${game.home_team} (${homeScore})`);
  }

  if (awayScore !== null && homeGoalieGa !== null && homeGoalieGa !== awayScore) {
    warnings.push(`Gardien ${game.home_team} (${game.home_goalie?.name || 'Gardien'}): Buts accordés (${homeGoalieGa}) ≠ Buts ${game.away_team} (${awayScore})`);
  }

  const balanced = warnings.length === 0 && homeScore !== null && awayScore !== null && game.has_home_sheet !== false && game.has_away_sheet !== false;
  return {
    ...game,
    home_score: homeScore,
    away_score: awayScore,
    home_goals_sum: homeGoalsSum,
    away_goals_sum: awayGoalsSum,
    home_assists_sum: homeAssistsSum,
    away_assists_sum: awayAssistsSum,
    max_assists_per_goal: maxAssistsPerGoal,
    balanced,
    warnings
  };
}

export function consolidateSheetsIntoGames(parsedSheets, fixtures = [], candidatePlayers = [], options = {}) {
  // Group 4 fixtures of the week
  const gamesMap = new Map();

  for (const f of fixtures) {
    const key = `${f.home}-${f.away}`;
    gamesMap.set(key, {
      id: `game_${f.week}_${f.home}_${f.away}`,
      week: f.week,
      date: f.date,
      venue: f.venue,
      time: f.time,
      gym: f.gym,
      home_team: f.home,
      away_team: f.away,
      home_score: f.hg !== undefined ? f.hg : null,
      away_score: f.ag !== undefined ? f.ag : null,
      home_sheet_score: null,
      away_sheet_score: null,
      has_home_sheet: false,
      has_away_sheet: false,
      home_goalie: { name: '', id: null, ga: null, is_sub: false },
      away_goalie: { name: '', id: null, ga: null, is_sub: false },
      home_players: [],
      away_players: []
    });
  }

  const teamCfg = options.config;

  for (const sheet of parsedSheets) {
    const team = normalizeTeam(sheet.team, teamCfg);
    if (!team) continue;

    const processSheetGame = (gameData, isG1) => {
      if (!gameData) return;
      let opp = normalizeTeam(gameData.opponent, teamCfg);
      let gameKey = opp ? (gamesMap.has(`${team}-${opp}`) ? `${team}-${opp}` : `${opp}-${team}`) : null;
      let game = gameKey ? gamesMap.get(gameKey) : null;

      // Fallback: match by scheduled fixture order if opponent name is missing or unmatched
      if (!game && fixtures.length > 0) {
        const teamFixtures = fixtures.filter(f => f.home === team || f.away === team)
          .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
        const targetFixture = isG1 ? teamFixtures[0] : teamFixtures[1];
        if (targetFixture) {
          gameKey = `${targetFixture.home}-${targetFixture.away}`;
          game = gamesMap.get(gameKey);
        }
      }
      if (!game) return;

      const isHome = game.home_team === team;
      const teamScore = gameData.team_score !== null && gameData.team_score !== undefined ? Number(gameData.team_score) : null;
      const oppScore = gameData.opponent_score !== null && gameData.opponent_score !== undefined ? Number(gameData.opponent_score) : null;

      if (isHome) {
        game.has_home_sheet = true;
        game.home_sheet_score = { home: teamScore, away: oppScore };
        if (teamScore !== null) game.home_score = teamScore;
        if (oppScore !== null && game.away_score === null) game.away_score = oppScore;
      } else {
        game.has_away_sheet = true;
        game.away_sheet_score = { home: oppScore, away: teamScore };
        if (teamScore !== null) game.away_score = teamScore;
        if (oppScore !== null && game.home_score === null) game.home_score = oppScore;
      }

      const goalieGa = isG1 ? sheet.goalie?.game1_ga : sheet.goalie?.game2_ga;
      const matchedGoalie = matchPlayerName(sheet.goalie?.name, candidatePlayers);
      const goalieData = {
        name: matchedGoalie ? matchedGoalie.name : (sheet.goalie?.name || ''),
        id: matchedGoalie ? (matchedGoalie.player_id || matchedGoalie.id) : null,
        ga: goalieGa !== null && goalieGa !== undefined ? Number(goalieGa) : null,
        is_sub: !!sheet.goalie?.is_sub
      };
      if (isHome) game.home_goalie = goalieData;
      else game.away_goalie = goalieData;

      const roster = (sheet.players || []).map(p => {
        const matched = matchPlayerName(p.name, candidatePlayers);
        return {
          name: matched ? matched.name : p.name,
          id: matched ? (matched.player_id || matched.id) : null,
          is_sub: !!p.is_sub,
          absent: !!p.absent,
          goals: Number(isG1 ? p.game1_goals : p.game2_goals) || 0,
          assists: Number(isG1 ? p.game1_assists : p.game2_assists) || 0
        };
      });

      if (isHome) game.home_players = roster;
      else game.away_players = roster;
    };

    processSheetGame(sheet.game1, true);
    processSheetGame(sheet.game2, false);
  }

  return Array.from(gamesMap.values()).map(g => validateGameStats(g, options));
}

export function updateLeagueDataWithReview(originalData, week, games, subPlayerIds = null) {
  const d = JSON.parse(JSON.stringify(originalData));
  const s0 = d.seasons && d.seasons[0];
  if (!s0) throw new Error('No current season found in data.json');

  const seasonName = s0.name || d.current_season || 'Fall 2026';
  const cfg = getSeasonConfig(d, seasonName);

  const maxWeek = Math.max(...(s0.fixtures || []).map(f => Number(f.week) || 0));
  const regularFixtures = (s0.fixtures || []).filter(f => Number(f.week) < maxWeek);
  const isPlayoffWeek = regularFixtures.length > 0 && Number(week) === maxWeek;

  // 1. Update fixtures for this week
  for (const g of games) {
    const f = (s0.fixtures || []).find(x => x.week === Number(week) &&
      (((x.home === g.home_team && x.away === g.away_team) || (x.home === g.away_team && x.away === g.home_team)) ||
       (x.home === 'TBD' && x.away === 'TBD' && g.time && x.time === g.time && (!g.gym || x.gym === g.gym))));
    if (f) {
      if (f.home === 'TBD' && f.away === 'TBD') {
        f.home = g.home_team;
        f.away = g.away_team;
      }
      if (f.home === g.home_team) {
        f.hg = Number(g.home_score);
        f.ag = Number(g.away_score);
      } else {
        f.hg = Number(g.away_score);
        f.ag = Number(g.home_score);
      }

      const isHome = f.home === g.home_team;
      const hPlayers = isHome ? (g.home_players || []) : (g.away_players || []);
      const aPlayers = isHome ? (g.away_players || []) : (g.home_players || []);
      const hGoalie = isHome ? g.home_goalie : g.away_goalie;
      const aGoalie = isHome ? g.away_goalie : g.home_goalie;

      f.boxscore = {
        home_goalie: hGoalie && hGoalie.name ? {
          name: hGoalie.name,
          id: hGoalie.id || null,
          ga: hGoalie.ga != null ? Number(hGoalie.ga) : f.ag,
          is_sub: !!hGoalie.is_sub || (subPlayerIds && hGoalie.id && subPlayerIds.has(hGoalie.id))
        } : null,
        away_goalie: aGoalie && aGoalie.name ? {
          name: aGoalie.name,
          id: aGoalie.id || null,
          ga: aGoalie.ga != null ? Number(aGoalie.ga) : f.hg,
          is_sub: !!aGoalie.is_sub || (subPlayerIds && aGoalie.id && subPlayerIds.has(aGoalie.id))
        } : null,
        home_players: hPlayers.filter(p => !p.absent).map(p => ({
          name: p.name,
          id: p.id || null,
          goals: Number(p.goals) || 0,
          assists: Number(p.assists) || 0,
          is_sub: !!p.is_sub || (subPlayerIds && p.id && subPlayerIds.has(p.id))
        })),
        away_players: aPlayers.filter(p => !p.absent).map(p => ({
          name: p.name,
          id: p.id || null,
          goals: Number(p.goals) || 0,
          assists: Number(p.assists) || 0,
          is_sub: !!p.is_sub || (subPlayerIds && p.id && subPlayerIds.has(p.id))
        }))
      };
    }
  }

  // 2. Recalculate Standings from all played regular season fixtures
  const standingsMap = {};
  for (const t of getTeamNames(cfg)) {
    standingsMap[t] = { team: t, gp: 0, w: 0, l: 0, t: 0, pts: 0, gf: 0, ga: 0 };
  }

  let totalPlayedGames = 0;
  let totalGoals = 0;

  for (const f of (s0.fixtures || [])) {
    // Only count regular season games (< maxWeek) in standings and regular season stats
    if ((!isPlayoffWeek || Number(f.week) < maxWeek) && f.hg !== null && f.ag !== null && f.hg !== undefined && f.ag !== undefined) {
      totalPlayedGames++;
      const h = f.home;
      const a = f.away;
      const hg = Number(f.hg);
      const ag = Number(f.ag);
      totalGoals += (hg + ag);

      if (standingsMap[h]) {
        standingsMap[h].gp++;
        standingsMap[h].gf += hg;
        standingsMap[h].ga += ag;
      }
      if (standingsMap[a]) {
        standingsMap[a].gp++;
        standingsMap[a].gf += ag;
        standingsMap[a].ga += hg;
      }

      if (hg > ag) {
        if (standingsMap[h]) { standingsMap[h].w++; standingsMap[h].pts += 2; }
        if (standingsMap[a]) { standingsMap[a].l++; }
      } else if (ag > hg) {
        if (standingsMap[a]) { standingsMap[a].w++; standingsMap[a].pts += 2; }
        if (standingsMap[h]) { standingsMap[h].l++; }
      } else {
        if (standingsMap[h]) { standingsMap[h].t++; standingsMap[h].pts += 1; }
        if (standingsMap[a]) { standingsMap[a].t++; standingsMap[a].pts += 1; }
      }
    }
  }

  s0.standings = sortStandings(Object.values(standingsMap), getRegularGoalsByTeam(d, seasonName));
  s0.games = totalPlayedGames;
  s0.goals_per_game = totalPlayedGames > 0 ? Number((totalGoals / totalPlayedGames).toFixed(2)) : 0;

  // 3. Update player stats (only during regular season; SMBHL does not tally player goals/assists for playoffs)
  if (!isPlayoffWeek) {
    if (!d.players) d.players = [];

    const playerStatsDelta = new Map(); // id or cleanName -> { gp, g, a, name, team, isGoalie, isSub, goalieStats: { gp, ga, w, l, t, so } }

  for (const g of games) {
    const hScore = Number(g.home_score);
    const aScore = Number(g.away_score);
    const homeGoalieKey = (g.home_goalie && g.home_goalie.name) ? (g.home_goalie.id || cleanName(g.home_goalie.name)) : null;
    const awayGoalieKey = (g.away_goalie && g.away_goalie.name) ? (g.away_goalie.id || cleanName(g.away_goalie.name)) : null;

    // Home players
    for (const p of (g.home_players || [])) {
      if (p.absent) continue;
      const key = p.id || cleanName(p.name);
      const isThisGoalie = homeGoalieKey && key === homeGoalieKey;
      const isSub = !!p.is_sub || (subPlayerIds && p.id && subPlayerIds.has(p.id));
      if (!playerStatsDelta.has(key)) {
        playerStatsDelta.set(key, { id: p.id, name: p.name, team: g.home_team, isSub, gp: 0, g: 0, a: 0, isGoalie: !!isThisGoalie, goalieStats: isThisGoalie ? { gp: 0, ga: 0, w: 0, l: 0, t: 0, so: 0, g: 0, a: 0 } : null });
      }
      const record = playerStatsDelta.get(key);
      if (isSub) record.isSub = true;
      if (isThisGoalie) {
        record.isGoalie = true;
        if (!record.goalieStats) record.goalieStats = { gp: 0, ga: 0, w: 0, l: 0, t: 0, so: 0, g: 0, a: 0 };
        record.goalieStats.g = (record.goalieStats.g || 0) + (Number(p.goals) || 0);
        record.goalieStats.a = (record.goalieStats.a || 0) + (Number(p.assists) || 0);
      } else {
        record.gp += 1;
        record.g += Number(p.goals) || 0;
        record.a += Number(p.assists) || 0;
      }
    }

    // Away players
    for (const p of (g.away_players || [])) {
      if (p.absent) continue;
      const key = p.id || cleanName(p.name);
      const isThisGoalie = awayGoalieKey && key === awayGoalieKey;
      const isSub = !!p.is_sub || (subPlayerIds && p.id && subPlayerIds.has(p.id));
      if (!playerStatsDelta.has(key)) {
        playerStatsDelta.set(key, { id: p.id, name: p.name, team: g.away_team, isSub, gp: 0, g: 0, a: 0, isGoalie: !!isThisGoalie, goalieStats: isThisGoalie ? { gp: 0, ga: 0, w: 0, l: 0, t: 0, so: 0, g: 0, a: 0 } : null });
      }
      const record = playerStatsDelta.get(key);
      if (isSub) record.isSub = true;
      if (isThisGoalie) {
        record.isGoalie = true;
        if (!record.goalieStats) record.goalieStats = { gp: 0, ga: 0, w: 0, l: 0, t: 0, so: 0, g: 0, a: 0 };
        record.goalieStats.g = (record.goalieStats.g || 0) + (Number(p.goals) || 0);
        record.goalieStats.a = (record.goalieStats.a || 0) + (Number(p.assists) || 0);
      } else {
        record.gp += 1;
        record.g += Number(p.goals) || 0;
        record.a += Number(p.assists) || 0;
      }
    }

    // Home Goalie
    if (g.home_goalie && g.home_goalie.name) {
      const key = g.home_goalie.id || cleanName(g.home_goalie.name);
      const ga = Number(g.home_goalie.ga) || aScore || 0;
      const w = hScore > aScore ? 1 : 0;
      const l = hScore < aScore ? 1 : 0;
      const t = hScore === aScore ? 1 : 0;
      const so = ga === 0 ? 1 : 0;
      const isSub = !!g.home_goalie.is_sub || (subPlayerIds && g.home_goalie.id && subPlayerIds.has(g.home_goalie.id));

      if (!playerStatsDelta.has(key)) {
        playerStatsDelta.set(key, { id: g.home_goalie.id, name: g.home_goalie.name, team: g.home_team, isSub, gp: 0, g: 0, a: 0, isGoalie: true, goalieStats: { gp: 0, ga: 0, w: 0, l: 0, t: 0, so: 0 } });
      }
      const record = playerStatsDelta.get(key);
      if (isSub) record.isSub = true;
      record.isGoalie = true;
      if (!record.goalieStats) record.goalieStats = { gp: 0, ga: 0, w: 0, l: 0, t: 0, so: 0 };
      record.goalieStats.gp += 1;
      record.goalieStats.ga += ga;
      record.goalieStats.w += w;
      record.goalieStats.l += l;
      record.goalieStats.t += t;
      record.goalieStats.so += so;
    }

    // Away Goalie
    if (g.away_goalie && g.away_goalie.name) {
      const key = g.away_goalie.id || cleanName(g.away_goalie.name);
      const ga = Number(g.away_goalie.ga) || hScore || 0;
      const w = aScore > hScore ? 1 : 0;
      const l = aScore < hScore ? 1 : 0;
      const t = aScore === hScore ? 1 : 0;
      const so = ga === 0 ? 1 : 0;
      const isSub = !!g.away_goalie.is_sub || (subPlayerIds && g.away_goalie.id && subPlayerIds.has(g.away_goalie.id));

      if (!playerStatsDelta.has(key)) {
        playerStatsDelta.set(key, { id: g.away_goalie.id, name: g.away_goalie.name, team: g.away_team, isSub, gp: 0, g: 0, a: 0, isGoalie: true, goalieStats: { gp: 0, ga: 0, w: 0, l: 0, t: 0, so: 0 } });
      }
      const record = playerStatsDelta.get(key);
      if (isSub) record.isSub = true;
      record.isGoalie = true;
      if (!record.goalieStats) record.goalieStats = { gp: 0, ga: 0, w: 0, l: 0, t: 0, so: 0 };
      record.goalieStats.gp += 1;
      record.goalieStats.ga += ga;
      record.goalieStats.w += w;
      record.goalieStats.l += l;
      record.goalieStats.t += t;
      record.goalieStats.so += so;
    }
  }

  // Apply deltas to data.players
  for (const [_, delta] of playerStatsDelta.entries()) {
    let p = d.players.find(x => (delta.id && x.id === delta.id) || cleanName(x.name) === cleanName(delta.name));
    if (!p) {
      // Create new player
      const nextIdNum = d.players.reduce((max, cur) => {
        const num = parseInt((cur.id || '').replace(/\D/g, ''), 10);
        return !isNaN(num) && num > max ? num : max;
      }, 0) + 1;
      const newId = `P${String(nextIdNum).padStart(4, '0')}`;
      p = {
        id: newId,
        key: delta.name.toUpperCase(),
        name: delta.name,
        seasons: {},
        gseasons: {},
        career: { gp: 0, g: 0, a: 0, pts: 0 },
        gcareer: { gp: 0, w: 0, l: 0, t: 0, ga: 0, so: 0 },
        legacy: false,
        titles: []
      };
      d.players.push(p);
    }

    if (!p.seasons) p.seasons = {};
    if (!p.gseasons) p.gseasons = {};
    if (!p.career) p.career = { gp: 0, g: 0, a: 0, pts: 0 };
    if (!p.gcareer) p.gcareer = { gp: 0, w: 0, l: 0, t: 0, ga: 0, so: 0 };

    const isSub = !!delta.isSub ||
      (subPlayerIds && ((delta.id && subPlayerIds.has(delta.id)) || (p.id && subPlayerIds.has(p.id)))) ||
      (p.seasons?.[seasonName]?.team === null) ||
      (p.gseasons?.[seasonName]?.team === null);

    // Skater stats
    if (delta.gp > 0) {
      if (!p.seasons[seasonName]) {
        p.seasons[seasonName] = { team: isSub ? null : delta.team, pos: null, gp: 0, g: 0, a: 0, pts: 0 };
      } else if (isSub) {
        p.seasons[seasonName].team = null;
      }
      const sStat = p.seasons[seasonName];
      sStat.gp += delta.gp;
      sStat.g += delta.g;
      sStat.a += delta.a;
      sStat.pts = sStat.g + sStat.a;

      if (isSub && delta.team) {
        if (!sStat.with) sStat.with = {};
        if (!sStat.with[delta.team]) sStat.with[delta.team] = { gp: 0, g: 0, a: 0, pts: 0 };
        sStat.with[delta.team].gp += delta.gp;
        sStat.with[delta.team].g += delta.g;
        sStat.with[delta.team].a += delta.a;
        sStat.with[delta.team].pts += (delta.g + delta.a);
      }

      p.career.gp += delta.gp;
      p.career.g += delta.g;
      p.career.a += delta.a;
      p.career.pts = p.career.g + p.career.a;
    }

    // Goalie stats
    if (delta.isGoalie && delta.goalieStats) {
      if (!p.gseasons[seasonName]) {
        p.gseasons[seasonName] = { team: isSub ? null : delta.team, gp: 0, ga: 0, w: 0, l: 0, t: 0, so: 0, g: 0, a: 0 };
      } else if (isSub) {
        p.gseasons[seasonName].team = null;
      }
      const gStat = p.gseasons[seasonName];
      gStat.gp += delta.goalieStats.gp;
      gStat.ga += delta.goalieStats.ga;
      gStat.w += delta.goalieStats.w;
      gStat.l += delta.goalieStats.l;
      gStat.t += delta.goalieStats.t;
      gStat.so += delta.goalieStats.so;
      gStat.g = (gStat.g || 0) + (delta.goalieStats.g || 0);
      gStat.a = (gStat.a || 0) + (delta.goalieStats.a || 0);

      p.gcareer.gp += delta.goalieStats.gp;
      p.gcareer.ga += delta.goalieStats.ga;
      p.gcareer.w += delta.goalieStats.w;
      p.gcareer.l += delta.goalieStats.l;
      p.gcareer.t += delta.goalieStats.t;
      p.gcareer.so += delta.goalieStats.so;
      p.gcareer.g = (p.gcareer.g || 0) + (delta.goalieStats.g || 0);
      p.gcareer.a = (p.gcareer.a || 0) + (delta.goalieStats.a || 0);
    }
  }
}

  const regGoals = getRegularGoalsByTeam(d, seasonName);
  s0.standings = sortStandings(Object.values(standingsMap), regGoals);
  updatePlayoffSchedule(s0, d);

  d.updated = new Date().toISOString().slice(0, 10);
  return d;
}

export function renderReviewPage(review, candidatePlayers = [], options = {}) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const images = JSON.parse(review.images_json || '[]');
  const games = JSON.parse(review.validated_json || '[]');
  const parsedSheets = JSON.parse(review.extracted_json || '[]');
  const teamCfg = options.config && options.config.teams ? options.config : DEFAULT_SEASON_CONFIG;
  const teamNames = getTeamNames(teamCfg);
  const receivedTeams = [...new Set(parsedSheets.map(s => normalizeTeam(s.team, teamCfg)).filter(Boolean))];
  const missingTeams = teamNames.filter(t => !receivedTeams.includes(t));
  const isPublished = review.status === 'published';
  const isDiscarded = review.status === 'discarded';
  const showStatsTabs = tracksStats(options.config);
  // Present only for a scoped single-review token visitor (the scoresheet
  // email link) — empty for the normal admin-key flow. Safe to embed as-is:
  // unlike the ADMIN_KEY, this is already scoped to this one review and the
  // recipient already has it via the URL that got them here.
  const reviewToken = options.reviewToken || { rt: '', exp: '' };
  const reviewTokenQS = reviewToken.rt ? `&rt=${encodeURIComponent(reviewToken.rt)}&exp=${encodeURIComponent(reviewToken.exp)}` : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMBHL · Validation des feuilles (Semaine ${review.week})</title>
<link rel="icon" href="https://smbhl.com/img/favicon-32.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: #16181d;
    --ink-soft: #5d636e;
    --rule: #dde1e7;
    --rule-dark: #b9bec7;
    --bg: #f4f5f8;
    --white: #ffffff;
    --red: #b3122c;
    --blue: #17457f;
    --green: #15803d;
    --green-bg: #dcfce7;
    --warn: #b45309;
    --warn-bg: #fef3c7;
    --danger: #b91c1c;
    --danger-bg: #fee2e2;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; background: var(--bg); color: var(--ink);
    font-family: 'Barlow', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 15px; line-height: 1.4;
  }
  .top { background: var(--ink); color: #fff; padding: 14px 0; }
  .top .wrap { max-width: 1100px; margin: 0 auto; padding: 0 16px; display: flex; align-items: center; justify-content: space-between; }
  .top img { height: 30px; }
  .langswitch { display: flex; gap: 4px; align-items: center; }
  .langbtn {
    font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 13px;
    padding: 3px 8px; border-radius: 3px; border: 1px solid #4a5160;
    background: transparent; color: #9aa1ac; cursor: pointer; line-height: 1.2;
  }
  .langbtn:hover { color: #fff; border-color: #9aa1ac; }
  .langbtn.on { background: #fff; border-color: #fff; color: #16181d; }
  .picker { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 16px; }
  .tabbtn {
    font-family: 'Barlow Condensed', sans-serif; font-weight: 600; font-size: 14px;
    padding: 6px 11px; border: 1px solid var(--rule-dark); background: var(--white);
    color: var(--ink-soft); text-decoration: none; border-radius: 3px; display: inline-block; white-space: nowrap;
  }
  .tabbtn.on { background: var(--ink); border-color: var(--ink); color: #fff; }
  .tabbtn:hover { border-color: var(--ink); }
  .badge-status {
    font-size: 11px; text-transform: uppercase; font-weight: 700;
    padding: 3px 8px; border-radius: 4px; letter-spacing: .05em;
  }
  .status-draft { background: #fef08a; color: #854d0e; }
  .status-published { background: #bbf7d0; color: #166534; }
  .status-discarded { background: #fecaca; color: #991b1b; }

  .container { max-width: 1100px; margin: 0 auto; padding: 20px 16px 100px; }

  /* Gallery of Photos */
  .section-title {
    font-family: 'Barlow Condensed', sans-serif; font-size: 22px; font-weight: 700;
    margin: 24px 0 12px; display: flex; align-items: center; justify-content: space-between;
  }
  .photo-gallery {
    display: flex; gap: 14px; overflow-x: auto; padding: 6px 2px 14px;
    scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch;
  }
  .photo-card {
    flex: 0 0 240px; background: var(--white); border-radius: 8px;
    border: 1px solid var(--rule); overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.06);
    scroll-snap-align: start; cursor: pointer; transition: transform .15s;
  }
  .photo-card:hover { transform: translateY(-2px); }
  .photo-card img { width: 100%; height: 200px; object-fit: cover; display: block; }
  .photo-card .label { padding: 8px 10px; font-size: 12px; font-weight: 600; color: var(--ink-soft); }

  /* Alerts */
  .alert-card {
    border-radius: 8px; padding: 14px 18px; margin-bottom: 20px;
    display: flex; gap: 12px; align-items: flex-start;
  }
  .alert-warn { background: var(--warn-bg); border-left: 4px solid var(--warn); color: #78350f; }
  .alert-ok { background: var(--green-bg); border-left: 4px solid var(--green); color: #14532d; }
  .alert-title { font-weight: 700; margin-bottom: 4px; }
  .alert-list { margin: 0; padding-left: 18px; font-size: 13.5px; }

  /* Games layout */
  .game-card {
    background: var(--white); border-radius: 10px; border: 1px solid var(--rule);
    margin-bottom: 24px; box-shadow: 0 2px 6px rgba(0,0,0,.04); overflow: hidden;
  }
  .game-header {
    background: #f9fafb; padding: 12px 18px; border-bottom: 1px solid var(--rule);
    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;
  }
  .game-meta { font-size: 13px; color: var(--ink-soft); font-weight: 500; }
  .game-score-box {
    display: flex; align-items: center; gap: 14px;
    font-family: 'Barlow Condensed', sans-serif; font-size: 26px; font-weight: 700;
  }
  .score-input {
    width: 52px; height: 42px; text-align: center; font-size: 22px; font-weight: 700;
    border: 2px solid var(--rule-dark); border-radius: 6px; font-family: inherit;
  }
  .score-input:focus { border-color: var(--blue); outline: none; }

  .teams-split {
    display: grid; grid-template-columns: 1fr 1fr; border-bottom: 1px solid var(--rule);
  }
  @media (max-width: 768px) {
    .teams-split { grid-template-columns: 1fr; }
  }
  .team-col { padding: 16px; }
  .team-col:first-child { border-right: 1px solid var(--rule); }
  @media (max-width: 768px) {
    .team-col:first-child { border-right: none; border-bottom: 1px solid var(--rule); }
  }
  .team-name-hdr {
    font-family: 'Barlow Condensed', sans-serif; font-size: 19px; font-weight: 700;
    margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;
  }
  .team-tag { padding: 2px 8px; border-radius: 3px; color: #fff; font-size: 13px; }
  .tag-Red { background: var(--red); }
  .tag-Blue { background: var(--blue); }
  .tag-White { background: #fff; color: #16181d; border: 1px solid var(--rule-dark); }
  .tag-Black { background: #1c1f24; }

  /* Goalies box */
  .goalie-box {
    background: #f1f5f9; border-radius: 6px; padding: 10px 14px; margin-bottom: 14px;
    display: flex; align-items: center; justify-content: space-between;
  }
  .goalie-title { font-size: 13px; font-weight: 600; color: var(--ink-soft); }
  .goalie-ga-row { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
  .ga-input { width: 44px; height: 32px; text-align: center; border: 1px solid var(--rule-dark); border-radius: 4px; font-weight: 700; }

  /* Roster Table */
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: left; padding: 6px 8px; border-bottom: 1.5px solid var(--rule-dark); font-size: 11px; text-transform: uppercase; color: var(--ink-soft); }
  td { padding: 7px 8px; border-bottom: 1px solid var(--rule); vertical-align: middle; }
  tr.absent-row td { opacity: .45; text-decoration: line-through; background: #fafafa; }
  .player-name-cell { display: flex; align-items: center; gap: 6px; font-weight: 500; flex-wrap: wrap; }
  .sub-tag { font-size: 10px; font-weight: 700; background: #e2e8f0; color: #334155; padding: 1px 5px; border-radius: 2px; }
  .badge-id { font-size: 11px; color: #475569; background: #f1f5f9; padding: 1px 6px; border-radius: 3px; font-weight: 600; border: 1px solid var(--rule); }
  .badge-new { font-size: 11px; color: #9a3412; background: #ffedd5; padding: 1px 6px; border-radius: 3px; font-weight: 700; border: 1px solid #fed7aa; }
  .btn-edit { background: transparent; border: 1px solid var(--rule-dark); border-radius: 4px; padding: 2px 6px; font-size: 11px; cursor: pointer; color: var(--ink-soft); line-height: 1.2; }
  .btn-edit:hover { background: #f1f5f9; color: var(--ink); }
  .player-edit-row { margin-top: 5px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .player-edit-row select { font-size: 12px; padding: 3px 6px; border: 1px solid var(--rule-dark); border-radius: 4px; max-width: 190px; background: #fff; }
  .player-edit-row input[type="text"] { font-size: 12px; padding: 3px 6px; border: 1px solid var(--rule-dark); border-radius: 4px; width: 130px; }
  .player-warn-msg { font-size: 11px; color: var(--danger); font-weight: 600; margin-top: 3px; display: none; }

  /* Counter buttons */
  .counter { display: inline-flex; align-items: center; gap: 4px; }
  .btn-step {
    width: 26px; height: 26px; border: 1px solid var(--rule-dark); border-radius: 4px;
    background: #fff; font-size: 15px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center;
  }
  .btn-step:hover { background: #f1f5f9; }
  .counter-input { width: 32px; height: 26px; text-align: center; border: 1px solid var(--rule); border-radius: 4px; font-size: 13px; font-weight: 600; }

  /* Action footer bar */
  .sticky-bar {
    position: fixed; bottom: 0; left: 0; right: 0; background: #fff;
    border-top: 1px solid var(--rule-dark); padding: 14px 20px; z-index: 30;
    display: flex; align-items: center; justify-content: space-between; box-shadow: 0 -4px 12px rgba(0,0,0,.08);
  }
  .balance-indicator { font-weight: 600; display: flex; align-items: center; gap: 8px; font-size: 14px; }
  .btn-pub {
    background: var(--green); color: #fff; border: none; border-radius: 6px;
    padding: 10px 22px; font-size: 15px; font-weight: 700; cursor: pointer; transition: background .15s;
  }
  .btn-pub:hover { background: #166534; }
  .btn-pub:disabled { opacity: .5; cursor: not-allowed; }
  .btn-del {
    background: transparent; color: var(--danger); border: 1px solid var(--danger); border-radius: 6px;
    padding: 9px 16px; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  .btn-del:hover { background: var(--danger-bg); }

  /* Modal for full photo */
  .modal {
    display: none; position: fixed; z-index: 100; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,.85); align-items: center; justify-content: center; padding: 20px;
  }
  .modal.active { display: flex; }
  .modal img { max-width: 95vw; max-height: 92vh; object-fit: contain; border-radius: 4px; }
  .modal-close {
    position: absolute; top: 20px; right: 24px; color: #fff; font-size: 32px; font-weight: 700; cursor: pointer;
  }
</style>
</head>
<body>

<div class="top"><div class="wrap">
  <a href="https://smbhl.com/" id="logo-link"><img src="/api/logo.svg" alt="SMBHL"></a>
  <div class="langswitch">
    <button type="button" class="langbtn on" data-l="fr" id="btn-lang-fr" onclick="window.__setLang &amp;&amp; window.__setLang('fr')">FR</button>
    <button type="button" class="langbtn" data-l="en" id="btn-lang-en" onclick="window.__setLang &amp;&amp; window.__setLang('en')">EN</button>
  </div>
</div></div>

<div class="container">
  <div class="picker" id="admin-nav-tabs">
    <a class="tabbtn" href="/admin/board" data-tab="board" data-fr="Tableau" data-en="Board">Tableau</a>
    <a class="tabbtn" href="/admin/subs" data-tab="subs" data-fr="Substituts" data-en="Substitutes">Substituts</a>
    <a class="tabbtn" href="/admin/teams" data-tab="teams" data-fr="Équipes 👥" data-en="Teams 👥">Équipes 👥</a>
    <a class="tabbtn" href="/admin/season" data-tab="season" data-fr="Saison 🏒" data-en="Season 🏒">Saison 🏒</a>
    <a class="tabbtn" href="/admin/contacts" data-tab="contacts" data-fr="Contacts 📇" data-en="Contacts 📇">Contacts 📇</a>
    <a class="tabbtn" href="/admin/schedule" data-tab="schedule" data-fr="Calendrier 📅" data-en="Schedule 📅">Calendrier 📅</a>
    <a class="tabbtn" href="/admin/comms" data-tab="comms" data-fr="Comms 💬" data-en="Comms 💬">Comms 💬</a>
    <a class="tabbtn" href="/admin/finances" data-tab="finances" data-fr="Finances 💵" data-en="Finances 💵">Finances 💵</a>
    ${showStatsTabs ? `<a class="tabbtn on" href="/admin/review" data-tab="review" data-fr="Feuilles 📸" data-en="Scoresheets 📸">Feuilles 📸</a>` : ''}
    <a class="tabbtn" href="/admin/polls" data-tab="polls" data-fr="Sondages 🗳️" data-en="Polls 🗳️">Sondages 🗳️</a>
    ${showStatsTabs ? `<a class="tabbtn" href="/admin/season-recap" data-tab="recap" data-fr="Bilan 🏆" data-en="Season Recap 🏆">Bilan 🏆</a>` : ''}
  </div>

  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px; flex-wrap:wrap; gap:10px;">
    <h1 style="font-family:'Barlow Condensed',sans-serif; font-size:28px; font-weight:700; margin:0;">
      🏒 <span id="pageTitleText">Feuilles de match — Semaine ${review.week}</span> <span style="color:var(--ink-soft); font-size:18px; font-weight:normal;">(${esc(review.season)})</span>
    </h1>
    <div>
      <span id="reviewStatusBadge" class="badge-status status-${review.status}">${review.status}</span>
    </div>
  </div>
  ${images.length > 0 ? `
  <div class="section-title">
    <span id="galleryTitle">📸 Feuilles de match photographiées (${images.length})</span>
    <span id="gallerySub" style="font-size:12px; color:var(--ink-soft); font-weight:normal;">Cliquez pour agrandir</span>
  </div>
  <div class="photo-gallery">
    ${images.map((imgKey, idx) => `
      <div class="photo-card" onclick="openModal('/admin/review/image?key=${encodeURIComponent(imgKey)}&id=${encodeURIComponent(review.id)}${reviewTokenQS}')">
        <img src="/admin/review/image?key=${encodeURIComponent(imgKey)}&id=${encodeURIComponent(review.id)}${reviewTokenQS}" alt="Feuille ${idx + 1}" loading="lazy">
        <div class="label photo-label" data-idx="${idx + 1}">Feuille #${idx + 1} ↗</div>
      </div>
    `).join('')}
  </div>
  ` : ''}

  <div id="alertBox"></div>
  ${images.length > 0 && receivedTeams.length === 0 ? `
  <div class="alert-card alert-warn" id="unparsedBanner">
    <div>
      <div class="alert-title" id="unparsedTitle">⚠️ Photos reçues mais non assignées aux équipes</div>
      <div id="unparsedDesc" style="font-size:13.5px; margin-top:4px;">
        Cliquez sur le bouton <b>⚡ Réanalyser avec l'IA 🤖</b> ci-dessous pour extraire automatiquement les statistiques et alignements.
      </div>
    </div>
  </div>
  ` : ''}

  <!-- Team Sheet Status Tracker -->
  <div style="background:#fff; border:1px solid var(--rule); border-radius:8px; padding:14px 18px; margin-bottom:20px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
    <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
      <span id="trackerTitle" style="font-weight:700; font-size:14px;">Feuilles reçues (${receivedTeams.length}/${teamNames.length}) :</span>
      ${teamNames.map(t => {
        const ok = receivedTeams.includes(t);
        return `<span style="display:inline-flex; align-items:center; gap:4px; padding:4px 10px; border-radius:4px; font-size:12.5px; font-weight:700; background:${ok ? 'var(--green-bg)' : '#fee2e2'}; color:${ok ? 'var(--green)' : 'var(--danger)'};">
          ${ok ? '✓' : '✗'} ${t}
        </span>`;
      }).join('')}
    </div>
    <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
      ${!isPublished && !isDiscarded && images.length > 0 ? `
        <button type="button" id="btnReprocessAI" class="btn-step" style="width:auto; padding:6px 14px; font-size:13px; font-weight:600; cursor:pointer; background:#eff6ff; border-color:#93c5fd; color:#1d4ed8;" onclick="reprocessWithAI()">
          ⚡ Réanalyser avec l'IA 🤖
        </button>
      ` : ''}
      ${!isPublished && !isDiscarded && missingTeams.length > 0 ? `
        <form action="/admin/review/add-sheet" method="POST" enctype="multipart/form-data" style="margin:0;">
          <input type="hidden" name="review_id" value="${review.id}">
          <input type="hidden" name="rt" value="${esc(reviewToken.rt)}">
          <input type="hidden" name="exp" value="${esc(String(reviewToken.exp))}">
          <input type="file" id="addSheetInput" name="sheets" multiple accept="image/*" style="display:none" onchange="this.form.submit()">
          <button type="button" class="btn-step" id="btnAddMissingSheets" data-missing="${esc(missingTeams.join(', '))}" style="width:auto; padding:6px 14px; font-size:13px; font-weight:600; cursor:pointer; background:#f8fafc; border-color:var(--rule-dark); color:var(--ink);" onclick="document.getElementById('addSheetInput').click()">
            + Ajouter feuille(s) manquante(s) (${esc(missingTeams.join(', '))}) 📸
          </button>
        </form>
      ` : ''}
    </div>
  </div>

  <div class="section-title">
    <span id="gamesSectionTitle">📋 Matchs de la semaine (${games.length})</span>
  </div>

  <div id="gamesContainer">
    ${games.map((g, gIdx) => `
      <div class="game-card" data-game-idx="${gIdx}">
        <div class="game-header">
          <div class="game-meta">
            <b>${g.time || '10:30 AM'}</b> · ${g.gym || 'Gym'} · ${g.venue || 'Letendre'}
          </div>
          <div class="game-score-box">
            <span class="team-tag tag-${g.home_team}">${g.home_team}</span>
            <input type="number" class="score-input" name="g_${gIdx}_home_score" value="${g.home_score !== null ? g.home_score : ''}" min="0" oninput="recalc()">
            <span>–</span>
            <input type="number" class="score-input" name="g_${gIdx}_away_score" value="${g.away_score !== null ? g.away_score : ''}" min="0" oninput="recalc()">
            <span class="team-tag tag-${g.away_team}">${g.away_team}</span>
          </div>
        </div>

        ${g.home_sheet_score && g.away_sheet_score && (g.home_sheet_score.home !== g.away_sheet_score.home || g.home_sheet_score.away !== g.away_sheet_score.away) ? `
          <div class="game-conflict-box" data-home="${esc(g.home_team)}" data-away="${esc(g.away_team)}" data-hhome="${g.home_sheet_score.home}" data-haway="${g.home_sheet_score.away}" data-ahome="${g.away_sheet_score.home}" data-aaway="${g.away_sheet_score.away}" style="background:#fee2e2; border-left:4px solid var(--danger); border-radius:4px; padding:8px 14px; margin:10px 16px 0; font-size:13px; color:#991b1b; font-weight:600;">
            <div class="conflict-title">⚠️ Conflit de pointage entre les 2 feuilles : Feuille ${g.home_team} = ${g.home_sheet_score.home}-${g.home_sheet_score.away} vs Feuille ${g.away_team} = ${g.away_sheet_score.home}-${g.away_sheet_score.away} !</div>
            <div class="conflict-sub" style="font-weight:normal; font-size:12px; margin-top:2px; color:#7f1d1d;">
              Vérifiez les totaux de buts individuels ci-dessous et ajustez les cases de score pour fixer le résultat officiel.
            </div>
          </div>
        ` : ''}

        ${!g.has_home_sheet || !g.has_away_sheet ? `
          <div class="game-missing-box" data-home="${esc(g.home_team)}" data-away="${esc(g.away_team)}" data-has-home="${g.has_home_sheet ? '1' : '0'}" data-has-away="${g.has_away_sheet ? '1' : '0'}" style="background:#fef3c7; border-left:4px solid var(--warn); border-radius:4px; padding:6px 14px; margin:8px 16px 0; font-size:12.5px; color:#92400e; font-weight:600;">
            ⚠️ Information : ${!g.has_home_sheet ? `Feuille ${g.home_team} manquante. ` : ''}${!g.has_away_sheet ? `Feuille ${g.away_team} manquante.` : ''} Alignement et pointage partiels.
          </div>
        ` : ''}

        <div class="teams-split">
          <!-- Home Team Column -->
          <div class="team-col">
            <div class="team-name-hdr">
              <span class="team-title-label" data-team="${g.home_team}" data-side="home">${g.home_team} (Domicile)</span>
              <span id="badge_sum_${gIdx}_home" style="font-size:13px; font-weight:600;"></span>
            </div>

            <div class="goalie-box">
              <div style="flex:1;">
                <div class="goalie-title" data-i18n="goalieTitle">GARDIEN</div>
                <div style="display:flex; align-items:center; gap:6px; margin-top:2px; flex-wrap:wrap;">
                  <b id="glabel_${gIdx}_home" class="goalie-name-label" data-unassigned="${g.home_goalie?.name ? '' : '1'}" style="font-size:14px;">${esc(g.home_goalie?.name || 'Non assigné')}</b>
                  <span id="gbadge_${gIdx}_home" class="${g.home_goalie?.id ? 'badge-id' : (g.home_goalie?.name ? 'badge-new' : '')}">${g.home_goalie?.id || (g.home_goalie?.name ? '⚠️ Nouveau' : '')}</span>
                  <button type="button" class="btn-edit" title="Modifier le gardien" data-title-fr="Modifier le gardien" data-title-en="Edit goalie" onclick="toggleEditGoalie(${gIdx}, 'home')">✏️</button>
                </div>
                <div id="gedit_${gIdx}_home" class="player-edit-row" style="${g.home_goalie?.name && !g.home_goalie?.id ? 'display:flex;' : 'display:none;'}">
                  <select onchange="onGoalieSelectChange(this, ${gIdx}, 'home')">
                    <option value="__NEW__" class="opt-new-goalie" ${!g.home_goalie?.id ? 'selected' : ''}>➕ [Nouveau gardien…]</option>
                    <optgroup label="Gardiens / Joueurs" class="optgrp-goalies">
                      ${candidatePlayers.map(c => `<option value="${esc(c.id)}" ${g.home_goalie?.id === c.id ? 'selected' : ''}>${esc(c.name)} (${esc(c.id)})${c.is_goalie ? ' 🥅' : ''}</option>`).join('')}
                    </optgroup>
                  </select>
                  <input type="text" id="gname_${gIdx}_home" value="${esc(g.home_goalie?.name || '')}" placeholder="Prénom Nom" data-ph-fr="Prénom Nom" data-ph-en="First Last" style="${g.home_goalie?.id ? 'display:none;' : 'display:inline-block;'}" oninput="onGoalieNameInput(this, ${gIdx}, 'home')">
                </div>
                <div id="gwarn_${gIdx}_home" class="player-warn-msg"></div>
              </div>
              <div class="goalie-ga-row">
                <span class="goalie-ga-label" data-i18n="gaLabel">Buts alloués (GA):</span>
                <input type="number" class="ga-input" name="g_${gIdx}_home_ga" value="${g.home_goalie?.ga !== null && g.home_goalie?.ga !== undefined ? g.home_goalie.ga : ''}" min="0" oninput="recalc()">
              </div>
            </div>

            <table>
              <thead>
                <tr>
                  <th data-i18n="thPlayer">Joueur</th>
                  <th style="width:70px; text-align:center;" data-i18n="thPresent">Présent</th>
                  <th style="width:85px; text-align:center;" data-i18n="thGoals">Buts</th>
                  <th style="width:85px; text-align:center;" data-i18n="thAssists">Passes</th>
                </tr>
              </thead>
              <tbody id="tbody_${gIdx}_home">
                ${(g.home_players || []).map((p, pIdx) => `
                  <tr class="${p.absent ? 'absent-row' : ''}">
                    <td>
                      <div class="player-name-cell">
                        <span id="plabel_${gIdx}_home_${pIdx}" class="player-name-label" style="font-weight:600;">${esc(p.name)}</span>
                        <span id="pbadge_${gIdx}_home_${pIdx}" class="${p.id ? 'badge-id' : 'badge-new'}">${p.id || '⚠️ Nouveau'}</span>
                        ${p.is_sub ? '<span class="sub-tag">SUB</span>' : ''}
                        <button type="button" class="btn-edit" title="Modifier le joueur" data-title-fr="Modifier le joueur" data-title-en="Edit player" onclick="toggleEditPlayer(${gIdx}, 'home', ${pIdx})">✏️</button>
                      </div>
                      <div id="pedit_${gIdx}_home_${pIdx}" class="player-edit-row" style="${p.id ? 'display:none;' : 'display:flex;'}">
                        <select onchange="onPlayerSelectChange(this, ${gIdx}, 'home', ${pIdx})">
                          <option value="__NEW__" class="opt-new-player" ${!p.id ? 'selected' : ''}>➕ [Nouveau joueur…]</option>
                          <optgroup label="Joueurs de la ligue" class="optgrp-players">
                            ${candidatePlayers.map(c => `<option value="${esc(c.id)}" ${p.id === c.id ? 'selected' : ''}>${esc(c.name)} (${esc(c.id)})</option>`).join('')}
                          </optgroup>
                        </select>
                        <input type="text" id="pname_${gIdx}_home_${pIdx}" value="${esc(p.name || '')}" placeholder="Prénom Nom" data-ph-fr="Prénom Nom" data-ph-en="First Last" style="${p.id ? 'display:none;' : 'display:inline-block;'}" oninput="onPlayerNameInput(this, ${gIdx}, 'home', ${pIdx})">
                      </div>
                      <div id="pwarn_${gIdx}_home_${pIdx}" class="player-warn-msg"></div>
                    </td>
                    <td style="text-align:center;">
                      <input type="checkbox" ${!p.absent ? 'checked' : ''} onchange="toggleAbsent(this, ${gIdx}, 'home', ${pIdx})">
                    </td>
                    <td style="text-align:center;">
                      <div class="counter">
                        <button type="button" class="btn-step" onclick="stepVal(${gIdx}, 'home', ${pIdx}, 'goals', -1)">–</button>
                        <input type="number" class="counter-input" value="${p.goals || 0}" min="0" oninput="recalc()">
                        <button type="button" class="btn-step" onclick="stepVal(${gIdx}, 'home', ${pIdx}, 'goals', 1)">+</button>
                      </div>
                    </td>
                    <td style="text-align:center;">
                      <div class="counter">
                        <button type="button" class="btn-step" onclick="stepVal(${gIdx}, 'home', ${pIdx}, 'assists', -1)">–</button>
                        <input type="number" class="counter-input" value="${p.assists || 0}" min="0" oninput="recalc()">
                        <button type="button" class="btn-step" onclick="stepVal(${gIdx}, 'home', ${pIdx}, 'assists', 1)">+</button>
                      </div>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
            <button type="button" class="btn-step btn-add-player" style="width:auto; margin-top:8px; padding:6px 14px; font-size:12.5px; font-weight:600;" onclick="addPlayerRow(${gIdx}, 'home')">+ Ajouter un joueur</button>
          </div>

          <!-- Away Team Column -->
          <div class="team-col">
            <div class="team-name-hdr">
              <span class="team-title-label" data-team="${g.away_team}" data-side="away">${g.away_team} (Visiteur)</span>
              <span id="badge_sum_${gIdx}_away" style="font-size:13px; font-weight:600;"></span>
            </div>

            <div class="goalie-box">
              <div style="flex:1;">
                <div class="goalie-title" data-i18n="goalieTitle">GARDIEN</div>
                <div style="display:flex; align-items:center; gap:6px; margin-top:2px; flex-wrap:wrap;">
                  <b id="glabel_${gIdx}_away" class="goalie-name-label" data-unassigned="${g.away_goalie?.name ? '' : '1'}" style="font-size:14px;">${esc(g.away_goalie?.name || 'Non assigné')}</b>
                  <span id="gbadge_${gIdx}_away" class="${g.away_goalie?.id ? 'badge-id' : (g.away_goalie?.name ? 'badge-new' : '')}">${g.away_goalie?.id || (g.away_goalie?.name ? '⚠️ Nouveau' : '')}</span>
                  <button type="button" class="btn-edit" title="Modifier le gardien" data-title-fr="Modifier le gardien" data-title-en="Edit goalie" onclick="toggleEditGoalie(${gIdx}, 'away')">✏️</button>
                </div>
                <div id="gedit_${gIdx}_away" class="player-edit-row" style="${g.away_goalie?.name && !g.away_goalie?.id ? 'display:flex;' : 'display:none;'}">
                  <select onchange="onGoalieSelectChange(this, ${gIdx}, 'away')">
                    <option value="__NEW__" class="opt-new-goalie" ${!g.away_goalie?.id ? 'selected' : ''}>➕ [Nouveau gardien…]</option>
                    <optgroup label="Gardiens / Joueurs" class="optgrp-goalies">
                      ${candidatePlayers.map(c => `<option value="${esc(c.id)}" ${g.away_goalie?.id === c.id ? 'selected' : ''}>${esc(c.name)} (${esc(c.id)})${c.is_goalie ? ' 🥅' : ''}</option>`).join('')}
                    </optgroup>
                  </select>
                  <input type="text" id="gname_${gIdx}_away" value="${esc(g.away_goalie?.name || '')}" placeholder="Prénom Nom" data-ph-fr="Prénom Nom" data-ph-en="First Last" style="${g.away_goalie?.id ? 'display:none;' : 'display:inline-block;'}" oninput="onGoalieNameInput(this, ${gIdx}, 'away')">
                </div>
                <div id="gwarn_${gIdx}_away" class="player-warn-msg"></div>
              </div>
              <div class="goalie-ga-row">
                <span class="goalie-ga-label" data-i18n="gaLabel">Buts alloués (GA):</span>
                <input type="number" class="ga-input" name="g_${gIdx}_away_ga" value="${g.away_goalie?.ga !== null && g.away_goalie?.ga !== undefined ? g.away_goalie.ga : ''}" min="0" oninput="recalc()">
              </div>
            </div>

            <table>
              <thead>
                <tr>
                  <th data-i18n="thPlayer">Joueur</th>
                  <th style="width:70px; text-align:center;" data-i18n="thPresent">Présent</th>
                  <th style="width:85px; text-align:center;" data-i18n="thGoals">Buts</th>
                  <th style="width:85px; text-align:center;" data-i18n="thAssists">Passes</th>
                </tr>
              </thead>
              <tbody id="tbody_${gIdx}_away">
                ${(g.away_players || []).map((p, pIdx) => `
                  <tr class="${p.absent ? 'absent-row' : ''}">
                    <td>
                      <div class="player-name-cell">
                        <span id="plabel_${gIdx}_away_${pIdx}" class="player-name-label" style="font-weight:600;">${esc(p.name)}</span>
                        <span id="pbadge_${gIdx}_away_${pIdx}" class="${p.id ? 'badge-id' : 'badge-new'}">${p.id || '⚠️ Nouveau'}</span>
                        ${p.is_sub ? '<span class="sub-tag">SUB</span>' : ''}
                        <button type="button" class="btn-edit" title="Modifier le joueur" data-title-fr="Modifier le joueur" data-title-en="Edit player" onclick="toggleEditPlayer(${gIdx}, 'away', ${pIdx})">✏️</button>
                      </div>
                      <div id="pedit_${gIdx}_away_${pIdx}" class="player-edit-row" style="${p.id ? 'display:none;' : 'display:flex;'}">
                        <select onchange="onPlayerSelectChange(this, ${gIdx}, 'away', ${pIdx})">
                          <option value="__NEW__" class="opt-new-player" ${!p.id ? 'selected' : ''}>➕ [Nouveau joueur…]</option>
                          <optgroup label="Joueurs de la ligue" class="optgrp-players">
                            ${candidatePlayers.map(c => `<option value="${esc(c.id)}" ${p.id === c.id ? 'selected' : ''}>${esc(c.name)} (${esc(c.id)})</option>`).join('')}
                          </optgroup>
                        </select>
                        <input type="text" id="pname_${gIdx}_away_${pIdx}" value="${esc(p.name || '')}" placeholder="Prénom Nom" data-ph-fr="Prénom Nom" data-ph-en="First Last" style="${p.id ? 'display:none;' : 'display:inline-block;'}" oninput="onPlayerNameInput(this, ${gIdx}, 'away', ${pIdx})">
                      </div>
                      <div id="pwarn_${gIdx}_away_${pIdx}" class="player-warn-msg"></div>
                    </td>
                    <td style="text-align:center;">
                      <input type="checkbox" ${!p.absent ? 'checked' : ''} onchange="toggleAbsent(this, ${gIdx}, 'away', ${pIdx})">
                    </td>
                    <td style="text-align:center;">
                      <div class="counter">
                        <button type="button" class="btn-step" onclick="stepVal(${gIdx}, 'away', ${pIdx}, 'goals', -1)">–</button>
                        <input type="number" class="counter-input" value="${p.goals || 0}" min="0" oninput="recalc()">
                        <button type="button" class="btn-step" onclick="stepVal(${gIdx}, 'away', ${pIdx}, 'goals', 1)">+</button>
                      </div>
                    </td>
                    <td style="text-align:center;">
                      <div class="counter">
                        <button type="button" class="btn-step" onclick="stepVal(${gIdx}, 'away', ${pIdx}, 'assists', -1)">–</button>
                        <input type="number" class="counter-input" value="${p.assists || 0}" min="0" oninput="recalc()">
                        <button type="button" class="btn-step" onclick="stepVal(${gIdx}, 'away', ${pIdx}, 'assists', 1)">+</button>
                      </div>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
            <button type="button" class="btn-step btn-add-player" style="width:auto; margin-top:8px; padding:6px 14px; font-size:12.5px; font-weight:600;" onclick="addPlayerRow(${gIdx}, 'away')">+ Ajouter un joueur</button>
          </div>
        </div>
      </div>
    `).join('')}
  </div>
</div>

<div class="sticky-bar">
  <div class="balance-indicator" id="statusBar">
    <span>Calcul des totaux…</span>
  </div>
  <div style="display:flex; gap:10px;">
    ${!isPublished && !isDiscarded ? `
      <button type="button" class="btn-del" id="btnDiscard" onclick="discardReview()">Supprimer / Rejeter</button>
      <button type="button" class="btn-pub" id="btnPublish" onclick="publishReview()">Confirmer et Publier 🚀</button>
    ` : ''}
    ${isPublished ? `<span id="msgPublished" style="color:var(--green); font-weight:700; align-self:center;">✅ Publié en ligne! Photos supprimées.</span>` : ''}
  </div>
</div>

<div class="modal" id="photoModal" onclick="closeModal()">
  <span class="modal-close">&times;</span>
  <img id="modalImg" src="" alt="Scoresheet">
</div>

<script>
// The server never embeds the admin key — it's resolved client-side the same
// way every other admin page does (URL param, then localStorage, then the
// admin_key cookie the server sets once you're authenticated).
let K = new URLSearchParams(location.search).get('key') || new URLSearchParams(location.search).get('k') || new URLSearchParams(location.search).get('t') || localStorage.getItem('adminkey') || (document.cookie.match(/(?:^|;\s*)admin_key=([^;]+)/)?.[1] ? decodeURIComponent(RegExp.$1) : '') || '';
if (K) { try { localStorage.setItem('adminkey', K); } catch (_) {} }
if (window.history && window.history.replaceState) {
  const u = new URL(location);
  if (u.searchParams.has('key') || u.searchParams.has('k') || u.searchParams.has('t')) {
    u.searchParams.delete('key'); u.searchParams.delete('k'); u.searchParams.delete('t');
    window.history.replaceState({}, document.title, u.pathname + u.search);
  }
}
const reviewId = ${JSON.stringify(review.id)};
// Scoped single-review token, present only for a scoresheet-email link
// visitor. Forwarded on every subsequent action below alongside x-admin —
// checkReviewAuth accepts either. Never a substitute for the ADMIN_KEY on
// any route outside this one review.
const RT = ${JSON.stringify(reviewToken.rt)};
const REXP = ${JSON.stringify(String(reviewToken.exp))};
const reviewWeek = ${JSON.stringify(review.week)};
const candidatePlayers = ${JSON.stringify(candidatePlayers)};
let gamesData = ${JSON.stringify(games)};
const imagesCount = ${images.length};
const receivedTeamsCount = ${receivedTeams.length};
const gamesCount = ${games.length};

const I18N_REVIEW_PAGE = {
  fr: {
    docTitle: w => "SMBHL · Validation des feuilles (Semaine " + w + ")",
    pageTitleText: w => "Feuilles de match — Semaine " + w,
    statusDraft: "Brouillon",
    statusPublished: "Publié",
    statusDiscarded: "Rejeté",
    galleryTitle: n => "📸 Feuilles de match photographiées (" + n + ")",
    gallerySub: "Cliquez pour agrandir",
    sheetNumber: n => "Feuille #" + n + " ↗",
    trackerTitle: n => "Feuilles reçues (" + n + "/${teamNames.length}) :",
    addMissingSheets: teams => "+ Ajouter feuille(s) manquante(s) (" + teams + ") 📸",
    gamesSectionTitle: n => "📋 Matchs de la semaine (" + n + ")",
    homeLabel: "Domicile",
    awayLabel: "Visiteur",
    goalieTitle: "GARDIEN",
    unassignedGoalie: "Non assigné",
    newBadge: "⚠️ Nouveau",
    newPlayerDefault: "Nouveau joueur",
    newGoalieDefault: "Nouveau gardien",
    newGoalieOption: "➕ [Nouveau gardien…]",
    newPlayerOption: "➕ [Nouveau joueur…]",
    optgrpGoalies: "Gardiens / Joueurs",
    optgrpPlayers: "Joueurs de la ligue",
    namePlaceholder: "Prénom Nom",
    gaLabel: "Buts alloués (GA):",
    thPlayer: "Joueur",
    thPresent: "Présent",
    thGoals: "Buts",
    thAssists: "Passes",
    editGoalieTitle: "Modifier le gardien",
    editPlayerTitle: "Modifier le joueur",
    btnAddPlayer: "+ Ajouter un joueur",
    btnDiscard: "Supprimer / Rejeter",
    btnPublish: "Confirmer et Publier 🚀",
    btnPublishing: "Publication en cours…",
    msgPublished: "✅ Publié en ligne! Photos supprimées.",
    conflictTitle: (home, away, hHome, hAway, aHome, aAway) =>
      "⚠️ Conflit de pointage entre les 2 feuilles : Feuille " + home + " = " + hHome + "-" + hAway + " vs Feuille " + away + " = " + aHome + "-" + aAway + " !",
    conflictSub: "Vérifiez les totaux de buts individuels ci-dessous et ajustez les cases de score pour fixer le résultat officiel.",
    missingInfo: (missingHome, missingAway, homeTeam, awayTeam) =>
      "⚠️ Information : " + (missingHome ? "Feuille " + homeTeam + " manquante. " : "") + (missingAway ? "Feuille " + awayTeam + " manquante." : "") + " Alignement et pointage partiels.",
    warnIncompletePlayer: (team, gameNum, name) =>
      team + " (Match #" + gameNum + "): Nom incomplet '" + name + "' (prénom seul). Veuillez entrer le nom complet ou associer à un joueur existant.",
    warnPlayerNameHelp: "⚠️ Prénom et nom de famille requis (ou choisir un joueur dans la liste)",
    warnIncompleteGoalie: (team, gameNum, name) =>
      "Gardien " + team + " (Match #" + gameNum + "): Nom incomplet '" + name + "'. Prénom et nom requis.",
    warnGoalieNameHelp: "⚠️ Prénom et nom requis (ou choisir un gardien dans la liste)",
    goalsBadge: (sum, score) => "Buts: " + sum + (score !== null ? " / " + score : ""),
    assistsBadge: (sum, max) => "Passes: " + sum + (max !== null ? " / max " + max : ""),
    warnMoreAssistsThanGoals: (team, gameNum, assists, maxAssists, maxPerGoal) =>
      team + " (Match #" + gameNum + "): Plus de passes (" + assists + ") que de buts permises (" + maxAssists + "). Maximum " + maxPerGoal + " passe" + (maxPerGoal > 1 ? "s" : "") + " par but.",
    warnGoalsMismatch: (team, gameNum, sum, score) =>
      team + " (Match #" + gameNum + "): Buts des joueurs (" + sum + ") ≠ Pointage (" + score + ")",
    warnGaMismatch: (team, goalieName, ga, opponentTeam, oppScore) =>
      "Gardien " + team + " (" + goalieName + "): GA (" + ga + ") ≠ Buts " + opponentTeam + " (" + oppScore + ")",
    warnCardTitle: n => "⚠️ Attention : " + n + " incohérence(s) détectée(s)",
    okCardTitle: "✅ Toutes les fiches concordent parfaitement!",
    okCardSub: "Tous les buts individuels correspondent aux pointages finaux et aux fiches des gardiens.",
    statusDiscrepancies: n => "⚠️ Des écarts subsistent (" + n + ")",
    statusBalanced: "✅ Équilibré et prêt pour publication",
    alertCannotPublish: "Impossible de publier :\\n\\nVeuillez corriger les écarts de pointage et renseigner les noms complets (prénom et nom) pour tous les nouveaux joueurs avant de publier.",
    confirmPublish: "Confirmer et mettre à jour le site SMBHL en direct ?\\n\\nNote : Toutes les photos de feuilles de match seront immédiatement supprimées du serveur.",
    alertPublishSuccess: "Bravo ! Les statistiques sont maintenant en direct sur smbhl.com et les photos temporaires ont été supprimées.",
    alertError: err => "Erreur: " + err,
    alertNetError: err => "Erreur réseau: " + err,
    confirmDiscard: "Voulez-vous vraiment rejeter et supprimer ces feuilles et photos ?",
    alertDiscardSuccess: "Session rejetée et photos supprimées.",
    btnReprocess: "⚡ Réanalyser avec l'IA 🤖",
    btnReprocessing: "🤖 Analyse en cours par Gemini...",
    reprocessSuccess: "Analyse terminée avec succès ! La page va se recharger.",
    unparsedAlertTitle: "⚠️ Photos reçues mais non assignées aux équipes",
    unparsedAlertDesc: "Cliquez sur le bouton <b>⚡ Réanalyser avec l'IA 🤖</b> ci-dessous pour extraire automatiquement les statistiques et alignements."
  },
  en: {
    docTitle: w => "SMBHL · Scoresheet Validation (Week " + w + ")",
    pageTitleText: w => "Scoresheets — Week " + w,
    statusDraft: "Draft",
    statusPublished: "Published",
    statusDiscarded: "Discarded",
    galleryTitle: n => "📸 Photographed Scoresheets (" + n + ")",
    gallerySub: "Click to enlarge",
    sheetNumber: n => "Sheet #" + n + " ↗",
    trackerTitle: n => "Sheets received (" + n + "/${teamNames.length}):",
    addMissingSheets: teams => "+ Add missing sheet(s) (" + teams + ") 📸",
    gamesSectionTitle: n => "📋 Weekly Games (" + n + ")",
    homeLabel: "Home",
    awayLabel: "Away",
    goalieTitle: "GOALIE",
    unassignedGoalie: "Unassigned",
    newBadge: "⚠️ New",
    newPlayerDefault: "New player",
    newGoalieDefault: "New goalie",
    newGoalieOption: "➕ [New goalie…]",
    newPlayerOption: "➕ [New player…]",
    optgrpGoalies: "Goalies / Players",
    optgrpPlayers: "League players",
    namePlaceholder: "First Last",
    gaLabel: "Goals against (GA):",
    thPlayer: "Player",
    thPresent: "Present",
    thGoals: "Goals",
    thAssists: "Assists",
    editGoalieTitle: "Edit goalie",
    editPlayerTitle: "Edit player",
    btnAddPlayer: "+ Add player",
    btnDiscard: "Delete / Discard",
    btnPublish: "Confirm and Publish 🚀",
    btnPublishing: "Publishing…",
    msgPublished: "✅ Published live! Photos deleted.",
    conflictTitle: (home, away, hHome, hAway, aHome, aAway) =>
      "⚠️ Score conflict between the 2 sheets: " + home + " sheet = " + hHome + "-" + hAway + " vs " + away + " sheet = " + aHome + "-" + aAway + " !",
    conflictSub: "Check individual goal totals below and adjust the score boxes to set the official result.",
    missingInfo: (missingHome, missingAway, homeTeam, awayTeam) =>
      "⚠️ Note: " + (missingHome ? "Missing sheet for " + homeTeam + ". " : "") + (missingAway ? "Missing sheet for " + awayTeam + "." : "") + " Partial roster and scores.",
    warnIncompletePlayer: (team, gameNum, name) =>
      team + " (Game #" + gameNum + "): Incomplete name '" + name + "' (first name only). Please enter full name or link to existing player.",
    warnPlayerNameHelp: "⚠️ First and last name required (or choose a player from the list)",
    warnIncompleteGoalie: (team, gameNum, name) =>
      "Goalie " + team + " (Game #" + gameNum + "): Incomplete name '" + name + "'. First and last name required.",
    warnGoalieNameHelp: "⚠️ First and last name required (or choose a goalie from the list)",
    goalsBadge: (sum, score) => "Goals: " + sum + (score !== null ? " / " + score : ""),
    assistsBadge: (sum, max) => "Assists: " + sum + (max !== null ? " / max " + max : ""),
    warnMoreAssistsThanGoals: (team, gameNum, assists, maxAssists, maxPerGoal) =>
      team + " (Game #" + gameNum + "): More assists (" + assists + ") than allowed goals (" + maxAssists + "). Maximum " + maxPerGoal + " assist" + (maxPerGoal > 1 ? "s" : "") + " per goal.",
    warnGoalsMismatch: (team, gameNum, sum, score) =>
      team + " (Game #" + gameNum + "): Player goals (" + sum + ") ≠ Score (" + score + ")",
    warnGaMismatch: (team, goalieName, ga, opponentTeam, oppScore) =>
      "Goalie " + team + " (" + goalieName + "): GA (" + ga + ") ≠ Goals " + opponentTeam + " (" + oppScore + ")",
    warnCardTitle: n => "⚠️ Warning: " + n + " discrepancy(ies) detected",
    okCardTitle: "✅ All sheets match perfectly!",
    okCardSub: "All individual goals match final scores and goalie sheets.",
    statusDiscrepancies: n => "⚠️ Discrepancies remain (" + n + ")",
    statusBalanced: "✅ Balanced and ready to publish",
    alertCannotPublish: "Cannot publish:\\n\\nPlease fix score discrepancies and enter full names (first and last) for all new players before publishing.",
    confirmPublish: "Confirm and update live SMBHL site?\\n\\nNote: All scoresheet photos will be immediately deleted from the server.",
    alertPublishSuccess: "Success! Stats are now live on smbhl.com and temporary photos have been deleted.",
    alertError: err => "Error: " + err,
    alertNetError: err => "Network error: " + err,
    confirmDiscard: "Are you sure you want to discard and delete these sheets and photos?",
    alertDiscardSuccess: "Session discarded and photos deleted.",
    btnReprocess: "⚡ Re-analyze with AI 🤖",
    btnReprocessing: "🤖 Analyzing with Gemini...",
    reprocessSuccess: "Analysis complete! The page will reload.",
    unparsedAlertTitle: "⚠️ Photos received but not assigned to teams",
    unparsedAlertDesc: "Click the <b>⚡ Re-analyze with AI 🤖</b> button below to automatically extract stats and rosters."
  }
};

let currentLang = (function() {
  try {
    var saved = localStorage.getItem('smbhl_admin_lang');
    if (saved === 'fr' || saved === 'en') return saved;
    if (/^en/i.test(navigator.language || '')) return 'en';
  } catch(e) {}
  return 'fr';
})();

window.__currentLang = currentLang;
window.__maxAssistsPerGoal = ${JSON.stringify(options.maxAssistsPerGoal ?? review.max_assists_per_goal ?? 1)};

window.__updateAdminTabsLang = function(l) {
  document.querySelectorAll('#admin-nav-tabs .tabbtn').forEach(function(btn) {
    var t = l === 'en' ? btn.dataset.en : btn.dataset.fr;
    if (t) btn.textContent = t;
  });
};

window.__setLang = function(l) {
  if (l !== 'fr' && l !== 'en') return;
  currentLang = l;
  window.__currentLang = l;
  try { localStorage.setItem('smbhl_admin_lang', l); } catch(e) {}
  applyLanguage(l);
};

function applyLanguage(lang) {
  const dict = I18N_REVIEW_PAGE[lang] || I18N_REVIEW_PAGE.fr;
  document.documentElement.lang = lang;
  document.title = dict.docTitle(reviewWeek);

  document.querySelectorAll('.langbtn').forEach(function(b) {
    b.classList.toggle('on', b.dataset.l === lang);
  });

  if (window.__updateAdminTabsLang) window.__updateAdminTabsLang(lang);

  const titleEl = document.getElementById('pageTitleText');
  if (titleEl) titleEl.textContent = dict.pageTitleText(reviewWeek);

  const badgeEl = document.getElementById('reviewStatusBadge');
  if (badgeEl) {
    if (badgeEl.classList.contains('status-draft')) badgeEl.textContent = dict.statusDraft;
    else if (badgeEl.classList.contains('status-published')) badgeEl.textContent = dict.statusPublished;
    else if (badgeEl.classList.contains('status-discarded')) badgeEl.textContent = dict.statusDiscarded;
  }

  const galTitle = document.getElementById('galleryTitle');
  if (galTitle) galTitle.textContent = dict.galleryTitle(imagesCount);
  const galSub = document.getElementById('gallerySub');
  if (galSub) galSub.textContent = dict.gallerySub;

  document.querySelectorAll('.photo-label').forEach(function(el) {
    if (el.dataset && el.dataset.idx) el.textContent = dict.sheetNumber(el.dataset.idx);
  });

  const trkTitle = document.getElementById('trackerTitle');
  if (trkTitle) trkTitle.textContent = dict.trackerTitle(receivedTeamsCount);

  const btnAddMissing = document.getElementById('btnAddMissingSheets');
  if (btnAddMissing && btnAddMissing.dataset && btnAddMissing.dataset.missing) {
    btnAddMissing.textContent = dict.addMissingSheets(btnAddMissing.dataset.missing);
  }

  document.querySelectorAll('.btn-add-player').forEach(function(el) { el.textContent = dict.btnAddPlayer; });

  const gSecTitle = document.getElementById('gamesSectionTitle');
  if (gSecTitle) gSecTitle.textContent = dict.gamesSectionTitle(gamesCount);

  // Conflicts and missing sheet boxes
  document.querySelectorAll('.game-conflict-box').forEach(function(box) {
    const title = box.querySelector('.conflict-title');
    const sub = box.querySelector('.conflict-sub');
    if (title && box.dataset) title.textContent = dict.conflictTitle(box.dataset.home, box.dataset.away, box.dataset.hhome, box.dataset.haway, box.dataset.ahome, box.dataset.aaway);
    if (sub) sub.textContent = dict.conflictSub;
  });

  document.querySelectorAll('.game-missing-box').forEach(function(box) {
    if (box.dataset) {
      box.textContent = dict.missingInfo(box.dataset.hasHome === '0', box.dataset.hasAway === '0', box.dataset.home, box.dataset.away);
    }
  });

  document.querySelectorAll('.team-title-label').forEach(function(el) {
    if (el.dataset) {
      el.textContent = (el.dataset.team || '') + ' (' + (el.dataset.side === 'home' ? dict.homeLabel : dict.awayLabel) + ')';
    }
  });

  document.querySelectorAll('.goalie-title').forEach(function(el) { el.textContent = dict.goalieTitle; });
  document.querySelectorAll('.goalie-ga-label').forEach(function(el) { el.textContent = dict.gaLabel; });
  document.querySelectorAll('th[data-i18n="thPlayer"]').forEach(function(el) { el.textContent = dict.thPlayer; });
  document.querySelectorAll('th[data-i18n="thPresent"]').forEach(function(el) { el.textContent = dict.thPresent; });
  document.querySelectorAll('th[data-i18n="thGoals"]').forEach(function(el) { el.textContent = dict.thGoals; });
  document.querySelectorAll('th[data-i18n="thAssists"]').forEach(function(el) { el.textContent = dict.thAssists; });

  document.querySelectorAll('.opt-new-goalie').forEach(function(el) { el.textContent = dict.newGoalieOption; });
  document.querySelectorAll('.opt-new-player').forEach(function(el) { el.textContent = dict.newPlayerOption; });
  document.querySelectorAll('.optgrp-goalies').forEach(function(el) { el.label = dict.optgrpGoalies; });
  document.querySelectorAll('.optgrp-players').forEach(function(el) { el.label = dict.optgrpPlayers; });

  document.querySelectorAll('input[data-ph-fr]').forEach(function(el) {
    el.placeholder = (lang === 'en' ? el.dataset.phEn : el.dataset.phFr);
  });
  document.querySelectorAll('button[data-title-fr]').forEach(function(el) {
    el.title = (lang === 'en' ? el.dataset.titleEn : el.dataset.titleFr);
  });

  document.querySelectorAll('.goalie-name-label').forEach(function(el) {
    if (el.dataset.unassigned === '1') el.textContent = dict.unassignedGoalie;
  });
  document.querySelectorAll('.badge-new').forEach(function(el) {
    el.textContent = dict.newBadge;
  });

  const btnDiscard = document.getElementById('btnDiscard');
  if (btnDiscard) btnDiscard.textContent = dict.btnDiscard;
  const btnPub = document.getElementById('btnPublish');
  if (btnPub && !btnPub.disabled) btnPub.textContent = dict.btnPublish;
  const btnReprocess = document.getElementById('btnReprocessAI');
  if (btnReprocess && !btnReprocess.disabled) btnReprocess.textContent = dict.btnReprocess;
  const unpTitle = document.getElementById('unparsedTitle');
  if (unpTitle) unpTitle.textContent = dict.unparsedAlertTitle;
  const unpDesc = document.getElementById('unparsedDesc');
  if (unpDesc) unpDesc.innerHTML = dict.unparsedAlertDesc;
  const msgPub = document.getElementById('msgPublished');
  if (msgPub) msgPub.textContent = dict.msgPublished;

  recalc();
}

window.addEventListener('admin_lang_changed', function(e) {
  if (e.detail && e.detail.lang) {
    currentLang = e.detail.lang;
    applyLanguage(currentLang);
  }
});

function openModal(src) {
  document.getElementById('modalImg').src = src;
  document.getElementById('photoModal').classList.add('active');
}
function closeModal() {
  document.getElementById('photoModal').classList.remove('active');
}

function toggleAbsent(cb, gIdx, side, pIdx) {
  const tr = cb.closest('tr');
  const isPresent = cb.checked;
  if (!isPresent) {
    tr.classList.add('absent-row');
  } else {
    tr.classList.remove('absent-row');
  }
  gamesData[gIdx][side + '_players'][pIdx].absent = !isPresent;
  recalc();
}

function stepVal(gIdx, side, pIdx, field, delta) {
  const player = gamesData[gIdx][side + '_players'][pIdx];
  let cur = Number(player[field]) || 0;
  cur = Math.max(0, cur + delta);
  player[field] = cur;

  const tbody = document.getElementById('tbody_' + gIdx + '_' + side);
  const row = tbody.children[pIdx];
  const colIdx = field === 'goals' ? 2 : 3;
  row.children[colIdx].querySelector('.counter-input').value = cur;
  recalc();
}

function toggleEditPlayer(gIdx, side, pIdx) {
  const box = document.getElementById('pedit_' + gIdx + '_' + side + '_' + pIdx);
  if (box) box.style.display = (box.style.display === 'none' ? 'flex' : 'none');
}

function onPlayerSelectChange(sel, gIdx, side, pIdx) {
  const val = sel.value;
  const player = gamesData[gIdx][side + '_players'][pIdx];
  const nameInput = document.getElementById('pname_' + gIdx + '_' + side + '_' + pIdx);
  const nameLabel = document.getElementById('plabel_' + gIdx + '_' + side + '_' + pIdx);
  const idBadge = document.getElementById('pbadge_' + gIdx + '_' + side + '_' + pIdx);
  const dict = I18N_REVIEW_PAGE[currentLang] || I18N_REVIEW_PAGE.fr;

  if (val === '__NEW__') {
    player.id = null;
    if (nameInput) {
      nameInput.style.display = 'inline-block';
      nameInput.focus();
      player.name = nameInput.value.trim();
    }
    if (nameLabel) nameLabel.innerText = player.name || dict.newPlayerDefault;
    if (idBadge) {
      idBadge.innerText = dict.newBadge;
      idBadge.className = 'badge-new';
    }
  } else {
    const cand = candidatePlayers.find(c => c.id === val);
    if (cand) {
      player.id = cand.id;
      player.name = cand.name;
      if (nameInput) {
        nameInput.value = cand.name;
        nameInput.style.display = 'none';
      }
      if (nameLabel) nameLabel.innerText = cand.name;
      if (idBadge) {
        idBadge.innerText = cand.id;
        idBadge.className = 'badge-id';
      }
    }
  }
  recalc();
}

function onPlayerNameInput(inp, gIdx, side, pIdx) {
  const player = gamesData[gIdx][side + '_players'][pIdx];
  player.name = inp.value.trim();
  const nameLabel = document.getElementById('plabel_' + gIdx + '_' + side + '_' + pIdx);
  const dict = I18N_REVIEW_PAGE[currentLang] || I18N_REVIEW_PAGE.fr;
  if (nameLabel) nameLabel.innerText = player.name || dict.newPlayerDefault;
  recalc();
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Appends a blank, manually-editable player row to a game's roster table. Used
// both for manual (no-photo) reviews and to add a skater OCR missed entirely,
// since the OCR-extracted rows don't otherwise offer a way to add one.
function addPlayerRow(gIdx, side) {
  const g = gamesData[gIdx];
  const arr = g[side + '_players'] || (g[side + '_players'] = []);
  const pIdx = arr.length;
  arr.push({ name: '', id: null, is_sub: false, absent: false, goals: 0, assists: 0 });

  const optionsHtml = candidatePlayers.map(function(c) {
    return '<option value="' + escHtml(c.id) + '">' + escHtml(c.name) + ' (' + escHtml(c.id) + ')</option>';
  }).join('');

  const dict = I18N_REVIEW_PAGE[currentLang] || I18N_REVIEW_PAGE.fr;
  const row = document.createElement('tr');
  row.innerHTML =
    '<td>' +
      '<div class="player-name-cell">' +
        '<span id="plabel_' + gIdx + '_' + side + '_' + pIdx + '" class="player-name-label" style="font-weight:600;">' + dict.newPlayerDefault + '</span>' +
        '<span id="pbadge_' + gIdx + '_' + side + '_' + pIdx + '" class="badge-new">' + dict.newBadge + '</span>' +
        '<button type="button" class="btn-edit" onclick="toggleEditPlayer(' + gIdx + ', \'' + side + '\', ' + pIdx + ')">✏️</button>' +
      '</div>' +
      '<div id="pedit_' + gIdx + '_' + side + '_' + pIdx + '" class="player-edit-row" style="display:flex;">' +
        '<select onchange="onPlayerSelectChange(this, ' + gIdx + ', \'' + side + '\', ' + pIdx + ')">' +
          '<option value="__NEW__" class="opt-new-player" selected>' + dict.newPlayerOption + '</option>' +
          '<optgroup label="' + dict.optgrpPlayers + '" class="optgrp-players">' + optionsHtml + '</optgroup>' +
        '</select>' +
        '<input type="text" id="pname_' + gIdx + '_' + side + '_' + pIdx + '" value="" placeholder="' + dict.namePlaceholder + '" style="display:inline-block;" oninput="onPlayerNameInput(this, ' + gIdx + ', \'' + side + '\', ' + pIdx + ')">' +
      '</div>' +
      '<div id="pwarn_' + gIdx + '_' + side + '_' + pIdx + '" class="player-warn-msg"></div>' +
    '</td>' +
    '<td style="text-align:center;"><input type="checkbox" checked onchange="toggleAbsent(this, ' + gIdx + ', \'' + side + '\', ' + pIdx + ')"></td>' +
    '<td style="text-align:center;"><div class="counter">' +
      '<button type="button" class="btn-step" onclick="stepVal(' + gIdx + ', \'' + side + '\', ' + pIdx + ', \'goals\', -1)">–</button>' +
      '<input type="number" class="counter-input" value="0" min="0" oninput="recalc()">' +
      '<button type="button" class="btn-step" onclick="stepVal(' + gIdx + ', \'' + side + '\', ' + pIdx + ', \'goals\', 1)">+</button>' +
    '</div></td>' +
    '<td style="text-align:center;"><div class="counter">' +
      '<button type="button" class="btn-step" onclick="stepVal(' + gIdx + ', \'' + side + '\', ' + pIdx + ', \'assists\', -1)">–</button>' +
      '<input type="number" class="counter-input" value="0" min="0" oninput="recalc()">' +
      '<button type="button" class="btn-step" onclick="stepVal(' + gIdx + ', \'' + side + '\', ' + pIdx + ', \'assists\', 1)">+</button>' +
    '</div></td>';

  document.getElementById('tbody_' + gIdx + '_' + side).appendChild(row);
  recalc();
}

function toggleEditGoalie(gIdx, side) {
  const box = document.getElementById('gedit_' + gIdx + '_' + side);
  if (box) box.style.display = (box.style.display === 'none' ? 'flex' : 'none');
}

function onGoalieSelectChange(sel, gIdx, side) {
  const val = sel.value;
  const goalie = gamesData[gIdx][side + '_goalie'];
  const nameInput = document.getElementById('gname_' + gIdx + '_' + side);
  const nameLabel = document.getElementById('glabel_' + gIdx + '_' + side);
  const idBadge = document.getElementById('gbadge_' + gIdx + '_' + side);
  const dict = I18N_REVIEW_PAGE[currentLang] || I18N_REVIEW_PAGE.fr;

  if (val === '__NEW__') {
    goalie.id = null;
    if (nameInput) {
      nameInput.style.display = 'inline-block';
      nameInput.focus();
      goalie.name = nameInput.value.trim();
    }
    if (nameLabel) {
      nameLabel.innerText = goalie.name || dict.newGoalieDefault;
      nameLabel.dataset.unassigned = goalie.name ? '' : '1';
    }
    if (idBadge) {
      idBadge.innerText = dict.newBadge;
      idBadge.className = 'badge-new';
    }
  } else {
    const cand = candidatePlayers.find(c => c.id === val);
    if (cand) {
      goalie.id = cand.id;
      goalie.name = cand.name;
      if (nameInput) {
        nameInput.value = cand.name;
        nameInput.style.display = 'none';
      }
      if (nameLabel) {
        nameLabel.innerText = cand.name;
        nameLabel.dataset.unassigned = '';
      }
      if (idBadge) {
        idBadge.innerText = cand.id;
        idBadge.className = 'badge-id';
      }
    }
  }
  recalc();
}

function onGoalieNameInput(inp, gIdx, side) {
  const goalie = gamesData[gIdx][side + '_goalie'];
  goalie.name = inp.value.trim();
  const nameLabel = document.getElementById('glabel_' + gIdx + '_' + side);
  const dict = I18N_REVIEW_PAGE[currentLang] || I18N_REVIEW_PAGE.fr;
  if (nameLabel) {
    nameLabel.innerText = goalie.name || dict.newGoalieDefault;
    nameLabel.dataset.unassigned = goalie.name ? '' : '1';
  }
  recalc();
}

let isPublishingBalanced = true;

function recalc() {
  const dict = I18N_REVIEW_PAGE[currentLang] || I18N_REVIEW_PAGE.fr;
  const warnings = [];
  let allBalanced = true;

  gamesData.forEach((g, gIdx) => {
    const card = document.querySelector('[data-game-idx="' + gIdx + '"]');
    const hScoreInput = card.querySelector('[name="g_' + gIdx + '_home_score"]');
    const aScoreInput = card.querySelector('[name="g_' + gIdx + '_away_score"]');
    const hGaInput = card.querySelector('[name="g_' + gIdx + '_home_ga"]');
    const aGaInput = card.querySelector('[name="g_' + gIdx + '_away_ga"]');

    g.home_score = hScoreInput.value !== '' ? Number(hScoreInput.value) : null;
    g.away_score = aScoreInput.value !== '' ? Number(aScoreInput.value) : null;
    if (g.home_goalie) g.home_goalie.ga = hGaInput.value !== '' ? Number(hGaInput.value) : null;
    if (g.away_goalie) g.away_goalie.ga = aGaInput.value !== '' ? Number(aGaInput.value) : null;

    // Sum home goals and assists
    const hTbody = document.getElementById('tbody_' + gIdx + '_home');
    let hSum = 0;
    let hAssistsSum = 0;
    (g.home_players || []).forEach((p, pIdx) => {
      const row = hTbody.children[pIdx];
      const val = Number(row.children[2].querySelector('.counter-input').value) || 0;
      const aVal = Number(row.children[3].querySelector('.counter-input').value) || 0;
      p.goals = val;
      p.assists = aVal;
      if (!p.absent) {
        hSum += val;
        hAssistsSum += aVal;
      }
    });

    // Sum away goals and assists
    const aTbody = document.getElementById('tbody_' + gIdx + '_away');
    let aSum = 0;
    let aAssistsSum = 0;
    (g.away_players || []).forEach((p, pIdx) => {
      const row = aTbody.children[pIdx];
      const val = Number(row.children[2].querySelector('.counter-input').value) || 0;
      const aVal = Number(row.children[3].querySelector('.counter-input').value) || 0;
      p.goals = val;
      p.assists = aVal;
      if (!p.absent) {
        aSum += val;
        aAssistsSum += aVal;
      }
    });

    // Check for incomplete player names (e.g. single-word names like "Mike")
    ['home', 'away'].forEach(side => {
      const teamName = side === 'home' ? g.home_team : g.away_team;
      (g[side + '_players'] || []).forEach((p, pIdx) => {
        const warnEl = document.getElementById('pwarn_' + gIdx + '_' + side + '_' + pIdx);
        if (!p.absent) {
          if (!p.id) {
            const parts = (p.name || '').trim().split(/\s+/).filter(Boolean);
            if (parts.length < 2) {
              warnings.push(dict.warnIncompletePlayer(teamName, gIdx + 1, p.name || (currentLang === 'en' ? 'unknown' : 'inconnu')));
              allBalanced = false;
              if (warnEl) {
                warnEl.innerText = dict.warnPlayerNameHelp;
                warnEl.style.display = 'block';
              }
            } else {
              if (warnEl) warnEl.style.display = 'none';
            }
          } else {
            if (warnEl) warnEl.style.display = 'none';
          }
        } else {
          if (warnEl) warnEl.style.display = 'none';
        }
      });

      const goalie = g[side + '_goalie'];
      const gWarnEl = document.getElementById('gwarn_' + gIdx + '_' + side);
      if (goalie && goalie.name && !goalie.id) {
        const parts = (goalie.name || '').trim().split(/\s+/).filter(Boolean);
        if (parts.length < 2) {
          warnings.push(dict.warnIncompleteGoalie(teamName, gIdx + 1, goalie.name));
          allBalanced = false;
          if (gWarnEl) {
            gWarnEl.innerText = dict.warnGoalieNameHelp;
            gWarnEl.style.display = 'block';
          }
        } else {
          if (gWarnEl) gWarnEl.style.display = 'none';
        }
      } else {
        if (gWarnEl) gWarnEl.style.display = 'none';
      }
    });

    // Assist limit checks (max assists per goal)
    const maxAssistsPerGoal = (typeof window.__maxAssistsPerGoal === 'number' ? window.__maxAssistsPerGoal : 1);
    const effectiveHomeGoals = g.home_score !== null ? g.home_score : hSum;
    const effectiveAwayGoals = g.away_score !== null ? g.away_score : aSum;
    const maxHomeAssists = effectiveHomeGoals * maxAssistsPerGoal;
    const maxAwayAssists = effectiveAwayGoals * maxAssistsPerGoal;

    const hAssistsValid = hAssistsSum <= maxHomeAssists;
    const aAssistsValid = aAssistsSum <= maxAwayAssists;

    // Badges
    const hBadge = document.getElementById('badge_sum_' + gIdx + '_home');
    const aBadge = document.getElementById('badge_sum_' + gIdx + '_away');

    const hMatch = g.home_score !== null && hSum === g.home_score;
    const aMatch = g.away_score !== null && aSum === g.away_score;

    hBadge.innerHTML = dict.goalsBadge(hSum, g.home_score) + (hMatch ? ' <span style="color:var(--green)">✓</span>' : ' <span style="color:var(--danger)">⚠</span>') +
      ' · ' + dict.assistsBadge(hAssistsSum, maxHomeAssists) + (hAssistsValid ? ' <span style="color:var(--green)">✓</span>' : ' <span style="color:var(--danger)">⚠</span>');
    aBadge.innerHTML = dict.goalsBadge(aSum, g.away_score) + (aMatch ? ' <span style="color:var(--green)">✓</span>' : ' <span style="color:var(--danger)">⚠</span>') +
      ' · ' + dict.assistsBadge(aAssistsSum, maxAwayAssists) + (aAssistsValid ? ' <span style="color:var(--green)">✓</span>' : ' <span style="color:var(--danger)">⚠</span>');

    if (g.home_score !== null && hSum !== g.home_score) {
      warnings.push(dict.warnGoalsMismatch(g.home_team, gIdx + 1, hSum, g.home_score));
      allBalanced = false;
    }
    if (g.away_score !== null && aSum !== g.away_score) {
      warnings.push(dict.warnGoalsMismatch(g.away_team, gIdx + 1, aSum, g.away_score));
      allBalanced = false;
    }
    if (!hAssistsValid) {
      warnings.push(dict.warnMoreAssistsThanGoals(g.home_team, gIdx + 1, hAssistsSum, maxHomeAssists, maxAssistsPerGoal));
      allBalanced = false;
    }
    if (!aAssistsValid) {
      warnings.push(dict.warnMoreAssistsThanGoals(g.away_team, gIdx + 1, aAssistsSum, maxAwayAssists, maxAssistsPerGoal));
      allBalanced = false;
    }
    if (g.home_score !== null && g.away_goalie && g.away_goalie.ga !== null && g.away_goalie.ga !== g.home_score) {
      warnings.push(dict.warnGaMismatch(g.away_team, g.away_goalie.name || (currentLang === 'en' ? 'Goalie' : 'Gardien'), g.away_goalie.ga, g.home_team, g.home_score));
      allBalanced = false;
    }
    if (g.away_score !== null && g.home_goalie && g.home_goalie.ga !== null && g.home_goalie.ga !== g.away_score) {
      warnings.push(dict.warnGaMismatch(g.home_team, g.home_goalie.name || (currentLang === 'en' ? 'Goalie' : 'Gardien'), g.home_goalie.ga, g.away_team, g.away_score));
      allBalanced = false;
    }
  });

  isPublishingBalanced = allBalanced;
  const alertBox = document.getElementById('alertBox');
  const statusBar = document.getElementById('statusBar');

  if (warnings.length > 0) {
    alertBox.innerHTML = '<div class="alert-card alert-warn">' +
      '<div>' +
        '<div class="alert-title">' + dict.warnCardTitle(warnings.length) + '</div>' +
        '<ul class="alert-list">' + warnings.map(w => '<li>' + w + '</li>').join('') + '</ul>' +
      '</div></div>';
    statusBar.innerHTML = '<span style="color:var(--warn)">' + dict.statusDiscrepancies(warnings.length) + '</span>';
  } else {
    alertBox.innerHTML = '<div class="alert-card alert-ok">' +
      '<div>' +
        '<div class="alert-title">' + dict.okCardTitle + '</div>' +
        '<div>' + dict.okCardSub + '</div>' +
      '</div></div>';
    statusBar.innerHTML = '<span style="color:var(--green)">' + dict.statusBalanced + '</span>';
  }
}

async function publishReview() {
  const dict = I18N_REVIEW_PAGE[currentLang] || I18N_REVIEW_PAGE.fr;
  if (!isPublishingBalanced) {
    alert(dict.alertCannotPublish);
    return;
  }
  if (!confirm(dict.confirmPublish)) return;
  const btn = document.getElementById('btnPublish');
  btn.disabled = true;
  btn.innerText = dict.btnPublishing;

  try {
    const res = await fetch('/admin/review/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin': K, 'x-review-token': RT, 'x-review-exp': REXP },
      body: JSON.stringify({ review_id: reviewId, week: reviewWeek, games: gamesData })
    });
    const data = await res.json();
    if (data.ok) {
      alert(dict.alertPublishSuccess);
      window.location.reload();
    } else {
      alert(dict.alertError(data.error || 'Erreur inconnue'));
      btn.disabled = false;
      btn.innerText = dict.btnPublish;
    }
  } catch (e) {
    alert(dict.alertNetError(e.message));
    btn.disabled = false;
    btn.innerText = dict.btnPublish;
  }
}

async function discardReview() {
  const dict = I18N_REVIEW_PAGE[currentLang] || I18N_REVIEW_PAGE.fr;
  if (!confirm(dict.confirmDiscard)) return;
  try {
    const res = await fetch('/admin/review/discard', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin': K, 'x-review-token': RT, 'x-review-exp': REXP },
      body: JSON.stringify({ review_id: reviewId })
    });
    const data = await res.json();
    if (data.ok) {
      alert(dict.alertDiscardSuccess);
      window.location.href = '/admin/review';
    }
  } catch (e) {
    alert(dict.alertError(e.message));
  }
}

async function reprocessWithAI() {
  const dict = I18N_REVIEW_PAGE[currentLang] || I18N_REVIEW_PAGE.fr;
  const btn = document.getElementById('btnReprocessAI');
  if (btn) {
    btn.disabled = true;
    btn.innerText = dict.btnReprocessing;
  }
  try {
    const res = await fetch('/admin/review/reprocess', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin': K, 'x-review-token': RT, 'x-review-exp': REXP },
      body: JSON.stringify({ review_id: reviewId })
    });
    const data = await res.json();
    if (data.ok) {
      if (data.errors && data.errors.length > 0) {
        alert((currentLang === 'en' ? 'Partial extraction (' : 'Extraction partielle (') + data.count + '/' + data.total + ')' + String.fromCharCode(10, 10) + data.errors.join(String.fromCharCode(10)));
      } else {
        alert(dict.reprocessSuccess);
      }
      window.location.reload();
    } else {
      alert(dict.alertError(data.error || 'Erreur inconnue'));
      if (btn) {
        btn.disabled = false;
        btn.innerText = dict.btnReprocess;
      }
    }
  } catch (err) {
    alert(dict.alertNetError(err.message));
    if (btn) {
      btn.disabled = false;
      btn.innerText = dict.btnReprocess;
    }
  }
}

applyLanguage(currentLang);
</script>
</body>
</html>`;
}

export function renderReviewIndex(reviews = [], backups = [], showStatsTabs = true) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMBHL · Gestion des feuilles de match</title>
<link rel="icon" href="https://smbhl.com/img/favicon-32.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: #16181d;
    --ink-soft: #5d636e;
    --rule: #dde1e7;
    --bg: #f4f5f8;
    --white: #ffffff;
    --green: #15803d;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; background: var(--bg); color: var(--ink);
    font-family: 'Barlow', -apple-system, sans-serif; font-size: 15px;
  }
  .top { background: var(--ink); color: #fff; padding: 14px 0; }
  .top .wrap { max-width: 800px; margin: 0 auto; padding: 0 16px; display: flex; align-items: center; justify-content: space-between; }
  .top img { height: 30px; }
  .langswitch { display: flex; gap: 4px; align-items: center; }
  .langbtn {
    font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 13px;
    padding: 3px 8px; border-radius: 3px; border: 1px solid #4a5160;
    background: transparent; color: #9aa1ac; cursor: pointer; line-height: 1.2;
  }
  .langbtn:hover { color: #fff; border-color: #9aa1ac; }
  .langbtn.on { background: #fff; border-color: #fff; color: #16181d; }
  .picker { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 16px; }
  .tabbtn {
    font-family: 'Barlow Condensed', sans-serif; font-weight: 600; font-size: 14px;
    padding: 6px 11px; border: 1px solid var(--rule); background: var(--white);
    color: var(--ink-soft); text-decoration: none; border-radius: 3px; display: inline-block; white-space: nowrap;
  }
  .tabbtn.on { background: var(--ink); border-color: var(--ink); color: #fff; }
  .tabbtn:hover { border-color: var(--ink); }
  .container { max-width: 800px; margin: 20px auto 40px; padding: 0 16px; }

  .card {
    background: var(--white); border-radius: 8px; border: 1px solid var(--rule);
    padding: 20px 24px; margin-bottom: 24px; box-shadow: 0 2px 6px rgba(0,0,0,.04);
  }
  h2 { font-family: 'Barlow Condensed', sans-serif; font-size: 22px; margin-top: 0; margin-bottom: 12px; }

  /* Upload box */
  .upload-zone {
    border: 2px dashed #94a3b8; border-radius: 8px; padding: 28px; text-align: center;
    background: #f8fafc; cursor: pointer; transition: border-color .15s;
  }
  .upload-zone:hover { border-color: #3b82f6; }
  .btn-submit {
    background: var(--green); color: #fff; border: none; border-radius: 6px;
    padding: 10px 20px; font-size: 15px; font-weight: 700; cursor: pointer; margin-top: 14px;
  }

  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th { text-align: left; padding: 8px 10px; border-bottom: 1.5px solid var(--rule); font-size: 12px; color: var(--ink-soft); text-transform: uppercase; }
  td { padding: 10px; border-bottom: 1px solid var(--rule); }
  .status-tag { padding: 2px 7px; border-radius: 3px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
  .status-draft { background: #fef08a; color: #854d0e; }
  .status-published { background: #bbf7d0; color: #166534; }
  .status-discarded { background: #fee2e2; color: #991b1b; }
</style>
</head>
<body>

<div class="top"><div class="wrap">
  <a href="https://smbhl.com/" id="logo-link"><img src="/api/logo.svg" alt="SMBHL"></a>
  <div class="langswitch">
    <button type="button" class="langbtn on" data-l="fr" id="btn-lang-fr" onclick="window.__setLang &amp;&amp; window.__setLang('fr')">FR</button>
    <button type="button" class="langbtn" data-l="en" id="btn-lang-en" onclick="window.__setLang &amp;&amp; window.__setLang('en')">EN</button>
  </div>
</div></div>

<div class="container">
  <div class="picker" id="admin-nav-tabs">
    <a class="tabbtn" href="/admin/board" data-tab="board" data-fr="Tableau" data-en="Board">Tableau</a>
    <a class="tabbtn" href="/admin/subs" data-tab="subs" data-fr="Substituts" data-en="Substitutes">Substituts</a>
    <a class="tabbtn" href="/admin/teams" data-tab="teams" data-fr="Équipes 👥" data-en="Teams 👥">Équipes 👥</a>
    <a class="tabbtn" href="/admin/season" data-tab="season" data-fr="Saison 🏒" data-en="Season 🏒">Saison 🏒</a>
    <a class="tabbtn" href="/admin/contacts" data-tab="contacts" data-fr="Contacts 📇" data-en="Contacts 📇">Contacts 📇</a>
    <a class="tabbtn" href="/admin/schedule" data-tab="schedule" data-fr="Calendrier 📅" data-en="Schedule 📅">Calendrier 📅</a>
    <a class="tabbtn" href="/admin/comms" data-tab="comms" data-fr="Comms 💬" data-en="Comms 💬">Comms 💬</a>
    <a class="tabbtn" href="/admin/finances" data-tab="finances" data-fr="Finances 💵" data-en="Finances 💵">Finances 💵</a>
    ${showStatsTabs ? `<a class="tabbtn on" href="/admin/review" data-tab="review" data-fr="Feuilles 📸" data-en="Scoresheets 📸">Feuilles 📸</a>` : ''}
    <a class="tabbtn" href="/admin/polls" data-tab="polls" data-fr="Sondages 🗳️" data-en="Polls 🗳️">Sondages 🗳️</a>
    ${showStatsTabs ? `<a class="tabbtn" href="/admin/season-recap" data-tab="recap" data-fr="Bilan 🏆" data-en="Season Recap 🏆">Bilan 🏆</a>` : ''}
  </div>

  <h1 id="pageHeading" data-i18n="pageHeading" style="font-family:'Barlow Condensed',sans-serif; font-size:28px; font-weight:700; margin:0 0 16px;">
    📸 Feuilles de match & Révisions
  </h1>
  <div class="card">
    <h2 id="uploadTitle" data-i18n="uploadTitle">📸 Téléverser de nouvelles feuilles</h2>
    <p id="uploadDesc" data-i18n="uploadDesc" style="color:var(--ink-soft); margin-bottom:16px;">
      Prenez en photo les 4 feuilles de match et téléversez-les ici, ou envoyez-les directement par courriel à <b>scores@smbhl.com</b>.
    </p>
    <form action="/admin/review/upload" method="POST" enctype="multipart/form-data">
      <div class="upload-zone" onclick="document.getElementById('fileInput').click()">
        <input type="file" id="fileInput" name="sheets" multiple accept="image/*" style="display:none" onchange="updateFileLabel(this)">
        <div style="font-size:28px; margin-bottom:8px;">📷</div>
        <div style="font-weight:600;" id="fileLabel" data-i18n="fileLabelDefault">Cliquez pour sélectionner ou prendre les photos des feuilles</div>
        <div style="font-size:12px; color:var(--ink-soft); margin-top:4px;" id="fileFormatNote" data-i18n="fileFormatNote">JPEG, PNG, WebP acceptés</div>
      </div>
      <button type="submit" class="btn-submit" id="btnUpload" data-i18n="btnUpload" style="display:none;">Analyser les feuilles avec l'IA ⚡</button>
    </form>
  </div>

  <div class="card">
    <h2 id="manualTitle" data-i18n="manualTitle">✍️ Saisie manuelle (sans photo)</h2>
    <p id="manualDesc" data-i18n="manualDesc" style="color:var(--ink-soft); margin-bottom:16px;">
      Aucune photo de feuille ? Créez une révision vierge pour une semaine et entrez les résultats à la main.
    </p>
    <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
      <label for="manualWeekInput" id="manualWeekLabel" data-i18n="manualWeekLabel">Semaine :</label>
      <input type="number" id="manualWeekInput" min="1" style="width:80px; font:inherit; padding:8px; border:1px solid var(--rule-dark); border-radius:4px;">
      <button type="button" class="btn-submit" id="btnManualStart" data-i18n="btnManualStart" onclick="startManualReview()" style="width:auto; padding:10px 18px;">Démarrer une saisie manuelle ✍️</button>
    </div>
  </div>

  <div class="card">
    <h2 id="historyTitle" data-i18n="historyTitle">Historique des révisions</h2>
    ${reviews.length === 0 ? '<p id="noReviewsMsg" data-i18n="noReviews" style="color:var(--ink-soft);">Aucune révision enregistrée pour le moment.</p>' : `
      <table>
        <thead>
          <tr>
            <th data-i18n="thDate">Date</th>
            <th data-i18n="thWeek">Semaine</th>
            <th data-i18n="thStatus">Statut</th>
            <th data-i18n="thAction">Action</th>
          </tr>
        </thead>
        <tbody>
          ${reviews.map(r => `
            <tr>
              <td>${r.created_at ? r.created_at.slice(0, 16).replace('T', ' ') : '-'}</td>
              <td><b><span class="cell-week" data-week="${r.week}">Semaine ${r.week}</span></b></td>
              <td><span class="status-tag status-${r.status}">${r.status}</span></td>
              <td><a href="/admin/review?id=${encodeURIComponent(r.id)}" class="review-link" data-i18n="viewValidate" style="font-weight:600; color:#2563eb;">Voir / Valider ↗</a></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `}
  </div>

  <div class="card">
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
      <h2 id="backupsTitle" data-i18n="backupsTitle" style="margin:0;">💾 Sauvegardes Cloud (data.json)</h2>
      <a href="/api/data-json" target="_blank" id="viewCurrentJson" data-i18n="viewCurrentJson" style="font-size:13px; font-weight:600; color:#2563eb; text-decoration:none;">Voir data.json actuel ↗</a>
    </div>
    <p id="backupsDesc" data-i18n="backupsDesc" style="color:var(--ink-soft); font-size:14px; margin-bottom:14px;">
      Chaque publication de feuille de match génère automatiquement une copie de sauvegarde immuable dans le Cloud et vous est envoyée par courriel.
    </p>
    ${backups.length === 0 ? '<p id="noBackupsMsg" data-i18n="noBackups" style="color:var(--ink-soft); font-size:14px;">Aucune sauvegarde archivée pour l\'instant.</p>' : `
      <table>
        <thead>
          <tr>
            <th data-i18n="thDateTime">Date / Heure</th>
            <th data-i18n="thWeek">Semaine</th>
            <th data-i18n="thSeason">Saison</th>
            <th data-i18n="thGames">Matchs</th>
            <th data-i18n="thAction">Action</th>
          </tr>
        </thead>
        <tbody>
          ${backups.map(b => `
            <tr>
              <td>${b.timestamp ? b.timestamp.slice(0, 16).replace('T', ' ') : '-'}</td>
              <td><b><span class="cell-backup-week" data-week="${b.week}">Semaine ${b.week}</span></b></td>
              <td>${b.season || '-'}</td>
              <td><span class="cell-backup-games" data-games="${b.games || 0}">${b.games || 0} matchs</span></td>
              <td>
                <a href="/api/backups/download?key=${encodeURIComponent(b.key)}" class="btn-dl-json" data-i18n="downloadJson" style="font-weight:600; color:#15803d; text-decoration:none; padding:4px 8px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:4px; font-size:12px;">📥 Télécharger JSON</a>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `}
  </div>
</div>

<script>
// The server never embeds the admin key — it's resolved client-side the same
// way every other admin page does (URL param, then localStorage, then the
// admin_key cookie the server sets once you're authenticated).
let K = new URLSearchParams(location.search).get('key') || new URLSearchParams(location.search).get('k') || new URLSearchParams(location.search).get('t') || localStorage.getItem('adminkey') || (document.cookie.match(/(?:^|;\s*)admin_key=([^;]+)/)?.[1] ? decodeURIComponent(RegExp.$1) : '') || '';
if (K) { try { localStorage.setItem('adminkey', K); } catch (_) {} }
if (window.history && window.history.replaceState) {
  const u = new URL(location);
  if (u.searchParams.has('key') || u.searchParams.has('k') || u.searchParams.has('t')) {
    u.searchParams.delete('key'); u.searchParams.delete('k'); u.searchParams.delete('t');
    window.history.replaceState({}, document.title, u.pathname + u.search);
  }
}

const I18N_REVIEW_INDEX = {
  fr: {
    docTitle: "SMBHL · Gestion des feuilles de match",
    pageHeading: "📸 Feuilles de match & Révisions",
    uploadTitle: "📸 Téléverser de nouvelles feuilles",
    uploadDesc: "Prenez en photo les 4 feuilles de match et téléversez-les ici, ou envoyez-les directement par courriel à <b>scores@smbhl.com</b>.",
    fileLabelDefault: "Cliquez pour sélectionner ou prendre les photos des feuilles",
    fileFormatNote: "JPEG, PNG, WebP acceptés",
    fileCountSelected: count => count + " photo(s) sélectionnée(s)",
    btnUpload: "Analyser les feuilles avec l'IA ⚡",
    manualTitle: "✍️ Saisie manuelle (sans photo)",
    manualDesc: "Aucune photo de feuille ? Créez une révision vierge pour une semaine et entrez les résultats à la main.",
    manualWeekLabel: "Semaine :",
    btnManualStart: "Démarrer une saisie manuelle ✍️",
    btnManualStarting: "Création en cours…",
    manualStartError: err => "Erreur : " + err,
    manualStartNetError: err => "Erreur réseau : " + err,
    manualWeekRequired: "Veuillez entrer un numéro de semaine.",
    historyTitle: "Historique des révisions",
    noReviews: "Aucune révision enregistrée pour le moment.",
    thDate: "Date",
    thWeek: "Semaine",
    thStatus: "Statut",
    thAction: "Action",
    weekLabel: w => "Semaine " + w,
    viewValidate: "Voir / Valider ↗",
    backupsTitle: "💾 Sauvegardes Cloud (data.json)",
    viewCurrentJson: "Voir data.json actuel ↗",
    backupsDesc: "Chaque publication de feuille de match génère automatiquement une copie de sauvegarde immuable dans le Cloud et vous est envoyée par courriel.",
    noBackups: "Aucune sauvegarde archivée pour l'instant.",
    thDateTime: "Date / Heure",
    thSeason: "Saison",
    thGames: "Matchs",
    gamesCount: g => g + " matchs",
    downloadJson: "📥 Télécharger JSON",
    statusDraft: "Brouillon",
    statusPublished: "Publié",
    statusDiscarded: "Rejeté"
  },
  en: {
    docTitle: "SMBHL · Scoresheet Management",
    pageHeading: "📸 Scoresheets & Reviews",
    uploadTitle: "📸 Upload New Scoresheets",
    uploadDesc: "Take photos of all 4 scoresheets and upload them here, or email them directly to <b>scores@smbhl.com</b>.",
    fileLabelDefault: "Click to select or take photos of the scoresheets",
    fileFormatNote: "JPEG, PNG, WebP accepted",
    fileCountSelected: count => count + " photo(s) selected",
    btnUpload: "Analyze Sheets with AI ⚡",
    manualTitle: "✍️ Manual Entry (no photo)",
    manualDesc: "No scoresheet photo? Create a blank review for a week and type in the results by hand.",
    manualWeekLabel: "Week:",
    btnManualStart: "Start Manual Entry ✍️",
    btnManualStarting: "Creating…",
    manualStartError: err => "Error: " + err,
    manualStartNetError: err => "Network error: " + err,
    manualWeekRequired: "Please enter a week number.",
    historyTitle: "Review History",
    noReviews: "No reviews recorded yet.",
    thDate: "Date",
    thWeek: "Week",
    thStatus: "Status",
    thAction: "Action",
    weekLabel: w => "Week " + w,
    viewValidate: "View / Validate ↗",
    backupsTitle: "💾 Cloud Backups (data.json)",
    viewCurrentJson: "View current data.json ↗",
    backupsDesc: "Every published scoresheet automatically creates an immutable Cloud backup and is emailed to you.",
    noBackups: "No backups archived yet.",
    thDateTime: "Date / Time",
    thSeason: "Season",
    thGames: "Games",
    gamesCount: g => g + " games",
    downloadJson: "📥 Download JSON",
    statusDraft: "Draft",
    statusPublished: "Published",
    statusDiscarded: "Discarded"
  }
};

let currentLang = (function() {
  try {
    var saved = localStorage.getItem('smbhl_admin_lang');
    if (saved === 'fr' || saved === 'en') return saved;
    if (/^en/i.test(navigator.language || '')) return 'en';
  } catch(e) {}
  return 'fr';
})();

window.__currentLang = currentLang;

window.__updateAdminTabsLang = function(l) {
  document.querySelectorAll('#admin-nav-tabs .tabbtn').forEach(function(btn) {
    var t = l === 'en' ? btn.dataset.en : btn.dataset.fr;
    if (t) btn.textContent = t;
  });
};

window.__setLang = function(l) {
  if (l !== 'fr' && l !== 'en') return;
  currentLang = l;
  window.__currentLang = l;
  try { localStorage.setItem('smbhl_admin_lang', l); } catch(e) {}
  applyLanguage(l);
};

function applyLanguage(lang) {
  const dict = I18N_REVIEW_INDEX[lang] || I18N_REVIEW_INDEX.fr;
  document.documentElement.lang = lang;
  document.title = dict.docTitle;

  document.querySelectorAll('.langbtn').forEach(function(b) {
    b.classList.toggle('on', b.dataset.l === lang);
  });

  if (window.__updateAdminTabsLang) window.__updateAdminTabsLang(lang);

  const fileInput = document.getElementById('fileInput');
  const fileLabel = document.getElementById('fileLabel');
  if (fileInput && fileInput.files && fileInput.files.length > 0) {
    fileLabel.textContent = dict.fileCountSelected(fileInput.files.length);
  } else if (fileLabel) {
    fileLabel.textContent = dict.fileLabelDefault;
  }

  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    const k = el.getAttribute('data-i18n');
    if (dict[k] !== undefined && typeof dict[k] === 'string') {
      if (k === 'uploadDesc' || k === 'backupsDesc') {
        el.innerHTML = dict[k];
      } else {
        el.textContent = dict[k];
      }
    }
  });

  document.querySelectorAll('.cell-week').forEach(function(el) {
    el.textContent = dict.weekLabel(el.dataset.week);
  });
  document.querySelectorAll('.cell-backup-week').forEach(function(el) {
    el.textContent = dict.weekLabel(el.dataset.week);
  });
  document.querySelectorAll('.cell-backup-games').forEach(function(el) {
    el.textContent = dict.gamesCount(el.dataset.games);
  });
  document.querySelectorAll('.review-link').forEach(function(el) {
    el.textContent = dict.viewValidate;
  });
  document.querySelectorAll('.btn-dl-json').forEach(function(el) {
    el.textContent = dict.downloadJson;
  });

  document.querySelectorAll('.status-tag').forEach(function(el) {
    if (el.classList.contains('status-draft')) el.textContent = dict.statusDraft;
    else if (el.classList.contains('status-published')) el.textContent = dict.statusPublished;
    else if (el.classList.contains('status-discarded')) el.textContent = dict.statusDiscarded;
  });
}

function updateFileLabel(input) {
  const dict = I18N_REVIEW_INDEX[currentLang] || I18N_REVIEW_INDEX.fr;
  if (input.files && input.files.length > 0) {
    document.getElementById('fileLabel').innerText = dict.fileCountSelected(input.files.length);
    document.getElementById('btnUpload').style.display = 'inline-block';
  }
}

async function startManualReview() {
  const dict = I18N_REVIEW_INDEX[currentLang] || I18N_REVIEW_INDEX.fr;
  const weekInput = document.getElementById('manualWeekInput');
  const week = weekInput ? Number(weekInput.value) : NaN;
  if (!week || week < 1) {
    alert(dict.manualWeekRequired);
    return;
  }
  const btn = document.getElementById('btnManualStart');
  btn.disabled = true;
  btn.textContent = dict.btnManualStarting;
  try {
    const res = await fetch('/admin/review/manual-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin': K },
      body: JSON.stringify({ week })
    });
    const data = await res.json();
    if (data.ok) {
      const keyParam = K ? '&key=' + encodeURIComponent(K) : '';
      window.location.href = '/admin/review?id=' + encodeURIComponent(data.id) + keyParam;
    } else {
      alert(dict.manualStartError(data.error || 'Unknown error'));
      btn.disabled = false;
      btn.textContent = dict.btnManualStart;
    }
  } catch (e) {
    alert(dict.manualStartNetError(e.message));
    btn.disabled = false;
    btn.textContent = dict.btnManualStart;
  }
}

window.addEventListener('admin_lang_changed', function(e) {
  if (e.detail && e.detail.lang) {
    currentLang = e.detail.lang;
    applyLanguage(currentLang);
  }
});

applyLanguage(currentLang);
</script>
</body>
</html>`;
}

export async function cleanupOldReviews(env) {
  try {
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const rows = (await env.DB.prepare(
      `SELECT id, images_json FROM sheet_reviews WHERE status = 'draft' AND created_at < ?`
    ).bind(twoDaysAgo).all()).results || [];

    for (const r of rows) {
      const keys = JSON.parse(r.images_json || '[]');
      for (const k of keys) {
        try { await env.SHEETS_KV.delete(k); } catch (e) {}
      }
      await env.DB.prepare(
        `UPDATE sheet_reviews SET status = 'expired', images_json = NULL WHERE id = ?`
      ).bind(r.id).run();
    }
  } catch (err) {
    console.error('cleanupOldReviews error:', err);
  }
}

export async function handleScoresheetEmail(message, env, sendMailFunc, replyToEmail) {
  try {
    const parser = new PostalMime();
    const parsed = await parser.parse(message.raw);
    const attachments = parsed.attachments || [];

    const imageAttachments = attachments.filter(att => {
      const mime = (att.mimeType || '').toLowerCase();
      const fn = (att.filename || '').toLowerCase();
      return mime.startsWith('image/') || fn.endsWith('.jpg') || fn.endsWith('.jpeg') || fn.endsWith('.png') || fn.endsWith('.webp') || fn.endsWith('.heic');
    });

    if (imageAttachments.length === 0) {
      console.log('No image attachments found in scoresheet email from', message.from);
      return;
    }

    // Determine week & season first to check for existing draft
    const curEvent = await env.DB.prepare("SELECT * FROM events WHERE state='open' ORDER BY week LIMIT 1").first()
      || await env.DB.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 1").first();
    const season = curEvent?.season || 'Fall 2026';
    let defaultWeek = curEvent?.week || 1;

    const leagueDataRaw = await env.SHEETS_KV.get('data_json') || await (await fetch(`${env.SITE_URL || 'https://smbhl.com'}/data.json`)).text();
    const leagueData = JSON.parse(leagueDataRaw);
    const cfg = getSeasonConfig(leagueData, season);
    if (!tracksStats(cfg)) {
      console.log(`Scoresheet email received for season "${season}" which has tracksStats:false — skipping OCR ingestion.`);
      return;
    }

    // Check if an existing open draft exists for this season/week
    const existingReview = await env.DB.prepare(
      `SELECT * FROM sheet_reviews WHERE season = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1`
    ).bind(season).first();

    const reviewId = existingReview ? existingReview.id : ('rev_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7));
    const allImageKeys = existingReview ? JSON.parse(existingReview.images_json || '[]') : [];
    const allParsedSheets = existingReview ? JSON.parse(existingReview.extracted_json || '[]') : [];

    for (let i = 0; i < imageAttachments.length; i++) {
      const att = imageAttachments[i];
      const key = `img:${reviewId}:${allImageKeys.length}`;
      await env.SHEETS_KV.put(key, att.content, {
        expirationTtl: 172800 // 48h safety TTL
      });
      allImageKeys.push(key);

      try {
        const sheet = await parseSheetWithGemini(env.GEMINI_API_KEY, att.content, att.mimeType || 'image/jpeg');
        allParsedSheets.push(sheet);
      } catch (err) {
        console.error(`Error parsing sheet with Gemini:`, err);
      }
    }

    const week = allParsedSheets.find(s => s.week)?.week || existingReview?.week || defaultWeek;

    const teamNames = getTeamNames(cfg);
    const s0 = (leagueData.seasons || []).find(s => s.name === season) || leagueData.seasons?.[0];
    const fixtures = (s0?.fixtures || []).filter(f => f.week === Number(week));

    const contacts = (await env.DB.prepare('SELECT player_id, name, is_sub, role, is_goalie FROM contacts').all()).results || [];
    const candidatePlayers = [
      ...contacts,
      ...(leagueData.players || []).map(p => ({ player_id: p.id, name: p.name }))
    ];

    const games = consolidateSheetsIntoGames(allParsedSheets, fixtures, candidatePlayers, { config: cfg });
    const now = new Date().toISOString();

    const receivedTeams = [...new Set(allParsedSheets.map(s => normalizeTeam(s.team, cfg)).filter(Boolean))];
    const missingTeams = teamNames.filter(t => !receivedTeams.includes(t));

    if (existingReview) {
      await env.DB.prepare(
        `UPDATE sheet_reviews SET images_json = ?, extracted_json = ?, validated_json = ? WHERE id = ?`
      ).bind(
        JSON.stringify(allImageKeys),
        JSON.stringify(allParsedSheets),
        JSON.stringify(games),
        reviewId
      ).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO sheet_reviews (id, event_id, season, week, created_at, status, images_json, extracted_json, validated_json)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`
      ).bind(
        reviewId,
        curEvent?.id || `${season}-${week}`,
        season,
        week,
        now,
        JSON.stringify(allImageKeys),
        JSON.stringify(allParsedSheets),
        JSON.stringify(games)
      ).run();
    }

    const publicUrl = env.PUBLIC_URL || 'https://rsvp.smbhl.com';
    // Scoped to this one review only (see admin_auth.js's checkReviewAuth) —
    // never the shared ADMIN_KEY, so this link can't unlock any other admin
    // route or review even if the email is forwarded or the inbox leaks.
    const { rt, exp } = await generateReviewToken(env, reviewId);
    const magicLink = `${publicUrl}/admin/review?id=${encodeURIComponent(reviewId)}&rt=${encodeURIComponent(rt)}&exp=${exp}`;
    const hasWarnings = games.some(g => !g.balanced) || missingTeams.length > 0;
    const notifyLeagueCfg = getLeagueConfig(cfg);

    const subject = `[${notifyLeagueCfg.name}] ${hasWarnings ? '⚠️ Validation requise' : '✅ Prêt à publier'} : Feuilles Semaine ${week} (${receivedTeams.length}/${teamNames.length} reçues)`;
    const text = `Bonjour Roberto,\n\n` +
      `${imageAttachments.length} nouvelle(s) feuille(s) de match ont été reçues pour la semaine ${week}.\n` +
      `État : ${receivedTeams.length}/${teamNames.length} feuilles reçues (${receivedTeams.join(', ') || 'aucune'}).${missingTeams.length > 0 ? ` (Manque : ${missingTeams.join(', ')})` : ''}\n\n` +
      `${hasWarnings ? '⚠️ Des écarts de pointage ou des feuilles manquantes nécessitent votre validation.' : `✅ Toutes les statistiques et les ${teamNames.length} feuilles concordent parfaitement!`}\n\n` +
      `Cliquez sur le lien suivant pour vérifier et publier en direct sur le site :\n` +
      `${magicLink}\n\n` +
      `Note : Dès que vous confirmerez la publication, toutes les photos temporaires seront définitivement supprimées du serveur.\n\n` +
      `—\n${notifyLeagueCfg.name} Automation`;

    const escH = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
    const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escH(subject)}</title>
</head>
<body style="margin:0; padding:16px 8px; background-color:#f4f5f8; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#16181d; line-height:1.5;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:540px; margin:0 auto; background-color:#ffffff; border:1px solid #dde1e7; border-radius:8px; overflow:hidden;">
    <tr>
      <td style="background-color:#16181d; padding:14px 20px; color:#ffffff;">
        <span style="font-size:18px; font-weight:700; letter-spacing:0.02em;">🏒 ${notifyLeagueCfg.name} — Feuilles de match</span>
      </td>
    </tr>
    <tr>
      <td style="padding:22px 20px;">
        <p style="font-size:16px; margin:0 0 14px;">Bonjour <b>Roberto</b>,</p>
        <p style="font-size:15px; margin:0 0 14px;">
          <b>${escH(imageAttachments.length)}</b> nouvelle(s) feuille(s) de match ont été reçues pour la <b>semaine ${escH(week)}</b>.
        </p>
        <div style="background-color:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:12px 14px; margin:0 0 18px; font-size:14px;">
          <b>État :</b> ${escH(receivedTeams.length)}/${escH(teamNames.length)} feuilles reçues (${escH(receivedTeams.join(', ') || 'aucune')}).
          ${missingTeams.length > 0 ? `<br><span style="color:#b91c1c; font-weight:600;">Manque : ${escH(missingTeams.join(', '))}</span>` : ''}
          <div style="margin-top:8px; font-weight:600; color:${hasWarnings ? '#b45309' : '#15803d'};">
            ${hasWarnings ? '⚠️ Des écarts de pointage ou des feuilles manquantes nécessitent votre validation.' : `✅ Toutes les statistiques et les ${teamNames.length} feuilles concordent parfaitement!`}
          </div>
        </div>
        <div style="margin:20px 0;">
          <a href="${escH(magicLink)}" style="display:inline-block; padding:13px 24px; background-color:#15803d; color:#ffffff; text-decoration:none; font-weight:700; font-size:15px; border-radius:6px; text-align:center;">🏒 Vérifier et Publier en direct ↗</a>
        </div>
        <p style="font-size:12px; color:#64748b; margin:14px 0 0;">
          Note : Dès que vous confirmerez la publication, toutes les photos temporaires seront définitivement supprimées du serveur.
        </p>
      </td>
    </tr>
    <tr>
      <td style="background-color:#f8fafc; padding:14px 20px; border-top:1px solid #e2e8f0; font-size:12px; color:#64748b; text-align:center;">
        ${notifyLeagueCfg.name} · ${notifyLeagueCfg.tagline} · <a href="${notifyLeagueCfg.siteUrl}" style="color:#2563eb; text-decoration:none;">${String(notifyLeagueCfg.siteUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>
      </td>
    </tr>
  </table>
</body>
</html>`;

    if (typeof sendMailFunc === 'function') {
      await sendMailFunc(env, replyToEmail, subject, text, html, null, notifyLeagueCfg);
    }
    console.log(`Scoresheet review ${reviewId} processed and notification sent to ${replyToEmail}`);
  } catch (err) {
    console.error('handleScoresheetEmail error:', err);
  }
}

export async function handleReviewUpload(req, env) {
  try {
    const formData = await req.formData();
    const files = formData.getAll('sheets');
    if (!files || files.length === 0) {
      return new Response('No files uploaded', { status: 400 });
    }

    const curEvent = await env.DB.prepare("SELECT * FROM events WHERE state='open' ORDER BY week LIMIT 1").first()
      || await env.DB.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 1").first();
    const season = curEvent?.season || 'Fall 2026';
    let defaultWeek = curEvent?.week || 1;

    const leagueDataRaw = await env.SHEETS_KV.get('data_json') || await (await fetch(`${env.SITE_URL || 'https://smbhl.com'}/data.json`)).text();
    const leagueData = JSON.parse(leagueDataRaw);
    const cfg = getSeasonConfig(leagueData, season);
    if (!tracksStats(cfg)) {
      return Response.json({ ok: false, error: STATS_DISABLED_MSG }, { status: 404 });
    }

    // Check existing draft
    const existingReview = await env.DB.prepare(
      `SELECT * FROM sheet_reviews WHERE season = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1`
    ).bind(season).first();

    const reviewId = existingReview ? existingReview.id : ('rev_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7));
    const allImageKeys = existingReview ? JSON.parse(existingReview.images_json || '[]') : [];
    const allParsedSheets = existingReview ? JSON.parse(existingReview.extracted_json || '[]') : [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file || typeof file.arrayBuffer !== 'function' || file.size === 0) continue;
      const buf = await file.arrayBuffer();
      const mime = file.type || 'image/jpeg';
      const key = `img:${reviewId}:${allImageKeys.length}`;
      await env.SHEETS_KV.put(key, buf, { expirationTtl: 172800 });
      allImageKeys.push(key);

      try {
        const sheet = await parseSheetWithGemini(env.GEMINI_API_KEY, buf, mime);
        allParsedSheets.push(sheet);
      } catch (err) {
        console.error('Error parsing uploaded file with Gemini:', err);
      }
    }

    const week = allParsedSheets.find(s => s.week)?.week || existingReview?.week || defaultWeek;

    const s0 = (leagueData.seasons || []).find(s => s.name === season) || leagueData.seasons?.[0];
    const fixtures = (s0?.fixtures || []).filter(f => f.week === Number(week));

    const contacts = (await env.DB.prepare('SELECT player_id, name, is_sub, role, is_goalie FROM contacts').all()).results || [];
    const candidatePlayers = [
      ...contacts,
      ...(leagueData.players || []).map(p => ({ player_id: p.id, name: p.name }))
    ];

    const games = consolidateSheetsIntoGames(allParsedSheets, fixtures, candidatePlayers, { config: cfg });
    const now = new Date().toISOString();

    if (existingReview) {
      await env.DB.prepare(
        `UPDATE sheet_reviews SET images_json = ?, extracted_json = ?, validated_json = ? WHERE id = ?`
      ).bind(
        JSON.stringify(allImageKeys),
        JSON.stringify(allParsedSheets),
        JSON.stringify(games),
        reviewId
      ).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO sheet_reviews (id, event_id, season, week, created_at, status, images_json, extracted_json, validated_json)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`
      ).bind(
        reviewId,
        curEvent?.id || `${season}-${week}`,
        season,
        week,
        now,
        JSON.stringify(allImageKeys),
        JSON.stringify(allParsedSheets),
        JSON.stringify(games)
      ).run();
    }

    return Response.redirect(`${new URL(req.url).origin}/admin/review?id=${encodeURIComponent(reviewId)}`, 303);
  } catch (err) {
    return new Response('Upload failed: ' + err.message, { status: 500 });
  }
}

// Creates a draft review with no photo/OCR step at all: one blank game card per
// scheduled fixture for the given season+week, ready for an admin to fill in by
// hand. Produces the exact same sheet_reviews row shape as handleReviewUpload
// (empty images_json/extracted_json instead of OCR output), so validation,
// publishing, standings and awards all work unchanged downstream.
export async function handleReviewManualStart(req, env) {
  try {
    const body = await req.json().catch(() => ({}));

    const curEvent = await env.DB.prepare("SELECT * FROM events WHERE state='open' ORDER BY week LIMIT 1").first()
      || await env.DB.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 1").first();
    const season = String(body.season || curEvent?.season || 'Fall 2026').trim();
    const week = Number(body.week) || curEvent?.week || 1;

    const leagueDataRaw = await env.SHEETS_KV.get('data_json') || await (await fetch(`${env.SITE_URL || 'https://smbhl.com'}/data.json`)).text();
    const leagueData = JSON.parse(leagueDataRaw);
    const cfg = getSeasonConfig(leagueData, season);
    if (!tracksStats(cfg)) {
      return Response.json({ ok: false, error: STATS_DISABLED_MSG }, { status: 404 });
    }

    // Reuse an existing draft for this season+week instead of creating a duplicate
    // (e.g. a double-click, or switching back to this week after navigating away).
    const existingReview = await env.DB.prepare(
      `SELECT id FROM sheet_reviews WHERE season = ? AND week = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1`
    ).bind(season, week).first();
    if (existingReview) {
      return Response.json({ ok: true, id: existingReview.id });
    }

    const s0 = (leagueData.seasons || []).find(s => s.name === season) || leagueData.seasons?.[0];
    const fixtures = (s0?.fixtures || []).filter(f => f.week === Number(week));
    if (fixtures.length === 0) {
      return Response.json({ ok: false, error: `Aucun match programmé pour la semaine ${week} (${season}).` }, { status: 400 });
    }

    const contacts = (await env.DB.prepare('SELECT player_id, name, is_sub, role, is_goalie FROM contacts').all()).results || [];
    const candidatePlayers = [
      ...contacts,
      ...(leagueData.players || []).map(p => ({ player_id: p.id, name: p.name }))
    ];

    const games = consolidateSheetsIntoGames([], fixtures, candidatePlayers, { config: cfg });

    const reviewId = 'rev_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
    const now = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO sheet_reviews (id, event_id, season, week, created_at, status, images_json, extracted_json, validated_json)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`
    ).bind(
      reviewId,
      curEvent?.id || `${season}-${week}`,
      season,
      week,
      now,
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify(games)
    ).run();

    return Response.json({ ok: true, id: reviewId });
  } catch (err) {
    return Response.json({ ok: false, error: 'Manual start failed: ' + err.message }, { status: 500 });
  }
}

export async function handleReviewAddSheet(req, env, preParsedFormData = null) {
  try {
    const formData = preParsedFormData || await req.formData();
    const reviewId = formData.get('review_id');
    const files = formData.getAll('sheets');
    if (!reviewId || !files || files.length === 0) {
      return new Response('Missing review_id or files', { status: 400 });
    }

    const review = await env.DB.prepare('SELECT * FROM sheet_reviews WHERE id = ?').bind(reviewId).first();
    if (!review) return new Response('Review not found', { status: 404 });

    const leagueDataRaw = await env.SHEETS_KV.get('data_json') || await (await fetch(`${env.SITE_URL || 'https://smbhl.com'}/data.json`)).text();
    const leagueData = JSON.parse(leagueDataRaw);
    const cfg = getSeasonConfig(leagueData, review.season);
    if (!tracksStats(cfg)) {
      return Response.json({ ok: false, error: STATS_DISABLED_MSG }, { status: 404 });
    }

    const allImageKeys = JSON.parse(review.images_json || '[]');
    const allParsedSheets = JSON.parse(review.extracted_json || '[]');

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file || typeof file.arrayBuffer !== 'function' || file.size === 0) continue;
      const buf = await file.arrayBuffer();
      const mime = file.type || 'image/jpeg';
      const key = `img:${reviewId}:${allImageKeys.length}`;
      await env.SHEETS_KV.put(key, buf, { expirationTtl: 172800 });
      allImageKeys.push(key);

      try {
        const sheet = await parseSheetWithGemini(env.GEMINI_API_KEY, buf, mime);
        allParsedSheets.push(sheet);
      } catch (err) {
        console.error('Error parsing added sheet with Gemini:', err);
      }
    }

    const s0 = (leagueData.seasons || []).find(s => s.name === review.season) || leagueData.seasons?.[0];
    const fixtures = (s0?.fixtures || []).filter(f => f.week === Number(review.week));

    const contacts = (await env.DB.prepare('SELECT player_id, name, is_sub, role, is_goalie FROM contacts').all()).results || [];
    const candidatePlayers = [
      ...contacts,
      ...(leagueData.players || []).map(p => ({ player_id: p.id, name: p.name }))
    ];

    const games = consolidateSheetsIntoGames(allParsedSheets, fixtures, candidatePlayers, { config: cfg });

    await env.DB.prepare(
      `UPDATE sheet_reviews SET images_json = ?, extracted_json = ?, validated_json = ? WHERE id = ?`
    ).bind(
      JSON.stringify(allImageKeys),
      JSON.stringify(allParsedSheets),
      JSON.stringify(games),
      reviewId
    ).run();

    // Carry the scoped review token forward through the redirect, if this
    // request was authenticated with one (the scoresheet-email link flow) —
    // otherwise a token-only visitor would follow this redirect straight into
    // a 403, since the target URL would have no credential on it at all.
    const rt = formData.get('rt');
    const exp = formData.get('exp');
    const tokenQS = rt ? `&rt=${encodeURIComponent(rt)}&exp=${encodeURIComponent(exp)}` : '';
    return Response.redirect(`${new URL(req.url).origin}/admin/review?id=${encodeURIComponent(reviewId)}${tokenQS}`, 303);
  } catch (err) {
    return new Response('Add sheet failed: ' + err.message, { status: 500 });
  }
}

export async function reprocessReview(review, env) {
  const reviewId = review.id;
  const season = review.season || 'Fall 2026';
  const imageKeys = JSON.parse(review.images_json || '[]');
  if (!imageKeys || imageKeys.length === 0) {
    return { ok: false, error: 'No scoresheet images found to reprocess' };
  }

  const leagueDataRaw = await env.SHEETS_KV.get('data_json') || await (await fetch(`${env.SITE_URL || 'https://smbhl.com'}/data.json`)).text();
  const leagueData = JSON.parse(leagueDataRaw);
  const seasonCfg = getSeasonConfig(leagueData, season);
  if (!tracksStats(seasonCfg)) {
    return { ok: false, error: STATS_DISABLED_MSG };
  }
  const s0 = (leagueData.seasons || []).find(s => s.name === season) || leagueData.seasons?.[0];

  const allParsedSheets = [];
  const errors = [];
  let lastError = null;

  for (let i = 0; i < imageKeys.length; i++) {
    const key = imageKeys[i];
    if (i > 0) {
      // 2.5s pacing to avoid rate limit spikes on vision API
      await new Promise(r => setTimeout(r, 2500));
    }
    const buf = await env.SHEETS_KV.get(key, { type: 'arrayBuffer' });
    if (!buf) {
      console.warn(`Image ${key} not found in KV (may have expired)`);
      lastError = new Error(`Image ${key} not found in KV (may have expired)`);
      errors.push(`Sheet #${i + 1}: Image missing from KV`);
      continue;
    }
    const mime = detectMime(buf, 'image/jpeg');
    try {
      const sheet = await parseSheetWithGemini(env.GEMINI_API_KEY, buf, mime);
      sheet.image_key = key;
      sheet.team = deduceTeamFromPlayers(sheet) || sheet.team;
      allParsedSheets.push(sheet);
    } catch (err) {
      console.error(`Error parsing scoresheet image ${key} with Gemini:`, err);
      errors.push(`Sheet #${i + 1}: ${err.message}`);
      lastError = err;
    }
  }

  // Merge any sheets from previous extraction that were not parsed in this run
  // (e.g. if one sheet succeeded previously, ensure it is preserved)
  try {
    const existingParsed = JSON.parse(review.extracted_json || '[]');
    for (const existing of existingParsed) {
      const exTeam = normalizeTeam(existing?.team, seasonCfg);
      if (exTeam && !allParsedSheets.some(s => normalizeTeam(s?.team, seasonCfg) === exTeam)) {
        console.log(`Preserving previously extracted sheet for team ${existing.team}`);
        allParsedSheets.push(existing);
      }
    }
  } catch (mergeErr) {
    console.warn('Failed to merge existing parsed sheets:', mergeErr);
  }

  if (allParsedSheets.length === 0) {
    return { ok: false, error: errors.length > 0 ? errors.join('; ') : (lastError ? lastError.message : 'Could not extract data from any of the scoresheet images') };
  }

  const week = allParsedSheets.find(s => s.week)?.week || review.week || 1;
  const fixtures = (s0?.fixtures || []).filter(f => f.week === Number(week));

  const contacts = (await env.DB.prepare('SELECT player_id, name, is_sub, role, is_goalie FROM contacts').all()).results || [];
  const candidatePlayers = [
    ...contacts,
    ...(leagueData.players || []).map(p => ({ player_id: p.id, name: p.name }))
  ];

  let maxAssistsPerGoal = 1;
  try {
    const cfgRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'season_draft_config'").first();
    if (cfgRow?.value) {
      const draftCfg = JSON.parse(cfgRow.value);
      if (draftCfg.maxAssistsPerGoal != null) maxAssistsPerGoal = Number(draftCfg.maxAssistsPerGoal) || 1;
    }
    const assistRuleRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'max_assists_per_goal'").first();
    if (assistRuleRow?.value) maxAssistsPerGoal = Number(assistRuleRow.value) || 1;
  } catch (_) {}

  const games = consolidateSheetsIntoGames(allParsedSheets, fixtures, candidatePlayers, { maxAssistsPerGoal, config: seasonCfg });

  await env.DB.prepare(
    `UPDATE sheet_reviews SET extracted_json = ?, validated_json = ?, week = ? WHERE id = ?`
  ).bind(
    JSON.stringify(allParsedSheets),
    JSON.stringify(games),
    week,
    reviewId
  ).run();

  return {
    ok: true,
    count: allParsedSheets.length,
    total: imageKeys.length,
    receivedTeams: [...new Set(allParsedSheets.map(s => normalizeTeam(s.team, seasonCfg)).filter(Boolean))],
    errors: errors.length > 0 ? errors : undefined
  };
}

export async function handleReviewReprocess(req, env) {
  try {
    let reviewId;
    if (req.headers.get('content-type')?.includes('application/json')) {
      const body = await req.json();
      reviewId = body.review_id;
    } else {
      const formData = await req.formData();
      reviewId = formData.get('review_id');
    }
    if (!reviewId) return Response.json({ ok: false, error: 'Missing review_id' }, { status: 400 });

    const review = await env.DB.prepare('SELECT * FROM sheet_reviews WHERE id = ?').bind(reviewId).first();
    if (!review) return Response.json({ ok: false, error: 'Review session not found' }, { status: 404 });

    const result = await reprocessReview(review, env);
    return Response.json(result);
  } catch (err) {
    console.error('handleReviewReprocess error:', err);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function handleReviewGet(req, env, url) {
  const reviewId = url.searchParams.get('id');
  if (reviewId) {
    let review = await env.DB.prepare('SELECT * FROM sheet_reviews WHERE id = ?').bind(reviewId).first();
    if (!review) return new Response('Review session not found', { status: 404 });

    if (url.searchParams.get('reparse') === '1' && review.status === 'draft') {
      try {
        await reprocessReview(review, env);
        review = await env.DB.prepare('SELECT * FROM sheet_reviews WHERE id = ?').bind(reviewId).first();
      } catch (err) {
        console.error('Error reparsing review during GET:', err);
      }
    }

    let candidatePlayers = [];
    let seasonCfg = DEFAULT_SEASON_CONFIG;
    try {
      const leagueDataRaw = await env.SHEETS_KV.get('data_json') || await (await fetch(`${env.SITE_URL || 'https://smbhl.com'}/data.json`)).text();
      const leagueData = JSON.parse(leagueDataRaw);
      seasonCfg = getSeasonConfig(leagueData, review.season);
      const contacts = (await env.DB.prepare('SELECT player_id, name, is_sub, role, is_goalie FROM contacts').all()).results || [];

      const candidateMap = new Map();
      for (const c of contacts) {
        if (c.player_id && c.name) {
          candidateMap.set(c.player_id, { id: c.player_id, name: c.name, is_goalie: !!c.is_goalie });
        }
      }
      for (const p of (leagueData.players || [])) {
        if (p.id && p.name && !candidateMap.has(p.id)) {
          candidateMap.set(p.id, { id: p.id, name: p.name, is_goalie: !!(p.gcareer && p.gcareer.gp > 0) });
        }
      }
      candidatePlayers = Array.from(candidateMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
    } catch (e) {
      console.error('Error fetching candidate players for review page:', e);
    }

    let maxAssistsPerGoal = 1;
    try {
      const cfgRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'season_draft_config'").first();
      if (cfgRow?.value) {
        const draftCfg = JSON.parse(cfgRow.value);
        if (draftCfg.maxAssistsPerGoal != null) maxAssistsPerGoal = Number(draftCfg.maxAssistsPerGoal) || 1;
      }
      const assistRuleRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'max_assists_per_goal'").first();
      if (assistRuleRow?.value) maxAssistsPerGoal = Number(assistRuleRow.value) || 1;
    } catch (_) {}

    // The router already required valid auth to reach this point — either the
    // full ADMIN_KEY or a scoped single-review token (see admin_auth.js). Only
    // the former gets the admin_key cookie refreshed: a scoped-token visitor
    // (the scoresheet-email link) must never receive the real admin secret,
    // or the token would be a full admin bypass instead of a narrow one.
    const isFullAdmin = checkAdminAuth(req, env) === 'ok';
    const headers = isFullAdmin
      ? adminPageHeaders(true, env)
      : { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    const reviewToken = { rt: url.searchParams.get('rt') || '', exp: url.searchParams.get('exp') || '' };
    return new Response(renderReviewPage(review, candidatePlayers, { maxAssistsPerGoal, config: seasonCfg, reviewToken }), { headers });
  }

  const reviews = (await env.DB.prepare('SELECT id, season, week, created_at, status FROM sheet_reviews ORDER BY created_at DESC LIMIT 25').all()).results || [];
  let backups = [];
  try {
    const backupsRaw = await env.SHEETS_KV.get('backup:history');
    if (backupsRaw) backups = JSON.parse(backupsRaw);
  } catch (e) {}
  let showStatsTabs = true;
  try {
    showStatsTabs = tracksStats(await getSeasonConfigFromEnv(env, null));
  } catch (_) {}
  return new Response(renderReviewIndex(reviews, backups, showStatsTabs), { headers: adminPageHeaders(true, env) });
}

export async function handleReviewImage(req, env, url) {
  const key = url.searchParams.get('key');
  if (!key) return new Response('Missing key', { status: 400 });
  const imgStream = await env.SHEETS_KV.get(key, { type: 'stream' });
  if (!imgStream) return new Response('Image expired or deleted', { status: 404 });

  return new Response(imgStream, {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'private, max-age=3600'
    }
  });
}

export async function handleReviewPublish(req, env, sendMailFunc = null, replyToEmail = null, ensureNextEventFunc = null) {
  const { review_id, week, games } = await req.json().catch(() => ({}));
  if (!review_id || !games) {
    return Response.json({ ok: false, error: 'Paramètres manquants' }, { status: 400 });
  }

  const review = await env.DB.prepare('SELECT * FROM sheet_reviews WHERE id = ?').bind(review_id).first();
  if (!review) {
    return Response.json({ ok: false, error: 'Révision non trouvée' }, { status: 404 });
  }
  if (review.status === 'published') {
    return Response.json({ ok: false, error: 'Cette révision est déjà publiée' }, { status: 400 });
  }

  // Guard against incomplete names (single-word names) for all active participants
  for (const g of games) {
    const activeParticipants = [
      ...(g.home_players || []).filter(p => !p.absent).map(p => ({ ...p, team: g.home_team })),
      ...(g.away_players || []).filter(p => !p.absent).map(p => ({ ...p, team: g.away_team })),
      ...(g.home_goalie?.name ? [{ ...g.home_goalie, team: g.home_team }] : []),
      ...(g.away_goalie?.name ? [{ ...g.away_goalie, team: g.away_team }] : [])
    ];

    for (const pt of activeParticipants) {
      if (!pt.id) {
        const parts = (pt.name || '').trim().split(/\s+/).filter(Boolean);
        if (parts.length < 2) {
          return Response.json({
            ok: false,
            error: `Le joueur "${pt.name || 'inconnu'}" (${pt.team}) a un nom incomplet (prénom seul). Veuillez entrer le prénom et le nom de famille complet, ou l'associer à un joueur existant avant de publier.`
          }, { status: 400 });
        }
      }
    }
  }

  const rawData = await env.SHEETS_KV.get('data_json') || await (await fetch(`${env.SITE_URL || 'https://smbhl.com'}/data.json`)).text();
  const originalData = JSON.parse(rawData);

  const publishSeasonCfg = getSeasonConfig(originalData, review.season);
  if (!tracksStats(publishSeasonCfg)) {
    return Response.json({ ok: false, error: STATS_DISABLED_MSG }, { status: 404 });
  }
  const publishLeagueCfg = getLeagueConfig(publishSeasonCfg);

  let subPlayerIds = new Set();
  try {
    const subRows = (await env.DB.prepare('SELECT player_id FROM contacts WHERE is_sub = 1 OR role != ?').bind('roster').all()).results || [];
    subPlayerIds = new Set(subRows.map(r => r.player_id).filter(Boolean));
  } catch (e) {
    console.error('Failed to load sub player IDs:', e);
  }

  const weekNum = week || review.week;
  const updatedData = updateLeagueDataWithReview(originalData, weekNum, games, subPlayerIds);
  const updatedDataStr = JSON.stringify(updatedData, null, 2);

  // 1. Update live data.json in KV
  await env.SHEETS_KV.put('data_json', updatedDataStr);

  const now = new Date().toISOString();
  const timestampSafe = now.replace(/[:.]/g, '-');
  const backupKey = `backup:data_json:${timestampSafe}`;
  const weekBackupKey = `backup:data_json:week_${weekNum}`;
  const seasonName = updatedData.seasons?.[0]?.name || 'Fall 2026';

  // 2. Cloud Snapshots in KV (Immutable timestamp + week copy + history index)
  try {
    await env.SHEETS_KV.put(backupKey, updatedDataStr);
    await env.SHEETS_KV.put(weekBackupKey, updatedDataStr);

    const historyRaw = await env.SHEETS_KV.get('backup:history');
    const history = historyRaw ? JSON.parse(historyRaw) : [];
    history.unshift({
      key: backupKey,
      week: weekNum,
      season: seasonName,
      timestamp: now,
      games: updatedData.seasons?.[0]?.games || 0,
      updatedDate: updatedData.updated
    });
    // Keep last 30 backup references
    await env.SHEETS_KV.put('backup:history', JSON.stringify(history.slice(0, 30)));
    console.log(`Cloud backup snapshot saved: ${backupKey}`);
  } catch (snapErr) {
    console.error('Error creating cloud backup snapshot:', snapErr);
  }

  // Save weekly recap in KV for invite email highlights
  try {
    const recap = computeWeeklyRecap(updatedData, weekNum, games);
    await env.SHEETS_KV.put(`recap:${seasonName}:week_${weekNum}`, JSON.stringify(recap));
    await env.SHEETS_KV.put(`recap:week_${weekNum}`, JSON.stringify(recap));
    console.log(`Weekly recap saved for ${seasonName} week ${weekNum}`);
  } catch (recapErr) {
    console.error('Error saving weekly recap:', recapErr);
  }

  // 3. Automated Email Backup to Roberto with data.json attached
  if (typeof sendMailFunc === 'function' && replyToEmail) {
    try {
      const publicUrl = env.PUBLIC_URL || 'https://rsvp.smbhl.com';
      const downloadUrl = `${publicUrl}/api/backups/download?key=${encodeURIComponent(backupKey)}`;
      const league = publishLeagueCfg;
      const siteHost = String(league.siteUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      const subj = `[${league.name}] ✅ Semaine ${weekNum} publiée — Sauvegarde automatique data.json`;

      const gameLines = (games || []).map(g => {
        const hScore = g.home_score != null ? g.home_score : '-';
        const aScore = g.away_score != null ? g.away_score : '-';
        return `• ${g.home_team} ${hScore} - ${aScore} ${g.away_team}`;
      }).join('\n');

      const gameCardsHtml = (games || []).map(g => {
        const hScore = g.home_score != null ? g.home_score : '-';
        const aScore = g.away_score != null ? g.away_score : '-';
        return `<div style="padding:6px 0; border-bottom:1px solid #e2e8f0; font-size:14px;">
          <b>${g.home_team}</b> <span style="font-size:16px; font-weight:700; color:#17457f;">${hScore} - ${aScore}</span> <b>${g.away_team}</b>
        </div>`;
      }).join('');

      const text = `Bonjour Roberto,\n\n` +
        `Les résultats de la semaine ${weekNum} ont été confirmés et publiés avec succès sur ${siteHost}!\n\n` +
        `Matchs enregistrés :\n${gameLines}\n\n` +
        `Une copie de sauvegarde de sécurité a été archivée dans le Cloud (clé: ${backupKey}).\n` +
        `Le fichier data.json à jour est joint à ce courriel.\n\n` +
        `Lien direct de téléchargement de cette sauvegarde :\n${downloadUrl}\n\n` +
        `Site en direct : ${league.siteUrl}\n\n` +
        `—\n${league.name} Automation`;

      let attachments = [];
      try {
        let b64 = '';
        if (typeof Buffer !== 'undefined') {
          b64 = Buffer.from(updatedDataStr, 'utf8').toString('base64');
        } else {
          b64 = btoa(unescape(encodeURIComponent(updatedDataStr)));
        }
        attachments.push({
          filename: `data-backup-week-${weekNum}-${timestampSafe}.json`,
          content: b64
        });
      } catch (bErr) {
        console.warn('Could not base64 encode data.json attachment:', bErr);
      }

      const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${subj}</title>
</head>
<body style="margin:0; padding:16px 8px; background-color:#f4f5f8; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#16181d; line-height:1.5;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:540px; margin:0 auto; background-color:#ffffff; border:1px solid #dde1e7; border-radius:8px; overflow:hidden;">
    <tr>
      <td style="background-color:#16181d; padding:14px 20px; color:#ffffff;">
        <span style="font-size:18px; font-weight:700; letter-spacing:0.02em;">🏒 ${league.name} — Sauvegarde Automatique</span>
      </td>
    </tr>
    <tr>
      <td style="padding:22px 20px;">
        <p style="font-size:16px; margin:0 0 12px;">Bonjour <b>Roberto</b>,</p>
        <p style="font-size:15px; margin:0 0 16px;">
          Les résultats de la <b>semaine ${weekNum}</b> ont été publiés avec succès sur <a href="${league.siteUrl}" style="color:#2563eb; text-decoration:none; font-weight:600;">${siteHost}</a>!
        </p>
        <div style="background-color:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:14px; margin:0 0 18px;">
          <div style="font-size:12px; font-weight:700; color:#64748b; text-transform:uppercase; margin-bottom:8px;">Matchs enregistrés</div>
          ${gameCardsHtml}
        </div>
        <div style="background-color:#ecfdf5; border:1px solid #a7f3d0; border-radius:6px; padding:12px 14px; margin:0 0 20px; font-size:14px; color:#065f46;">
          ✅ <b>Sauvegarde automatique effectuée :</b><br>
          • Archivée dans le Cloud (Clé : <code>${backupKey}</code>)<br>
          • Fichier <code>data.json</code> complet attaché à ce courriel.
        </div>
        <div style="margin:20px 0;">
          <a href="${downloadUrl}" style="display:inline-block; padding:12px 20px; background-color:#17457f; color:#ffffff; text-decoration:none; font-weight:700; font-size:14px; border-radius:6px; margin-right:8px;">📥 Télécharger cette copie JSON</a>
          <a href="${league.siteUrl}" style="display:inline-block; padding:12px 20px; background-color:#f1f5f9; color:#1e293b; text-decoration:none; font-weight:600; font-size:14px; border-radius:6px; border:1px solid #cbd5e1;">🌐 Voir ${siteHost}</a>
        </div>
      </td>
    </tr>
    <tr>
      <td style="background-color:#f8fafc; padding:14px 20px; border-top:1px solid #e2e8f0; font-size:12px; color:#64748b; text-align:center;">
        ${league.name} · ${league.tagline} · <a href="${league.siteUrl}" style="color:#2563eb; text-decoration:none;">${siteHost}</a>
      </td>
    </tr>
  </table>
</body>
</html>`;

      await sendMailFunc(env, replyToEmail, subj, text, html, attachments, publishLeagueCfg);
      console.log(`Backup email sent to ${replyToEmail}`);
    } catch (mailErr) {
      console.error('Error sending backup email:', mailErr);
    }
  }

  // 4. Immediate deletion of all temporary images
  const imageKeys = JSON.parse(review.images_json || '[]');
  for (const k of imageKeys) {
    try {
      await env.SHEETS_KV.delete(k);
    } catch (e) {
      console.error('Error deleting image key', k, e);
    }
  }

  const eventId = review.event_id;

  // 5. Sync new players and attendance to D1 contacts and rsvp
  try {
    for (const g of games) {
      const participants = [
        ...(g.home_players || []).filter(p => !p.absent).map(p => ({ ...p, team: g.home_team, isGoalie: false })),
        ...(g.away_players || []).filter(p => !p.absent).map(p => ({ ...p, team: g.away_team, isGoalie: false })),
        ...(g.home_goalie?.name ? [{ name: g.home_goalie.name, id: g.home_goalie.id, team: g.home_team, isGoalie: true }] : []),
        ...(g.away_goalie?.name ? [{ name: g.away_goalie.name, id: g.away_goalie.id, team: g.away_team, isGoalie: true }] : [])
      ];

      for (const pt of participants) {
        const pObj = (updatedData.players || []).find(x => (pt.id && x.id === pt.id) || cleanName(x.name) === cleanName(pt.name));
        const pId = pObj?.id || pt.id;
        const pName = pObj?.name || pt.name;

        if (!pId) continue;

        // Check contacts table by player_id OR normalized name
        const contact = await env.DB.prepare(
          `SELECT player_id, name, email, role, is_goalie, preferred_team 
             FROM contacts 
            WHERE player_id = ? OR LOWER(TRIM(name)) = LOWER(TRIM(?))`
        ).bind(pId, pName).first();

        if (contact && contact.player_id !== pId) {
          const oldPid = contact.player_id;
          // Sub was originally assigned a temporary P9xxx ID. Migrate to canonical league pId.
          await env.DB.prepare('UPDATE contacts SET player_id = ?, last_played = ? WHERE player_id = ?').bind(pId, seasonName, oldPid).run();
          await env.DB.prepare('UPDATE rsvp SET player_id = ? WHERE player_id = ?').bind(pId, oldPid).run();
          await env.DB.prepare('UPDATE availability SET player_id = ? WHERE player_id = ?').bind(pId, oldPid).run();
          await env.DB.prepare('UPDATE outbox SET player_id = ? WHERE player_id = ?').bind(pId, oldPid).run();
          try {
            await env.DB.prepare('UPDATE team_messages SET player_id = ? WHERE player_id = ?').bind(pId, oldPid).run();
          } catch (_) {}
        } else if (contact) {
          await env.DB.prepare('UPDATE contacts SET last_played = ? WHERE player_id = ?').bind(seasonName, pId).run();
        } else {
          const salt = crypto.randomUUID().replace(/-/g, '');
          const role = pt.isGoalie ? 'sub_goalie' : 'sub_skater';
          await env.DB.prepare(
            `INSERT INTO contacts (player_id, name, is_sub, role, is_goalie, token_salt, last_played)
             VALUES (?, ?, 1, ?, ?, ?, ?)`
          ).bind(pId, pName, role, pt.isGoalie ? 1 : 0, salt, seasonName).run();
        }

        // Record attendance in rsvp
        if (eventId) {
          const existingRsvp = await env.DB.prepare(
            'SELECT player_id, team, status, role, status_by FROM rsvp WHERE event_id = ? AND player_id = ?'
          ).bind(eventId, pId).first();

          if (!existingRsvp) {
            await env.DB.prepare(
              `INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at)
               VALUES (?, ?, ?, 'in', 'sub', 'sheet', ?)`
            ).bind(eventId, pId, pt.team, now).run();
          } else if (existingRsvp.status !== 'in' || existingRsvp.team !== pt.team) {
            await env.DB.prepare(
              `UPDATE rsvp SET team = ?, status = 'in', updated_at = ? WHERE event_id = ? AND player_id = ?`
            ).bind(pt.team, now, eventId, pId).run();
          }
        }
      }
    }
  } catch (err) {
    console.error('Error syncing players to D1:', err);
  }

  await env.DB.prepare(
    `UPDATE sheet_reviews SET status = 'published', images_json = NULL, validated_json = ?, published_at = ? WHERE id = ?`
  ).bind(JSON.stringify(games), now, review_id).run();

  // If champion crowned after the final playoff game, schedule recap prompt for admin in 60 mins
  if (updatedData.seasons?.[0]?.champion) {
    try {
      const sendAfter = new Date(Date.now() + 60 * 60000).toISOString();
      await env.DB.prepare(
        `INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at)
         VALUES ('season_recap_prompt', ?, NULL, NULL, ?, ?, ?, ?)`
      ).bind(
        review.event_id || `${seasonName}-${weekNum}`,
        `season_recap_prompt:${seasonName}`,
        JSON.stringify({ season: seasonName, to: replyToEmail || 'emailrobertosantana@gmail.com' }),
        sendAfter,
        now
      ).run();
    } catch (recapErr) {
      console.error('Error queuing season recap prompt after playoff review:', recapErr);
    }
  }

  // 6. Transition completed event to 'done' and auto-create/open next event
  try {
    if (eventId) {
      await env.DB.prepare("UPDATE events SET state = 'done' WHERE id = ?").bind(eventId).run();
    }
    if (weekNum) {
      await env.DB.prepare("UPDATE events SET state = 'done' WHERE week = ?").bind(weekNum).run();
    }
  } catch (evErr) {
    console.error('Error marking event done after review publish:', evErr);
  }

  if (typeof ensureNextEventFunc === 'function') {
    try {
      await ensureNextEventFunc(env, true);
    } catch (nextErr) {
      console.error('Error auto-creating next event after review publish:', nextErr);
    }
  }

  return Response.json({ ok: true, published: true });
}

export async function handleReviewDiscard(req, env) {
  const { review_id } = await req.json().catch(() => ({}));
  if (!review_id) return Response.json({ ok: false, error: 'Missing review_id' }, { status: 400 });

  const review = await env.DB.prepare('SELECT * FROM sheet_reviews WHERE id = ?').bind(review_id).first();
  if (!review) return Response.json({ ok: false, error: 'Review not found' }, { status: 404 });

  const imageKeys = JSON.parse(review.images_json || '[]');
  for (const k of imageKeys) {
    try { await env.SHEETS_KV.delete(k); } catch (e) {}
  }

  await env.DB.prepare(`UPDATE sheet_reviews SET status = 'discarded', images_json = NULL WHERE id = ?`).bind(review_id).run();
  return Response.json({ ok: true, discarded: true });
}

export async function handleDataJson(env) {
  const kvData = await env.SHEETS_KV.get('data_json');
  if (kvData) {
    return new Response(kvData, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=60'
      }
    });
  }
  const r = await fetch(`${env.SITE_URL || 'https://smbhl.com'}/data.json`);
  return new Response(await r.text(), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=60'
    }
  });
}

export async function handleListBackups(env) {
  const history = await env.SHEETS_KV.get('backup:history');
  return new Response(history || '[]', {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    }
  });
}

export async function handleDownloadBackup(env, url) {
  const key = url.searchParams.get('key');
  if (!key) return new Response('Missing key parameter', { status: 400 });
  const content = await env.SHEETS_KV.get(key);
  if (!content) return new Response('Backup not found', { status: 404 });
  const filename = key.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json';
  return new Response(content, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    }
  });
}


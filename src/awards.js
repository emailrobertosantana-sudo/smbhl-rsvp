// Seasonal awards computation, standings tie-breaking, and end-of-season recap helpers

import { normalizeSeasonConfig, getSeasonConfig, getTeamNames } from './season_config.js';

/**
 * Sorts league standings according to SMBHL tie-break rules:
 * 1. Points (pts)
 * 2. Total Wins (w)
 * 3. Goal Differential (gf - ga)
 * 4. Total Goals For (gf)
 * 5. Most Goals Scored by Regular Players (reg_gf)
 * 6. Deterministic / Alphabetical tie-break
 *
 * @param {Array} standings - Array of team standing objects
 * @param {Object} regularGoalsMap - Map of team name to total goals scored by regular roster players { 'Red': 45, ... }
 * @returns {Array} Sorted standings
 */
export function sortStandings(standings, regularGoalsMap = {}) {
  return (standings || []).slice().sort((a, b) => {
    // 1. Points
    if (b.pts !== a.pts) return b.pts - a.pts;

    // 2. Wins
    if (b.w !== a.w) return b.w - a.w;

    // 3. Goal Differential (+/-)
    const diffA = (a.gf || 0) - (a.ga || 0);
    const diffB = (b.gf || 0) - (b.ga || 0);
    if (diffB !== diffA) return diffB - diffA;

    // 4. Goals For
    if (b.gf !== a.gf) return (b.gf || 0) - (a.gf || 0);

    // 5. Most Goals Scored by Regular Players
    const regA = regularGoalsMap[a.team] || 0;
    const regB = regularGoalsMap[b.team] || 0;
    if (regB !== regA) return regB - regA;

    // 6. Deterministic fallback
    return String(a.team || '').localeCompare(String(b.team || ''));
  });
}

/**
 * Computes goals scored by regular roster players for each team in a given season
 * @param {Object} dataJson - Full league data.json
 * @param {string} seasonName - Name of the season
 * @returns {Object} { 'Red': 32, 'Blue': 45, ... }
 */
export function getRegularGoalsByTeam(dataJson, seasonName) {
  const cfg = getSeasonConfig(dataJson, seasonName);
  const map = {};
  for (const t of getTeamNames(cfg)) map[t] = 0;
  const players = dataJson?.players || [];

  for (const p of players) {
    const sStat = p.seasons?.[seasonName];
    // Regular players have an assigned team on permanent roster (team !== null)
    if (sStat && sStat.team && map[sStat.team] !== undefined) {
      map[sStat.team] += Number(sStat.g || 0);
    }
  }
  return map;
}

/**
 * Computes pre-populated seasonal awards from season data
 * @param {Object} dataJson - Full league data.json
 * @param {string} seasonName - Name of the season
 * @returns {Object} Pre-populated awards with text descriptions
 */
export function computeSeasonAwards(dataJson, seasonName) {
  const s0 = dataJson?.seasons?.find(s => s.name === seasonName) || dataJson?.seasons?.[0];
  const season = s0?.name || seasonName || 'Fall 2026';
  const players = dataJson?.players || [];
  const standings = s0?.standings || [];

  // Team goal totals
  const teamGoals = {};
  for (const st of standings) {
    teamGoals[st.team] = Number(st.gf || 0);
  }

  const seasonSkaters = [];
  const seasonGoalies = [];

  for (const p of players) {
    let priorCareerGp = 0;
    let hadPriorRegularSkaterSeason = false;
    let hadPriorRegularGoalieSeason = false;

    // Check all seasons prior to the current season
    for (const [sName, sData] of Object.entries(p.seasons || {})) {
      if (sName !== season) {
        const gp = Number(sData?.gp || 0);
        priorCareerGp += gp;
        if (sData?.team !== null && gp > 0) {
          hadPriorRegularSkaterSeason = true;
        }
      }
    }

    for (const [gName, gData] of Object.entries(p.gseasons || {})) {
      if (gName !== season) {
        const gp = Number(gData?.gp || 0);
        priorCareerGp += gp;
        if (gData?.team !== null && gp > 0) {
          hadPriorRegularGoalieSeason = true;
        }
      }
    }

    const sStat = p.seasons?.[season];
    if (sStat && sStat.gp > 0) {
      const isRegular = sStat.team !== null;
      // Rookie rule: 1st official season as a regular, and <= 25 prior career games
      const isRookie = isRegular && !hadPriorRegularSkaterSeason && priorCareerGp <= 25;

      seasonSkaters.push({
        id: p.id,
        name: p.name,
        team: sStat.team,
        gp: Number(sStat.gp || 0),
        g: Number(sStat.g || 0),
        a: Number(sStat.a || 0),
        pts: Number(sStat.pts || (sStat.g + sStat.a) || 0),
        pos: sStat.pos || null,
        isRookie,
        isSub: sStat.team === null,
        priorCareerGp
      });
    }

    const gStat = p.gseasons?.[season];
    if (gStat && gStat.gp > 0) {
      const isRegular = gStat.team !== null;
      // 1st official season as a regular goalie, and <= 25 prior career games
      const isRookieGoalie = isRegular && !hadPriorRegularGoalieSeason && priorCareerGp <= 25;

      seasonGoalies.push({
        id: p.id,
        name: p.name,
        team: gStat.team,
        gp: Number(gStat.gp || 0),
        ga: Number(gStat.ga || 0),
        gaa: gStat.gp > 0 ? Number((gStat.ga / gStat.gp).toFixed(2)) : 999,
        w: Number(gStat.w || 0),
        l: Number(gStat.l || 0),
        t: Number(gStat.t || 0),
        so: Number(gStat.so || 0),
        isRookieGoalie,
        priorCareerGp
      });
    }
  }

  // 1. Rocket Richard: Top Goal Scorer
  const byGoals = seasonSkaters.slice().sort((a, b) => b.g - a.g || b.pts - a.pts);
  let rocketRichard = '';
  if (byGoals.length && byGoals[0].g > 0) {
    const topG = byGoals[0].g;
    const tied = byGoals.filter(s => s.g === topG);
    const gLabel = topG === 1 ? '1 but / goal' : `${topG} buts / goals`;
    if (tied.length > 1) {
      const names = tied.map(s => s.name);
      const nameStr = names.length === 2 ? names.join(' & ') : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
      rocketRichard = `${nameStr}, ${gLabel}`;
    } else {
      rocketRichard = `${tied[0].name}, ${gLabel}`;
    }
  }

  // 2. Lady Byng: Most Assists (only mentions multiple players in case of a tie)
  const byAssists = seasonSkaters.slice().sort((a, b) => b.a - a.a || b.pts - a.pts);
  let ladyByng = '';
  if (byAssists.length && byAssists[0].a > 0) {
    const topA = byAssists[0].a;
    const tied = byAssists.filter(s => s.a === topA);
    const aLabel = topA === 1 ? '1 passe / assist' : `${topA} passes / assists`;
    if (tied.length > 1) {
      const names = tied.map(s => s.name);
      const nameStr = names.length === 2 ? names.join(' & ') : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
      ladyByng = `${nameStr}, ${aLabel}`;
    } else {
      ladyByng = `${tied[0].name}, ${aLabel}`;
    }
  }

  // 3. Art Ross: Most Points
  const byPts = seasonSkaters.slice().sort((a, b) => b.pts - a.pts || b.g - a.g);
  let artRoss = '';
  if (byPts.length && byPts[0].pts > 0) {
    const topPts = byPts[0].pts;
    const tied = byPts.filter(s => s.pts === topPts);
    const ptsLabel = topPts === 1 ? '1 point' : `${topPts} points`;
    if (tied.length > 1) {
      const names = tied.map(s => s.name);
      const nameStr = names.length === 2 ? names.join(' & ') : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
      artRoss = `${nameStr}, ${ptsLabel}`;
    } else {
      artRoss = `${tied[0].name}, ${ptsLabel}`;
    }
  }

  // 4. Hart Trophy: Highest Points Per Game (min 4 GP if available, else min 1)
  const qualifiedForHart = seasonSkaters.filter(s => s.gp >= 4);
  const hartCandidates = qualifiedForHart.length ? qualifiedForHart : seasonSkaters.filter(s => s.gp > 0);
  const byPpg = hartCandidates.slice().sort((a, b) => (b.pts / b.gp) - (a.pts / a.gp) || b.pts - a.pts);
  const hartTrophy = byPpg.length && byPpg[0].pts > 0
    ? `${byPpg[0].name}, ${(byPpg[0].pts / byPpg[0].gp).toFixed(1)} PPM / PPG`
    : '';

  // 5. Norris: Top Defenseman (pos === 'D', or top scoring defenseman pick)
  const defs = seasonSkaters.filter(s => s.pos === 'D');
  const topDef = defs.length
    ? defs.sort((a, b) => b.pts - a.pts)[0]
    : null;
  const norris = topDef
    ? `${topDef.name}, ${topDef.pts} ${topDef.pts === 1 ? 'point' : 'points'}`
    : '';

  // 6. Vezina: Lowest GAA (min 2 GP if available)
  const qualifiedGoalies = seasonGoalies.filter(g => g.gp >= 2);
  const gCandidates = qualifiedGoalies.length ? qualifiedGoalies : seasonGoalies.filter(g => g.gp > 0);
  const byGaa = gCandidates.slice().sort((a, b) => a.gaa - b.gaa || b.w - a.w);
  const vezina = byGaa.length
    ? `${byGaa[0].name}, ${byGaa[0].gaa.toFixed(2)} MBA / GAA`
    : '';

  // 7. Calder: Top Rookie
  // Eligible: 1st official season as regular on a roster, with <= 25 prior career games (subs can be considered at discretion).
  const rookieSkaters = seasonSkaters.filter(s => s.isRookie && s.pts > 0);
  const topRookieSkater = rookieSkaters.length
    ? rookieSkaters.sort((a, b) => b.pts - a.pts || b.g - a.g)[0]
    : null;

  const rookieGoalies = seasonGoalies.filter(g => g.isRookieGoalie);
  const topRookieGoalie = rookieGoalies.length
    ? rookieGoalies.sort((a, b) => a.gaa - b.gaa || b.w - a.w)[0]
    : null;

  const calder = topRookieSkater
    ? `${topRookieSkater.name}, ${topRookieSkater.pts} ${topRookieSkater.pts === 1 ? 'point' : 'points'}`
    : (topRookieGoalie ? `${topRookieGoalie.name} (G), ${topRookieGoalie.gaa.toFixed(2)} MBA / GAA` : '');

  const calderCandidates = {
    topSkater: topRookieSkater ? { name: topRookieSkater.name, pts: topRookieSkater.pts, g: topRookieSkater.g, team: topRookieSkater.team } : null,
    topGoalie: topRookieGoalie ? { name: topRookieGoalie.name, gaa: topRookieGoalie.gaa, gp: topRookieGoalie.gp, w: topRookieGoalie.w, team: topRookieGoalie.team } : null,
    allRookieSkaters: rookieSkaters.map(s => ({ name: s.name, pts: s.pts, g: s.g, team: s.team })),
    allRookieGoalies: rookieGoalies.map(g => ({ name: g.name, gaa: g.gaa, gp: g.gp, w: g.w, team: g.team }))
  };

  // 8. Subway Award: Top Sub
  const subs = seasonSkaters.filter(s => s.isSub && s.pts > 0);
  const topSub = subs.length
    ? subs.sort((a, b) => b.pts - a.pts || b.g - a.g)[0]
    : null;
  const subway = topSub
    ? `${topSub.name}, ${topSub.pts} ${topSub.pts === 1 ? 'point' : 'points'}`
    : '';

  // 9. MVP: Highest % involvement in their team's goals (player.pts / team.gf)
  let bestMvp = null;
  for (const s of seasonSkaters) {
    if (!s.team) continue;
    const tGf = teamGoals[s.team] || 0;
    if (tGf > 0 && s.pts > 0) {
      const pct = Math.round((s.pts / tGf) * 100);
      if (!bestMvp || pct > bestMvp.pct || (pct === bestMvp.pct && s.pts > bestMvp.pts)) {
        bestMvp = { name: s.name, team: s.team, pct, pts: s.pts };
      }
    }
  }
  const mvp = bestMvp
    ? `${bestMvp.name}, ${bestMvp.pct}% des buts / goals (Team ${bestMvp.team})`
    : '';

  // 10. Bill Masterton: Suggested winner is Most Improved player since previous season (can be overwritten)
  let billMasterton = '';
  const allSeasons = dataJson?.seasons || [];
  const currentIdx = allSeasons.findIndex(s => s.name === season);
  const prevSeason = currentIdx >= 0 && currentIdx + 1 < allSeasons.length ? allSeasons[currentIdx + 1] : null;

  if (prevSeason && prevSeason.name) {
    const prevSeasonName = prevSeason.name;
    let bestImproved = null;

    for (const p of players) {
      const curStat = p.seasons?.[season];
      const prevStat = p.seasons?.[prevSeasonName];

      if (curStat && curStat.gp >= 2 && prevStat && prevStat.gp >= 2) {
        const curPts = Number(curStat.pts || (curStat.g + curStat.a) || 0);
        const prevPts = Number(prevStat.pts || (prevStat.g + prevStat.a) || 0);
        const ptsDiff = curPts - prevPts;

        if (ptsDiff > 0 && (!bestImproved || ptsDiff > bestImproved.ptsDiff)) {
          bestImproved = { name: p.name, ptsDiff };
        }
      }
    }

    if (bestImproved) {
      billMasterton = bestImproved.name;
    }
  }

  // Determine champion: if final game played, use winner, else check s0.champion
  const champion = s0?.champion || '';

  return {
    season,
    champion,
    rocketRichard,
    ladyByng,
    artRoss,
    hartTrophy,
    norris,
    vezina,
    calder,
    calderCandidates,
    subway,
    mvp,
    billMasterton
  };
}

/**
 * Picks the ordered pair of fixtures for a playoff slot (e.g. the two semifinal
 * games, or Final + Consolation). Order is determined by each fixture's gym name
 * when the slot has at least as many distinct gyms as games (dynamic replacement
 * for the old hardcoded 'Gym #1' / 'Gym #2' lookup); otherwise falls back to the
 * fixtures' original order.
 */
function pickSlotFixtures(fixtures) {
  const gyms = new Set(fixtures.map(f => f.gym).filter(Boolean));
  if (gyms.size >= fixtures.length) {
    return fixtures.slice().sort((a, b) => String(a.gym || '').localeCompare(String(b.gym || '')));
  }
  return fixtures.slice();
}

/**
 * Seeds and, once played, resolves the winners for a 1v4 / 2v3 slot, returning
 * the winner/loser pair used to seed the next round.
 */
function seedAndResolveSemis(semiFixtures, rank1, rank2, rank3, rank4) {
  const [f1v4, f2v3] = pickSlotFixtures(semiFixtures);

  if (f1v4.hg === null || f1v4.hg === undefined) {
    f1v4.home = rank1;
    f1v4.away = rank4;
  }
  if (f2v3.hg === null || f2v3.hg === undefined) {
    f2v3.home = rank2;
    f2v3.away = rank3;
  }

  const played = f1v4.hg !== null && f1v4.hg !== undefined && f2v3.hg !== null && f2v3.hg !== undefined;
  if (!played) return null;

  const hg1 = Number(f1v4.hg), ag1 = Number(f1v4.ag);
  const hg2 = Number(f2v3.hg), ag2 = Number(f2v3.ag);

  return {
    winner1: hg1 > ag1 ? f1v4.home : f1v4.away,
    loser1:  hg1 > ag1 ? f1v4.away : f1v4.home,
    winner2: hg2 > ag2 ? f2v3.home : f2v3.away,
    loser2:  hg2 > ag2 ? f2v3.away : f2v3.home
  };
}

/**
 * Seeds Final/Consolation from the semifinal results and, once the Final is
 * played, crowns the champion (unless already set/overridden).
 */
function seedAndResolveFinal(s0, finalFixtures, results) {
  const { winner1, loser1, winner2, loser2 } = results;
  const [fFinal, fConsol] = pickSlotFixtures(finalFixtures);

  if (fFinal.hg === null || fFinal.hg === undefined) {
    fFinal.home = winner1;
    fFinal.away = winner2;
  }
  if (fConsol.hg === null || fConsol.hg === undefined) {
    fConsol.home = loser1;
    fConsol.away = loser2;
  }

  if (fFinal.hg !== null && fFinal.hg !== undefined) {
    const finalHg = Number(fFinal.hg);
    const finalAg = Number(fFinal.ag);
    if (!s0.champion) {
      s0.champion = finalHg > finalAg ? fFinal.home : fFinal.away;
    }
    if (!s0.last_game && fFinal.date) {
      s0.last_game = fFinal.date;
    }
  }
}

/**
 * Resolves the season config for the season actually being processed (not
 * always "the current season"): the season's own `.config` if present,
 * otherwise the standard getSeasonConfig(dataJson, seasonName) chain
 * (season lookup -> current_season -> SMBHL defaults).
 */
function resolvePlayoffConfig(s0, dataJson) {
  if (s0 && s0.config && typeof s0.config === 'object') {
    return normalizeSeasonConfig(s0.config);
  }
  return getSeasonConfig(dataJson, s0 && s0.name);
}

/**
 * Automatically updates playoff fixtures according to the season's playoffFormat:
 * - 'none': no automated playoff scheduling.
 * - 'top4_single_day' (default): both rounds played in the last fixture week --
 *   Game 1 (1v4, 2v3) in the earlier time slot, Game 2 (Final/Consolation) in the
 *   later slot. Works for any standings size >= 4 (top 4 make the playoffs).
 * - 'top4_two_weeks': semifinals (1v4, 2v3) seeded in the second-to-last fixture
 *   week, Final/Consolation in the last fixture week.
 * Once the Final is played, crowns the season champion.
 *
 * @param {Object} s0 - Season object from data.json (the season being processed)
 * @param {Object} [dataJson] - Full data.json payload, used to resolve config
 *   fallback (current season, then SMBHL defaults) when s0 has no own config.
 */
export function updatePlayoffSchedule(s0, dataJson) {
  if (!s0 || !s0.fixtures || !s0.fixtures.length) return;

  const cfg = resolvePlayoffConfig(s0, dataJson);
  if (cfg.playoffFormat === 'none') return;
  if (!s0.standings || s0.standings.length < 4) return;

  const rank1 = s0.standings[0].team;
  const rank2 = s0.standings[1].team;
  const rank3 = s0.standings[2].team;
  const rank4 = s0.standings[3].team;

  if (cfg.playoffFormat === 'top4_two_weeks') {
    const weeks = [...new Set(s0.fixtures.map(f => Number(f.week) || 0))].sort((a, b) => a - b);
    if (weeks.length < 2) return;
    const finalWeek = weeks[weeks.length - 1];
    const semiWeek = weeks[weeks.length - 2];

    const semiFixtures = s0.fixtures.filter(f => Number(f.week) === semiWeek);
    const finalFixtures = s0.fixtures.filter(f => Number(f.week) === finalWeek);
    if (semiFixtures.length < 2 || finalFixtures.length < 2) return;

    const regularFixtures = s0.fixtures.filter(f => Number(f.week) < semiWeek);
    const allRegularPlayed = regularFixtures.length > 0 && regularFixtures.every(f =>
      f.hg !== null && f.ag !== null && f.hg !== undefined && f.ag !== undefined
    );
    if (!allRegularPlayed) return;

    const results = seedAndResolveSemis(semiFixtures, rank1, rank2, rank3, rank4);
    if (results) seedAndResolveFinal(s0, finalFixtures, results);
    return;
  }

  // 'top4_single_day' (and any unrecognized format falls back to this default)
  const maxWeek = Math.max(...s0.fixtures.map(f => Number(f.week) || 0));
  const playoffFixtures = s0.fixtures.filter(f => Number(f.week) === maxWeek);
  if (playoffFixtures.length < 4) return;

  const regularFixtures = s0.fixtures.filter(f => Number(f.week) < maxWeek);
  const allRegularPlayed = regularFixtures.length > 0 && regularFixtures.every(f =>
    f.hg !== null && f.ag !== null && f.hg !== undefined && f.ag !== undefined
  );
  if (!allRegularPlayed) return;

  // Distinguish early game (Game 1 - Semi-finals) vs later game (Game 2 - Finals)
  const times = [...new Set(playoffFixtures.map(f => f.time))].sort();
  const game1Time = times[0];
  const game1Fixtures = playoffFixtures.filter(f => f.time === game1Time);
  const game2Fixtures = playoffFixtures.filter(f => f.time !== game1Time);
  if (game1Fixtures.length < 2 || game2Fixtures.length < 2) return;

  const results = seedAndResolveSemis(game1Fixtures, rank1, rank2, rank3, rank4);
  if (results) seedAndResolveFinal(s0, game2Fixtures, results);
}


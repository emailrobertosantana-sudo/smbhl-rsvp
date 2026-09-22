// Highlights, weekly honors, milestone tracking, and career firsts for SMBHL invite emails

import { getTeamNameFr, DEFAULT_SEASON_CONFIG } from './season_config.js';

export function getMilestonesForStat(statType, maxCareerVal = 0) {
  let base;
  if (statType === 'pts') {
    // 25, 50, 75, 100, 200, 250, 300, 400, 500, 600, 700, 750, 800, 900
    base = [25, 50, 75, 100, 200, 250, 300, 400, 500, 600, 700, 750, 800, 900];
  } else if (statType === 'g' || statType === 'a') {
    // 25, 50, 75, 100, 200, 250, 300, 400, 500, 600, 700, 750, 800, 900
    base = [25, 50, 75, 100, 200, 250, 300, 400, 500, 600, 700, 750, 800, 900];
  } else if (statType === 'gp') {
    // 25, 50, 75, 100, 200, 250, 300, 400, 500, 600, 700, 750, 800, 900
    base = [25, 50, 75, 100, 200, 250, 300, 400, 500, 600, 700, 750, 800, 900];
  } else if (statType === 'gw') {
    // 10, 25, 50, 75, 100, 150, 200, 225, 250, 275, 300... (every 25 thereafter)
    base = [10, 25, 50, 75, 100, 150, 200];
    const upperLimit = Math.max(250, Math.ceil((maxCareerVal + 25) / 25) * 25);
    for (let mark = 225; mark <= upperLimit; mark += 25) {
      base.push(mark);
    }
    return base.sort((a, b) => b - a);
  } else {
    base = [25, 50, 75, 100];
  }

  // Any mark >= 1000 increases by 250, dynamically expanding whenever a player approaches/passes it
  const upperLimit = Math.max(1500, Math.ceil((maxCareerVal + 250) / 250) * 250);
  for (let mark = 1000; mark <= upperLimit; mark += 250) {
    base.push(mark);
  }
  return base.sort((a, b) => b - a);
}

export function isFullName(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (/\bTBD\b/i.test(trimmed)) return false;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  return parts.length >= 2;
}

export function cleanPlayerName(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

export const EXCLUDED_FROM_CAREER_FIRSTS = new Set([]);

/**
 * Computes the weekly recap from games data and data.json
 * @param {Object} dataJson - Full league data.json
 * @param {number} weekNum - Week number
 * @param {Array} games - Games played in this week
 */
export function computeWeeklyRecap(dataJson, weekNum, games = []) {
  if (!games || games.length === 0) {
    return {
      week: weekNum,
      achievements: [],
      playerOfTheWeek: null,
      goalieOfTheWeek: null,
      subOfTheWeek: null,
      firsts: { goals: [], assists: [] }
    };
  }

  const s0 = dataJson?.seasons?.[0];
  const seasonName = s0?.name || dataJson?.current_season || 'Fall 2026';
  const players = dataJson?.players || [];

  // Aggregate skater and goalie stats for this week's games
  const skaterStats = new Map(); // key -> { name, team, id, g, a, pts, isSub }
  const goalieStats = new Map(); // key -> { name, team, id, gp, ga, w, l, t, isSub }

  for (const g of games) {
    const hScore = Number(g.home_score);
    const aScore = Number(g.away_score);

    // Home players
    for (const p of (g.home_players || [])) {
      if (p.absent) continue;
      const key = p.id || cleanPlayerName(p.name);
      if (!skaterStats.has(key)) {
        skaterStats.set(key, { name: p.name, team: g.home_team, id: p.id, g: 0, a: 0, pts: 0, isSub: false });
      }
      const rec = skaterStats.get(key);
      const goals = Number(p.goals) || 0;
      const assists = Number(p.assists) || 0;
      rec.g += goals;
      rec.a += assists;
      rec.pts += (goals + assists);
    }

    // Away players
    for (const p of (g.away_players || [])) {
      if (p.absent) continue;
      const key = p.id || cleanPlayerName(p.name);
      if (!skaterStats.has(key)) {
        skaterStats.set(key, { name: p.name, team: g.away_team, id: p.id, g: 0, a: 0, pts: 0, isSub: false });
      }
      const rec = skaterStats.get(key);
      const goals = Number(p.goals) || 0;
      const assists = Number(p.assists) || 0;
      rec.g += goals;
      rec.a += assists;
      rec.pts += (goals + assists);
    }

    // Home goalie
    if (g.home_goalie && g.home_goalie.name) {
      const key = g.home_goalie.id || cleanPlayerName(g.home_goalie.name);
      const ga = Number(g.home_goalie.ga) || aScore || 0;
      if (!goalieStats.has(key)) {
        goalieStats.set(key, { name: g.home_goalie.name, team: g.home_team, id: g.home_goalie.id, gp: 0, ga: 0, w: 0, l: 0, t: 0, so: 0, isSub: false });
      }
      const rec = goalieStats.get(key);
      rec.gp += 1;
      rec.ga += ga;
      if (ga === 0) rec.so = (rec.so || 0) + 1;
      if (hScore > aScore) rec.w += 1;
      else if (hScore < aScore) rec.l += 1;
      else rec.t += 1;
    }

    // Away goalie
    if (g.away_goalie && g.away_goalie.name) {
      const key = g.away_goalie.id || cleanPlayerName(g.away_goalie.name);
      const ga = Number(g.away_goalie.ga) || hScore || 0;
      if (!goalieStats.has(key)) {
        goalieStats.set(key, { name: g.away_goalie.name, team: g.away_team, id: g.away_goalie.id, gp: 0, ga: 0, w: 0, l: 0, t: 0, so: 0, isSub: false });
      }
      const rec = goalieStats.get(key);
      rec.gp += 1;
      rec.ga += ga;
      if (ga === 0) rec.so = (rec.so || 0) + 1;
      if (aScore > hScore) rec.w += 1;
      else if (aScore < hScore) rec.l += 1;
      else rec.t += 1;
    }
  }

  // Determine which players are substitutes (team in season is null, or not on permanent roster)
  for (const [key, rec] of skaterStats.entries()) {
    const pObj = players.find(x => (rec.id && x.id === rec.id) || cleanPlayerName(x.name) === key);
    if (pObj) {
      const seasonRec = pObj.seasons?.[seasonName];
      if (!seasonRec || seasonRec.team === null) {
        rec.isSub = true;
      }
    }
  }
  for (const [key, rec] of goalieStats.entries()) {
    const pObj = players.find(x => (rec.id && x.id === rec.id) || cleanPlayerName(x.name) === key);
    if (pObj) {
      const gSeasonRec = pObj.gseasons?.[seasonName];
      if (!gSeasonRec || gSeasonRec.team === null) {
        rec.isSub = true;
      }
    }
  }

  // 1. Player of the week (highest points among skaters with full names)
  const allSkaters = Array.from(skaterStats.values()).filter(s => isFullName(s.name));
  allSkaters.sort((a, b) => b.pts - a.pts || b.g - a.g);
  const playerOfTheWeek = allSkaters.length && allSkaters[0].pts > 0 ? allSkaters[0] : null;

  // 2. Goalie of the week (lowest GAA among goalies with gp >= 1 and full names, tiebreak on wins, then gp)
  const allGoalies = Array.from(goalieStats.values()).filter(g => g.gp > 0 && isFullName(g.name));
  allGoalies.sort((a, b) => {
    const gaaA = a.ga / a.gp;
    const gaaB = b.ga / b.gp;
    if (Math.abs(gaaA - gaaB) > 0.001) return gaaA - gaaB;
    return b.w - a.w || b.gp - a.gp;
  });
  const goalieOfTheWeek = allGoalies.length ? {
    ...allGoalies[0],
    gaa: Number((allGoalies[0].ga / allGoalies[0].gp).toFixed(2))
  } : null;

  // 3. Sub of the week: if the top sub is the same person as the Player of the week, award it to the next best sub using the same ranking. If there is no other eligible sub, omit the line.
  const allSubs = allSkaters.filter(s => s.isSub);
  allSubs.sort((a, b) => b.pts - a.pts || b.g - a.g || (a.name || '').localeCompare(b.name || ''));
  let subOfTheWeek = null;
  if (allSubs.length > 0) {
    const isTopSubPotw = playerOfTheWeek && (allSubs[0].id ? allSubs[0].id === playerOfTheWeek.id : cleanPlayerName(allSubs[0].name) === cleanPlayerName(playerOfTheWeek.name));
    if (isTopSubPotw) {
      subOfTheWeek = allSubs.length > 1 ? allSubs[1] : null;
    } else {
      subOfTheWeek = allSubs[0];
    }
  }

  // 4. Firsts: Goal, Assist, Goalie Win, Goalie Shutout (full names only, no TBD)
  const firstGoals = [];
  const firstAssists = [];
  const firstWins = [];
  const firstShutouts = [];

  for (const s of allSkaters) {
    if (!isFullName(s.name)) continue;
    const pObj = players.find(x => (s.id && x.id === s.id) || cleanPlayerName(x.name) === cleanPlayerName(s.name));
    if (!pObj) continue;

    const pKey = cleanPlayerName(pObj.name);
    if (EXCLUDED_FROM_CAREER_FIRSTS.has(pKey)) continue;

    // Career stats in pObj include this game. Check if prior was 0.
    const careerG = pObj.career?.g || 0;
    const careerA = pObj.career?.a || 0;

    if (s.g > 0 && careerG === s.g) {
      firstGoals.push(s.name);
    }
    if (s.a > 0 && careerA === s.a) {
      firstAssists.push(s.name);
    }
  }

  for (const g of allGoalies) {
    if (!isFullName(g.name)) continue;
    const pObj = players.find(x => (g.id && x.id === g.id) || cleanPlayerName(x.name) === cleanPlayerName(g.name));
    if (!pObj) continue;

    const gcareer = pObj.gcareer || {};
    const careerW = gcareer.w || 0;
    const careerSO = gcareer.so || 0;

    if (g.w > 0 && careerW === g.w) {
      firstWins.push(g.name);
    }
    if (g.so > 0 && careerSO === g.so) {
      firstShutouts.push(g.name);
    }
  }

  // 5. Achievements reached (milestones crossed this week)
  const achievements = [];
  const checkMilestone = (cur, weekVal, mark, frLabel, enLabel, name, statType) => {
    const prev = cur - weekVal;
    if (prev < mark && cur >= mark) {
      achievements.push({
        name,
        mark,
        statType,
        fr: `${name} a atteint ${mark} ${frLabel}`,
        en: `${name} reached ${mark} ${enLabel}`
      });
    }
  };

  for (const s of allSkaters) {
    const pObj = players.find(x => (s.id && x.id === s.id) || cleanPlayerName(x.name) === cleanPlayerName(s.name));
    if (!pObj || !isFullName(pObj.name)) continue;

    const career = pObj.career || {};
    // Points
    for (const m of getMilestonesForStat('pts', career.pts || 0)) {
      checkMilestone(career.pts || 0, s.pts, m, 'points en carrière', 'career points', pObj.name, 'pts');
    }
    // Goals
    for (const m of getMilestonesForStat('g', career.g || 0)) {
      checkMilestone(career.g || 0, s.g, m, 'buts en carrière', 'career goals', pObj.name, 'g');
    }
    // Assists
    for (const m of getMilestonesForStat('a', career.a || 0)) {
      checkMilestone(career.a || 0, s.a, m, 'passes en carrière', 'career assists', pObj.name, 'a');
    }
    // Games played
    for (const m of getMilestonesForStat('gp', career.gp || 0)) {
      checkMilestone(career.gp || 0, 1, m, 'matchs en carrière', 'career games played', pObj.name, 'gp');
    }
  }

  // Check goalies for milestones (e.g. 200, 100, 75, 50, 25, 10 wins)
  for (const g of allGoalies) {
    const pObj = players.find(x => (g.id && x.id === g.id) || cleanPlayerName(x.name) === cleanPlayerName(g.name));
    if (!pObj || !isFullName(pObj.name)) continue;

    const gcareer = pObj.gcareer || {};
    for (const m of getMilestonesForStat('gw', gcareer.w || 0)) {
      checkMilestone(gcareer.w || 0, g.w, m, 'victoires en carrière', 'career goalie wins', pObj.name, 'gw');
    }
  }

  // All-time leaderboard rank movements (Top 25 skater points, Top 10 goalie wins)
  const rankMovements = computeAllTimeRankMovements(players, skaterStats, goalieStats);
  achievements.push(...rankMovements);

  return {
    week: weekNum,
    achievements,
    playerOfTheWeek,
    goalieOfTheWeek,
    subOfTheWeek,
    firsts: {
      goals: Array.from(new Set(firstGoals)),
      assists: Array.from(new Set(firstAssists)),
      wins: Array.from(new Set(firstWins)),
      shutouts: Array.from(new Set(firstShutouts))
    }
  };
}

/**
 * Helper to determine if skater A is strictly ahead of skater B
 * Points primary, goals tiebreaker, assists secondary tiebreaker
 */
export function isSkaterStrictlyAhead(aPts, aG, aA, bPts, bG, bA) {
  if (aPts !== bPts) return aPts > bPts;
  if (aG !== bG) return aG > bG;
  if (aA !== bA) return aA > bA;
  return false;
}

/**
 * Helper to determine if goalie A is strictly ahead of goalie B
 * Wins primary, fewer games played (gp) tiebreaker, fewer goals against (ga) secondary tiebreaker
 */
export function isGoalieStrictlyAhead(aW, aGP, aGA, bW, bGP, bGA) {
  if (aW !== bW) return aW > bW;
  if (aGP !== bGP) return aGP < bGP;
  if (aGA !== bGA) return aGA < bGA;
  return false;
}

/**
 * Computes all-time leaderboard movements for:
 * - Skaters entering or moving up within the Top 25 all-time points
 * - Goalies entering or moving up within the Top 10 all-time wins
 * Only triggers if the player strictly passed at least one player previously ahead.
 */
export function computeAllTimeRankMovements(players, skaterStats, goalieStats) {
  if (!players || !Array.isArray(players)) return [];
  skaterStats = skaterStats || new Map();
  goalieStats = goalieStats || new Map();

  const getSkaterWeek = (p) => {
    if (p.id && skaterStats.has(p.id)) return skaterStats.get(p.id);
    const clean = cleanPlayerName(p.name);
    if (skaterStats.has(clean)) return skaterStats.get(clean);
    for (const val of skaterStats.values()) {
      if ((p.id && val.id === p.id) || cleanPlayerName(val.name) === clean) return val;
    }
    return null;
  };

  const getGoalieWeek = (p) => {
    if (p.id && goalieStats.has(p.id)) return goalieStats.get(p.id);
    const clean = cleanPlayerName(p.name);
    if (goalieStats.has(clean)) return goalieStats.get(clean);
    for (const val of goalieStats.values()) {
      if ((p.id && val.id === p.id) || cleanPlayerName(val.name) === clean) return val;
    }
    return null;
  };

  const achievements = [];

  // 1. Skater Top 25 Points
  const skaterEntries = [];
  for (const p of players) {
    if (!isFullName(p.name)) continue;
    const career = p.career || {};
    const currentPts = Number(career.pts) || 0;
    const currentG = Number(career.g) || 0;
    const currentA = Number(career.a) || 0;

    const s = getSkaterWeek(p);
    const weekPts = Number(s?.pts) || 0;
    const weekG = Number(s?.g) || 0;
    const weekA = Number(s?.a) || 0;

    const priorPts = Math.max(0, currentPts - weekPts);
    const priorG = Math.max(0, currentG - weekG);
    const priorA = Math.max(0, currentA - weekA);

    skaterEntries.push({
      id: p.id,
      name: p.name,
      currentPts,
      currentG,
      currentA,
      priorPts,
      priorG,
      priorA,
      weekPts,
      weekG,
      weekA
    });
  }

  // Calculate priorRank and currentRank
  for (const s of skaterEntries) {
    s.priorRank = 1 + skaterEntries.filter(other =>
      other !== s && isSkaterStrictlyAhead(other.priorPts, other.priorG, other.priorA, s.priorPts, s.priorG, s.priorA)
    ).length;
    s.currentRank = 1 + skaterEntries.filter(other =>
      other !== s && isSkaterStrictlyAhead(other.currentPts, other.currentG, other.currentA, s.currentPts, s.currentG, s.currentA)
    ).length;
  }

  for (const s of skaterEntries) {
    if (s.weekPts <= 0 || s.currentRank > 25) continue;

    const passed = skaterEntries.filter(other =>
      other !== s &&
      isSkaterStrictlyAhead(other.priorPts, other.priorG, other.priorA, s.priorPts, s.priorG, s.priorA) &&
      isSkaterStrictlyAhead(s.currentPts, s.currentG, s.currentA, other.currentPts, other.currentG, other.currentA)
    );

    if (passed.length === 0) continue;

    passed.sort((a, b) => a.priorRank - b.priorRank);
    const passedNames = passed.map(p => p.name);

    const rankLabel = s.currentRank === 1 ? '1er rang historique' : `${s.currentRank}e rang historique`;
    const valStr = `${s.currentPts} ${s.currentPts === 1 ? 'pt' : 'pts'}`;
    const passedStr = ` (dépasse ${passedNames.join(', ')})`;
    const fr = `${rankLabel} · ${valStr}${passedStr}`;
    const enRank = s.currentRank === 1 ? '1st' : s.currentRank === 2 ? '2nd' : s.currentRank === 3 ? '3rd' : `${s.currentRank}th`;
    const en = `${enRank} all-time · ${valStr} (passes ${passedNames.join(', ')})`;

    achievements.push({
      name: s.name,
      mark: 10000 - s.currentRank,
      rank: s.currentRank,
      priorRank: s.priorRank,
      currentVal: s.currentPts,
      passedNames,
      statType: 'rank',
      subType: 'skater_points',
      fr,
      en
    });
  }

  // 2. Goalie Top 10 Wins
  const goalieEntries = [];
  for (const p of players) {
    if (!isFullName(p.name)) continue;
    const gcareer = p.gcareer || {};
    const currentW = Number(gcareer.w) || 0;
    const currentGP = Number(gcareer.gp) || 0;
    const currentGA = Number(gcareer.ga) || 0;

    const g = getGoalieWeek(p);
    const weekW = Number(g?.w) || 0;
    const weekGP = Number(g?.gp) || 0;
    const weekGA = Number(g?.ga) || 0;

    const priorW = Math.max(0, currentW - weekW);
    const priorGP = Math.max(0, currentGP - weekGP);
    const priorGA = Math.max(0, currentGA - weekGA);

    goalieEntries.push({
      id: p.id,
      name: p.name,
      currentW,
      currentGP,
      currentGA,
      priorW,
      priorGP,
      priorGA,
      weekW,
      weekGP,
      weekGA
    });
  }

  for (const g of goalieEntries) {
    g.priorRank = 1 + goalieEntries.filter(other =>
      other !== g && isGoalieStrictlyAhead(other.priorW, other.priorGP, other.priorGA, g.priorW, g.priorGP, g.priorGA)
    ).length;
    g.currentRank = 1 + goalieEntries.filter(other =>
      other !== g && isGoalieStrictlyAhead(other.currentW, other.currentGP, other.currentGA, g.currentW, g.currentGP, g.currentGA)
    ).length;
  }

  for (const g of goalieEntries) {
    if (g.weekW <= 0 || g.currentRank > 10) continue;

    const passed = goalieEntries.filter(other =>
      other !== g &&
      isGoalieStrictlyAhead(other.priorW, other.priorGP, other.priorGA, g.priorW, g.priorGP, g.priorGA) &&
      isGoalieStrictlyAhead(g.currentW, g.currentGP, g.currentGA, other.currentW, other.currentGP, other.currentGA)
    );

    if (passed.length === 0) continue;

    passed.sort((a, b) => a.priorRank - b.priorRank);
    const passedNames = passed.map(p => p.name);

    const rankLabel = g.currentRank === 1 ? '1er rang historique' : `${g.currentRank}e rang historique`;
    const valStr = `${g.currentW} ${g.currentW === 1 ? 'victoire' : 'victoires'}`;
    const passedStr = ` (dépasse ${passedNames.join(', ')})`;
    const fr = `${rankLabel} · ${valStr}${passedStr}`;
    const enRank = g.currentRank === 1 ? '1st' : g.currentRank === 2 ? '2nd' : g.currentRank === 3 ? '3rd' : `${g.currentRank}th`;
    const en = `${enRank} all-time · ${valStr} (passes ${passedNames.join(', ')})`;

    achievements.push({
      name: g.name,
      mark: 10000 - g.currentRank,
      rank: g.currentRank,
      priorRank: g.priorRank,
      currentVal: g.currentW,
      passedNames,
      statType: 'rank',
      subType: 'goalie_wins',
      fr,
      en
    });
  }

  return achievements;
}

/**
 * Computes top 2-3 players closing in on career milestones (matching website widget)
 */
export function computeClosingIn(dataJson) {
  if (!dataJson || !dataJson.players) return [];

  const curSeason = dataJson.current_season || dataJson.seasons?.[0]?.name || 'Fall 2026';
  const playerBestMap = new Map(); // playerId -> best closing in item

  dataJson.players.forEach(p => {
    if (!isFullName(p.name)) return;

    const s = p.seasons?.[curSeason];
    const gs = p.gseasons?.[curSeason];
    const isRosterRegular = (s && s.team !== null && s.team !== undefined) ||
                            (gs && gs.team !== null && gs.team !== undefined);
    const hasPlayedSub = (s && (!s.team) && Number(s.gp) >= 1) ||
                         (gs && (!gs.team) && Number(gs.gp) >= 1);

    if (!isRosterRegular && !hasPlayedSub) return;

    const c = p.career || {};
    const gc = p.gcareer || {};

    // Reachable thresholds: goals <= 4, assists <= 5, points <= 5, games played <= 2
    const checks = [
      { type: 'g', v: c.g || 0, maxNeed: 4 },
      { type: 'a', v: c.a || 0, maxNeed: 5 },
      { type: 'pts', v: c.pts || 0, maxNeed: 5 },
      { type: 'gp', v: (gc.gp > (c.gp || 0) ? gc.gp : (c.gp || 0)), maxNeed: 2 }
    ];

    checks.forEach(({ type, v, maxNeed }) => {
      const marks = getMilestonesForStat(type, v);
      const targets = marks.filter(m => m > v);
      const target = targets.length ? targets[targets.length - 1] : null;
      if (!target) return;
      const need = target - v;
      if (need <= maxNeed) {
        const item = {
          name: p.name,
          type,
          need,
          target,
          current: v
        };
        if (!playerBestMap.has(p.id) ||
            need < playerBestMap.get(p.id).need ||
            (need === playerBestMap.get(p.id).need && target > playerBestMap.get(p.id).target)) {
          playerBestMap.set(p.id, item);
        }
      }
    });
  });

  return Array.from(playerBestMap.values()).sort((a, b) => {
    if (a.need !== b.need) return a.need - b.need;
    if (a.target !== b.target) return b.target - a.target;
    return (a.name || '').localeCompare(b.name || '');
  });
}

/**
 * Returns baseline recap for Week 1 (from historical record in data.json)
 */
export function getWeek1BaselineRecap(dataJson) {
  return {
    week: 1,
    achievements: [
      {
        name: 'Guillaume Thibault',
        mark: 500,
        fr: 'Guillaume Thibault a atteint 500 points en carrière!',
        en: 'Guillaume Thibault reached 500 career points!'
      }
    ],
    playerOfTheWeek: {
      name: 'Anthony Coventry',
      team: 'Black',
      pts: 11,
      g: 5,
      a: 6
    },
    goalieOfTheWeek: {
      name: 'Anthony Saragoca',
      team: 'Blue',
      gp: 2,
      ga: 9,
      gaa: 4.5,
      w: 2
    },
    subOfTheWeek: {
      name: 'Armando Tempestilli',
      pts: 4,
      g: 2,
      a: 2
    },
    firsts: {
      goals: ['Max Latreille'],
      assists: ['Armando Tempestilli', 'Henrik Santana']
    }
  };
}

/**
 * Retrieves the weekly highlights to include in the invite email
 * - If targetWeek === 3: includes Week 1 and Week 2
 * - If targetWeek > 3: includes targetWeek - 1
 * - If targetWeek === 2: includes Week 1
 */
export async function getWeeklyHighlights(env, targetWeek, season = null) {
  const tWeek = Number(targetWeek);
  if (isNaN(tWeek) || tWeek <= 1) return null;

  let rawData = null;
  try {
    rawData = await env.SHEETS_KV.get('data_json');
  } catch (e) {}
  if (!rawData) {
    try {
      const r = await fetch(`${env.SITE_URL || 'https://smbhl.com'}/data.json`);
      if (r.ok) rawData = await r.text();
    } catch (e) {}
  }
  const dataJson = rawData ? JSON.parse(rawData) : null;
  const currentSeason = season || dataJson?.current_season || dataJson?.seasons?.[0]?.name || 'Fall 2026';

  // Fall 2026 special case: feature launched right before Week 3, so Week 3 combines milestones from Weeks 1 & 2.
  // In future seasons (Winter 2027+), Week 2 email fires normally with Week 1 recap, and Week 3 fires normally with Week 2 recap.
  const isFall2026 = /Fall\s*2026/i.test(currentSeason);
  const milestoneWeeks = (isFall2026 && tWeek === 3) ? [1, 2] : [tWeek - 1];
  const starsWeek = tWeek - 1;

  const recapsByWeek = new Map();
  const allNeededWeeks = Array.from(new Set([starsWeek, ...milestoneWeeks])).sort((a, b) => a - b);

  for (const w of allNeededWeeks) {
    let weekRecap = null;

    // Check KV for cached recap (season-scoped first, then generic fallback)
    try {
      const kvRecap = await env.SHEETS_KV.get(`recap:${currentSeason}:week_${w}`) ||
                      await env.SHEETS_KV.get(`recap:week_${w}`);
      if (kvRecap) weekRecap = JSON.parse(kvRecap);
    } catch (e) {}

    // Fallback for Week 1 strictly for Fall 2026 baseline
    if (!weekRecap && w === 1 && isFall2026 && dataJson) {
      weekRecap = getWeek1BaselineRecap(dataJson);
    }

    // Fallback from dataJson fixtures if weekRecap is not in KV
    if (!weekRecap && dataJson) {
      const s = (dataJson.seasons || []).find(x => x.name === currentSeason) || dataJson.seasons?.[0];
      const wFixtures = (s?.fixtures || []).filter(f => f.week === w && (f.boxscore || f.home_score != null || f.hg != null));
      if (wFixtures.length > 0) {
        const games = wFixtures.map(f => ({
          home_team: f.home || f.home_team,
          away_team: f.away || f.away_team,
          home_score: f.hg !== undefined ? f.hg : f.home_score,
          away_score: f.ag !== undefined ? f.ag : f.away_score,
          home_goalie: f.boxscore?.home_goalie || f.home_goalie,
          away_goalie: f.boxscore?.away_goalie || f.away_goalie,
          home_players: f.boxscore?.home_players || f.home_players,
          away_players: f.boxscore?.away_players || f.away_players
        }));
        weekRecap = computeWeeklyRecap(dataJson, w, games);
      }
    }

    if (weekRecap) recapsByWeek.set(w, weekRecap);
  }

  if (recapsByWeek.size === 0) return null;

  // 1. Stars strictly from starsWeek (immediately preceding week)
  const starsRecap = recapsByWeek.get(starsWeek);
  const playerOfTheWeek = starsRecap?.playerOfTheWeek || null;
  const goalieOfTheWeek = starsRecap?.goalieOfTheWeek || null;
  let subOfTheWeek = starsRecap?.subOfTheWeek || null;

  // Ensure subOfTheWeek is awarded to next best sub if top sub is POTW (e.g. Week 2)
  const isDuplicateSub = subOfTheWeek && playerOfTheWeek && (
    (subOfTheWeek.id && playerOfTheWeek.id)
      ? subOfTheWeek.id === playerOfTheWeek.id
      : cleanPlayerName(subOfTheWeek.name) === cleanPlayerName(playerOfTheWeek.name)
  );
  if (!subOfTheWeek || isDuplicateSub) {
    if (dataJson) {
      const s = (dataJson.seasons || []).find(x => x.name === currentSeason) || dataJson.seasons?.[0];
      const wFixtures = (s?.fixtures || []).filter(f => f.week === starsWeek && (f.boxscore || f.home_score != null || f.hg != null));
      if (wFixtures.length > 0) {
        const games = wFixtures.map(f => ({
          home_team: f.home || f.home_team,
          away_team: f.away || f.away_team,
          home_score: f.hg !== undefined ? f.hg : f.home_score,
          away_score: f.ag !== undefined ? f.ag : f.away_score,
          home_goalie: f.boxscore?.home_goalie || f.home_goalie,
          away_goalie: f.boxscore?.away_goalie || f.away_goalie,
          home_players: f.boxscore?.home_players || f.home_players,
          away_players: f.boxscore?.away_players || f.away_players
        }));
        const freshRecap = computeWeeklyRecap(dataJson, starsWeek, games);
        if (freshRecap?.subOfTheWeek) {
          subOfTheWeek = freshRecap.subOfTheWeek;
        }
      }
    }
  }

  // 2. Milestones and firsts combined from milestoneWeeks
  const allAchievements = [];
  const allFirstGoals = [];
  const allFirstAssists = [];

  for (const w of milestoneWeeks) {
    const r = recapsByWeek.get(w);
    if (r) {
      if (r.achievements) allAchievements.push(...r.achievements);
      if (r.firsts?.goals) allFirstGoals.push(...r.firsts.goals);
      if (r.firsts?.assists) allFirstAssists.push(...r.firsts.assists);
    }
  }

  const closingIn = dataJson ? computeClosingIn(dataJson) : [];

  return {
    targetWeek: tWeek,
    starsWeek,
    milestoneWeeks,
    sourceWeeks: milestoneWeeks,
    achievements: allAchievements,
    playerOfTheWeek,
    goalieOfTheWeek,
    subOfTheWeek,
    firsts: {
      goals: Array.from(new Set(allFirstGoals)),
      assists: Array.from(new Set(allFirstAssists))
    },
    closingIn
  };
}

export const TEAM_FR = { Red: 'Rouge', Blue: 'Bleu', White: 'Blanc', Black: 'Noir' };
export const tFR = (t, cfg) => cfg ? getTeamNameFr(cfg, t) : (TEAM_FR[t] || t);

/**
 * Formats milestone stat concisely without duplicate FR/EN sentences
 * e.g. "500 pts", "300 passes / assists"
 */
export function formatMilestoneStat(a) {
  if (a.statType === 'rank') {
    const rank = a.rank;
    const rankLabel = rank === 1 ? '1er rang historique' : `${rank}e rang historique`;
    const passedStr = a.passedNames && a.passedNames.length > 0 ? ` (dépasse ${a.passedNames.join(', ')})` : '';
    if (a.subType === 'goalie_wins') {
      const val = a.currentVal;
      const unit = val === 1 ? 'victoire' : 'victoires';
      return `${rankLabel} · ${val} ${unit}${passedStr}`;
    } else {
      const val = a.currentVal;
      const unit = val === 1 ? 'pt' : 'pts';
      return `${rankLabel} · ${val} ${unit}${passedStr}`;
    }
  }

  const mark = a.mark;
  const st = a.statType || a.stat;
  if (st === 'pts') return `${mark} ${mark === 1 ? 'pt' : 'pts'}`;
  if (st === 'g') return `${mark} ${mark === 1 ? 'but' : 'buts'}`;
  if (st === 'a') return `${mark} ${mark === 1 ? 'passe' : 'passes'}`;
  if (st === 'gp') return `${mark} ${mark === 1 ? 'match' : 'matchs'}`;
  if (st === 'gw') return `${mark} ${mark === 1 ? 'victoire' : 'victoires'}`;

  const txt = `${a.fr || ''} ${a.en || ''}`;
  if (/point/i.test(txt)) return `${mark} ${mark === 1 ? 'pt' : 'pts'}`;
  if (/but/i.test(txt) || /goal/i.test(txt)) return `${mark} ${mark === 1 ? 'but' : 'buts'}`;
  if (/passe/i.test(txt) || /assist/i.test(txt)) return `${mark} ${mark === 1 ? 'passe' : 'passes'}`;
  if (/match/i.test(txt) || /game/i.test(txt)) return `${mark} ${mark === 1 ? 'match' : 'matchs'}`;
  if (/victoire/i.test(txt) || /win/i.test(txt)) return `${mark} ${mark === 1 ? 'victoire' : 'victoires'}`;

  return `${mark} ${mark === 1 ? 'pt' : 'pts'}`;
}

/**
 * Formats closing in line concisely with target plus distance
 * e.g. "Chase Brunetti : 75 passes (-1)"
 */
export function formatClosingInLine(c, isHtml = false) {
  let unit = 'pts';
  if (c.type === 'a') {
    unit = c.target === 1 ? 'passe' : 'passes';
  } else if (c.type === 'g') {
    unit = c.target === 1 ? 'but' : 'buts';
  } else if (c.type === 'pts') {
    unit = c.target === 1 ? 'pt' : 'pts';
  } else if (c.type === 'gp') {
    unit = c.target === 1 ? 'match' : 'matchs';
  } else {
    unit = c.target === 1 ? 'pt' : 'pts';
  }

  const namePart = isHtml ? `<b>${c.name}</b>` : c.name;
  return `${namePart} : ${c.target} ${unit} (-${c.need})`;
}

/**
 * Formats weekly highlights as responsive HTML for email
 */
export function renderHighlightsHtml(highlights, leagueCfg = null) {
  if (!highlights) return '';
  const league = leagueCfg || DEFAULT_SEASON_CONFIG.league;
  const siteHost = String(league.siteUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);

  const starsWeek = highlights.starsWeek || (highlights.sourceWeeks ? highlights.sourceWeeks[highlights.sourceWeeks.length - 1] : 1);
  const milestoneWeeks = highlights.milestoneWeeks || highlights.sourceWeeks || [starsWeek];

  const hasMultiWeek = milestoneWeeks && milestoneWeeks.length > 1;
  const heading = hasMultiWeek
    ? `Faits saillants / Highlights · Sem. / Wk ${milestoneWeeks[0]}-${milestoneWeeks[milestoneWeeks.length - 1]}`
    : `Faits saillants / Highlights · Sem. / Wk ${starsWeek}`;

  const groupHeadingStyle = 'font-size:13px; font-weight:700; color:#16181d; margin-top:14px; margin-bottom:4px;';
  const itemLabelStyle = 'font-size:12px; font-weight:normal; color:#64748b; margin-top:6px; margin-bottom:2px;';

  const groups = [];

  // a) Étoiles / Stars · Sem. / Wk {n}
  const starRows = [];
  if (highlights.playerOfTheWeek) {
    const p = highlights.playerOfTheWeek;
    const stat = `${p.pts} ${p.pts === 1 ? 'pt' : 'pts'}`;
    starRows.push(`
      <tr>
        <td style="font-size:12px; font-weight:normal; color:#64748b; white-space:nowrap; padding:2px 14px 2px 0; vertical-align:baseline;">Joueur / Player</td>
        <td style="font-size:13px; color:#1e293b; padding:2px 0; vertical-align:baseline;"><b>${esc(p.name)}</b>, ${stat}</td>
      </tr>
    `.trim());
  }
  if (highlights.goalieOfTheWeek) {
    const g = highlights.goalieOfTheWeek;
    const stat = `${Number(g.gaa).toFixed(2)} MOY`;
    starRows.push(`
      <tr>
        <td style="font-size:12px; font-weight:normal; color:#64748b; white-space:nowrap; padding:2px 14px 2px 0; vertical-align:baseline;">Gardien / Goalie</td>
        <td style="font-size:13px; color:#1e293b; padding:2px 0; vertical-align:baseline;"><b>${esc(g.name)}</b>, ${stat}</td>
      </tr>
    `.trim());
  }
  let sub = highlights.subOfTheWeek;
  if (sub && highlights.playerOfTheWeek) {
    const sameName = (sub.id && highlights.playerOfTheWeek.id)
      ? sub.id === highlights.playerOfTheWeek.id
      : cleanPlayerName(sub.name) === cleanPlayerName(highlights.playerOfTheWeek.name);
    if (sameName) sub = null;
  }
  if (sub) {
    const stat = `${sub.pts} ${sub.pts === 1 ? 'pt' : 'pts'}`;
    starRows.push(`
      <tr>
        <td style="font-size:12px; font-weight:normal; color:#64748b; white-space:nowrap; padding:2px 14px 2px 0; vertical-align:baseline;">Substitut / Sub</td>
        <td style="font-size:13px; color:#1e293b; padding:2px 0; vertical-align:baseline;"><b>${esc(sub.name)}</b>, ${stat}</td>
      </tr>
    `.trim());
  }
  if (starRows.length > 0) {
    groups.push(`
      <div style="${groupHeadingStyle}">Étoiles / Stars · Sem. / Wk ${starsWeek}</div>
      <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse; margin-top:2px;">
        ${starRows.join('\n')}
      </table>
    `);
  }

  // b) Plateaux / Milestones
  if (highlights.achievements && highlights.achievements.length > 0) {
    const sorted = [...highlights.achievements].sort((a, b) => (b.mark || 0) - (a.mark || 0));
    const milestoneLines = sorted.map(a => `<div><b>${esc(a.name)}</b> : ${esc(formatMilestoneStat(a))}</div>`);
    groups.push(`
      <div style="${groupHeadingStyle}">Plateaux / Milestones</div>
      <div>${milestoneLines.join('\n')}</div>
    `);
  }

  // c) Premières / Firsts
  const firstBlocks = [];
  if (highlights.firsts?.goals?.length > 0) {
    const names = highlights.firsts.goals.map(n => `<b>${esc(n)}</b>`).join(', ');
    firstBlocks.push(`
      <div>
        <div style="${itemLabelStyle}">But / Goal</div>
        <div>${names}</div>
      </div>
    `.trim());
  }
  if (highlights.firsts?.assists?.length > 0) {
    const names = highlights.firsts.assists.map(n => `<b>${esc(n)}</b>`).join(', ');
    firstBlocks.push(`
      <div>
        <div style="${itemLabelStyle}">Passe / Assist</div>
        <div>${names}</div>
      </div>
    `.trim());
  }
  if (highlights.firsts?.wins?.length > 0) {
    const names = highlights.firsts.wins.map(n => `<b>${esc(n)}</b>`).join(', ');
    firstBlocks.push(`
      <div>
        <div style="${itemLabelStyle}">Victoire / Win</div>
        <div>${names}</div>
      </div>
    `.trim());
  }
  if (highlights.firsts?.shutouts?.length > 0) {
    const names = highlights.firsts.shutouts.map(n => `<b>${esc(n)}</b>`).join(', ');
    firstBlocks.push(`
      <div>
        <div style="${itemLabelStyle}">Blanchissage / Shutout</div>
        <div>${names}</div>
      </div>
    `.trim());
  }
  if (firstBlocks.length > 0) {
    groups.push(`
      <div style="${groupHeadingStyle}">Premières / Firsts</div>
      <div>${firstBlocks.join('\n')}</div>
    `);
  }

  // d) À surveiller / Closing in
  if (highlights.closingIn && highlights.closingIn.length > 0) {
    const closingLines = highlights.closingIn.map(c => `<div>${formatClosingInLine(c, true)}</div>`);
    groups.push(`
      <div style="${groupHeadingStyle}">À surveiller / Closing in</div>
      <div>${closingLines.join('\n')}</div>
    `);
  }

  if (groups.length === 0) return '';

  return `
    <div style="margin:20px 0 16px; background-color:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:14px 16px; font-size:13px; color:#1e293b; line-height:1.5;">
      <div style="font-size:13px; font-weight:700; color:#17457f;">
        ${esc(heading)}
      </div>
      ${groups.join('')}
      <div style="margin-top:14px; font-size:12px;">
        <a href="${league.siteUrl}" style="color:#17457f; text-decoration:underline;">Tout voir sur ${siteHost} / See all on ${siteHost}</a>
      </div>
    </div>
  `;
}

/**
 * Formats weekly highlights as plain text for email fallback
 */
export function renderHighlightsText(highlights, leagueCfg = null) {
  if (!highlights) return '';
  const league = leagueCfg || DEFAULT_SEASON_CONFIG.league;
  const siteHost = String(league.siteUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

  const starsWeek = highlights.starsWeek || (highlights.sourceWeeks ? highlights.sourceWeeks[highlights.sourceWeeks.length - 1] : 1);
  const milestoneWeeks = highlights.milestoneWeeks || highlights.sourceWeeks || [starsWeek];

  const hasMultiWeek = milestoneWeeks && milestoneWeeks.length > 1;
  const heading = hasMultiWeek
    ? `Faits saillants / Highlights · Sem. / Wk ${milestoneWeeks[0]}-${milestoneWeeks[milestoneWeeks.length - 1]}`
    : `Faits saillants / Highlights · Sem. / Wk ${starsWeek}`;

  const sections = [];

  // a) Stars
  const starLinesText = [];
  if (highlights.playerOfTheWeek) {
    const p = highlights.playerOfTheWeek;
    const stat = `${p.pts} ${p.pts === 1 ? 'pt' : 'pts'}`;
    starLinesText.push(`Joueur / Player : ${p.name}, ${stat}`);
  }
  if (highlights.goalieOfTheWeek) {
    const g = highlights.goalieOfTheWeek;
    const stat = `${Number(g.gaa).toFixed(2)} MOY`;
    starLinesText.push(`Gardien / Goalie : ${g.name}, ${stat}`);
  }
  let sub = highlights.subOfTheWeek;
  if (sub && highlights.playerOfTheWeek) {
    const sameName = (sub.id && highlights.playerOfTheWeek.id)
      ? sub.id === highlights.playerOfTheWeek.id
      : cleanPlayerName(sub.name) === cleanPlayerName(highlights.playerOfTheWeek.name);
    if (sameName) sub = null;
  }
  if (sub) {
    const stat = `${sub.pts} ${sub.pts === 1 ? 'pt' : 'pts'}`;
    starLinesText.push(`Substitut / Sub : ${sub.name}, ${stat}`);
  }
  if (starLinesText.length > 0) {
    sections.push(`Étoiles / Stars · Sem. / Wk ${starsWeek}\n` + starLinesText.join('\n'));
  }

  // b) Milestones
  if (highlights.achievements && highlights.achievements.length > 0) {
    const sorted = [...highlights.achievements].sort((a, b) => (b.mark || 0) - (a.mark || 0));
    sections.push('Plateaux / Milestones\n' + sorted.map(a => `${a.name} : ${formatMilestoneStat(a)}`).join('\n'));
  }

  // c) Career firsts
  const firstBlocksText = [];
  if (highlights.firsts?.goals?.length > 0) {
    firstBlocksText.push(`But / Goal\n${highlights.firsts.goals.join(', ')}`);
  }
  if (highlights.firsts?.assists?.length > 0) {
    firstBlocksText.push(`Passe / Assist\n${highlights.firsts.assists.join(', ')}`);
  }
  if (highlights.firsts?.wins?.length > 0) {
    firstBlocksText.push(`Victoire / Win\n${highlights.firsts.wins.join(', ')}`);
  }
  if (highlights.firsts?.shutouts?.length > 0) {
    firstBlocksText.push(`Blanchissage / Shutout\n${highlights.firsts.shutouts.join(', ')}`);
  }
  if (firstBlocksText.length > 0) {
    sections.push('Premières / Firsts\n' + firstBlocksText.join('\n'));
  }

  // d) Closing in
  if (highlights.closingIn && highlights.closingIn.length > 0) {
    sections.push('À surveiller / Closing in\n' + highlights.closingIn.map(c => formatClosingInLine(c, false)).join('\n'));
  }

  if (sections.length === 0) return '';

  return [
    heading,
    '',
    sections.join('\n\n'),
    '',
    `Tout voir sur ${siteHost} / See all on ${siteHost} : ${league.siteUrl}`
  ].join('\n');
}

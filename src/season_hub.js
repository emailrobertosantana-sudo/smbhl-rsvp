/**
 * season_hub.js — SMBHL Season Hub & Balanced Roster Engine
 * 
 * Capabilities:
 * 1. Player Valuation & Stratification (EVM, Tiers 1-4, Positional Quotas)
 * 2. 2-Opt Monte Carlo Permutation Draft Engine (Pins, Tandems, Parity Optimization)
 * 3. Counter-Balance Swap Advisor (What-If Sandbox Helper)
 * 4. 14-Week Letendre Doubleheader Schedule Matrix Generator
 * 5. Pre-Season Roll-Call & Candidate Intake Management
 * 6. 1-Click Season Publishing Engine (D1 SQLite ⇄ KV data.json)
 */

import {
  DEFAULT_SEASON_CONFIG,
  normalizeSeasonConfig,
  getSeasonConfig,
  getTeamNames,
  getTeamNameFr,
  getTeamColour
} from './season_config.js';

export const TEAM_COLORS = getTeamNames(DEFAULT_SEASON_CONFIG);
export const TEAM_LABELS = {
  Red: { fr: 'Rouge', en: 'Red', color: '#b3122c', text: '#fff' },
  Blue: { fr: 'Bleu', en: 'Blue', color: '#17457f', text: '#fff' },
  White: { fr: 'Blanc', en: 'White', color: '#f8fafc', text: '#16181d', border: '#cbd5e1' },
  Black: { fr: 'Noir', en: 'Black', color: '#16181d', text: '#fff' }
};

/**
 * Computes individual player metrics (EVM, PPG, Position, Reliability) from data.json and contacts
 */
export function computePlayerMetrics(player, career, recentSeasons = []) {
  const isGoalie = !!(player.is_goalie || (player.gcareer && player.gcareer.gp > 0));
  const pos = player.position || player.pos || (isGoalie ? 'G' : 'F');
  
  if (isGoalie) {
    const gcareer = player.gcareer || {};
    const gp = gcareer.gp || 0;
    const ga = gcareer.ga || 0;
    const gaa = gp > 0 ? parseFloat((ga / gp).toFixed(2)) : 5.0;
    return {
      playerId: player.id || player.player_id,
      name: player.name,
      isGoalie: true,
      pos: 'G',
      gp,
      gaa,
      evm: parseFloat((10.0 - Math.min(gaa, 8.0)).toFixed(2)),
      tier: 1 // Goalies handled separately
    };
  }

  // Skater calculation
  const carGp = (career && career.gp) || 0;
  const carPts = (career && career.pts) || 0;
  const carPpg = carGp > 0 ? carPts / carGp : 1.0;

  // Recent 2 seasons stats
  let recGp = 0;
  let recPts = 0;
  let recSched = 0;
  for (const s of recentSeasons) {
    if (s && typeof s === 'object') {
      recGp += (s.gp || 0);
      recPts += (s.pts || 0);
      recSched += (s.sched || 28); // Standard regular season is 28 games (14 weeks x 2)
    }
  }

  const recPpg = recGp > 0 ? recPts / recGp : carPpg;
  
  // Weighted PPG: 70% recent, 30% career (or 100% career if no recent)
  const weightedPpg = recGp >= 5 ? (0.70 * recPpg + 0.30 * carPpg) : carPpg;

  // Reliability Factor based on attendance
  const attRatio = recSched > 0 ? Math.min(1.0, recGp / (recSched * 0.75)) : 1.0;
  const reliability = 0.85 + (0.15 * attRatio);

  // Position multiplier: Pure defensemen are rarer and hold tactical value
  const posMultiplier = pos === 'D' ? 1.15 : 1.00;

  const evm = parseFloat((weightedPpg * reliability * posMultiplier).toFixed(2));

  return {
    playerId: player.id || player.player_id,
    name: player.name,
    isGoalie: false,
    pos: pos === 'D' ? 'D' : 'F',
    carGp,
    carPts,
    carPpg: parseFloat(carPpg.toFixed(2)),
    recGp,
    recPts,
    recPpg: parseFloat(recPpg.toFixed(2)),
    weightedPpg: parseFloat(weightedPpg.toFixed(2)),
    reliability: parseFloat(reliability.toFixed(2)),
    evm: Math.max(0.2, evm),
    tier: 3 // Will be populated by stratifySkaters
  };
}

/**
 * Generates all round-robin pairings for any N teams using the polygon/Berger method
 */
export function generateRoundRobinRounds(teams) {
  const list = [...teams];
  if (list.length % 2 !== 0) {
    list.push('BYE');
  }
  const n = list.length;
  const rounds = [];
  for (let round = 0; round < n - 1; round++) {
    const pairings = [];
    for (let i = 0; i < n / 2; i++) {
      const home = list[i];
      const away = list[n - 1 - i];
      if (home !== 'BYE' && away !== 'BYE') {
        if (round % 2 === 0) pairings.push({ home, away });
        else pairings.push({ home: away, away: home });
      }
    }
    rounds.push(pairings);
    list.splice(1, 0, list.pop());
  }
  return rounds;
}

/**
 * Stratifies skaters into 4 Tiers:
 * Tier 1: Top N players (1 per team, where N = numTeams)
 * Tier 2: Next 2*N players (2 per team)
 * Tier 3: Next 2*N players (2 per team)
 * Tier 4: Remaining players (2 per team)
 */
export function stratifySkaters(skatersList, numTeams = 4) {
  const sorted = [...skatersList].sort((a, b) => b.evm - a.evm);
  const total = sorted.length;
  
  const t1Count = numTeams;
  const remaining = Math.max(0, total - t1Count);
  const t2Count = Math.min(numTeams * 2, Math.floor(remaining / 3));
  const t3Count = Math.min(numTeams * 2, Math.floor(remaining / 3));

  return sorted.map((s, idx) => {
    let tier = 4;
    if (idx < t1Count) tier = 1;
    else if (idx < t1Count + t2Count) tier = 2;
    else if (idx < t1Count + t2Count + t3Count) tier = 3;
    return { ...s, tier };
  });
}

/**
 * Evaluates the Cost / Penalty function of a roster configuration across any active teams
 */
export function evaluateRosterCost(rosters, goaliesByTeam = {}, activeTeams = null) {
  const teamMetrics = {};
  const evmTotals = [];
  const dCounts = [];
  const teamsToEval = (activeTeams && activeTeams.length > 0) ? activeTeams : (rosters ? Object.keys(rosters) : TEAM_COLORS);

  let penalty = 0;

  for (const team of teamsToEval) {
    const skaters = rosters[team] || [];
    const goalie = goaliesByTeam[team] || null;
    
    let sumEvm = 0;
    let sumPpg = 0;
    let dCount = 0;
    let fCount = 0;
    const tierCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };

    for (const p of skaters) {
      sumEvm += (p.evm || 1.0);
      sumPpg += (p.weightedPpg || p.carPpg || 1.0);
      if (p.pos === 'D') dCount++;
      else fCount++;
      if (tierCounts[p.tier] != null) tierCounts[p.tier]++;
    }

    // Hard/Soft penalty for defensemen counts: ideal is 2 or 3 defensemen per team
    if (dCount < 2) penalty += (2 - dCount) * 15.0;
    if (dCount > 4) penalty += (dCount - 4) * 15.0;

    // Penalty for Tier 1 imbalance: strictly 1 T1 player per team
    if (tierCounts[1] !== 1) {
      penalty += Math.abs(tierCounts[1] - 1) * 30.0;
    }
    // Tier 2 penalty: ideally 2
    if (tierCounts[2] !== 2) {
      penalty += Math.abs(tierCounts[2] - 2) * 8.0;
    }

    // Goalie coupling: if a team has a higher GAA goalie, give slight credit if they have more defensive depth
    if (goalie && goalie.gaa > 5.5 && dCount >= 3) {
      penalty -= 1.0;
    }

    teamMetrics[team] = {
      skaterCount: skaters.length,
      sumEvm: parseFloat(sumEvm.toFixed(2)),
      sumPpg: parseFloat(sumPpg.toFixed(2)),
      dCount,
      fCount,
      tierCounts,
      goalie: goalie ? { name: goalie.name, gaa: goalie.gaa } : null
    };

    evmTotals.push(sumEvm);
    dCounts.push(dCount);
  }

  // Variance of EVM across the active teams
  const meanEvm = evmTotals.reduce((a, b) => a + b, 0) / (evmTotals.length || 1);
  const varianceEvm = evmTotals.reduce((acc, v) => acc + Math.pow(v - meanEvm, 2), 0) / evmTotals.length;
  const spread = Math.max(...evmTotals) - Math.min(...evmTotals);

  const totalCost = (varianceEvm * 10.0) + (spread * 5.0) + penalty;

  return {
    totalCost,
    spread: parseFloat(spread.toFixed(2)),
    varianceEvm: parseFloat(varianceEvm.toFixed(2)),
    teamMetrics,
    meanEvm: parseFloat(meanEvm.toFixed(2))
  };
}

/**
 * 2-Opt Monte Carlo Permutation Search for optimal team balance (generalized for any teams)
 */
export function autoDraftTeams({
  skaters,
  goalies = [],
  pinned = {},
  tandems = [],
  teams = TEAM_COLORS,
  skatersPerTeam,
  maxIterations = 5000
}) {
  const activeTeams = teams && teams.length > 0 ? teams : TEAM_COLORS;
  const numTeams = activeTeams.length;
  const maxSkatersPerTeam = skatersPerTeam || Math.ceil(skaters.length / numTeams) || 7;
  const stratified = stratifySkaters(skaters, numTeams);
  const skaterMap = new Map(stratified.map(s => [s.playerId, s]));

  // 1. Assign Goalies
  const goaliesByTeam = {};
  const unassignedGoalies = [...goalies];
  
  // Assign pinned goalies first
  for (const team of activeTeams) {
    for (const g of unassignedGoalies) {
      if (pinned[g.playerId] === team) {
        goaliesByTeam[team] = g;
        break;
      }
    }
  }
  for (const team of activeTeams) {
    if (!goaliesByTeam[team] && unassignedGoalies.length > 0) {
      const g = unassignedGoalies.find(x => !Object.values(goaliesByTeam).includes(x));
      if (g) goaliesByTeam[team] = g;
    }
  }

  // 2. Initial Roster Setup
  const rosters = Object.fromEntries(activeTeams.map(t => [t, []]));
  const assigned = new Set();

  // A. Place pinned skaters
  for (const [pId, team] of Object.entries(pinned)) {
    const s = skaterMap.get(pId);
    if (s && rosters[team] && !s.isGoalie) {
      rosters[team].push(s);
      assigned.add(s.playerId);
    }
  }

  // B. Place tandems together if not already assigned
  for (const pair of tandems) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const [p1Id, p2Id] = pair;
    const s1 = skaterMap.get(p1Id);
    const s2 = skaterMap.get(p2Id);
    if (!s1 || !s2 || assigned.has(p1Id) || assigned.has(p2Id)) continue;

    // Find team with lowest skater count that can take both
    let bestTeam = null;
    let minCount = 99;
    for (const t of activeTeams) {
      if (rosters[t].length < minCount && rosters[t].length <= (maxSkatersPerTeam - 2)) {
        minCount = rosters[t].length;
        bestTeam = t;
      }
    }
    if (bestTeam) {
      rosters[bestTeam].push(s1, s2);
      assigned.add(p1Id);
      assigned.add(p2Id);
    }
  }

  // C. Distribute remaining skaters by Tier using Snake distribution
  for (let tier = 1; tier <= 4; tier++) {
    const tierSkaters = stratified.filter(s => s.tier === tier && !assigned.has(s.playerId));
    tierSkaters.sort((a, b) => b.evm - a.evm);

    for (const s of tierSkaters) {
      let chosenTeam = null;
      let minTierCount = 99;
      let minTotal = 99;

      for (const t of activeTeams) {
        const tCount = rosters[t].filter(x => x.tier === tier).length;
        const total = rosters[t].length;
        if (total >= maxSkatersPerTeam) continue;
        if (tCount < minTierCount || (tCount === minTierCount && total < minTotal)) {
          minTierCount = tCount;
          minTotal = total;
          chosenTeam = t;
        }
      }

      if (!chosenTeam) {
        chosenTeam = activeTeams.find(t => rosters[t].length < maxSkatersPerTeam) || activeTeams[0];
      }

      rosters[chosenTeam].push(s);
      assigned.add(s.playerId);
    }
  }

  // Ensure all skaters are in rosters
  for (const s of stratified) {
    if (!assigned.has(s.playerId)) {
      const t = activeTeams.find(c => rosters[c].length < maxSkatersPerTeam) || activeTeams[0];
      rosters[t].push(s);
      assigned.add(s.playerId);
    }
  }

  // 3. Monte Carlo / 2-Opt Permutation Optimization Loop
  let currentCostObj = evaluateRosterCost(rosters, goaliesByTeam, activeTeams);
  let bestCost = currentCostObj.totalCost;
  let bestCostObj = currentCostObj;
  let bestRosters = Object.fromEntries(activeTeams.map(t => [t, [...(rosters[t] || [])]]));

  const isLocked = (playerId) => {
    if (pinned[playerId]) return true;
    for (const pair of tandems) {
      if (pair.includes(playerId)) return true;
    }
    return false;
  };

  for (let iter = 0; iter < maxIterations; iter++) {
    const tAIdx = Math.floor(Math.random() * numTeams);
    let tBIdx = Math.floor(Math.random() * numTeams);
    while (tBIdx === tAIdx) tBIdx = Math.floor(Math.random() * numTeams);

    const teamA = activeTeams[tAIdx];
    const teamB = activeTeams[tBIdx];

    const unpinnedA = rosters[teamA].filter(p => !isLocked(p.playerId));
    const unpinnedB = rosters[teamB].filter(p => !isLocked(p.playerId));

    if (unpinnedA.length === 0 || unpinnedB.length === 0) continue;

    const pA = unpinnedA[Math.floor(Math.random() * unpinnedA.length)];
    const matchingTierB = unpinnedB.filter(p => p.tier === pA.tier);
    const pB = (matchingTierB.length > 0 && Math.random() < 0.75)
      ? matchingTierB[Math.floor(Math.random() * matchingTierB.length)]
      : unpinnedB[Math.floor(Math.random() * unpinnedB.length)];

    if (!pA || !pB || pA.playerId === pB.playerId) continue;

    const idxA = rosters[teamA].indexOf(pA);
    const idxB = rosters[teamB].indexOf(pB);

    rosters[teamA][idxA] = pB;
    rosters[teamB][idxB] = pA;

    const evalRes = evaluateRosterCost(rosters, goaliesByTeam, activeTeams);

    if (evalRes.totalCost < bestCost) {
      bestCost = evalRes.totalCost;
      bestCostObj = evalRes;
      bestRosters = Object.fromEntries(activeTeams.map(t => [t, [...rosters[t]]]));
    } else {
      rosters[teamA][idxA] = pA;
      rosters[teamB][idxB] = pB;
    }
  }

  const finalEval = evaluateRosterCost(bestRosters, goaliesByTeam, activeTeams);

  return {
    rosters: bestRosters,
    goalies: goaliesByTeam,
    metrics: finalEval.teamMetrics,
    spread: finalEval.spread,
    variance: finalEval.varianceEvm,
    meanEvm: finalEval.meanEvm,
    parityScore: Math.max(80, Math.round(100 - (finalEval.spread * 12)))
  };
}

/**
 * Suggests an optimal counter-swap between two teams to restore parity after a manual swap
 */
export function suggestCounterSwap({ currentRosters, teamA, teamB, pinned = {}, goalies = {} }) {
  if (!currentRosters[teamA] || !currentRosters[teamB]) return null;

  const baseEval = evaluateRosterCost(currentRosters, goalies);
  let bestSwap = null;
  let bestCost = baseEval.totalCost;

  const skatersA = currentRosters[teamA].filter(p => !pinned[p.playerId]);
  const skatersB = currentRosters[teamB].filter(p => !pinned[p.playerId]);

  for (const pA of skatersA) {
    for (const pB of skatersB) {
      // Simulate swap
      const testRosters = {
        ...currentRosters,
        [teamA]: currentRosters[teamA].map(p => p.playerId === pA.playerId ? pB : p),
        [teamB]: currentRosters[teamB].map(p => p.playerId === pB.playerId ? pA : p)
      };

      const testEval = evaluateRosterCost(testRosters, goalies);
      if (testEval.totalCost < bestCost) {
        bestCost = testEval.totalCost;
        bestSwap = {
          fromA: { id: pA.playerId, name: pA.name, pos: pA.pos, tier: pA.tier, evm: pA.evm },
          fromB: { id: pB.playerId, name: pB.name, pos: pB.pos, tier: pB.tier, evm: pB.evm },
          oldSpread: baseEval.spread,
          newSpread: testEval.spread,
          spreadImprovement: parseFloat((baseEval.spread - testEval.spread).toFixed(2))
        };
      }
    }
  }

  return bestSwap;
}

/**
 * Generates a balanced schedule matrix with support for:
 * - Arbitrary slot availability & multi-gym configurations (1 gym, 2 gyms, etc.)
 * - Arbitrary day assignments (Sundays, Saturdays, doubleheaders)
 * - Arbitrary team lists (4, 5, 6, 8 teams)
 * - Complete Playoff Tournament generation (Top 4 Single-Day / Final 4, 2-Week, or None)
 */
export function generateScheduleMatrix({
  seasonName,
  startDate,
  weeksCount = 14,
  byeDates = [],
  teams = TEAM_COLORS,
  customSlots = null,
  playoffFormat = 'top4_single_day'
}) {
  const fixtures = [];
  const events = [];
  const activeTeams = teams && teams.length > 0 ? teams : TEAM_COLORS;

  // Build the list of date items
  let dateEntries = [];

  if (customSlots && Array.isArray(customSlots) && customSlots.length > 0) {
    dateEntries = customSlots.filter(d => d && d.date && !byeDates.includes(d.date));
  } else {
    // Generate default Sundays
    let currentDate = new Date(startDate);
    while (currentDate.getUTCDay() !== 0) {
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    let w = 1;
    while (w <= weeksCount) {
      const dateStr = currentDate.toISOString().slice(0, 10);
      if (!byeDates.includes(dateStr)) {
        dateEntries.push({
          date: dateStr,
          venue: 'Letendre',
          slots: [
            { time: '10:30 AM', gym: 'Gym #1' },
            { time: '10:30 AM', gym: 'Gym #2' },
            { time: '11:30 AM', gym: 'Gym #1' },
            { time: '11:30 AM', gym: 'Gym #2' }
          ]
        });
        w++;
      }
      currentDate.setUTCDate(currentDate.getUTCDate() + 7);
    }
  }

  const totalDates = dateEntries.length;
  let regularDateCount = totalDates;
  if (playoffFormat === 'top4_single_day' && totalDates >= 2) {
    regularDateCount = totalDates - 1;
  } else if (playoffFormat === 'top4_two_weeks' && totalDates >= 3) {
    regularDateCount = totalDates - 2;
  }

  // Generate round-robin rounds for regular season
  const rrRounds = generateRoundRobinRounds(activeTeams);
  let roundIdx = 0;
  let matchInRoundIdx = 0;

  // Classic Letendre 4-team rotation patterns
  const rotations4Teams = [
    {
      stays: ['Red', 'White'],
      games1030: [
        { gym: 'Gym #1', home: 'Red', away: 'Blue' },
        { gym: 'Gym #2', home: 'White', away: 'Black' }
      ],
      games1130: [
        { gym: 'Gym #1', home: 'Red', away: 'Black' },
        { gym: 'Gym #2', home: 'White', away: 'Blue' }
      ]
    },
    {
      stays: ['Blue', 'Black'],
      games1030: [
        { gym: 'Gym #1', home: 'Blue', away: 'Black' },
        { gym: 'Gym #2', home: 'Red', away: 'White' }
      ],
      games1130: [
        { gym: 'Gym #1', home: 'Blue', away: 'Red' },
        { gym: 'Gym #2', home: 'Black', away: 'White' }
      ]
    },
    {
      stays: ['Red', 'Blue'],
      games1030: [
        { gym: 'Gym #1', home: 'Red', away: 'Black' },
        { gym: 'Gym #2', home: 'Blue', away: 'White' }
      ],
      games1130: [
        { gym: 'Gym #1', home: 'Red', away: 'White' },
        { gym: 'Gym #2', home: 'Blue', away: 'Black' }
      ]
    }
  ];

  for (let dIdx = 0; dIdx < totalDates; dIdx++) {
    const entry = dateEntries[dIdx];
    const weekNum = dIdx + 1;
    const isPlayoffDate = dIdx >= regularDateCount;
    const dateObj = new Date(entry.date + 'T12:00:00Z');
    const humanDate = dateObj.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC'
    });

    const venue = entry.venue || 'Letendre';
    const slots = entry.slots || [
      { time: '10:30 AM', gym: 'Gym #1' },
      { time: '10:30 AM', gym: 'Gym #2' },
      { time: '11:30 AM', gym: 'Gym #1' },
      { time: '11:30 AM', gym: 'Gym #2' }
    ];

    // Determine times for event
    const distinctTimes = [...new Set(slots.map(s => s.time))].sort();
    const startTime = distinctTimes[0] ? distinctTimes[0].replace(/[^0-9:]/g, '') : '10:30';
    const endTime = distinctTimes[distinctTimes.length - 1] ? '12:30' : '12:30';

    events.push({
      id: entry.date,
      season: seasonName,
      week: weekNum,
      date: humanDate,
      venue,
      state: 'open',
      start_time: startTime,
      end_time: endTime,
      is_playoff: isPlayoffDate
    });

    if (isPlayoffDate) {
      // PLAYOFF FIXTURES
      if (playoffFormat === 'top4_single_day' || playoffFormat === 'top4_two_weeks') {
        const earlyTime = distinctTimes[0] || '10:30 AM';
        const lateTime = distinctTimes[1] || distinctTimes[0] || '11:30 AM';
        const gym1 = slots[0]?.gym || 'Gym #1';
        const gym2 = slots[1]?.gym || 'Gym #2';

        if (playoffFormat === 'top4_single_day' || dIdx === totalDates - 1) {
          // Championship Sunday: Semis + Final + 3rd place
          fixtures.push(
            {
              week: weekNum,
              date: humanDate,
              venue,
              time: earlyTime,
              gym: gym1,
              home: '1st Seed',
              away: '4th Seed',
              hg: null,
              ag: null,
              is_playoff: true,
              playoff_round: 'semi_1',
              note: 'Demi-finale 1 (1er vs 4e)',
              note_fr: 'Demi-finale 1 (1er vs 4e)'
            },
            {
              week: weekNum,
              date: humanDate,
              venue,
              time: earlyTime,
              gym: gym2,
              home: '2nd Seed',
              away: '3rd Seed',
              hg: null,
              ag: null,
              is_playoff: true,
              playoff_round: 'semi_2',
              note: 'Demi-finale 2 (2e vs 3e)',
              note_fr: 'Demi-finale 2 (2e vs 3e)'
            },
            {
              week: weekNum,
              date: humanDate,
              venue,
              time: lateTime,
              gym: gym1,
              home: 'Winner SF1',
              away: 'Winner SF2',
              hg: null,
              ag: null,
              is_playoff: true,
              playoff_round: 'final',
              note: 'Grande Finale SMBHL 🏆',
              note_fr: 'Grande Finale SMBHL 🏆'
            },
            {
              week: weekNum,
              date: humanDate,
              venue,
              time: lateTime,
              gym: gym2,
              home: 'Loser SF1',
              away: 'Loser SF2',
              hg: null,
              ag: null,
              is_playoff: true,
              playoff_round: 'consolation',
              note: 'Match pour la 3e place',
              note_fr: 'Match pour la 3e place'
            }
          );
        } else {
          // Semi-Finals week in 2-week playoff
          fixtures.push(
            {
              week: weekNum,
              date: humanDate,
              venue,
              time: earlyTime,
              gym: gym1,
              home: '1st Seed',
              away: '4th Seed',
              hg: null,
              ag: null,
              is_playoff: true,
              playoff_round: 'semi_1',
              note: 'Demi-finale 1 (1er vs 4e)',
              note_fr: 'Demi-finale 1 (1er vs 4e)'
            },
            {
              week: weekNum,
              date: humanDate,
              venue,
              time: earlyTime,
              gym: gym2,
              home: '2nd Seed',
              away: '3rd Seed',
              hg: null,
              ag: null,
              is_playoff: true,
              playoff_round: 'semi_2',
              note: 'Demi-finale 2 (2e vs 3e)',
              note_fr: 'Demi-finale 2 (2e vs 3e)'
            }
          );
        }
      }
    } else {
      // REGULAR SEASON FIXTURES
      const isClassic4Letendre = activeTeams.length === 4 && slots.length === 4 &&
        slots.some(s => s.time.includes('10:30')) && slots.some(s => s.time.includes('11:30'));

      if (isClassic4Letendre) {
        const rot = rotations4Teams[(weekNum - 1) % rotations4Teams.length];
        fixtures.push(
          {
            week: weekNum,
            date: humanDate,
            venue,
            time: '10:30 AM',
            gym: rot.games1030[0].gym,
            home: rot.games1030[0].home,
            away: rot.games1030[0].away,
            hg: null,
            ag: null,
            stays: rot.stays
          },
          {
            week: weekNum,
            date: humanDate,
            venue,
            time: '10:30 AM',
            gym: rot.games1030[1].gym,
            home: rot.games1030[1].home,
            away: rot.games1030[1].away,
            hg: null,
            ag: null,
            stays: rot.stays
          },
          {
            week: weekNum,
            date: humanDate,
            venue,
            time: '11:30 AM',
            gym: rot.games1130[0].gym,
            home: rot.games1130[0].home,
            away: rot.games1130[0].away,
            hg: null,
            ag: null,
            stays: rot.stays
          },
          {
            week: weekNum,
            date: humanDate,
            venue,
            time: '11:30 AM',
            gym: rot.games1130[1].gym,
            home: rot.games1130[1].home,
            away: rot.games1130[1].away,
            hg: null,
            ag: null,
            stays: rot.stays
          }
        );
      } else {
        // Generic Round Robin across available slots on this date
        const usedTeamsThisSlot = new Map();

        for (const slot of slots) {
          const slotTime = slot.time;
          if (!usedTeamsThisSlot.has(slotTime)) {
            usedTeamsThisSlot.set(slotTime, new Set());
          }
          const busy = usedTeamsThisSlot.get(slotTime);

          // Find pairing without time conflict
          let pairing = null;
          let attempts = 0;
          while (attempts < 20) {
            const currentRound = rrRounds[roundIdx % rrRounds.length];
            const candidate = currentRound[matchInRoundIdx % currentRound.length];
            matchInRoundIdx++;
            if (matchInRoundIdx >= currentRound.length) {
              matchInRoundIdx = 0;
              roundIdx++;
            }

            if (!busy.has(candidate.home) && !busy.has(candidate.away)) {
              pairing = candidate;
              break;
            }
            attempts++;
          }

          if (!pairing) {
            pairing = { home: activeTeams[0], away: activeTeams[1] };
          }

          busy.add(pairing.home);
          busy.add(pairing.away);

          fixtures.push({
            week: weekNum,
            date: humanDate,
            venue,
            time: slot.time,
            gym: slot.gym || 'Gym #1',
            home: pairing.home,
            away: pairing.away,
            hg: null,
            ag: null
          });
        }
      }
    }
  }

  return { fixtures, events, playoffFormat };
}

/**
 * 1-Click Season Publishing Engine
 * Commits changes atomically to D1 SQLite and KV data.json
 */
export async function publishSeasonToProduction(env, { seasonName, startDate, rosters, fixtures, events, fees = {}, rosterConfig = {} }) {
  if (!seasonName || !rosters || !fixtures || !events) {
    throw new Error('Missing required season publication parameters');
  }

  const db = env.DB;
  if (!db) throw new Error('Database binding DB is missing');

  // 1. Insert/Replace events into D1
  for (const ev of events) {
    await db.prepare(`
      INSERT INTO events (id, season, week, date, venue, state, start_time, end_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        season=excluded.season,
        week=excluded.week,
        date=excluded.date,
        venue=excluded.venue,
        state=excluded.state,
        start_time=excluded.start_time,
        end_time=excluded.end_time
    `).bind(ev.id, ev.season, ev.week, ev.date, ev.venue, ev.state, ev.start_time, ev.end_time).run();
  }

  // 2. Update contacts table: assign roster spots and preferred_team
  const assignedPlayerIds = new Set();

  for (const [team, players] of Object.entries(rosters)) {
    for (const p of players) {
      assignedPlayerIds.add(p.playerId);
      await db.prepare(`
        UPDATE contacts
        SET role = 'roster',
            is_sub = 0,
            preferred_team = ?,
            last_played = ?
        WHERE player_id = ?
      `).bind(team, seasonName, p.playerId).run();
    }
  }

  // 3. Mark unassigned active contacts as subs
  const allContacts = (await db.prepare('SELECT player_id, role FROM contacts').all()).results || [];
  for (const c of allContacts) {
    if (!assignedPlayerIds.has(c.player_id) && c.role === 'roster') {
      await db.prepare(`
        UPDATE contacts
        SET role = 'sub',
            is_sub = 1
        WHERE player_id = ?
      `).bind(c.player_id).run();
    }
  }

  // 4. Seed Week 1 RSVP entries in D1
  const week1Event = events.find(e => e.week === 1);
  if (week1Event) {
    const now = new Date().toISOString();
    for (const [team, players] of Object.entries(rosters)) {
      for (const p of players) {
        await db.prepare(`
          INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at)
          VALUES (?, ?, ?, 'pending', 'roster', 'auto', ?)
          ON CONFLICT(event_id, player_id) DO UPDATE SET
            team=excluded.team,
            role='roster',
            updated_at=excluded.updated_at
        `).bind(week1Event.id, p.playerId, team, now).run();
      }
    }
  }

  // 5. Update data.json in KV
  let dataJson = {};
  if (env.SHEETS_KV) {
    const raw = await env.SHEETS_KV.get('data_json');
    if (raw) {
      try { dataJson = JSON.parse(raw); } catch (e) {}
    }
  }

  if (!dataJson.seasons) dataJson.seasons = {};
  if (!dataJson.players) dataJson.players = {};

  // Find highest season key
  const keys = Object.keys(dataJson.seasons).map(k => parseInt(k, 10)).filter(n => !isNaN(n));
  const newSeasonIndex = keys.length > 0 ? (Math.max(...keys) + 1).toString() : '42';

  const rosterTeams = Object.keys(rosters).length > 0 ? Object.keys(rosters) : TEAM_COLORS;
  
  // Assemble season config
  const teamsInput = (rosterConfig && Array.isArray(rosterConfig.teams) && rosterConfig.teams.length > 0)
    ? rosterConfig.teams
    : rosterTeams;

  const configTeams = teamsInput.map(t => {
    if (typeof t === 'object' && t !== null && t.name) {
      const name = String(t.name).trim();
      return {
        name,
        name_fr: t.name_fr ? String(t.name_fr).trim() : name,
        colour: t.colour || '#64748b',
        aliases: Array.isArray(t.aliases) ? t.aliases.map(a => String(a).trim()).filter(Boolean) : []
      };
    }
    const name = String(t).trim();
    const def = DEFAULT_SEASON_CONFIG.teams.find(x => x.name.toLowerCase() === name.toLowerCase());
    return def
      ? { ...def, aliases: [...def.aliases] }
      : { name, name_fr: name, colour: '#64748b', aliases: [] };
  });

  const seasonConfig = {
    teams: configTeams,
    goaliesPerTeam: Number(rosterConfig.goaliesPerTeam) || DEFAULT_SEASON_CONFIG.goaliesPerTeam,
    skatersPerTeam: Number(rosterConfig.skatersPerTeam) || DEFAULT_SEASON_CONFIG.skatersPerTeam,
    minSkaters: Number(rosterConfig.minSkaters) || DEFAULT_SEASON_CONFIG.minSkaters,
    playoffFormat: rosterConfig.playoffFormat || DEFAULT_SEASON_CONFIG.playoffFormat
  };

  const newSeasonObj = {
    name: seasonName,
    order: (dataJson.seasons['0']?.order || 0) + 1,
    standings: configTeams.map(t => ({
      team: t.name,
      gp: 0,
      w: 0,
      l: 0,
      t: 0,
      pts: 0,
      gf: 0,
      ga: 0
    })),
    config: seasonConfig,
    games: 0,
    goals_per_game: null,
    champion: null,
    first_game: fixtures[0]?.date || null,
    last_game: fixtures[fixtures.length - 1]?.date || null,
    recent: [],
    fixtures: fixtures,
    current: true,
    note: '',
    note_fr: ''
  };

  // Mark previous current season as current: false
  for (const s of Object.values(dataJson.seasons)) {
    if (s && s.current) s.current = false;
  }

  // Place new season at index '0' (as SMBHL convention places newest at '0') or newSeasonIndex
  dataJson.seasons[newSeasonIndex] = newSeasonObj;
  dataJson.current_season = seasonName;
  dataJson.updated = new Date().toISOString().slice(0, 10);

  // Update players in data.json
  for (const [team, players] of Object.entries(rosters)) {
    for (const p of players) {
      if (dataJson.players[p.playerId]) {
        if (!dataJson.players[p.playerId].seasons) dataJson.players[p.playerId].seasons = {};
        dataJson.players[p.playerId].seasons[seasonName] = {
          team,
          pos: p.pos || 'F',
          gp: 0,
          g: 0,
          a: 0,
          pts: 0
        };
      }
    }
  }

  if (env.SHEETS_KV) {
    await env.SHEETS_KV.put('data_json', JSON.stringify(dataJson, null, 2));
    // Also save backup
    await env.SHEETS_KV.put(`backup:season_launch:${seasonName}`, JSON.stringify(dataJson));
  }

  // 6. Update Settings
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES ('current_season', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).bind(seasonName).run();

  if (fees.regularDues != null || fees.subFee != null) {
    await db.prepare(`
      INSERT INTO settings (key, value) VALUES ('season_fees', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).bind(JSON.stringify(fees)).run();

    try {
      await db.prepare(`
        INSERT INTO season_pricing (season, price_player, price_goalie, price_sub_player, price_sub_goalie, updated_at)
        VALUES (?, ?, 0, ?, 0, datetime('now'))
        ON CONFLICT(season) DO UPDATE SET
          price_player=excluded.price_player,
          price_sub_player=excluded.price_sub_player,
          updated_at=excluded.updated_at
      `).bind(seasonName, Number(fees.regularDues) || 220, Number(fees.subFee) || 15).run();
    } catch (_) {}
  }

  if (rosterConfig && (rosterConfig.skatersPerTeam || rosterConfig.goaliesPerTeam || rosterConfig.minSkaters || rosterConfig.maxAssistsPerGoal || rosterConfig.teams || rosterConfig.playoffFormat)) {
    const existingRow = await db.prepare("SELECT value FROM settings WHERE key = 'season_draft_config'").first();
    const existing = existingRow ? JSON.parse(existingRow.value) : {};
    if (rosterConfig.teams) existing.teams = rosterConfig.teams;
    if (rosterConfig.skatersPerTeam) existing.skatersPerTeam = parseInt(rosterConfig.skatersPerTeam, 10) || 8;
    if (rosterConfig.goaliesPerTeam) existing.goaliesPerTeam = parseInt(rosterConfig.goaliesPerTeam, 10) || 1;
    if (rosterConfig.minSkaters) existing.minSkaters = parseInt(rosterConfig.minSkaters, 10) || 5;
    if (rosterConfig.playoffFormat) existing.playoffFormat = rosterConfig.playoffFormat;
    if (rosterConfig.maxAssistsPerGoal) {
      existing.maxAssistsPerGoal = parseInt(rosterConfig.maxAssistsPerGoal, 10) || 1;
      await db.prepare(`
        INSERT INTO settings (key, value) VALUES ('max_assists_per_goal', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `).bind(String(existing.maxAssistsPerGoal)).run();
    }
    await db.prepare(`
      INSERT INTO settings (key, value) VALUES ('season_draft_config', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).bind(JSON.stringify(existing)).run();
  }

  return {
    ok: true,
    seasonName,
    weeksCount: events.length,
    fixturesCount: fixtures.length,
    rostersCount: assignedPlayerIds.size,
    publishedAt: new Date().toISOString()
  };
}

/**
 * ============================================================================
 * HTTP Request Handlers for Season Hub API
 * ============================================================================
 */

export async function handleSeasonData(req, env, url) {
  const db = env.DB;
  let dataJson = {};
  if (env.SHEETS_KV) {
    const raw = await env.SHEETS_KV.get('data_json');
    if (raw) {
      try { dataJson = JSON.parse(raw); } catch (e) {}
    }
  }

  const currentSeason = dataJson.current_season || 'Fall 2026';
  const seasonsList = Object.values(dataJson.seasons || {})
    .filter(s => s && s.name)
    .map(s => ({ name: s.name, games: s.games, current: !!s.current }));

  // Query contacts
  const contacts = (await db.prepare(`
    SELECT player_id, name, email, phone, role, is_sub, is_goalie, preferred_team, position, last_played
    FROM contacts
    ORDER BY name ASC
  `).all()).results || [];

  // Query settings
  const rollCallRow = await db.prepare("SELECT value FROM settings WHERE key = 'season_rollcall'").first();
  const rollCall = rollCallRow ? JSON.parse(rollCallRow.value) : {};

  const draftConfigRow = await db.prepare("SELECT value FROM settings WHERE key = 'season_draft_config'").first();
  const draftConfig = draftConfigRow ? JSON.parse(draftConfigRow.value) : { pinned: {}, tandems: [], rosters: null };

  const feesRow = await db.prepare("SELECT value FROM settings WHERE key = 'season_fees'").first();
  let fees = feesRow ? JSON.parse(feesRow.value) : { regularDues: 220, subFee: 15 };

  // Check if target season has pricing in season_pricing (e.g. from Finances + Saison future)
  const targetSeason = url.searchParams.get('s') || url.searchParams.get('season') || 'Winter 2027';
  try {
    const pricingRow = await db.prepare("SELECT price_player, price_sub_player FROM season_pricing WHERE season = ?").bind(targetSeason).first();
    if (pricingRow) {
      if (pricingRow.price_player != null) fees.regularDues = Number(pricingRow.price_player);
      if (pricingRow.price_sub_player != null) fees.subFee = Number(pricingRow.price_sub_player);
    }
  } catch (_) {}

  // Calculate metrics for each contact
  const candidatePlayers = contacts.map(c => {
    const pData = dataJson.players ? dataJson.players[c.player_id] : null;
    const career = pData ? (pData.career || {}) : {};
    
    // Find stats in 2 recent active seasons
    const recentSeasons = [];
    if (pData && pData.seasons) {
      const sNames = Object.keys(pData.seasons).slice(-3);
      for (const sn of sNames) {
        if (pData.seasons[sn]) recentSeasons.push(pData.seasons[sn]);
      }
    }

    const metrics = computePlayerMetrics({
      ...c,
      pos: c.position,
      is_goalie: c.is_goalie,
      gcareer: pData?.gcareer
    }, career, recentSeasons);

    const savedStatus = rollCall[c.player_id]?.status;
    // Default status: if role === 'roster', default confirmed_regular unless specified
    const status = savedStatus || (c.role === 'roster' ? 'confirmed_regular' : (c.role === 'sub' ? 'confirmed_sub' : 'opted_out'));

    return {
      ...metrics,
      id: c.player_id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      role: c.role,
      preferredTeam: c.preferred_team,
      status
    };
  });

  // Stratify skaters
  const confirmedSkaters = candidatePlayers.filter(p => !p.isGoalie && p.status === 'confirmed_regular');
  const stratifiedConfirmed = stratifySkaters(confirmedSkaters);
  const stratifiedMap = new Map(stratifiedConfirmed.map(s => [s.playerId, s]));

  const enrichedCandidates = candidatePlayers.map(p => {
    if (stratifiedMap.has(p.id)) {
      return { ...p, tier: stratifiedMap.get(p.id).tier };
    }
    return p;
  });

  return Response.json({
    ok: true,
    currentSeason,
    seasons: seasonsList,
    candidates: enrichedCandidates,
    rollCall,
    draftConfig,
    fees,
    teamColors: (draftConfig?.teams && Array.isArray(draftConfig.teams) && draftConfig.teams.length > 0) ? draftConfig.teams : TEAM_COLORS,
    teamLabels: TEAM_LABELS,
    skatersPerTeam: draftConfig?.skatersPerTeam || 8,
    goaliesPerTeam: draftConfig?.goaliesPerTeam || 1,
    minSkaters: draftConfig?.minSkaters || 5,
    maxAssistsPerGoal: draftConfig?.maxAssistsPerGoal || 1,
    playoffFormat: draftConfig?.playoffFormat || 'top4_single_day'
  });
}

export async function handleSeasonRollCall(req, env) {
  const body = await req.json().catch(() => ({}));
  const { action, playerId, status, tandemPairId } = body;
  const db = env.DB;

  const row = await db.prepare("SELECT value FROM settings WHERE key = 'season_rollcall'").first();
  const rollCall = row ? JSON.parse(row.value) : {};

  if (action === 'update_status' && playerId) {
    if (!rollCall[playerId]) rollCall[playerId] = {};
    rollCall[playerId].status = status;
    rollCall[playerId].updatedAt = new Date().toISOString();
  } else if (action === 'promote_sub' && playerId) {
    if (!rollCall[playerId]) rollCall[playerId] = {};
    rollCall[playerId].status = 'confirmed_regular';
    rollCall[playerId].updatedAt = new Date().toISOString();
  } else if (action === 'link_tandem' && playerId && tandemPairId) {
    if (!rollCall[playerId]) rollCall[playerId] = {};
    rollCall[playerId].tandemWith = tandemPairId;
    if (!rollCall[tandemPairId]) rollCall[tandemPairId] = {};
    rollCall[tandemPairId].tandemWith = playerId;
  } else if (action === 'unlink_tandem' && playerId) {
    const otherId = rollCall[playerId]?.tandemWith;
    if (rollCall[playerId]) delete rollCall[playerId].tandemWith;
    if (otherId && rollCall[otherId]) delete rollCall[otherId].tandemWith;
  }

  await db.prepare(`
    INSERT INTO settings (key, value) VALUES ('season_rollcall', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).bind(JSON.stringify(rollCall)).run();

  return Response.json({ ok: true, rollCall });
}

export async function handleSeasonAutoDraft(req, env) {
  const body = await req.json().catch(() => ({}));
  const { candidateIds, pinned = {}, tandems = [], teams, skatersPerTeam = 7, goaliesPerTeam = 1 } = body;
  const db = env.DB;
  const activeTeams = teams && Array.isArray(teams) && teams.length > 0 ? teams : TEAM_COLORS;
  const sPerTeam = parseInt(skatersPerTeam, 10) || 7;
  const gPerTeam = parseInt(goaliesPerTeam, 10) || 1;

  // Query contacts
  const contacts = (await db.prepare(`
    SELECT player_id, name, email, phone, role, is_sub, is_goalie, preferred_team, position
    FROM contacts
  `).all()).results || [];

  let dataJson = {};
  if (env.SHEETS_KV) {
    const raw = await env.SHEETS_KV.get('data_json');
    if (raw) {
      try { dataJson = JSON.parse(raw); } catch (e) {}
    }
  }

  const selectedContacts = candidateIds && candidateIds.length > 0
    ? contacts.filter(c => candidateIds.includes(c.player_id))
    : contacts.filter(c => c.role === 'roster');

  const allMetrics = selectedContacts.map(c => {
    const pData = dataJson.players ? dataJson.players[c.player_id] : null;
    const career = pData ? (pData.career || {}) : {};
    const recentSeasons = [];
    if (pData && pData.seasons) {
      const sNames = Object.keys(pData.seasons).slice(-3);
      for (const sn of sNames) {
        if (pData.seasons[sn]) recentSeasons.push(pData.seasons[sn]);
      }
    }
    return computePlayerMetrics({
      ...c,
      pos: c.position,
      is_goalie: c.is_goalie,
      gcareer: pData?.gcareer
    }, career, recentSeasons);
  });

  const goalies = allMetrics.filter(p => p.isGoalie);
  const skaters = allMetrics.filter(p => !p.isGoalie);

  const draftResult = autoDraftTeams({
    skaters,
    goalies,
    pinned,
    tandems,
    teams: activeTeams,
    skatersPerTeam: sPerTeam,
    maxIterations: 5000
  });

  // Save to settings
  await db.prepare(`
    INSERT INTO settings (key, value) VALUES ('season_draft_config', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).bind(JSON.stringify({
    pinned,
    tandems,
    teams: activeTeams,
    skatersPerTeam: sPerTeam,
    goaliesPerTeam: gPerTeam,
    rosters: draftResult.rosters,
    goalies: draftResult.goalies,
    metrics: draftResult.metrics,
    spread: draftResult.spread,
    parityScore: draftResult.parityScore,
    updatedAt: new Date().toISOString()
  })).run();

  return Response.json({
    ok: true,
    ...draftResult,
    skatersPerTeam: sPerTeam,
    goaliesPerTeam: gPerTeam
  });
}

export async function handleSeasonSuggestSwap(req, env) {
  const body = await req.json().catch(() => ({}));
  const { currentRosters, teamA, teamB, pinned = {}, goalies = {} } = body;

  const swap = suggestCounterSwap({
    currentRosters,
    teamA,
    teamB,
    pinned,
    goalies
  });

  return Response.json({ ok: true, swap });
}

export async function handleSeasonGenerateSchedule(req, env) {
  const body = await req.json().catch(() => ({}));
  const {
    seasonName,
    startDate,
    weeksCount = 14,
    byeDates = [],
    teams,
    customSlots,
    playoffFormat = 'top4_single_day'
  } = body;

  if (!seasonName) {
    return Response.json({ ok: false, error: 'Nom de saison requis' }, { status: 400 });
  }

  const result = generateScheduleMatrix({
    seasonName,
    startDate: startDate || new Date().toISOString().slice(0, 10),
    weeksCount,
    byeDates,
    teams: teams || TEAM_COLORS,
    customSlots,
    playoffFormat
  });

  return Response.json({
    ok: true,
    seasonName,
    weeksCount: result.events.length,
    fixtures: result.fixtures,
    events: result.events,
    playoffFormat: result.playoffFormat
  });
}

export async function handleSeasonSaveConfig(req, env) {
  const body = await req.json().catch(() => ({}));
  const { teams, skatersPerTeam, goaliesPerTeam, minSkaters, playoffFormat, fees, rules } = body;
  const db = env.DB;

  const existingRow = await db.prepare("SELECT value FROM settings WHERE key = 'season_draft_config'").first();
  const existing = existingRow ? JSON.parse(existingRow.value) : {};

  if (teams && Array.isArray(teams) && teams.length > 0) {
    existing.teams = teams;
  }
  if (skatersPerTeam != null) {
    existing.skatersPerTeam = parseInt(skatersPerTeam, 10) || 8;
  }
  if (goaliesPerTeam != null) {
    existing.goaliesPerTeam = parseInt(goaliesPerTeam, 10) || 1;
  }
  if (minSkaters != null) {
    existing.minSkaters = parseInt(minSkaters, 10) || 5;
  }
  if (playoffFormat != null) {
    existing.playoffFormat = playoffFormat;
  }
  if (rules && rules.maxAssistsPerGoal != null) {
    existing.maxAssistsPerGoal = parseInt(rules.maxAssistsPerGoal, 10) || 1;
    await db.prepare(`
      INSERT INTO settings (key, value) VALUES ('max_assists_per_goal', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).bind(String(existing.maxAssistsPerGoal)).run();
  }

  await db.prepare(`
    INSERT INTO settings (key, value) VALUES ('season_draft_config', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).bind(JSON.stringify(existing)).run();

  if (fees && (fees.regularDues != null || fees.subFee != null)) {
    await db.prepare(`
      INSERT INTO settings (key, value) VALUES ('season_fees', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).bind(JSON.stringify(fees)).run();

    const targetSeason = body.seasonName || body.season || 'Winter 2027';
    try {
      await db.prepare(`
        INSERT INTO season_pricing (season, price_player, price_goalie, price_sub_player, price_sub_goalie, updated_at)
        VALUES (?, ?, 0, ?, 0, datetime('now'))
        ON CONFLICT(season) DO UPDATE SET
          price_player=excluded.price_player,
          price_sub_player=excluded.price_sub_player,
          updated_at=excluded.updated_at
      `).bind(targetSeason, Number(fees.regularDues) || 220, Number(fees.subFee) || 15).run();
    } catch (_) {}
  }

  return Response.json({ ok: true, config: existing });
}

export async function handleSeasonLaunch(req, env) {
  const body = await req.json().catch(() => ({}));
  const { seasonName, startDate, rosters, fixtures, events, fees, rosterConfig } = body;

  if (!seasonName || !startDate || !rosters || !fixtures || !events) {
    return Response.json({ ok: false, error: 'Paramètres incomplets pour le lancement de la saison' }, { status: 400 });
  }

  try {
    const result = await publishSeasonToProduction(env, {
      seasonName,
      startDate,
      rosters,
      fixtures,
      events,
      fees,
      rosterConfig
    });
    return Response.json({ ok: true, result });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

/**
 * ============================================================================
 * Season Hub UI Page (Bilingual, Responsive, Barlow Design)
 * ============================================================================
 */
export async function renderSeasonPage(env = null, isAuthed = false, adminTabsHtml = '', keyGateHtml = '') {
  return `
  <style>
    .wrap { max-width: 1200px !important; }
    .hub-header { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:20px; }
    .hub-title { font-family:'Barlow Condensed',sans-serif; font-size:32px; font-weight:700; margin:0; line-height:1.1; }
    .hub-steps { display:flex; gap:8px; flex-wrap:wrap; margin:16px 0 24px; }
    .step-btn { font-family:'Barlow Condensed',sans-serif; font-size:16px; font-weight:700; padding:10px 16px; border:2px solid var(--rule2); background:#fff; color:var(--soft); border-radius:4px; cursor:pointer; display:flex; align-items:center; gap:8px; transition:all .15s ease; }
    .step-btn:hover { background:#f8fafc; color:var(--ink); }
    .step-btn.on { background:var(--ink); color:#fff; border-color:var(--ink); }
    .step-btn .badge-num { background:rgba(0,0,0,0.08); padding:2px 7px; border-radius:12px; font-size:13px; }
    .step-btn.on .badge-num { background:rgba(255,255,255,0.25); color:#fff; }
    
    .hub-card { background:#fff; border:1px solid var(--rule); border-radius:6px; padding:20px; margin-bottom:20px; box-shadow:0 1px 3px rgba(0,0,0,0.04); }
    .kpi-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:14px; margin-bottom:20px; }
    .kpi-box { background:#f8fafc; border:1px solid var(--rule); border-radius:4px; padding:14px 16px; text-align:center; }
    .kpi-val { font-family:'Barlow Condensed',sans-serif; font-size:30px; font-weight:700; color:var(--ink); line-height:1; }
    .kpi-label { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; color:var(--soft); margin-top:4px; }

    /* Draft Board Columns */
    .draft-grid { display:grid; grid-template-columns:repeat(4, 1fr); gap:14px; margin-top:16px; }
    @media (max-width: 1000px) { .draft-grid { grid-template-columns:repeat(2, 1fr); } }
    @media (max-width: 600px) { .draft-grid { grid-template-columns:1fr; } }

    .team-col { background:#fdfdfd; border:2px solid var(--rule); border-radius:6px; overflow:hidden; display:flex; flex-direction:column; }
    .team-col.red { border-top:6px solid #b3122c; }
    .team-col.blue { border-top:6px solid #17457f; }
    .team-col.white { border-top:6px solid #cbd5e1; }
    .team-col.black { border-top:6px solid #16181d; }

    .team-col-header { padding:14px; background:#f8fafc; border-bottom:1px solid var(--rule); }
    .team-col-title { font-family:'Barlow Condensed',sans-serif; font-size:22px; font-weight:700; display:flex; justify-content:space-between; align-items:center; }
    .team-kpis { font-size:12px; color:var(--soft); margin-top:6px; display:flex; gap:10px; flex-wrap:wrap; font-weight:600; }

    .player-card { background:#fff; border:1px solid var(--rule); border-radius:4px; padding:10px 12px; margin:8px; display:flex; align-items:center; justify-content:space-between; transition:background .15s; font-size:14px; }
    .player-card:hover { background:#f8fafc; border-color:var(--rule2); }
    .player-card.goalie-card { background:#f0fdf4; border-color:#86efac; }
    .player-card.pinned { border-left:4px solid #f59e0b; }

    .tier-badge { font-size:11px; font-weight:700; padding:2px 6px; border-radius:3px; text-transform:uppercase; }
    .tier-1 { background:#fef3c7; color:#92400e; border:1px solid #fde68a; }
    .tier-2 { background:#e0e7ff; color:#3730a3; border:1px solid #c7d2fe; }
    .tier-3 { background:#f1f5f9; color:#475569; border:1px solid #cbd5e1; }
    .tier-4 { background:#f3f4f6; color:#6b7280; border:1px solid #e5e7eb; }

    .pos-tag { font-weight:700; font-size:12px; padding:2px 5px; border-radius:2px; }
    .pos-f { background:#fee2e2; color:#991b1b; }
    .pos-d { background:#dbeafe; color:#1e40af; }
    .pos-g { background:#dcfce7; color:#166534; }

    .act-icon { cursor:pointer; background:none; border:none; padding:4px; font-size:15px; border-radius:3px; }
    .act-icon:hover { background:#e2e8f0; }

    .parity-banner { background:#ecfdf5; border:1px solid #a7f3d0; border-radius:4px; padding:12px 16px; margin:14px 0; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; }
    .parity-alert { background:#fffbeb; border:1px solid #fde68a; border-radius:4px; padding:12px 16px; margin:14px 0; display:none; }

    .action-row { display:flex; gap:10px; flex-wrap:wrap; margin:14px 0; }
    .btn-action { font-family:'Barlow Condensed',sans-serif; font-weight:700; font-size:16px; padding:10px 18px; border-radius:4px; cursor:pointer; border:1px solid transparent; display:inline-flex; align-items:center; gap:8px; text-decoration:none; }
    .btn-action.primary { background:var(--green); color:#fff; }
    .btn-action.primary:hover { opacity:0.9; }
    .btn-action.secondary { background:#fff; border-color:var(--rule2); color:var(--ink); }
    .btn-action.secondary:hover { background:#f1f5f9; }
    .btn-action.accent { background:var(--blue); color:#fff; }

    table.hub-tbl { width:100%; border-collapse:collapse; font-size:14px; text-align:left; }
    table.hub-tbl th { background:#f8fafc; color:var(--soft); font-weight:700; font-size:12px; text-transform:uppercase; letter-spacing:0.04em; padding:10px 14px; border-bottom:1px solid var(--rule); }
    table.hub-tbl td { padding:10px 14px; border-bottom:1px solid var(--rule); vertical-align:middle; }
    table.hub-tbl tr:hover { background:#fbfcfe; }

    .status-chip { display:inline-flex; align-items:center; gap:5px; font-size:12px; font-weight:700; padding:3px 8px; border-radius:12px; cursor:pointer; border:1px solid var(--rule2); background:#fff; }
    .status-chip.active-regular { background:#ecfdf5; color:#047857; border-color:#a7f3d0; }
    .status-chip.active-sub { background:#eff6ff; color:#1d4ed8; border-color:#bfdbfe; }
    .status-chip.active-optout { background:#fee2e2; color:#991b1b; border-color:#fca5a5; }

    .fixture-card { background:#fff; border:1px solid var(--rule); border-radius:4px; padding:10px 14px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; font-size:14px; }
  </style>

  ${adminTabsHtml}
  
  <div class="hub-header">
    <div>
      <h1 class="hub-title" data-i18n="hubTitle">Hub de Lancement de Saison 🏒</h1>
      <div class="when" data-i18n="hubSubtitle" style="margin:2px 0 0">Transition complète, recensement et alignements équilibrés sans code.</div>
    </div>
    <div id="active-season-badge" style="background:#e0e7ff; color:#3730a3; padding:6px 14px; border-radius:20px; font-weight:700; font-size:14px;">
      <span data-i18n="activeSeasonPrefix">Saison active : </span><span id="cur-season-name">...</span>
    </div>
  </div>

  ${keyGateHtml}

  <div id="hub-main"${isAuthed ? '' : ' style="display:none"'}>
    <!-- Step Navigation Bar -->
    <div class="hub-steps">
      <button class="step-btn on" id="tab-step-1" onclick="switchStep(1)">
        <span class="badge-num">1</span> <span data-i18n="step1Nav">Structure & Équipes ⚙️</span>
      </button>
      <button class="step-btn" id="tab-step-2" onclick="switchStep(2)">
        <span class="badge-num">2</span> <span data-i18n="step2Nav">Recensement & Candidats 📋</span>
      </button>
      <button class="step-btn" id="tab-step-3" onclick="switchStep(3)">
        <span class="badge-num">3</span> <span data-i18n="step3Nav">Draft Board & Équilibrage 🏒</span>
      </button>
      <button class="step-btn" id="tab-step-4" onclick="switchStep(4)">
        <span class="badge-num">4</span> <span data-i18n="step4Nav">Calendrier & Gymnases 📅</span>
      </button>
      <button class="step-btn" id="tab-step-5" onclick="switchStep(5)">
        <span class="badge-num">5</span> <span data-i18n="step5Nav">Lancement Officiel 🚀</span>
      </button>
    </div>

    <!-- STEP 1: STRUCTURE & ACTIVE TEAMS -->
    <div id="step-1" class="step-content">
      <div class="hub-card">
        <h2 style="font-family:'Barlow Condensed',sans-serif; font-size:24px; margin:0 0 16px;" data-i18n="step1CardTitle">Structure de la Saison & Équipes</h2>
        
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:14px; margin-bottom:20px;">
          <div>
            <label style="font-size:12px; font-weight:700; color:var(--soft); text-transform:uppercase;" data-i18n="seasonNameLbl">Nom de la Saison</label>
            <input type="text" id="sched-season-name" class="form-control" value="Hiver 2027" oninput="syncSeasonName(this.value)" style="width:100%; padding:8px; font:inherit; border:1px solid var(--rule2); border-radius:3px; margin-top:4px;">
          </div>
          <div>
            <label style="font-size:12px; font-weight:700; color:var(--soft); text-transform:uppercase;" data-i18n="playoffFormatLbl">Format des Séries Éliminatoires 🏆</label>
            <select id="sched-playoff-format" onchange="saveStructureConfig()" style="width:100%; padding:8px; font:inherit; border:1px solid var(--rule2); border-radius:3px; margin-top:4px;">
              <option value="top4_single_day" data-i18n="playoffOpt1">🏆 Format SMBHL Classique (Top 4 en 1 journée : Demi-finales + Finale + 3e place)</option>
              <option value="top4_two_weeks" data-i18n="playoffOpt2">🥈 Séries sur 2 semaines (Top 4 : Semaine N Demi-finales, Semaine N+1 Finale)</option>
              <option value="none" data-i18n="playoffOpt3">⏸️ Aucune série (Saison régulière seulement)</option>
            </select>
          </div>
          <div>
            <label style="font-size:12px; font-weight:700; color:var(--soft); text-transform:uppercase;" data-i18n="skatersPerTeamLbl">Patineurs par Équipe 🏃</label>
            <input type="number" id="param-skaters-per-team" value="8" min="3" max="15" oninput="updateRosterSettings()" style="width:100%; padding:8px; font:inherit; border:1px solid var(--rule2); border-radius:3px; margin-top:4px;">
          </div>
          <div>
            <label style="font-size:12px; font-weight:700; color:var(--soft); text-transform:uppercase;" data-i18n="minSkatersLbl">Patineurs Min par Match ⚠️</label>
            <input type="number" id="param-min-skaters" value="5" min="3" max="10" oninput="saveStructureConfig()" style="width:100%; padding:8px; font:inherit; border:1px solid var(--rule2); border-radius:3px; margin-top:4px;">
          </div>
          <div>
            <label style="font-size:12px; font-weight:700; color:var(--soft); text-transform:uppercase;" data-i18n="goaliesPerTeamLbl">Gardiens par Équipe 🧤</label>
            <input type="number" id="param-goalies-per-team" value="1" min="1" max="2" oninput="updateRosterSettings()" style="width:100%; padding:8px; font:inherit; border:1px solid var(--rule2); border-radius:3px; margin-top:4px;">
          </div>
          <div>
            <label style="font-size:12px; font-weight:700; color:var(--soft); text-transform:uppercase;" data-i18n="regularDuesLbl">Frais Joueur Régulier ($)</label>
            <input type="number" id="param-regular-dues" value="220" oninput="saveStructureConfig()" style="width:100%; padding:8px; font:inherit; border:1px solid var(--rule2); border-radius:3px; margin-top:4px;">
          </div>
          <div>
            <label style="font-size:12px; font-weight:700; color:var(--soft); text-transform:uppercase;" data-i18n="subFeeLbl">Coût par Match Substitut ($)</label>
            <input type="number" id="param-sub-fee" value="15" oninput="saveStructureConfig()" style="width:100%; padding:8px; font:inherit; border:1px solid var(--rule2); border-radius:3px; margin-top:4px;">
          </div>
          <div>
            <label style="font-size:12px; font-weight:700; color:var(--soft); text-transform:uppercase;" data-i18n="maxAssistsLbl">Passes Max par But 🤝</label>
            <select id="param-max-assists-per-goal" onchange="saveStructureConfig()" style="width:100%; padding:8px; font:inherit; border:1px solid var(--rule2); border-radius:3px; margin-top:4px;">
              <option value="1" selected data-i18n="maxAssistsOpt1">1 passe max par but (Standard SMBHL)</option>
              <option value="2" data-i18n="maxAssistsOpt2">2 passes max par but (Style LNH / 2 passes)</option>
            </select>
          </div>
        </div>

        <hr style="border:none; border-top:1px solid var(--rule); margin:20px 0;">

        <div>
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
            <label style="font-size:13px; font-weight:700; color:var(--soft); text-transform:uppercase;" data-i18n="teamsInContention">Équipes en Lice</label>
            <span style="font-size:12px; color:var(--soft);" data-i18n="teamsHint">Cliquez sur une équipe (ou ✏️) pour modifier son nom, ou sur + pour en ajouter</span>
          </div>
          <div id="teams-list-tags" style="display:flex; gap:8px; flex-wrap:wrap; margin-top:6px; align-items:center;">
            <!-- Teams pills rendered here -->
          </div>

          <!-- Dynamic Quota Banner -->
          <div id="team-quota-banner" style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:4px; padding:12px 16px; margin-top:16px; font-size:15px; color:#1e40af; font-weight:600;">
            <!-- Dynamically calculated -->
          </div>
        </div>

        <div style="display:flex; justify-content:flex-end; margin-top:24px;">
          <button class="btn-action primary" onclick="switchStep(2)" data-i18n="nextToStep2">
            Passer au Recensement & Candidats ➡️
          </button>
        </div>
      </div>
    </div>

    <!-- STEP 2: ROLL-CALL & INTAKE -->
    <div id="step-2" class="step-content" style="display:none;">
      <div class="kpi-grid">
        <div class="kpi-box">
          <div class="kpi-val" id="kpi-regular-count">0 / 28</div>
          <div class="kpi-label" data-i18n="kpiRegular">Patineurs Réguliers Confirmés</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-val" id="kpi-goalie-count">0 / 4</div>
          <div class="kpi-label" data-i18n="kpiGoalies">Gardiens Titulaires</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-val" id="kpi-sub-count">0</div>
          <div class="kpi-label" data-i18n="kpiSubs">Substituts Disponibles</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-val" id="kpi-optout-count">0</div>
          <div class="kpi-label" data-i18n="kpiOptout">En Pause / Blessés</div>
        </div>
      </div>

      <div class="hub-card">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:14px;">
          <h2 style="font-family:'Barlow Condensed',sans-serif; font-size:22px; margin:0;" data-i18n="rosterCardTitle">Effectif & Statuts d'Intention</h2>
          <div style="display:flex; gap:8px;">
            <input type="search" id="filter-candidates" placeholder="Filtrer les joueurs..." oninput="renderCandidatesTable()" style="font:inherit; font-size:14px; padding:6px 10px; border:1px solid var(--rule2); border-radius:3px;">
            <button class="btn-action secondary" style="font-size:13px; padding:6px 12px;" onclick="pollIntentBroadcast()" data-i18n="sendPollBtn">📢 Envoyer sondage 1-clic</button>
          </div>
        </div>

        <div style="overflow-x:auto;">
          <table class="hub-tbl">
            <thead>
              <tr>
                <th data-i18n="tblPlayer">Joueur</th>
                <th data-i18n="tblPosition">Position</th>
                <th data-i18n="tblHistory">Historique (PPG)</th>
                <th data-i18n="tblAttendance">Taux Présence</th>
                <th data-i18n="tblStatus">Statut pour la saison à venir</th>
                <th data-i18n="tblActions">Actions</th>
              </tr>
            </thead>
            <tbody id="candidates-tbody">
              <tr><td colspan="6" style="text-align:center; padding:20px; color:var(--soft);" data-i18n="loadingRoster">Chargement de l'effectif...</td></tr>
            </tbody>
          </table>
        </div>

        <div style="display:flex; justify-content:space-between; margin-top:20px; flex-wrap:wrap; gap:10px;">
          <button class="btn-action secondary" onclick="switchStep(1)" data-i18n="backToStep1">⬅️ Équipes & Structure</button>
          <button class="btn-action primary" onclick="switchStep(3)" data-i18n="nextToStep3">Passer au Draft Board ➡️</button>
        </div>
      </div>
    </div>

    <!-- STEP 3: DRAFT BOARD & PARITY ENGINE -->
    <div id="step-3" class="step-content" style="display:none;">
      <div class="parity-banner" id="parity-banner">
        <div>
          <b style="font-size:16px;"><span data-i18n="parityTitle">Indicateur de Parité de la Ligue : </span><span id="parity-score-val">--%</span></b>
          <div style="font-size:13px; color:#047857;" id="parity-detail-text">Écart maximal : -- pts/match entre équipes</div>
        </div>
        <div class="action-row" style="margin:0;">
          <button class="btn-action primary" onclick="runAutoDraft()" data-i18n="suggestDraftBtn">✨ Suggérer un alignement équilibré</button>
          <button class="btn-action secondary" onclick="runRebalanceFree()" data-i18n="rebalanceFreeBtn">🔄 Rééquilibrer libres (Garder Pins)</button>
        </div>
      </div>

      <div class="parity-alert" id="parity-alert">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <div>
            <b style="color:#92400e;" data-i18n="imbalanceDetected">⚠️ Déséquilibre Détecté suite à une modification manuelle</b>
            <div style="font-size:13px; color:#78350f;" id="alert-swap-text">...</div>
          </div>
          <button class="btn-action accent" style="font-size:13px; padding:6px 12px;" id="btn-apply-counter-swap" data-i18n="applyCounterSwapBtn">💡 Appliquer le contre-échange recommandé</button>
        </div>
      </div>

      <div class="draft-grid" id="draft-columns">
        <!-- Team columns dynamically rendered here -->
      </div>

      <div style="display:flex; justify-content:space-between; margin-top:20px; flex-wrap:wrap; gap:10px;">
        <button class="btn-action secondary" onclick="switchStep(2)" data-i18n="backToStep2">⬅️ Recensement</button>
        <button class="btn-action primary" onclick="switchStep(4)" data-i18n="nextToStep4">Passer au Calendrier ➡️</button>
      </div>
    </div>

    <!-- STEP 4: SCHEDULE & AVAILABILITY BUILDER -->
    <div id="step-4" class="step-content" style="display:none;">
      <div class="hub-card">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:16px;">
          <h2 style="font-family:'Barlow Condensed',sans-serif; font-size:24px; margin:0;" data-i18n="schedTitle">
            🏟️ Plages Horaires, Gymnases & Calendrier
          </h2>
          <div style="font-size:14px; color:var(--soft);">
            <span data-i18n="schedSeasonLabel">Saison : </span><b id="sched-season-display">Hiver 2027</b> · <span id="sched-teams-count-display">4 équipes</span>
          </div>
        </div>

        <!-- Clone Pattern Toolbar -->
        <div style="background:#f8fafc; border:1px solid var(--rule); border-radius:6px; padding:16px; margin-bottom:18px;">
          <div style="font-weight:700; font-size:14px; margin-bottom:8px;" data-i18n="cloneToolTitle">🔁 Outil Cloner / Répéter un Modèle de Disponibilité :</div>
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:10px; align-items:flex-end;">
            <div>
              <label style="font-size:11px; font-weight:700; color:var(--soft); text-transform:uppercase;" data-i18n="clonePresetLbl">Modèle de Gymnase</label>
              <select id="clone-preset" style="width:100%; padding:8px; font:inherit; font-size:13px; border:1px solid var(--rule2); border-radius:3px;">
                <option value="smbhl_doubleheader" data-i18n="presetOptDoubleheader">SMBHL Standard (Dimanche 10h30 & 11h30 · Letendre Gym 1 & 2)</option>
                <option value="weekend_sat_sun" data-i18n="presetOptWeekend">Weekends (Samedi soir + Dimanche matin)</option>
                <option value="single_gym" data-i18n="presetOptSingleGym">1 Seul Gymnase (Matchs consécutifs 10h30, 11h30, 12h30, 13h30)</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px; font-weight:700; color:var(--soft); text-transform:uppercase;" data-i18n="cloneStartDateLbl">Date du Premier Match</label>
              <input type="date" id="clone-start-date" style="width:100%; padding:8px; font:inherit; font-size:13px; border:1px solid var(--rule2); border-radius:3px;">
            </div>
            <div>
              <label style="font-size:11px; font-weight:700; color:var(--soft); text-transform:uppercase;" data-i18n="cloneWeeksCountLbl">Nombre de Semaines</label>
              <input type="number" id="clone-weeks-count" value="14" min="4" max="24" style="width:100%; padding:8px; font:inherit; font-size:13px; border:1px solid var(--rule2); border-radius:3px;">
            </div>
            <div>
              <button class="btn-action accent" style="width:100%; justify-content:center; font-size:14px; padding:8px;" onclick="applyCloneSchedulePattern()" data-i18n="cloneApplyBtn">
                🔁 Cloner ce modèle
              </button>
            </div>
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:12px;">
          <h3 style="font-family:'Barlow Condensed',sans-serif; font-size:18px; margin:0;" data-i18n="datesSlotsTitle">
            📅 Dates & Créneaux Configurés
          </h3>
          <button class="btn-action secondary" style="font-size:13px; padding:6px 12px;" onclick="addCustomDatePrompt()" data-i18n="addCustomDateBtn">+ Ajouter une date ponctuelle</button>
        </div>

        <!-- Available Dates List -->
        <div id="slots-dates-container" style="display:flex; flex-direction:column; gap:10px; margin-bottom:20px; max-height:450px; overflow-y:auto; padding-right:4px;">
          <!-- Date cards with slots and delete buttons -->
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; border-top:1px solid var(--rule); padding-top:16px;">
          <div id="slots-totals-summary" style="font-size:14px; color:var(--soft);">
            Total : <b id="total-slots-count">0</b> créneaux sur <b id="total-dates-count">0</b> journées
          </div>
          <button class="btn-action primary" style="font-size:18px; padding:12px 24px;" onclick="generateSchedulePreview()" data-i18n="generateScheduleBtn">
            ⚡ Générer le Calendrier Complet (Régulier + Séries)
          </button>
        </div>

        <!-- Fixtures Preview -->
        <div id="sched-fixtures-container" style="margin-top:24px;">
          <div id="sched-empty-hint" style="color:var(--soft); text-align:center; padding:20px;" data-i18n="schedEmptyMsg">Cliquez sur « Générer le Calendrier » pour prévisualiser les matchs et les séries.</div>
        </div>

        <div style="display:flex; justify-content:space-between; margin-top:20px; flex-wrap:wrap; gap:10px; border-top:1px solid var(--rule); padding-top:16px;">
          <button class="btn-action secondary" onclick="switchStep(3)" data-i18n="backToStep3">⬅️ Draft Board</button>
          <button class="btn-action primary" onclick="switchStep(5)" data-i18n="nextToStep5">Passer au Lancement ➡️</button>
        </div>
      </div>
    </div>

    <!-- STEP 5: LAUNCH & PUBLISH -->
    <div id="step-5" class="step-content" style="display:none;">
      <div class="hub-card">
        <h2 style="font-family:'Barlow Condensed',sans-serif; font-size:24px; margin:0 0 16px;" data-i18n="step5Title">Vérifications Pré-Lancement & Déploiement</h2>
        
        <div style="background:#f8fafc; border:1px solid var(--rule); border-radius:4px; padding:16px; margin-bottom:20px;">
          <div style="font-weight:700; margin-bottom:10px;" data-i18n="checklistTitle">Liste de Contrôle :</div>
          <div style="display:flex; flex-direction:column; gap:8px; font-size:15px;">
            <div id="chk-goalies">⏳ Gardiens confirmés et assignés</div>
            <div id="chk-skaters">⏳ Patineurs réguliers assignés (7 par équipe)</div>
            <div id="chk-sched">⏳ Calendrier généré</div>
            <div id="chk-pricing">⏳ Tarification active</div>
          </div>
        </div>

        <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
          <button class="btn-action primary" style="font-size:20px; padding:14px 28px;" id="btn-launch-season" onclick="executeSeasonLaunch()" data-i18n="launchOfficialBtn">
            🚀 LANCER OFFICIELLEMENT LA SAISON
          </button>
          <a href="/data.json" download="data-backup.json" class="btn-action secondary" data-i18n="downloadBackupBtn">
            📥 Télécharger une copie de sécurité data.json
          </a>
        </div>
        <div id="launch-result-msg" style="margin-top:14px; font-weight:600;"></div>

        <div style="margin-top:20px;">
          <button class="btn-action secondary" onclick="switchStep(4)" data-i18n="backToStep4">⬅️ Retour au Calendrier</button>
        </div>
      </div>
    </div>
  </div>

  <script>
  let K = new URLSearchParams(location.search).get('key') || new URLSearchParams(location.search).get('k') || localStorage.getItem('adminkey') || (document.cookie.match(/(?:^|;\s*)admin_key=([^;]+)/)?.[1] ? decodeURIComponent(RegExp.$1) : '') || '';
  const $ = i => document.getElementById(i);
  const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  const teamPalette = {
    Red: { label: '🔴 Rouge', labelEn: '🔴 Red', bg: '#fee2e2', border: '#b3122c', color: '#991b1b' },
    Blue: { label: '🔵 Bleu', labelEn: '🔵 Blue', bg: '#dbeafe', border: '#17457f', color: '#1e40af' },
    White: { label: '⚪ Blanc', labelEn: '⚪ White', bg: '#f1f5f9', border: '#cbd5e1', color: '#334155' },
    Black: { label: '⚫ Noir', labelEn: '⚫ Black', bg: '#e2e8f0', border: '#16181d', color: '#0f172a' },
    Green: { label: '🟢 Vert', labelEn: '🟢 Green', bg: '#dcfce7', border: '#15803d', color: '#166534' },
    Gold: { label: '🟡 Or', labelEn: '🟡 Gold', bg: '#fef3c7', border: '#b45309', color: '#92400e' },
    Yellow: { label: '🟡 Jaune', labelEn: '🟡 Yellow', bg: '#fef9c3', border: '#eab308', color: '#854d0e' },
    Orange: { label: '🟠 Orange', labelEn: '🟠 Orange', bg: '#ffedd5', border: '#c2410c', color: '#9a3412' },
    Purple: { label: '🟣 Violet', labelEn: '🟣 Purple', bg: '#f3e8ff', border: '#7e22ce', color: '#6b21a8' },
    Grey: { label: '⚪ Gris', labelEn: '⚪ Grey', bg: '#f3f4f6', border: '#64748b', color: '#374151' }
  };

  let currentLang = (typeof window !== 'undefined' && window.__currentLang) || localStorage.getItem('smbhl_admin_lang') || 'fr';

  const I18N = {
    fr: {
      hubTitle: 'Hub de Lancement de Saison 🏒',
      hubSubtitle: 'Transition complète, recensement et alignements équilibrés sans code.',
      activeSeasonPrefix: 'Saison active : ',
      step1Nav: 'Structure & Équipes ⚙️',
      step2Nav: 'Recensement & Candidats 📋',
      step3Nav: 'Draft Board & Équilibrage 🏒',
      step4Nav: 'Calendrier & Gymnases 📅',
      step5Nav: 'Lancement Officiel 🚀',
      step1CardTitle: 'Structure de la Saison & Équipes',
      seasonNameLbl: 'Nom de la Saison',
      playoffFormatLbl: 'Format des Séries Éliminatoires 🏆',
      playoffOpt1: '🏆 Format SMBHL Classique (Top 4 en 1 journée : Demi-finales + Finale + 3e place)',
      playoffOpt2: '🥈 Séries sur 2 semaines (Top 4 : Semaine N Demi-finales, Semaine N+1 Finale)',
      playoffOpt3: '⏸️ Aucune série (Saison régulière seulement)',
      skatersPerTeamLbl: 'Patineurs par Équipe 🏃',
      minSkatersLbl: 'Patineurs Min par Match ⚠️',
      goaliesPerTeamLbl: 'Gardiens par Équipe 🧤',
      regularDuesLbl: 'Frais Joueur Régulier ($)',
      subFeeLbl: 'Coût par Match Substitut ($)',
      maxAssistsLbl: 'Passes Max par But 🤝',
      maxAssistsOpt1: '1 passe max par but (Standard SMBHL)',
      maxAssistsOpt2: '2 passes max par but (Style LNH / 2 passes)',
      teamsInContention: 'Équipes en Lice',
      teamsHint: 'Cliquez sur une équipe (ou ✏️) pour modifier son nom, ou sur + pour en ajouter',
      addTeamBtn: '+ Ajouter une équipe',
      nextToStep2: 'Passer au Recensement & Candidats ➡️',
      kpiRegular: 'Patineurs Réguliers Confirmés',
      kpiGoalies: 'Gardiens Titulaires',
      kpiSubs: 'Substituts Disponibles',
      kpiOptout: 'En Pause / Blessés',
      rosterCardTitle: "Effectif & Statuts d'Intention",
      filterPlaceholder: 'Filtrer les joueurs...',
      sendPollBtn: '📢 Envoyer sondage 1-clic',
      tblPlayer: 'Joueur',
      tblPosition: 'Position',
      tblHistory: 'Historique (PPG)',
      tblAttendance: 'Taux Présence',
      tblStatus: 'Statut pour la saison à venir',
      tblActions: 'Actions',
      loadingRoster: "Chargement de l'effectif...",
      backToStep1: '⬅️ Équipes & Structure',
      nextToStep3: 'Passer au Draft Board ➡️',
      statusRegular: '🟢 Régulier Partant',
      statusSub: '🧤 Substitut',
      statusOptout: '⏸️ Pause / Blessé',
      statusPending: '❓ En attente',
      promoteBtn: 'Promouvoir ⬆️',
      parityTitle: 'Indicateur de Parité de la Ligue : ',
      suggestDraftBtn: '✨ Suggérer un alignement équilibré',
      rebalanceFreeBtn: '🔄 Rééquilibrer libres (Garder Pins)',
      imbalanceDetected: '⚠️ Déséquilibre Détecté suite à une modification manuelle',
      applyCounterSwapBtn: '💡 Appliquer le contre-échange recommandé',
      backToStep2: '⬅️ Recensement',
      nextToStep4: 'Passer au Calendrier ➡️',
      noGoalieAssigned: 'Aucun gardien assigné',
      skatersCountLabel: 'Patineurs',
      defensemenCountLabel: 'Défenseurs',
      forwardsCountLabel: 'Attaquants',
      lockTooltip: 'Verrouiller dans cette équipe',
      schedTitle: '🏟️ Plages Horaires, Gymnases & Calendrier',
      schedSeasonLabel: 'Saison : ',
      cloneToolTitle: '🔁 Outil Cloner / Répéter un Modèle de Disponibilité :',
      clonePresetLbl: 'Modèle de Gymnase',
      presetOptDoubleheader: 'SMBHL Standard (Dimanche 10h30 & 11h30 · Letendre Gym 1 & 2)',
      presetOptWeekend: 'Weekends (Samedi soir + Dimanche matin)',
      presetOptSingleGym: '1 Seul Gymnase (Matchs consécutifs 10h30, 11h30, 12h30, 13h30)',
      cloneStartDateLbl: 'Date du Premier Match',
      cloneWeeksCountLbl: 'Nombre de Semaines',
      cloneApplyBtn: '🔁 Cloner ce modèle',
      datesSlotsTitle: '📅 Dates & Créneaux Configurés',
      addCustomDateBtn: '+ Ajouter une date ponctuelle',
      generateScheduleBtn: '⚡ Générer le Calendrier Complet (Régulier + Séries)',
      schedEmptyMsg: 'Cliquez sur « Générer le Calendrier » pour prévisualiser les matchs et les séries.',
      noDatesMsg: "Aucune date configurée. Utilisez l'outil de clonage ci-dessus ou ajoutez une date ponctuelle.",
      addSlotBtn: '+ Créneau',
      removeDateBtn: '❌ Retirer cette date',
      backToStep3: '⬅️ Draft Board',
      nextToStep5: 'Passer au Lancement ➡️',
      totalSlotsLabel: 'Total : ',
      slotsAcross: 'créneaux sur',
      daysLabel: 'journées',
      step5Title: 'Vérifications Pré-Lancement & Déploiement',
      checklistTitle: 'Liste de Contrôle :',
      chkGoaliesAssigned: 'Gardiens assignés',
      chkSkatersAssigned: 'Patineurs réguliers assignés',
      chkGamesScheduled: 'Matchs programmés',
      chkPricingActive: 'Tarification active',
      launchOfficialBtn: '🚀 LANCER OFFICIELLEMENT LA SAISON',
      downloadBackupBtn: '📥 Télécharger une copie de sécurité data.json',
      backToStep4: '⬅️ Retour au Calendrier',
      teamsStaying: 'Équipes qui restent : ',
      weekLabel: 'Semaine',
      playoffsLabel: 'SÉRIES ÉLIMINATOIRES / PLAYOFFS',
      adminKeyTitle: 'Clé admin',
      adminKeyPlaceholder: 'clé',
      adminKeyBtn: 'OUVRIR',
      errEnterKey: 'Entrez une clé svp',
      errKeyRejected: 'Clé refusée',
      errInvalidKey: 'Clé invalide',
      quotaBannerText: (teams, skaters, goalies, totalGoalies, totalSkaters, totalPlayers) =>
        '🏒 Pour <b>' + teams + ' équipes</b> à <b>' + skaters + ' patineurs</b> et <b>' + goalies + ' gardien' + (goalies > 1 ? 's' : '') + '</b> : la ligue nécessite au total <b>' + totalGoalies + ' gardiens</b> et <b>' + totalSkaters + ' patineurs réguliers</b> (' + totalPlayers + ' joueurs au total).',
      teamsCountDisplay: (n) => n + ' équipes',
      paritySpreadText: (spread) => 'Écart maximal : ' + spread.toFixed(2) + ' pts/m entre équipes',
      ptsPerGame: 'pts/m',
      gpShort: 'PJ'
    },
    en: {
      hubTitle: 'Season Launch Hub 🏒',
      hubSubtitle: 'Full transition, roll-call and balanced rosters with no code.',
      activeSeasonPrefix: 'Active season: ',
      step1Nav: 'Structure & Teams ⚙️',
      step2Nav: 'Roll-Call & Candidates 📋',
      step3Nav: 'Draft Board & Balance 🏒',
      step4Nav: 'Schedule & Gyms 📅',
      step5Nav: 'Official Launch 🚀',
      step1CardTitle: 'Season Structure & Teams',
      seasonNameLbl: 'Season Name',
      playoffFormatLbl: 'Playoff Format 🏆',
      playoffOpt1: '🏆 Classic SMBHL Format (Top 4 in 1 day: Semifinals + Final + 3rd place)',
      playoffOpt2: '🥈 2-Week Playoffs (Top 4: Week N Semifinals, Week N+1 Final)',
      playoffOpt3: '⏸️ No playoffs (Regular season only)',
      skatersPerTeamLbl: 'Skaters per Team 🏃',
      minSkatersLbl: 'Min Skaters per Game ⚠️',
      goaliesPerTeamLbl: 'Goalies per Team 🧤',
      regularDuesLbl: 'Regular Player Fee ($)',
      subFeeLbl: 'Sub Fee per Game ($)',
      maxAssistsLbl: 'Max Assists per Goal 🤝',
      maxAssistsOpt1: '1 assist max per goal (SMBHL Standard)',
      maxAssistsOpt2: '2 assists max per goal (NHL Style / 2 assists)',
      teamsInContention: 'Teams in Contention',
      teamsHint: 'Click a team (or ✏️) to rename, or + to add a team',
      addTeamBtn: '+ Add a team',
      nextToStep2: 'Proceed to Roll-Call & Candidates ➡️',
      kpiRegular: 'Confirmed Regular Skaters',
      kpiGoalies: 'Starting Goalies',
      kpiSubs: 'Available Substitutes',
      kpiOptout: 'On Break / Injured',
      rosterCardTitle: 'Roster & Intent Statuses',
      filterPlaceholder: 'Filter players...',
      sendPollBtn: '📢 Send 1-click poll',
      tblPlayer: 'Player',
      tblPosition: 'Position',
      tblHistory: 'History (PPG)',
      tblAttendance: 'Attendance Rate',
      tblStatus: 'Status for upcoming season',
      tblActions: 'Actions',
      loadingRoster: 'Loading roster...',
      backToStep1: '⬅️ Teams & Structure',
      nextToStep3: 'Proceed to Draft Board ➡️',
      statusRegular: '🟢 Regular Starter',
      statusSub: '🧤 Substitute',
      statusOptout: '⏸️ On Break / Injured',
      statusPending: '❓ Pending',
      promoteBtn: 'Promote ⬆️',
      parityTitle: 'League Parity Score: ',
      suggestDraftBtn: '✨ Suggest Balanced Rosters',
      rebalanceFreeBtn: '🔄 Rebalance Free (Keep Pins)',
      imbalanceDetected: '⚠️ Imbalance Detected following manual adjustment',
      applyCounterSwapBtn: '💡 Apply recommended counter-swap',
      backToStep2: '⬅️ Roll-Call',
      nextToStep4: 'Proceed to Schedule ➡️',
      noGoalieAssigned: 'No goalie assigned',
      skatersCountLabel: 'Skaters',
      defensemenCountLabel: 'Defensemen',
      forwardsCountLabel: 'Forwards',
      lockTooltip: 'Lock into this team',
      schedTitle: '🏟️ Time Slots, Gyms & Schedule',
      schedSeasonLabel: 'Season: ',
      cloneToolTitle: '🔁 Clone / Repeat Availability Template Tool:',
      clonePresetLbl: 'Gym Preset',
      presetOptDoubleheader: 'SMBHL Standard (Sunday 10:30 AM & 11:30 AM · Letendre Gym 1 & 2)',
      presetOptWeekend: 'Weekends (Saturday evening + Sunday morning)',
      presetOptSingleGym: 'Single Gym (Back-to-back games 10:30 AM, 11:30 AM, 12:30 PM, 1:30 PM)',
      cloneStartDateLbl: 'First Game Date',
      cloneWeeksCountLbl: 'Number of Weeks',
      cloneApplyBtn: '🔁 Clone this template',
      datesSlotsTitle: '📅 Configured Dates & Slots',
      addCustomDateBtn: '+ Add single date',
      generateScheduleBtn: '⚡ Generate Full Schedule (Regular + Playoffs)',
      schedEmptyMsg: 'Click "Generate Full Schedule" to preview games and playoff rounds.',
      noDatesMsg: 'No dates configured. Use the clone tool above or add a date.',
      addSlotBtn: '+ Slot',
      removeDateBtn: '❌ Remove this date',
      backToStep3: '⬅️ Draft Board',
      nextToStep5: 'Proceed to Launch ➡️',
      totalSlotsLabel: 'Total: ',
      slotsAcross: 'slots across',
      daysLabel: 'days',
      step5Title: 'Pre-Launch Checks & Deployment',
      checklistTitle: 'Checklist:',
      chkGoaliesAssigned: 'Goalies assigned',
      chkSkatersAssigned: 'Regular skaters assigned',
      chkGamesScheduled: 'Games scheduled',
      chkPricingActive: 'Pricing active',
      launchOfficialBtn: '🚀 OFFICIALLY LAUNCH SEASON',
      downloadBackupBtn: '📥 Download data.json backup',
      backToStep4: '⬅️ Back to Schedule',
      teamsStaying: 'Teams staying: ',
      weekLabel: 'Week',
      playoffsLabel: 'PLAYOFFS',
      adminKeyTitle: 'Admin Key',
      adminKeyPlaceholder: 'key',
      adminKeyBtn: 'UNLOCK',
      errEnterKey: 'Please enter key',
      errKeyRejected: 'Key rejected',
      errInvalidKey: 'Invalid key',
      quotaBannerText: (teams, skaters, goalies, totalGoalies, totalSkaters, totalPlayers) =>
        '🏒 For <b>' + teams + ' teams</b> with <b>' + skaters + ' skaters</b> and <b>' + goalies + ' goalie' + (goalies > 1 ? 's' : '') + '</b>: league requires in total <b>' + totalGoalies + ' goalies</b> and <b>' + totalSkaters + ' regular skaters</b> (' + totalPlayers + ' total players).',
      teamsCountDisplay: (n) => n + ' teams',
      paritySpreadText: (spread) => 'Max spread: ' + spread.toFixed(2) + ' pts/game between teams',
      ptsPerGame: 'pts/g',
      gpShort: 'GP'
    }
  };

  function t(k, ...args) {
    const dict = I18N[currentLang] || I18N.fr;
    const val = dict[k] != null ? dict[k] : (I18N.fr[k] != null ? I18N.fr[k] : k);
    if (typeof val === 'function') return val(...args);
    return val;
  }

  function getTeamLabel(tKey) {
    const pal = teamPalette[tKey];
    if (!pal) return '🏒 ' + tKey;
    if (currentLang === 'en' && pal.labelEn) return pal.labelEn;
    return pal.label || ('🏒 ' + tKey);
  }

  function applyLanguage(lang) {
    currentLang = (lang === 'en') ? 'en' : 'fr';
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const k = el.getAttribute('data-i18n');
      if (k) {
        const val = t(k);
        if (typeof val === 'string') {
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = val;
          else el.innerHTML = val;
        }
      }
    });

    document.querySelectorAll('[data-i18n-ph]').forEach(el => {
      const k = el.getAttribute('data-i18n-ph');
      if (k) {
        const val = t(k);
        if (typeof val === 'string') el.placeholder = val;
      }
    });

    if ($('filter-candidates')) {
      $('filter-candidates').placeholder = t('filterPlaceholder');
    }

    if (window.__updateAdminTabsLang) window.__updateAdminTabsLang(currentLang);

    renderTeamsTags();
    updateQuotaBanner();
    renderCandidatesTable();
    renderDraftBoard();
    if (generatedFixtures && generatedFixtures.length > 0) {
      renderScheduleFixtures(generatedFixtures);
    }
    renderDateSlotsUI();
    updateChecklist();
  }

  window.addEventListener('admin_lang_changed', (e) => {
    if (e.detail && e.detail.lang) {
      applyLanguage(e.detail.lang);
    }
  });

  let seasonData = null;
  let activeTeamsList = ['Red', 'Blue', 'White', 'Black'];
  let teamDetails = {
    Red: { name: 'Red', name_fr: 'Rouge', colour: '#c9152f', aliases: ['Red Wings'] },
    Blue: { name: 'Blue', name_fr: 'Bleu', colour: '#2a5fa8', aliases: ['Blues'] },
    White: { name: 'White', name_fr: 'Blanc', colour: '#ffffff', aliases: ['Capitals'] },
    Black: { name: 'Black', name_fr: 'Noir', colour: '#1c1f24', aliases: ['Bruins'] }
  };
  let availableDateSlots = [];
  let currentRosters = { Red: [], Blue: [], White: [], Black: [] };
  let currentGoalies = {};
  let pinnedPlayers = {};
  let tandemsList = [];
  let generatedFixtures = [];
  let generatedEvents = [];

  function getTeamsPayload() {
    return activeTeamsList.map(tKey => {
      const d = teamDetails[tKey] || {};
      const pal = teamPalette[tKey] || {};
      return {
        name: tKey,
        name_fr: d.name_fr || (pal.label ? pal.label.replace(/^[^\w\s]+\s*/, '') : tKey),
        colour: d.colour || pal.border || '#64748b',
        aliases: Array.isArray(d.aliases) ? d.aliases : []
      };
    });
  }

  async function api(p, opts = {}) {
    const r = await fetch(p, {
      ...opts,
      headers: {
        'x-admin': K,
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  function switchStep(stepNum) {
    for (let i = 1; i <= 5; i++) {
      const stepEl = $('step-' + i);
      const tabEl = $('tab-step-' + i);
      if (stepEl) stepEl.style.display = (i === stepNum) ? 'block' : 'none';
      if (tabEl) tabEl.className = 'step-btn' + (i === stepNum ? ' on' : '');
    }
  }

  function syncSeasonName(val) {
    if ($('sched-season-display')) $('sched-season-display').textContent = val;
    if ($('cur-season-name')) $('cur-season-name').textContent = val;
  }

  function updateQuotaBanner() {
    const banner = $('team-quota-banner');
    if (!banner) return;
    const n = activeTeamsList.length;
    const sPerTeam = parseInt($('param-skaters-per-team')?.value, 10) || 8;
    const gPerTeam = parseInt($('param-goalies-per-team')?.value, 10) || 1;
    const totalSkaters = n * sPerTeam;
    const totalGoalies = n * gPerTeam;
    const totalPlayers = totalSkaters + totalGoalies;
    banner.innerHTML = t('quotaBannerText', n, sPerTeam, gPerTeam, totalGoalies, totalSkaters, totalPlayers);
    if ($('sched-teams-count-display')) $('sched-teams-count-display').textContent = t('teamsCountDisplay', n);

    // Disable / block top 4 playoff formats when fewer than 4 teams
    const playoffSelect = $('sched-playoff-format');
    if (playoffSelect) {
      const top4Opts = playoffSelect.querySelectorAll('option[value^="top4"]');
      if (n < 4) {
        top4Opts.forEach(opt => { opt.disabled = true; });
        if (playoffSelect.value.startsWith('top4')) {
          playoffSelect.value = 'none';
        }
      } else {
        top4Opts.forEach(opt => { opt.disabled = false; });
      }
    }
  }

  function updateRosterSettings() {
    updateQuotaBanner();
    renderCandidatesTable();
    renderDraftBoard();
    updateChecklist();
    saveStructureConfig();
  }

  async function saveStructureConfig() {
    try {
      const sName = ($('sched-season-name')?.value || 'Hiver 2027').trim();
      const sPerTeam = parseInt($('param-skaters-per-team')?.value, 10) || 8;
      const gPerTeam = parseInt($('param-goalies-per-team')?.value, 10) || 1;
      const minSkaters = parseInt($('param-min-skaters')?.value, 10) || 5;
      const playoffFormat = $('sched-playoff-format')?.value || 'top4_single_day';
      const regularDues = parseFloat($('param-regular-dues')?.value) || 220;
      const subFee = parseFloat($('param-sub-fee')?.value) || 15;
      const maxAssistsPerGoal = parseInt($('param-max-assists-per-goal')?.value, 10) || 1;
      await api('/admin/season/config', {
        method: 'POST',
        body: JSON.stringify({
          seasonName: sName,
          teams: getTeamsPayload(),
          skatersPerTeam: sPerTeam,
          goaliesPerTeam: gPerTeam,
          minSkaters,
          playoffFormat,
          fees: { regularDues, subFee },
          rules: { maxAssistsPerGoal }
        })
      });
    } catch (e) {
      console.warn('Could not auto-save season config:', e);
    }
  }

  async function loadSeasonHub() {
    try {
      seasonData = await api('/admin/season/data');
      if ($('cur-season-name')) $('cur-season-name').textContent = seasonData.currentSeason;
      if ($('sched-season-name')) $('sched-season-name').value = 'Hiver 2027';
      if ($('sched-season-display')) $('sched-season-display').textContent = 'Hiver 2027';
      if ($('param-skaters-per-team')) $('param-skaters-per-team').value = seasonData?.skatersPerTeam || 8;
      if ($('param-goalies-per-team')) $('param-goalies-per-team').value = seasonData?.goaliesPerTeam || 1;
      if ($('param-min-skaters')) $('param-min-skaters').value = seasonData?.minSkaters || 5;
      if ($('sched-playoff-format')) $('sched-playoff-format').value = seasonData?.playoffFormat || 'top4_single_day';
      if ($('param-regular-dues')) $('param-regular-dues').value = seasonData?.fees?.regularDues || 220;
      if ($('param-sub-fee')) $('param-sub-fee').value = seasonData?.fees?.subFee || 15;
      if ($('param-max-assists-per-goal')) $('param-max-assists-per-goal').value = String(seasonData?.maxAssistsPerGoal || 1);
      
      // Populate defaults
      pinnedPlayers = seasonData.draftConfig?.pinned || {};
      tandemsList = seasonData.draftConfig?.tandems || [];
      if (seasonData.draftConfig?.teams && Array.isArray(seasonData.draftConfig.teams) && seasonData.draftConfig.teams.length > 0) {
        activeTeamsList = seasonData.draftConfig.teams.map(t => {
          if (typeof t === 'object' && t !== null && t.name) {
            teamDetails[t.name] = {
              name: t.name,
              name_fr: t.name_fr || t.name,
              colour: t.colour || '#64748b',
              aliases: Array.isArray(t.aliases) ? t.aliases : []
            };
            return t.name;
          }
          return String(t);
        });
      }
      for (const t of activeTeamsList) {
        if (!teamPalette[t]) {
          const c = teamDetails[t]?.colour || '#64748b';
          teamPalette[t] = { label: '🏒 ' + t, labelEn: '🏒 ' + t, bg: '#f1f5f9', border: c, color: 'var(--ink)' };
        }
      }
      if (seasonData.draftConfig?.rosters) {
        currentRosters = seasonData.draftConfig.rosters;
        currentGoalies = seasonData.draftConfig.goalies || {};
      }

      initDefaultScheduleSlots();
      renderTeamsTags();
      updateQuotaBanner();
      renderCandidatesTable();
      renderDraftBoard();
      updateChecklist();
    } catch (e) {
      console.error('Failed loading Season Hub data:', e);
    }
  }

  function renderTeamsTags() {
    const container = $('teams-list-tags');
    if (!container) return;
    container.innerHTML = activeTeamsList.map(tKey => {
      const canRemove = activeTeamsList.length > 2;
      const pal = teamPalette[tKey] || { label: '🏒 ' + tKey, labelEn: '🏒 ' + tKey, bg: '#f1f5f9', border: 'var(--rule2)', color: 'var(--ink)' };
      const displayLabel = getTeamLabel(tKey);
      const d = teamDetails[tKey] || {};
      const c = d.colour || pal.border || '#64748b';
      const aliasBadge = (d.aliases && d.aliases.length > 0) ? (' <span style="font-size:10px; opacity:0.75; font-weight:normal;">[' + esc(d.aliases.join(', ')) + ']</span>') : '';
      return '<span style="display:inline-flex; align-items:center; gap:6px; background:' + pal.bg + '; border:2px solid ' + c + '; color:' + pal.color + '; padding:6px 12px; border-radius:16px; font-size:13px; font-weight:700;">' +
        '<span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:' + c + '; border:1px solid rgba(0,0,0,0.25);"></span>' +
        '<span role="button" title="' + (currentLang === 'en' ? 'Click to edit team' : 'Modifier l\\'équipe') + '" data-team="' + esc(tKey) + '" onclick="editTeamPrompt(this.dataset.team)" style="cursor:pointer; display:inline-flex; align-items:center; gap:5px;">' +
          esc(displayLabel) + aliasBadge +
          '<span style="font-size:11px; opacity:0.65;">✏️</span>' +
        '</span>' +
        (canRemove ? '<button type="button" data-team="' + esc(tKey) + '" onclick="removeTeamTag(this.dataset.team)" style="background:none; border:none; cursor:pointer; color:' + pal.color + '; font-size:16px; padding:0 2px; line-height:1; opacity:0.7;" title="' + (currentLang === 'en' ? 'Remove' : 'Retirer') + '">&times;</button>' : '') +
      '</span>';
    }).join('') +
    '<button type="button" onclick="addTeamTagPrompt()" style="background:#fff; border:1px dashed var(--rule2); padding:6px 12px; border-radius:16px; font-size:13px; font-weight:700; cursor:pointer; color:var(--soft);">' + t('addTeamBtn') + '</button>';
    updateQuotaBanner();
  }

  function editTeamPrompt(oldName) {
    const cur = teamDetails[oldName] || { name: oldName, name_fr: oldName, colour: '#64748b', aliases: [] };
    const promptNameMsg = currentLang === 'en' ? "Team key/name:" : "Nom / Clé de l'équipe :";
    const newName = prompt(promptNameMsg, cur.name || oldName);
    if (!newName || !newName.trim()) return;
    const cleanName = newName.trim();

    const promptFrMsg = currentLang === 'en' ? "French display name (or blank to match):" : "Nom francophone affiché :";
    const newFr = prompt(promptFrMsg, cur.name_fr || cleanName);

    const promptColourMsg = currentLang === 'en'
      ? "Hex colour or palette name (e.g. #c9152f, Red, Blue, Green, Gold, Purple):"
      : "Couleur hex ou nom de palette (ex: #c9152f, Red, Blue, Green, Gold, Purple) :";
    const newColour = prompt(promptColourMsg, cur.colour || '#64748b');

    const promptAliasesMsg = currentLang === 'en'
      ? "Aliases / alternative names (comma-separated, e.g. Red Wings, Rouges):"
      : "Alias / noms alternatifs (séparés par des virgules, ex: Red Wings, Rouges) :";
    const curAliasesStr = (cur.aliases || []).join(', ');
    const newAliases = prompt(promptAliasesMsg, curAliasesStr);

    let resolvedColour = (newColour || '#64748b').trim();
    if (teamPalette[resolvedColour] && teamPalette[resolvedColour].border) {
      resolvedColour = teamPalette[resolvedColour].border;
    }

    const aliasesArr = (newAliases || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (cleanName !== oldName) {
      renameTeam(oldName, cleanName);
    }

    teamDetails[cleanName] = {
      name: cleanName,
      name_fr: (newFr || cleanName).trim(),
      colour: resolvedColour,
      aliases: aliasesArr
    };

    if (teamPalette[cleanName]) {
      teamPalette[cleanName].border = resolvedColour;
    }

    renderTeamsTags();
    saveStructureConfig();
  }

  function renameTeam(oldName, newName) {
    if (!newName || !newName.trim()) return;
    const clean = newName.trim();
    if (clean === oldName) return;
    if (activeTeamsList.includes(clean)) {
      alert(currentLang === 'en' ? ('A team named "' + clean + '" already exists.') : ('Une équipe nommée « ' + clean + ' » existe déjà.'));
      return;
    }

    const idx = activeTeamsList.indexOf(oldName);
    if (idx !== -1) {
      activeTeamsList[idx] = clean;
    } else {
      activeTeamsList.push(clean);
    }

    // Transfer details
    if (teamDetails[oldName]) {
      teamDetails[clean] = { ...teamDetails[oldName], name: clean };
      delete teamDetails[oldName];
    }

    // Transfer rosters
    if (currentRosters[oldName]) {
      currentRosters[clean] = currentRosters[oldName];
      delete currentRosters[oldName];
    } else if (!currentRosters[clean]) {
      currentRosters[clean] = [];
    }

    // Transfer goalie
    if (currentGoalies[oldName]) {
      currentGoalies[clean] = currentGoalies[oldName];
      delete currentGoalies[oldName];
    }

    // Transfer pinned players
    for (const [pId, team] of Object.entries(pinnedPlayers)) {
      if (team === oldName) pinnedPlayers[pId] = clean;
    }

    // Transfer palette style if exists
    if (teamPalette[oldName] && !teamPalette[clean]) {
      const oldPal = teamPalette[oldName];
      let prefix = '🏒 ';
      if (oldPal.label) {
        const parts = oldPal.label.split(' ');
        if (parts.length > 1 && /^[^\w\s]/.test(parts[0])) {
          prefix = parts[0] + ' ';
        }
      }
      teamPalette[clean] = {
        ...oldPal,
        label: prefix + clean,
        labelEn: prefix + clean
      };
    }

    renderTeamsTags();
    updateQuotaBanner();
    renderCandidatesTable();
    renderDraftBoard();
    updateChecklist();
    saveStructureConfig();
  }

  function addTeamTagPrompt() {
    const promptMsg = currentLang === 'en' ? "Name of new team (e.g. Green, Gold, Orange, Grey, Hawks):" : "Nom de la nouvelle équipe (ex: Green, Gold, Orange, Grey, Hawks) :";
    const name = prompt(promptMsg);
    if (name && name.trim()) {
      const clean = name.trim();
      if (!activeTeamsList.includes(clean)) {
        activeTeamsList.push(clean);
        if (!currentRosters[clean]) currentRosters[clean] = [];
        const pal = teamPalette[clean];
        teamDetails[clean] = {
          name: clean,
          name_fr: clean,
          colour: pal ? pal.border : '#64748b',
          aliases: []
        };
        renderTeamsTags();
        updateQuotaBanner();
        renderCandidatesTable();
        renderDraftBoard();
        updateChecklist();
        saveStructureConfig();
      }
    }
  }

  function removeTeamTag(teamName) {
    if (activeTeamsList.length <= 2) {
      alert(currentLang === 'en' ? "There must be at least 2 teams in the league." : "Il faut au minimum 2 équipes dans la ligue.");
      return;
    }
    activeTeamsList = activeTeamsList.filter(t => t !== teamName);
    delete currentRosters[teamName];
    delete currentGoalies[teamName];
    delete teamDetails[teamName];
    renderTeamsTags();
    updateQuotaBanner();
    renderCandidatesTable();
    renderDraftBoard();
    updateChecklist();
    saveStructureConfig();
  }

  function initDefaultScheduleSlots() {
    const d = new Date();
    const daysUntilSunday = (7 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + daysUntilSunday);
    const startIso = d.toISOString().slice(0, 10);
    const startInput = $('clone-start-date');
    if (startInput) startInput.value = startIso;

    if (availableDateSlots.length === 0) {
      applyCloneSchedulePattern();
    } else {
      renderDateSlotsUI();
    }
  }

  function applyCloneSchedulePattern() {
    const preset = $('clone-preset')?.value || 'smbhl_doubleheader';
    const startDateVal = $('clone-start-date')?.value || new Date().toISOString().slice(0, 10);
    const weeksCount = parseInt($('clone-weeks-count')?.value, 10) || 14;

    const parts = startDateVal.split('-').map(Number);
    const cursor = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));

    availableDateSlots = [];

    for (let w = 0; w < weeksCount; w++) {
      if (preset === 'weekend_sat_sun') {
        const sat = new Date(cursor.getTime());
        const satDateStr = sat.toISOString().slice(0, 10);
        const sun = new Date(cursor.getTime());
        sun.setUTCDate(sun.getUTCDate() + 1);
        const sunDateStr = sun.toISOString().slice(0, 10);

        availableDateSlots.push({
          date: satDateStr,
          venue: 'Letendre',
          slots: [
            { time: '19:00', gym: 'Gym #1' },
            { time: '20:00', gym: 'Gym #1' }
          ]
        });
        availableDateSlots.push({
          date: sunDateStr,
          venue: 'Letendre',
          slots: [
            { time: '10:30 AM', gym: 'Gym #1' },
            { time: '11:30 AM', gym: 'Gym #1' }
          ]
        });
        cursor.setUTCDate(cursor.getUTCDate() + 7);
      } else if (preset === 'single_gym') {
        const dateStr = cursor.toISOString().slice(0, 10);
        availableDateSlots.push({
          date: dateStr,
          venue: 'Letendre',
          slots: [
            { time: '10:30 AM', gym: 'Gym #1' },
            { time: '11:30 AM', gym: 'Gym #1' },
            { time: '12:30 PM', gym: 'Gym #1' },
            { time: '13:30 PM', gym: 'Gym #1' }
          ]
        });
        cursor.setUTCDate(cursor.getUTCDate() + 7);
      } else {
        // smbhl_doubleheader
        const dateStr = cursor.toISOString().slice(0, 10);
        availableDateSlots.push({
          date: dateStr,
          venue: 'Letendre',
          slots: [
            { time: '10:30 AM', gym: 'Gym #1' },
            { time: '10:30 AM', gym: 'Gym #2' },
            { time: '11:30 AM', gym: 'Gym #1' },
            { time: '11:30 AM', gym: 'Gym #2' }
          ]
        });
        cursor.setUTCDate(cursor.getUTCDate() + 7);
      }
    }

    renderDateSlotsUI();
  }

  function renderDateSlotsUI() {
    const container = $('slots-dates-container');
    if (!container) return;

    let totalSlots = 0;
    availableDateSlots.forEach(d => { totalSlots += (d.slots || []).length; });
    if ($('slots-totals-summary')) {
      $('slots-totals-summary').innerHTML = currentLang === 'en'
        ? ('Total: <b id="total-slots-count">' + totalSlots + '</b> ' + t('slotsAcross') + ' <b id="total-dates-count">' + availableDateSlots.length + '</b> ' + t('daysLabel'))
        : ('Total : <b id="total-slots-count">' + totalSlots + '</b> ' + t('slotsAcross') + ' <b id="total-dates-count">' + availableDateSlots.length + '</b> ' + t('daysLabel'));
    } else {
      if ($('total-slots-count')) $('total-slots-count').textContent = totalSlots;
      if ($('total-dates-count')) $('total-dates-count').textContent = availableDateSlots.length;
    }

    if (availableDateSlots.length === 0) {
      container.innerHTML = '<div style="padding:20px; text-align:center; color:var(--soft);">' + t('noDatesMsg') + '</div>';
      return;
    }

    const localeStr = currentLang === 'en' ? 'en-CA' : 'fr-CA';
    container.innerHTML = availableDateSlots.map((entry, dIdx) => {
      const dateParts = entry.date.split('-');
      const dObj = new Date(Date.UTC(+dateParts[0], +dateParts[1] - 1, +dateParts[2], 12, 0, 0));
      const humanStr = dObj.toLocaleDateString(localeStr, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

      const slotsHtml = (entry.slots || []).map((s, sIdx) => {
        return '<span style="display:inline-flex; align-items:center; gap:6px; background:#fff; border:1px solid var(--rule2); padding:3px 8px; border-radius:4px; font-size:12px;">' +
          '<b>' + esc(s.time) + '</b> <span style="color:var(--soft); font-size:11px;">(' + esc(s.gym) + ')</span>' +
          '<button type="button" onclick="removeSlotFromDate(' + dIdx + ', ' + sIdx + ')" title="' + (currentLang === 'en' ? 'Delete slot' : 'Supprimer ce créneau') + '" style="background:none; border:none; color:#dc2626; cursor:pointer; font-weight:700; padding:0 2px; line-height:1;">&times;</button>' +
        '</span>';
      }).join('');

      return '<div style="background:#fff; border:1px solid var(--rule); border-radius:4px; padding:10px 14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">' +
        '<div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">' +
          '<div style="font-weight:700; font-size:15px; min-width:170px;">📅 ' + humanStr + ' <span style="font-size:12px; color:var(--soft); font-weight:normal;">(' + entry.date + ')</span></div>' +
          '<div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">' +
            slotsHtml +
            '<button type="button" onclick="addSlotPrompt(' + dIdx + ')" style="background:#f1f5f9; border:1px dashed var(--rule2); padding:3px 8px; border-radius:4px; font-size:12px; cursor:pointer; font-weight:600;">' + t('addSlotBtn') + '</button>' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<button type="button" onclick="removeDateItem(' + dIdx + ')" style="background:#fff1f2; border:1px solid #fecdd3; color:#be123c; padding:4px 10px; border-radius:3px; font-size:12px; font-weight:700; cursor:pointer;" title="' + (currentLang === 'en' ? 'Remove date' : 'Retirer cette date') + '">' + t('removeDateBtn') + '</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function removeDateItem(dIdx) {
    availableDateSlots.splice(dIdx, 1);
    renderDateSlotsUI();
  }

  function removeSlotFromDate(dIdx, sIdx) {
    if (availableDateSlots[dIdx] && availableDateSlots[dIdx].slots) {
      availableDateSlots[dIdx].slots.splice(sIdx, 1);
      renderDateSlotsUI();
    }
  }

  function addSlotPrompt(dIdx) {
    const timePrompt = currentLang === 'en' ? "Game time (e.g. 10:30 AM, 12:30 PM, 19:00):" : "Heure du match (ex: 10:30 AM, 12:30 PM, 19:00) :";
    const time = prompt(timePrompt, "12:30 PM");
    if (!time) return;
    const gymPrompt = currentLang === 'en' ? "Gym or rink name (e.g. Gym #1, Gym #2, Court A):" : "Nom du gymnase ou terrain (ex: Gym #1, Gym #2, Terrain A) :";
    const gym = prompt(gymPrompt, "Gym #1");
    if (!gym) return;
    if (availableDateSlots[dIdx]) {
      availableDateSlots[dIdx].slots = availableDateSlots[dIdx].slots || [];
      availableDateSlots[dIdx].slots.push({ time: time.trim(), gym: gym.trim() });
      renderDateSlotsUI();
    }
  }

  function addCustomDatePrompt() {
    const datePrompt = currentLang === 'en' ? "Date in YYYY-MM-DD format (e.g. 2027-02-14):" : "Date au format AAAA-MM-JJ (ex: 2027-02-14) :";
    const dateStr = prompt(datePrompt);
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) {
      if (dateStr) alert(currentLang === 'en' ? "Invalid format. Use YYYY-MM-DD." : "Format invalide. Utilisez AAAA-MM-JJ.");
      return;
    }
    const cleanDate = dateStr.trim();
    if (availableDateSlots.some(d => d.date === cleanDate)) {
      alert(currentLang === 'en' ? "This date already exists in the list." : "Cette date existe déjà dans la liste.");
      return;
    }
    availableDateSlots.push({
      date: cleanDate,
      venue: 'Letendre',
      slots: [
        { time: '10:30 AM', gym: 'Gym #1' },
        { time: '10:30 AM', gym: 'Gym #2' },
        { time: '11:30 AM', gym: 'Gym #1' },
        { time: '11:30 AM', gym: 'Gym #2' }
      ]
    });
    availableDateSlots.sort((a, b) => a.date.localeCompare(b.date));
    renderDateSlotsUI();
  }

  function renderCandidatesTable() {
    if (!seasonData || !seasonData.candidates) return;
    const filter = ($('filter-candidates')?.value || '').toLowerCase();
    const list = seasonData.candidates.filter(c => c.name.toLowerCase().includes(filter));

    let regCount = 0;
    let goalieCount = 0;
    let subCount = 0;
    let optCount = 0;

    for (const c of seasonData.candidates) {
      if (c.status === 'confirmed_regular') {
        if (c.isGoalie) goalieCount++;
        else regCount++;
      } else if (c.status === 'confirmed_sub') {
        subCount++;
      } else if (c.status === 'opted_out') {
        optCount++;
      }
    }

    const sPerTeam = parseInt($('param-skaters-per-team')?.value, 10) || 7;
    const gPerTeam = parseInt($('param-goalies-per-team')?.value, 10) || 1;
    const targetSkaters = activeTeamsList.length * sPerTeam;
    const targetGoalies = activeTeamsList.length * gPerTeam;

    if ($('kpi-regular-count')) $('kpi-regular-count').textContent = regCount + ' / ' + targetSkaters;
    if ($('kpi-goalie-count')) $('kpi-goalie-count').textContent = goalieCount + ' / ' + targetGoalies;
    if ($('kpi-sub-count')) $('kpi-sub-count').textContent = subCount;
    if ($('kpi-optout-count')) $('kpi-optout-count').textContent = optCount;

    const tbody = $('candidates-tbody');
    if (!tbody) return;
    tbody.innerHTML = list.map(c => {
      const posClass = c.isGoalie ? 'pos-g' : (c.pos === 'D' ? 'pos-d' : 'pos-f');
      const posLabel = c.isGoalie ? 'G' : (c.pos === 'D' ? 'D' : 'F');
      const tierBadge = !c.isGoalie && c.tier ? '<span class="tier-badge tier-' + c.tier + '">T' + c.tier + '</span>' : '';

      return '<tr>' +
        '<td><b>' + esc(c.name) + '</b> ' + tierBadge + '</td>' +
        '<td><span class="pos-tag ' + posClass + '">' + posLabel + '</span></td>' +
        '<td><b>' + (c.weightedPpg || c.carPpg || 1.0).toFixed(1) + '</b> ' + t('ptsPerGame') + ' (' + (c.carGp || 0) + ' ' + t('gpShort') + ')</td>' +
        '<td>' + Math.round((c.reliability || 1.0) * 100) + '%</td>' +
        '<td>' +
          '<select data-id="' + c.id + '" onchange="updateCandidateStatus(this.dataset.id, this.value)" style="font:inherit; font-size:13px; padding:4px 8px; border-radius:3px; border:1px solid var(--rule2);">' +
            '<option value="confirmed_regular"' + (c.status === 'confirmed_regular' ? ' selected' : '') + '>' + t('statusRegular') + '</option>' +
            '<option value="confirmed_sub"' + (c.status === 'confirmed_sub' ? ' selected' : '') + '>' + t('statusSub') + '</option>' +
            '<option value="opted_out"' + (c.status === 'opted_out' ? ' selected' : '') + '>' + t('statusOptout') + '</option>' +
            '<option value="invited_pending"' + (c.status === 'invited_pending' ? ' selected' : '') + '>' + t('statusPending') + '</option>' +
          '</select>' +
        '</td>' +
        '<td>' +
          (c.status !== 'confirmed_regular' ? '<button class="status-chip active-regular" data-id="' + c.id + '" onclick="updateCandidateStatus(this.dataset.id, &quot;confirmed_regular&quot;)">' + t('promoteBtn') + '</button>' : '') +
        '</td>' +
      '</tr>';
    }).join('');
  }

  async function updateCandidateStatus(playerId, status) {
    try {
      await api('/admin/season/rollcall', {
        method: 'POST',
        body: JSON.stringify({ action: 'update_status', playerId, status })
      });
      const c = seasonData.candidates.find(x => x.id === playerId);
      if (c) c.status = status;
      renderCandidatesTable();
      updateChecklist();
    } catch (e) {
      alert((currentLang === 'en' ? "Error updating: " : "Erreur lors de la mise à jour : ") + e.message);
    }
  }

  function renderDraftBoard() {
    const container = $('draft-columns');
    if (!container) return;
    const colors = activeTeamsList;

    const sPerTeam = parseInt($('param-skaters-per-team')?.value, 10) || 7;

    container.innerHTML = colors.map(team => {
      const skaters = currentRosters[team] || [];
      const goalie = currentGoalies[team];
      const pal = teamPalette[team] || { label: '🏒 ' + team, border: '#64748b' };
      const teamLabel = getTeamLabel(team);
      const borderColor = pal.border || '#64748b';
      
      let sumEvm = 0;
      let dCount = 0;
      let fCount = 0;
      skaters.forEach(s => {
        sumEvm += (s.evm || 1.0);
        if (s.pos === 'D') dCount++;
        else fCount++;
      });

      return '<div class="team-col ' + team.toLowerCase() + '" style="border-top:6px solid ' + borderColor + ';">' +
        '<div class="team-col-header">' +
          '<div class="team-col-title">' +
            '<span>' + esc(teamLabel) + '</span>' +
            '<span style="font-size:18px;">' + sumEvm.toFixed(1) + ' EVM</span>' +
          '</div>' +
          '<div class="team-kpis">' +
            '<span>' + skaters.length + '/' + sPerTeam + ' ' + t('skatersCountLabel') + '</span>' +
            '<span>' + dCount + ' ' + t('defensemenCountLabel') + '</span>' +
            '<span>' + fCount + ' ' + t('forwardsCountLabel') + '</span>' +
          '</div>' +
        '</div>' +
        '<div style="flex:1; padding:4px;">' +
          (goalie ? 
            '<div class="player-card goalie-card">' +
              '<div>' +
                '<b>🧤 ' + esc(goalie.name) + '</b>' +
                '<div style="font-size:12px; color:var(--soft);">GAA: ' + (goalie.gaa || 5.0) + '</div>' +
              '</div>' +
              '<span class="pos-tag pos-g">G</span>' +
            '</div>' : 
            '<div style="padding:10px; font-size:13px; color:var(--soft); text-align:center;">' + t('noGoalieAssigned') + '</div>'
          ) +
          skaters.map(s => {
            const isPinned = !!pinnedPlayers[s.playerId];
            return '<div class="player-card' + (isPinned ? ' pinned' : '') + '">' +
              '<div>' +
                '<b>' + esc(s.name) + '</b> <span class="tier-badge tier-' + (s.tier || 3) + '">T' + (s.tier || 3) + '</span>' +
                '<div style="font-size:12px; color:var(--soft);">' + (s.weightedPpg || s.carPpg || 1.0).toFixed(1) + ' ' + t('ptsPerGame') + ' · ' + s.pos + '</div>' +
              '</div>' +
              '<div style="display:flex; align-items:center; gap:4px;">' +
                '<button class="act-icon" title="' + t('lockTooltip') + '" data-id="' + s.playerId + '" data-team="' + team + '" onclick="togglePin(this.dataset.id, this.dataset.team)">' + (isPinned ? '📌' : '📍') + '</button>' +
                '<select data-id="' + s.playerId + '" data-team="' + team + '" onchange="movePlayerManually(this.dataset.id, this.dataset.team, this.value)" style="font-size:11px; padding:2px; border:1px solid var(--rule2); border-radius:2px;">' +
                  '<option value="">⇄</option>' +
                  colors.filter(c => c !== team).map(c => '<option value="' + c + '">' + esc(getTeamLabel(c)) + '</option>').join('') +
                '</select>' +
              '</div>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>';
    }).join('');

    updateParityMetrics();
  }

  function updateParityMetrics() {
    const totals = [];
    for (const team of activeTeamsList) {
      const skaters = currentRosters[team] || [];
      const sum = skaters.reduce((a, b) => a + (b.evm || 1.0), 0);
      totals.push(sum);
    }
    if (totals.length === 0) return;
    const spread = Math.max(...totals) - Math.min(...totals);
    const parityScore = Math.max(75, Math.round(100 - (spread * 12)));
    if ($('parity-score-val')) $('parity-score-val').textContent = parityScore + '%';
    if ($('parity-detail-text')) $('parity-detail-text').textContent = t('paritySpreadText', spread);
  }

  function togglePin(playerId, team) {
    if (pinnedPlayers[playerId]) delete pinnedPlayers[playerId];
    else pinnedPlayers[playerId] = team;
    renderDraftBoard();
  }

  async function movePlayerManually(playerId, fromTeam, toTeam) {
    if (!toTeam) return;
    const pIdx = (currentRosters[fromTeam] || []).findIndex(x => x.playerId === playerId);
    if (pIdx === -1) return;
    const player = currentRosters[fromTeam].splice(pIdx, 1)[0];
    if (!currentRosters[toTeam]) currentRosters[toTeam] = [];
    currentRosters[toTeam].push(player);
    renderDraftBoard();

    // Check for counter-swap recommendation
    try {
      const res = await api('/admin/season/suggest-swap', {
        method: 'POST',
        body: JSON.stringify({
          currentRosters,
          teamA: toTeam,
          teamB: fromTeam,
          pinned: pinnedPlayers,
          goalies: currentGoalies
        })
      });
      if (res.swap && res.swap.spreadImprovement > 0.3) {
        if ($('alert-swap-text')) {
          $('alert-swap-text').textContent = currentLang === 'en'
            ? ('Swapping ' + res.swap.fromA.name + ' (' + toTeam + ') with ' + res.swap.fromB.name + ' (' + fromTeam + ') would restore a spread of ' + res.swap.newSpread.toFixed(2) + ' pts/g.')
            : ('Échanger ' + res.swap.fromA.name + ' (' + toTeam + ') avec ' + res.swap.fromB.name + ' (' + fromTeam + ') rétablirait un écart de ' + res.swap.newSpread.toFixed(2) + ' pts/m.');
        }
        if ($('btn-apply-counter-swap')) $('btn-apply-counter-swap').onclick = () => applySuggestedSwap(res.swap, toTeam, fromTeam);
        if ($('parity-alert')) $('parity-alert').style.display = 'block';
      } else {
        if ($('parity-alert')) $('parity-alert').style.display = 'none';
      }
    } catch (e) {}
  }

  function applySuggestedSwap(swap, teamA, teamB) {
    const idxA = (currentRosters[teamA] || []).findIndex(x => x.playerId === swap.fromA.id);
    const idxB = (currentRosters[teamB] || []).findIndex(x => x.playerId === swap.fromB.id);
    if (idxA !== -1 && idxB !== -1) {
      const pA = currentRosters[teamA][idxA];
      const pB = currentRosters[teamB][idxB];
      currentRosters[teamA][idxA] = pB;
      currentRosters[teamB][idxB] = pA;
      if ($('parity-alert')) $('parity-alert').style.display = 'none';
      renderDraftBoard();
    }
  }

  async function runAutoDraft() {
    try {
      const regularSkaters = (seasonData?.candidates || []).filter(c => c.status === 'confirmed_regular');
      const candidateIds = regularSkaters.map(c => c.id);
      const sPerTeam = parseInt($('param-skaters-per-team')?.value, 10) || 7;
      const gPerTeam = parseInt($('param-goalies-per-team')?.value, 10) || 1;

      const res = await api('/admin/season/autodraft', {
        method: 'POST',
        body: JSON.stringify({
          candidateIds,
          pinned: pinnedPlayers,
          tandems: tandemsList,
          teams: activeTeamsList,
          skatersPerTeam: sPerTeam,
          goaliesPerTeam: gPerTeam
        })
      });

      if (res.ok) {
        currentRosters = res.rosters;
        currentGoalies = res.goalies;
        renderDraftBoard();
        updateChecklist();
        alert(currentLang === 'en'
          ? ("✨ Balanced rosters generated successfully! Parity: " + res.parityScore + "%")
          : ("✨ Alignements équilibrés générés avec succès ! Parité : " + res.parityScore + "%"));
      }
    } catch (e) {
      alert((currentLang === 'en' ? "Error during draft: " : "Erreur lors du repêchage : ") + e.message);
    }
  }

  function runRebalanceFree() {
    runAutoDraft();
  }

  async function generateSchedulePreview() {
    const seasonName = ($('sched-season-name')?.value || 'Hiver 2027').trim();
    const playoffFormat = $('sched-playoff-format')?.value || 'top4_single_day';

    if (availableDateSlots.length === 0) {
      alert(currentLang === 'en' ? "Please configure at least one game date." : "Veuillez configurer au moins une date de match.");
      return;
    }

    try {
      const res = await api('/admin/season/schedule', {
        method: 'POST',
        body: JSON.stringify({
          seasonName,
          customSlots: availableDateSlots,
          teams: activeTeamsList,
          playoffFormat
        })
      });

      if (res.ok) {
        generatedFixtures = res.fixtures;
        generatedEvents = res.events;
        renderScheduleFixtures(res.fixtures);
        updateChecklist();
      }
    } catch (e) {
      alert((currentLang === 'en' ? "Error generating schedule: " : "Erreur génération calendrier : ") + e.message);
    }
  }

  function renderScheduleFixtures(fixtures) {
    const container = $('sched-fixtures-container');
    if (!container) return;
    const byWeek = {};
    for (const f of fixtures) {
      if (!byWeek[f.week]) byWeek[f.week] = [];
      byWeek[f.week].push(f);
    }

    container.innerHTML = Object.keys(byWeek).map(w => {
      const games = byWeek[w];
      const isPlayoffWeek = games.some(g => g.is_playoff);
      const weekTitle = isPlayoffWeek 
        ? '🏆 ' + t('weekLabel') + ' ' + w + ' · ' + t('playoffsLabel') + ' (' + games[0].date + ')' 
        : t('weekLabel') + ' ' + w + ' · ' + games[0].date;
      const borderStyle = isPlayoffWeek 
        ? 'border:2px solid #f59e0b; background:#fffdf5;' 
        : 'border:1px solid var(--rule); background:#fbfcfe;';
      const titleColor = isPlayoffWeek ? 'color:#92400e;' : 'color:var(--ink);';

      const stayingText = games[0].stays ? (t('teamsStaying') + (games[0].stays || []).join(', ')) : '';

      return '<div style="margin-bottom:18px; border-radius:6px; padding:14px; ' + borderStyle + '">' +
        '<div style="font-weight:700; font-size:16px; margin-bottom:10px; display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px;' + titleColor + '">' +
          '<span>' + weekTitle + '</span>' +
          (stayingText ? '<span style="font-size:12px; color:var(--soft); font-weight:normal;">' + stayingText + '</span>' : '') +
        '</div>' +
        '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:10px;">' +
          games.map(g => {
            const cardBorder = g.playoff_round === 'final' ? 'border:2px solid #f59e0b;' : 'border:1px solid var(--rule);';
            const noteText = currentLang === 'en' ? (g.note_en || g.note_fr) : (g.note_fr || g.note_en);
            return '<div class="fixture-card" style="' + cardBorder + ' background:#fff; flex-direction:column; align-items:flex-start; gap:4px;">' +
              '<div style="display:flex; justify-content:space-between; width:100%; font-size:12px; color:var(--soft);">' +
                '<span><b>' + esc(g.time) + '</b> (' + esc(g.gym) + ')</span>' +
                (noteText ? '<span style="font-weight:700; color:#b45309;">' + esc(noteText) + '</span>' : '') +
              '</div>' +
              '<div style="font-size:15px; font-weight:700; margin-top:2px;">' +
                esc(g.home) + ' <span style="font-weight:normal; color:var(--soft);">vs</span> ' + esc(g.away) +
              '</div>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>';
    }).join('');
  }

  function updateChecklist() {
    let gCount = 0;
    let sCount = 0;
    for (const t of activeTeamsList) {
      if (currentGoalies[t]) gCount++;
      sCount += (currentRosters[t] || []).length;
    }

    const sPerTeam = parseInt($('param-skaters-per-team')?.value, 10) || 7;
    const gPerTeam = parseInt($('param-goalies-per-team')?.value, 10) || 1;
    const targetGoalies = activeTeamsList.length * gPerTeam;
    const targetSkaters = activeTeamsList.length * sPerTeam;

    if ($('chk-goalies')) $('chk-goalies').innerHTML = (gCount >= targetGoalies ? '✅ ' : '⏳ ') + gCount + '/' + targetGoalies + ' ' + t('chkGoaliesAssigned');
    if ($('chk-skaters')) $('chk-skaters').innerHTML = (sCount >= targetSkaters ? '✅ ' : '⏳ ') + sCount + '/' + targetSkaters + ' ' + t('chkSkatersAssigned');
    if ($('chk-sched')) $('chk-sched').innerHTML = (generatedFixtures.length > 0 ? '✅ ' : '⏳ ') + generatedFixtures.length + ' ' + t('chkGamesScheduled');
    if ($('chk-pricing')) $('chk-pricing').innerHTML = '✅ ' + t('chkPricingActive');
  }

  async function executeSeasonLaunch() {
    const seasonName = ($('sched-season-name')?.value || 'Hiver 2027').trim();
    const startDate = availableDateSlots[0]?.date || new Date().toISOString().slice(0, 10);

    const confirmMsg = currentLang === 'en'
      ? ("Are you sure you want to officially launch the season " + seasonName + " ?\\n\\nThis will sync D1 and data.json, assign official rosters, and enable RSVPs.")
      : ("Êtes-vous certain de vouloir lancer officiellement la saison " + seasonName + " ?\\n\\nCette action va synchroniser D1 et data.json, assigner les effectifs officiels et activer les présences.");

    if (!confirm(confirmMsg)) return;

    if ($('btn-launch-season')) $('btn-launch-season').disabled = true;
    if ($('launch-result-msg')) $('launch-result-msg').textContent = currentLang === 'en' ? "Publishing..." : "Publication en cours...";

    try {
      const sPerTeam = parseInt($('param-skaters-per-team')?.value, 10) || 8;
      const gPerTeam = parseInt($('param-goalies-per-team')?.value, 10) || 1;
      const minSkaters = parseInt($('param-min-skaters')?.value, 10) || 5;
      const playoffFormat = $('sched-playoff-format')?.value || 'top4_single_day';
      const regularDues = parseFloat($('param-regular-dues')?.value) || seasonData?.fees?.regularDues || 220;
      const subFee = parseFloat($('param-sub-fee')?.value) || seasonData?.fees?.subFee || 15;

      const res = await api('/admin/season/launch', {
        method: 'POST',
        body: JSON.stringify({
          seasonName,
          startDate,
          rosters: currentRosters,
          fixtures: generatedFixtures,
          events: generatedEvents,
          fees: { regularDues, subFee },
          rosterConfig: {
            teams: getTeamsPayload(),
            skatersPerTeam: sPerTeam,
            goaliesPerTeam: gPerTeam,
            minSkaters,
            playoffFormat
          }
        })
      });

      if (res.ok) {
        const successMsg = currentLang === 'en'
          ? ("🎉 Success! The season " + esc(seasonName) + " is now active on smbhl.com and rsvp.smbhl.com!")
          : ("🎉 Succès ! La saison " + esc(seasonName) + " est maintenant active sur smbhl.com et rsvp.smbhl.com !");
        if ($('launch-result-msg')) $('launch-result-msg').innerHTML = "<span style='color:var(--green);'>" + successMsg + "</span>";
        alert(currentLang === 'en' ? "Season launched successfully!" : "Saison lancée avec succès !");
      }
    } catch (e) {
      const errPrefix = currentLang === 'en' ? "Error: " : "Erreur : ";
      if ($('launch-result-msg')) $('launch-result-msg').innerHTML = "<span style='color:var(--red);'>" + errPrefix + esc(e.message) + "</span>";
    } finally {
      if ($('btn-launch-season')) $('btn-launch-season').disabled = false;
    }
  }

  function pollIntentBroadcast() {
    alert(currentLang === 'en'
      ? "Pre-season intent poll ready to broadcast to players via Comms."
      : "Sondage d'intention pré-saison prêt à être envoyé aux joueurs via Comms.");
  }

  function initSeasonHub() {
    applyLanguage(currentLang);
    const goBtn = $('go');
    if (goBtn) {
      goBtn.addEventListener('click', () => {
        const keyInput = $('key');
        if (keyInput) {
          K = keyInput.value.trim();
          localStorage.setItem('adminkey', K);
          if ($('gate')) $('gate').style.display = 'none';
          if ($('hub-main')) $('hub-main').style.display = 'block';
          document.querySelectorAll('.picker').forEach(p => p.style.display = 'flex');
          loadSeasonHub();
        }
      });
    }
    const keyInput = $('key');
    if (keyInput) {
      keyInput.addEventListener('keydown', e => { if (e.key === 'Enter' && goBtn) goBtn.click(); });
    }
    if (K) {
      loadSeasonHub();
    } else if (${isAuthed ? 'true' : 'false'}) {
      if ($('gate')) $('gate').style.display = 'none';
      if ($('hub-main')) $('hub-main').style.display = 'block';
      document.querySelectorAll('.picker').forEach(p => p.style.display = 'flex');
      loadSeasonHub();
    }
  }

  applyLanguage(currentLang);
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initSeasonHub);
  } else {
    initSeasonHub();
  }
  </script>
  `;
}


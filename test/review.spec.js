import { describe, it, expect } from 'vitest';
import {
  normalizeTeam,
  cleanName,
  matchPlayerName,
  validateGameStats,
  consolidateSheetsIntoGames,
  updateLeagueDataWithReview,
  bufferToBase64,
  detectMime,
  extractJsonFromText,
  deduceTeamFromPlayers,
  renderReviewPage,
  renderReviewIndex
} from '../src/review.js';
import {
  sortStandings,
  getRegularGoalsByTeam,
  computeSeasonAwards,
  updatePlayoffSchedule
} from '../src/awards.js';
import { getSeasonConfig, getTeamNames } from '../src/season_config.js';

describe('Review & Scoring Engine', () => {
  it('extracts JSON cleanly even with surrounding markdown, text, or trailing commas', () => {
    const raw = "Here is the parsed scoresheet:\n```json\n{\n  \"team\": \"Red\",\n  \"week\": 2,\n}\n```\nNotes: good game.";
    const parsed = extractJsonFromText(raw);
    expect(parsed.team).toBe('Red');
    expect(parsed.week).toBe(2);
  });

  it('deduces team name from roster players when team header is missing or unknown', () => {
    const redSheet = {
      team: null,
      players: [
        { name: 'Adam Albanese' },
        { name: 'Brad Mackenzie' },
        { name: 'Some Sub' }
      ]
    };
    expect(deduceTeamFromPlayers(redSheet)).toBe('Red');

    const blackSheet = {
      team: 'Gym #1',
      goalie: { name: 'Anthony Saragoca' },
      players: [
        { name: 'Jerry Lalli' },
        { name: 'Richard Di Lallo' }
      ]
    };
    expect(deduceTeamFromPlayers(blackSheet)).toBe('Black');

    const blueSheet = {
      team: 'Unknown',
      players: [
        { name: 'Sylvain Couturier' },
        { name: 'Tyler Myrans' },
        { name: 'Yanick Audet' }
      ]
    };
    expect(deduceTeamFromPlayers(blueSheet)).toBe('Blue');
  });

  it('normalizes team names and nicknames correctly including French names', () => {
    expect(normalizeTeam('Red Wings')).toBe('Red');
    expect(normalizeTeam('Blues')).toBe('Blue');
    expect(normalizeTeam('Capitals')).toBe('White');
    expect(normalizeTeam('Bruins')).toBe('Black');
    expect(normalizeTeam('Red')).toBe('Red');
    expect(normalizeTeam('blue team')).toBe('Blue');
    expect(normalizeTeam('Rouge')).toBe('Red');
    expect(normalizeTeam('Bleu')).toBe('Blue');
    expect(normalizeTeam('Blanc')).toBe('White');
    expect(normalizeTeam('Noir')).toBe('Black');
  });

  it('correctly detects MIME types from buffer magic bytes', () => {
    const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]);
    expect(detectMime(jpeg)).toBe('image/jpeg');

    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47]);
    expect(detectMime(png)).toBe('image/png');

    const fallback = new Uint8Array([0x00, 0x01, 0x02]);
    expect(detectMime(fallback, 'image/jpeg')).toBe('image/jpeg');
  });

  it('converts large image buffers to base64 without stack overflow', () => {
    const largeBuf = new Uint8Array(2 * 1024 * 1024); // 2 MB buffer
    largeBuf.fill(65); // 'A'
    const b64 = bufferToBase64(largeBuf);
    expect(b64.length).toBeGreaterThan(0);
  });

  it('matches player names including nicknames, initials, and accents', () => {
    const candidates = [
      { player_id: 'P0001', name: 'Adam Albanese' },
      { player_id: 'P0087', name: 'François Beaucaire-Gaudreau' },
      { player_id: 'P0221', name: 'Sam Cartwright' }
    ];

    expect(matchPlayerName('Adam Albanese', candidates)?.player_id).toBe('P0001');
    expect(matchPlayerName('Francois Beaucaire Gaudreau', candidates)?.player_id).toBe('P0087');
    expect(matchPlayerName('Sam C.', candidates)?.player_id).toBe('P0221');
  });

  it('validates math and detects discrepancies correctly', () => {
    const balancedGame = {
      home_team: 'Red',
      away_team: 'Blue',
      home_score: 3,
      away_score: 5,
      home_goalie: { name: 'Sean Pichette', ga: 5 },
      away_goalie: { name: 'Anthony Saragoca', ga: 3 },
      home_players: [
        { name: 'Adam A', goals: 1, assists: 1, absent: false },
        { name: 'Brad M', goals: 2, assists: 0, absent: false }
      ],
      away_players: [
        { name: 'Player B', goals: 5, assists: 2, absent: false }
      ]
    };

    const res = validateGameStats(balancedGame);
    expect(res.balanced).toBe(true);
    expect(res.warnings.length).toBe(0);

    const imbalancedGame = {
      ...balancedGame,
      has_home_sheet: true,
      has_away_sheet: true,
      home_score: 4 // Discrepancy with 3 goals scored
    };
    const imbalancedRes = validateGameStats(imbalancedGame);
    expect(imbalancedRes.balanced).toBe(false);
    expect(imbalancedRes.warnings.length).toBeGreaterThan(0);
  });

  it('flags an error when a team has more assists than goals (maximum 1 assist per goal by default)', () => {
    const excessiveAssistsGame = {
      home_team: 'Red',
      away_team: 'Blue',
      home_score: 4,
      away_score: 3,
      has_home_sheet: true,
      has_away_sheet: true,
      home_sheet_score: { home: 4, away: 3 },
      away_sheet_score: { home: 4, away: 3 },
      home_goalie: { name: 'Sean Pichette', ga: 3 },
      away_goalie: { name: 'Anthony Saragoca', ga: 4 },
      home_players: [
        { name: 'Player A', goals: 2, assists: 3, absent: false },
        { name: 'Player B', goals: 2, assists: 2, absent: false }
      ], // 4 goals, 5 assists! (More assists than goals)
      away_players: [
        { name: 'Player C', goals: 3, assists: 2, absent: false }
      ]
    };

    const res = validateGameStats(excessiveAssistsGame);
    expect(res.balanced).toBe(false);
    expect(res.warnings.some(w => w.includes('Plus de passes (5) que de buts'))).toBe(true);

    // If maxAssistsPerGoal is configured as 2, 5 assists for 4 goals is allowed
    const resLnh = validateGameStats(excessiveAssistsGame, { maxAssistsPerGoal: 2 });
    expect(resLnh.balanced).toBe(true);
  });

  it('detects cross-sheet conflicts when Red reports 6-4 but White reports 6-5', () => {
    const conflictGame = {
      home_team: 'Red',
      away_team: 'White',
      home_score: 6,
      away_score: 4,
      has_home_sheet: true,
      has_away_sheet: true,
      home_sheet_score: { home: 6, away: 4 },
      away_sheet_score: { home: 6, away: 5 },
      home_goalie: { name: 'Sean Pichette', ga: 4 },
      away_goalie: { name: 'JP Flood', ga: 6 },
      home_players: [{ name: 'Player R', goals: 6, assists: 2, absent: false }],
      away_players: [{ name: 'Player W', goals: 5, assists: 1, absent: false }]
    };

    const res = validateGameStats(conflictGame);
    expect(res.balanced).toBe(false);
    const hasConflict = res.warnings.some(w => w.includes('Conflit entre les 2 feuilles') && w.includes('6-4') && w.includes('6-5'));
    expect(hasConflict).toBe(true);
  });

  it('flags missing sheets when not all 4 sheets have been uploaded', () => {
    const singleSheetGame = {
      home_team: 'Red',
      away_team: 'White',
      home_score: 6,
      away_score: 4,
      has_home_sheet: true,
      has_away_sheet: false, // White sheet missing!
      home_sheet_score: { home: 6, away: 4 },
      away_sheet_score: null,
      home_goalie: { name: 'Sean Pichette', ga: 4 },
      away_goalie: { name: '', ga: null },
      home_players: [{ name: 'Player R', goals: 6, assists: 2, absent: false }],
      away_players: []
    };

    const res = validateGameStats(singleSheetGame);
    expect(res.balanced).toBe(false);
    const hasMissingWarning = res.warnings.some(w => w.includes('Feuille White manquante'));
    expect(hasMissingWarning).toBe(true);
  });

  it('consolidates sheet into fixtures accurately', () => {
    const fixtures = [
      { week: 1, home: 'Red', away: 'Blue', time: '10:30 AM', gym: 'Gym #1' },
      { week: 1, home: 'White', away: 'Black', time: '10:30 AM', gym: 'Gym #2' }
    ];

    const parsedSheet = [{
      team: 'Red',
      goalie: { name: 'Sean Pichette', is_sub: false, game1_ga: 5, game2_ga: 9 },
      game1: { opponent: 'Blue', team_score: 3, opponent_score: 5 },
      players: [
        { name: 'Adam Albanese', game1_goals: 1, game1_assists: 1, game2_goals: 1, game2_assists: 1, absent: false }
      ]
    }];

    const games = consolidateSheetsIntoGames(parsedSheet, fixtures, [{ player_id: 'P0001', name: 'Adam Albanese' }]);
    expect(games.length).toBe(2);
    expect(games[0].home_score).toBe(3);
    expect(games[0].away_score).toBe(5);
    expect(games[0].home_players.length).toBe(1);
    expect(games[0].home_players[0].id).toBe('P0001');
  });

  it('updates standings and player stats in data.json', () => {
    const mockData = {
      current_season: 'Fall 2026',
      seasons: [{
        name: 'Fall 2026',
        fixtures: [
          { week: 1, home: 'Red', away: 'Blue', hg: null, ag: null }
        ],
        standings: [],
        games: 0,
        goals_per_game: 0
      }],
      players: [
        {
          id: 'P0001',
          name: 'Adam Albanese',
          seasons: {},
          gseasons: {},
          career: { gp: 10, g: 5, a: 5, pts: 10 },
          gcareer: { gp: 0, w: 0, l: 0, t: 0, ga: 0, so: 0 }
        }
      ]
    };

    const games = [{
      home_team: 'Red',
      away_team: 'Blue',
      home_score: 3,
      away_score: 5,
      home_goalie: { name: 'Sean Pichette', ga: 5 },
      away_goalie: { name: 'Anthony Saragoca', ga: 3 },
      home_players: [
        { id: 'P0001', name: 'Adam Albanese', goals: 3, assists: 0, absent: false }
      ],
      away_players: []
    }];

    const updated = updateLeagueDataWithReview(mockData, 1, games);
    expect(updated.seasons[0].fixtures[0].hg).toBe(3);
    expect(updated.seasons[0].fixtures[0].ag).toBe(5);
    expect(updated.seasons[0].games).toBe(1);
    expect(updated.seasons[0].goals_per_game).toBe(8);

    const redStandings = updated.seasons[0].standings.find(s => s.team === 'Red');
    const blueStandings = updated.seasons[0].standings.find(s => s.team === 'Blue');
    expect(redStandings.l).toBe(1);
    expect(blueStandings.w).toBe(1);
    expect(blueStandings.pts).toBe(2);

    const adam = updated.players.find(p => p.id === 'P0001');
    expect(adam.seasons['Fall 2026'].g).toBe(3);
    expect(adam.career.g).toBe(8);
  });

  it('does not tally player goals/assists or alter regular season standings during playoff week', () => {
    const mockDataWithPlayoffs = {
      league: 'SMBHL',
      current_season: 'Fall 2026',
      seasons: [{
        name: 'Fall 2026',
        fixtures: [
          // Regular season week 1
          { week: 1, home: 'Red', away: 'Blue', hg: 4, ag: 2 },
          // Playoff week 2
          { week: 2, time: '10:30 AM', gym: 'Gym #1', home: 'Red', away: 'Blue', hg: null, ag: null },
          { week: 2, time: '10:30 AM', gym: 'Gym #2', home: 'Black', away: 'White', hg: null, ag: null },
          { week: 2, time: '11:30 AM', gym: 'Gym #1', home: 'TBD', away: 'TBD', hg: null, ag: null },
          { week: 2, time: '11:30 AM', gym: 'Gym #2', home: 'TBD', away: 'TBD', hg: null, ag: null }
        ],
        standings: [
          { team: 'Red', gp: 1, w: 1, l: 0, t: 0, pts: 2, gf: 4, ga: 2 },
          { team: 'Blue', gp: 1, w: 0, l: 1, t: 0, pts: 0, gf: 2, ga: 4 }
        ],
        games: 1,
        goals_per_game: 6
      }],
      players: [
        {
          id: 'P0001',
          name: 'Adam Albanese',
          seasons: {
            'Fall 2026': { team: 'Red', gp: 1, g: 4, a: 0, pts: 4 }
          },
          gseasons: {},
          career: { gp: 1, g: 4, a: 0, pts: 4 },
          gcareer: { gp: 0, w: 0, l: 0, t: 0, ga: 0, so: 0 }
        }
      ]
    };

    const playoffGames = [{
      home_team: 'Red',
      away_team: 'Blue',
      home_score: 7,
      away_score: 3,
      home_players: [
        { id: 'P0001', name: 'Adam Albanese', goals: 5, assists: 2, absent: false }
      ],
      away_players: []
    }];

    const updated = updateLeagueDataWithReview(mockDataWithPlayoffs, 2, playoffGames);

    // 1. Playoff fixture score is recorded
    const f = updated.seasons[0].fixtures.find(x => x.week === 2 && x.home === 'Red' && x.away === 'Blue');
    expect(f.hg).toBe(7);
    expect(f.ag).toBe(3);

    // 2. Regular season standings remain intact (1 game, 6 GPG, Red still 2 pts, not 4 pts)
    expect(updated.seasons[0].games).toBe(1);
    expect(updated.seasons[0].goals_per_game).toBe(6);
    const redStandings = updated.seasons[0].standings.find(s => s.team === 'Red');
    expect(redStandings.pts).toBe(2);
    expect(redStandings.gp).toBe(1);

    // 3. Player goals and assists from playoffs are NOT added to seasonal or career totals
    const adam = updated.players.find(p => p.id === 'P0001');
    expect(adam.seasons['Fall 2026'].g).toBe(4); // still 4, not 4 + 5 = 9
    expect(adam.seasons['Fall 2026'].a).toBe(0); // still 0, not 2
    expect(adam.seasons['Fall 2026'].pts).toBe(4);
    expect(adam.career.g).toBe(4);
  });

  it('preserves team: null and aggregates with[team] stats for subs', () => {
    const mockData = {
      league: 'SMBHL',
      current_season: 'Fall 2026',
      seasons: [{
        name: 'Fall 2026',
        fixtures: [{ week: 1, home: 'Red', away: 'Blue', hg: null, ag: null }],
        standings: [
          { team: 'Red', gp: 0, w: 0, l: 0, t: 0, pts: 0, gf: 0, ga: 0 },
          { team: 'Blue', gp: 0, w: 0, l: 0, t: 0, pts: 0, gf: 0, ga: 0 }
        ],
        games: 0,
        goals_per_game: 0
      }],
      players: [
        {
          id: 'P0146',
          name: 'Louis-Philippe Lantier',
          seasons: {},
          career: { gp: 0, g: 0, a: 0, pts: 0 }
        },
        {
          id: 'P0299',
          name: 'Anthony Pietromonaco',
          gseasons: {},
          gcareer: { gp: 0, w: 0, l: 0, t: 0, ga: 0, so: 0 }
        }
      ]
    };

    const games = [{
      home_team: 'Red',
      away_team: 'Blue',
      home_score: 4,
      away_score: 2,
      home_goalie: { id: 'P0299', name: 'Anthony Pietromonaco', is_sub: true, ga: 2 },
      away_goalie: { name: 'Anthony Saragoca', ga: 4 },
      home_players: [
        { id: 'P0146', name: 'Louis-Philippe Lantier', is_sub: true, goals: 1, assists: 1, absent: false }
      ],
      away_players: []
    }];

    const subPlayerIds = new Set(['P0146', 'P0299']);
    const updated = updateLeagueDataWithReview(mockData, 1, games, subPlayerIds);

    const subSkater = updated.players.find(p => p.id === 'P0146');
    expect(subSkater.seasons['Fall 2026'].team).toBeNull();
    expect(subSkater.seasons['Fall 2026'].gp).toBe(1);
    expect(subSkater.seasons['Fall 2026'].g).toBe(1);
    expect(subSkater.seasons['Fall 2026'].a).toBe(1);
    expect(subSkater.seasons['Fall 2026'].pts).toBe(2);
    expect(subSkater.seasons['Fall 2026'].with.Red).toEqual({ gp: 1, g: 1, a: 1, pts: 2 });

    const subGoalie = updated.players.find(p => p.id === 'P0299');
    expect(subGoalie.gseasons['Fall 2026'].team).toBeNull();
    expect(subGoalie.gseasons['Fall 2026'].gp).toBe(1);
    expect(subGoalie.gseasons['Fall 2026'].ga).toBe(2);
    expect(subGoalie.gseasons['Fall 2026'].w).toBe(1);
  });
});

describe('SMBHL Standings Tie-Break Rules', () => {
  it('breaks ties strictly by: Pts -> Wins -> +/- -> GF -> Regular Player Goals -> Deterministic', () => {
    // 1. Points difference
    const byPts = sortStandings([
      { team: 'Red', pts: 10, w: 5, gf: 20, ga: 10 },
      { team: 'Blue', pts: 12, w: 6, gf: 20, ga: 10 }
    ]);
    expect(byPts[0].team).toBe('Blue');

    // 2. Wins tie-break
    const byWins = sortStandings([
      { team: 'Red', pts: 10, w: 5, gf: 25, ga: 15 },
      { team: 'Blue', pts: 10, w: 4, gf: 25, ga: 15 }
    ]);
    expect(byWins[0].team).toBe('Red');

    // 3. Goal Differential (+/-) tie-break
    const byDiff = sortStandings([
      { team: 'Red', pts: 10, w: 4, gf: 30, ga: 20 }, // +10
      { team: 'Blue', pts: 10, w: 4, gf: 32, ga: 20 } // +12
    ]);
    expect(byDiff[0].team).toBe('Blue');

    // 4. Total Goals For tie-break
    const byGf = sortStandings([
      { team: 'Red', pts: 10, w: 4, gf: 35, ga: 25 }, // +10, 35 GF
      { team: 'Blue', pts: 10, w: 4, gf: 30, ga: 20 } // +10, 30 GF
    ]);
    expect(byGf[0].team).toBe('Red');

    // 5. Goals Scored by Regular Players tie-break
    const regGoalsMap = { Red: 22, Blue: 28 };
    const byReg = sortStandings([
      { team: 'Red', pts: 10, w: 4, gf: 30, ga: 20 },
      { team: 'Blue', pts: 10, w: 4, gf: 30, ga: 20 }
    ], regGoalsMap);
    expect(byReg[0].team).toBe('Blue');

    // 6. Deterministic fallback (alphabetical by team name)
    const byFallback = sortStandings([
      { team: 'White', pts: 10, w: 4, gf: 30, ga: 20 },
      { team: 'Black', pts: 10, w: 4, gf: 30, ga: 20 }
    ], { White: 20, Black: 20 });
    expect(byFallback[0].team).toBe('Black');
  });
});

describe('Automated Playoff Bracket Scheduling', () => {
  it('populates Game 1 (1v4, 2v3) after regular season finishes, Game 2 after Game 1, and crowns champion after Final', () => {
    const s0 = {
      name: 'Fall 2026',
      standings: [
        { team: 'Blue', pts: 18 },
        { team: 'Black', pts: 14 },
        { team: 'Red', pts: 12 },
        { team: 'White', pts: 8 }
      ],
      champion: null,
      fixtures: [
        // Regular season week 13
        { week: 13, time: '10:30 AM', gym: 'Gym #1', home: 'Blue', away: 'Red', hg: 5, ag: 3 },
        { week: 13, time: '10:30 AM', gym: 'Gym #2', home: 'Black', away: 'White', hg: 6, ag: 2 },
        { week: 13, time: '11:30 AM', gym: 'Gym #1', home: 'Blue', away: 'Black', hg: 4, ag: 4 },
        { week: 13, time: '11:30 AM', gym: 'Gym #2', home: 'Red', away: 'White', hg: 7, ag: 1 },

        // Playoff week 14 (all unplayed initially)
        { week: 14, time: '10:30 AM', gym: 'Gym #1', home: 'TBD', away: 'TBD', hg: null, ag: null },
        { week: 14, time: '10:30 AM', gym: 'Gym #2', home: 'TBD', away: 'TBD', hg: null, ag: null },
        { week: 14, time: '11:30 AM', gym: 'Gym #1', home: 'TBD', away: 'TBD', hg: null, ag: null },
        { week: 14, time: '11:30 AM', gym: 'Gym #2', home: 'TBD', away: 'TBD', hg: null, ag: null }
      ]
    };

    // 1. Regular season finished -> Game 1 populated (1v4 and 2v3), Game 2 remains TBD
    updatePlayoffSchedule(s0);
    const w14 = s0.fixtures.filter(f => f.week === 14);
    const g1Gym1 = w14.find(f => f.time === '10:30 AM' && f.gym === 'Gym #1');
    const g1Gym2 = w14.find(f => f.time === '10:30 AM' && f.gym === 'Gym #2');
    const finalMatch = w14.find(f => f.time === '11:30 AM' && f.gym === 'Gym #1');
    const consolMatch = w14.find(f => f.time === '11:30 AM' && f.gym === 'Gym #2');

    expect(g1Gym1.home).toBe('Blue');  // 1st
    expect(g1Gym1.away).toBe('White'); // 4th
    expect(g1Gym2.home).toBe('Black'); // 2nd
    expect(g1Gym2.away).toBe('Red');   // 3rd
    expect(finalMatch.home).toBe('TBD');
    expect(finalMatch.away).toBe('TBD');

    // 2. Play Game 1: Blue beats White (6-3), Red upsets Black (5-4)
    g1Gym1.hg = 6;
    g1Gym1.ag = 3;
    g1Gym2.hg = 4;
    g1Gym2.ag = 5;

    updatePlayoffSchedule(s0);

    // Game 2 Final: Winner Blue vs Winner Red
    expect(finalMatch.home).toBe('Blue');
    expect(finalMatch.away).toBe('Red');

    // Game 2 Consolidation: Loser White vs Loser Black
    expect(consolMatch.home).toBe('White');
    expect(consolMatch.away).toBe('Black');
    expect(s0.champion).toBeNull();

    // 3. Play Game 2 Final: Blue beats Red (7-4)
    finalMatch.hg = 7;
    finalMatch.ag = 4;
    finalMatch.date = 'Sunday December 20, 2026';

    updatePlayoffSchedule(s0);

    // Blue is crowned champion!
    expect(s0.champion).toBe('Blue');
    expect(s0.last_game).toBe('Sunday December 20, 2026');
  });
});

describe('Season Awards Computation', () => {
  it('correctly calculates all 10 seasonal awards', () => {
    const dataJson = {
      seasons: [{
        name: 'Fall 2026',
        standings: [
          { team: 'Blue', gf: 30, ga: 15, pts: 8 },
          { team: 'Red', gf: 20, ga: 25, pts: 4 }
        ],
        champion: 'Blue'
      }],
      players: [
        {
          id: 'P0001',
          name: 'Roberto Santana',
          seasons: {
            'Fall 2026': { team: 'Blue', gp: 6, g: 15, a: 5, pts: 20, pos: 'F' },
            'Winter 2026': { team: 'Blue', gp: 10, g: 10, a: 5, pts: 15 }
          }
        },
        {
          id: 'P0002',
          name: 'Alex Romanello',
          seasons: {
            'Fall 2026': { team: 'Blue', gp: 6, g: 4, a: 12, pts: 16, pos: 'F' },
            'Winter 2026': { team: 'Blue', gp: 10, g: 5, a: 10, pts: 15 }
          }
        },
        {
          id: 'P0003',
          name: 'Francois Beaucaire',
          seasons: {
            'Fall 2026': { team: 'Blue', gp: 6, g: 2, a: 11, pts: 13, pos: 'F' },
            'Winter 2026': { team: 'Blue', gp: 10, g: 3, a: 10, pts: 13 }
          }
        },
        {
          id: 'P0004',
          name: 'Top Defenseman',
          seasons: {
            'Fall 2026': { team: 'Red', gp: 6, g: 5, a: 7, pts: 12, pos: 'D' },
            'Winter 2026': { team: 'Red', gp: 10, g: 5, a: 10, pts: 15 }
          }
        },
        {
          id: 'P0005',
          name: 'Great Rookie',
          seasons: {
            // Only 1 season on record -> Rookie
            'Fall 2026': { team: 'Red', gp: 6, g: 6, a: 4, pts: 10, pos: 'F' }
          }
        },
        {
          id: 'P0006',
          name: 'Super Sub',
          seasons: {
            // team: null -> Sub
            'Fall 2026': { team: null, gp: 4, g: 5, a: 3, pts: 8, pos: 'F' }
          }
        },
        {
          id: 'G0001',
          name: 'Star Goalie',
          seasons: {},
          gseasons: {
            'Fall 2026': { team: 'Blue', gp: 6, ga: 12, w: 5, l: 1, t: 0, so: 1 }
          }
        }
      ]
    };

    const awards = computeSeasonAwards(dataJson, 'Fall 2026');

    // Rocket Richard (Top goals: Roberto with 15)
    expect(awards.rocketRichard).toBe('Roberto Santana, 15 buts / goals');

    // Lady Byng (Top assists: Alex with 12, solo winner without runner-up callout)
    expect(awards.ladyByng).toBe('Alex Romanello, 12 passes / assists');

    // Art Ross (Top points: Roberto with 20)
    expect(awards.artRoss).toBe('Roberto Santana, 20 points');

    // Hart Trophy (PPG: Roberto with 3.3 PPG)
    expect(awards.hartTrophy).toContain('Roberto Santana');
    expect(awards.hartTrophy).toContain('PPM / PPG');

    // Norris (Top D: Top Defenseman with 12 points)
    expect(awards.norris).toBe('Top Defenseman, 12 points');

    // Vezina (Goalie GAA: 12 / 6 = 2.00 GAA)
    expect(awards.vezina).toBe('Star Goalie, 2.00 MBA / GAA');

    // Calder (Top rookie: Great Rookie with 10 points)
    expect(awards.calder).toBe('Great Rookie, 10 points');

    // Subway (Top sub: Super Sub with 8 points)
    expect(awards.subway).toBe('Super Sub, 8 points');

    // MVP (% Team Involvement: Roberto has 20 pts on Team Blue's 30 GF = 67%)
    expect(awards.mvp).toBe('Roberto Santana, 67% des buts / goals (Team Blue)');

    // Champion
    expect(awards.champion).toBe('Blue');
  });

  it('correctly applies Calder eligibility: 1st regular season, <= 25 prior games, and rookie goalie candidate', () => {
    const data = {
      current_season: 'Winter 2027',
      seasons: [
        {
          name: 'Winter 2027',
          standings: [
            { team: 'Red', gf: 20 },
            { team: 'Blue', gf: 20 },
            { team: 'White', gf: 20 },
            { team: 'Black', gf: 20 }
          ]
        }
      ],
      players: [
        {
          // Candidate A: 1st season as regular, had 5 sub games prior (<= 25) -> ELIGIBLE ROOKIE (18 pts)
          id: 'P_ROOKIE_ELIGIBLE',
          name: 'Eligible Rookie',
          seasons: {
            'Fall 2026': { team: null, gp: 5, g: 2, a: 3, pts: 5 },
            'Winter 2027': { team: 'Blue', gp: 10, g: 10, a: 8, pts: 18 }
          }
        },
        {
          // Candidate B: 1st season as regular, but played 28 sub games prior (> 25) -> DISQUALIFIED (22 pts)
          id: 'P_VET_SUB',
          name: 'Veteran Sub',
          seasons: {
            'Fall 2025': { team: null, gp: 14, g: 5, a: 5, pts: 10 },
            'Winter 2026': { team: null, gp: 14, g: 5, a: 5, pts: 10 },
            'Winter 2027': { team: 'Red', gp: 10, g: 12, a: 10, pts: 22 }
          }
        },
        {
          // Candidate C: Had a prior season as regular on White -> DISQUALIFIED (25 pts)
          id: 'P_PAST_REGULAR',
          name: 'Past Regular',
          seasons: {
            'Fall 2026': { team: 'White', gp: 8, g: 10, a: 10, pts: 20 },
            'Winter 2027': { team: 'White', gp: 10, g: 15, a: 10, pts: 25 }
          }
        },
        {
          // Candidate D: Rookie Goalie with 1st season as regular goalie, 0 prior games -> QUALIFIED ROOKIE GOALIE
          id: 'G_ROOKIE',
          name: 'Rookie Wall',
          seasons: {},
          gseasons: {
            'Winter 2027': { team: 'Black', gp: 8, ga: 16, w: 6, l: 2, t: 0, so: 1 }
          }
        }
      ]
    };

    const awards = computeSeasonAwards(data, 'Winter 2027');

    // Veteran Sub has 22 pts and Past Regular has 25 pts, but both are disqualified.
    // Eligible Rookie (18 pts) wins Calder!
    expect(awards.calder).toBe('Eligible Rookie, 18 points');

    // Verify rookie goalie candidate is tracked for admin discretion
    expect(awards.calderCandidates.topGoalie).not.toBeNull();
    expect(awards.calderCandidates.topGoalie.name).toBe('Rookie Wall');
    expect(awards.calderCandidates.topGoalie.gaa).toBe(2);
  });
});

describe('Multi-team season config (6-team season, Parts 3 & 4)', () => {
  const sixTeamConfig = {
    teams: [
      { name: 'Hawks', name_fr: 'Faucons', colour: '#1c1f24', aliases: ['Hawkeyes'] },
      { name: 'Wolves', name_fr: 'Loups', colour: '#374151', aliases: ['Timberwolves'] },
      { name: 'Bears', name_fr: 'Ours', colour: '#78350f', aliases: ['Grizzlies'] },
      { name: 'Lions', name_fr: 'Lions', colour: '#b45309', aliases: ['Nittany Lions'] },
      { name: 'Eagles', name_fr: 'Aigles', colour: '#166534', aliases: ['Philly'] },
      { name: 'Sharks', name_fr: 'Requins', colour: '#0369a1', aliases: ['Jaws'] }
    ],
    goaliesPerTeam: 1,
    skatersPerTeam: 7,
    minSkaters: 4,
    playoffFormat: 'top4_two_weeks'
  };

  it('matches OCR team names, name_fr, and aliases for a non-default season config', () => {
    expect(normalizeTeam('Hawks', sixTeamConfig)).toBe('Hawks');
    expect(normalizeTeam('Hawkeyes', sixTeamConfig)).toBe('Hawks');       // alias
    expect(normalizeTeam('Loups', sixTeamConfig)).toBe('Wolves');         // name_fr
    expect(normalizeTeam('Grizzlies', sixTeamConfig)).toBe('Bears');      // alias
    expect(normalizeTeam('Requins', sixTeamConfig)).toBe('Sharks');       // name_fr
    expect(normalizeTeam('eagles squad', sixTeamConfig)).toBe('Eagles'); // loose substring fallback
    // The default (SMBHL) config still resolves independently of any season config
    expect(normalizeTeam('Rouge')).toBe('Red');
  });

  it("detects missing sheets against the season's own team list", () => {
    const parsedSheets = [
      { team: 'Hawkeyes' }, // alias for Hawks
      { team: 'Loups' },    // name_fr for Wolves
      { team: 'Bears' }
    ];
    // Mirrors the missing-sheet detection in renderReviewPage / handleScoresheetEmail
    const receivedTeams = [...new Set(parsedSheets.map(s => normalizeTeam(s.team, sixTeamConfig)).filter(Boolean))];
    const missingTeams = getTeamNames(sixTeamConfig).filter(t => !receivedTeams.includes(t));

    expect(receivedTeams.sort()).toEqual(['Bears', 'Hawks', 'Wolves']);
    expect(missingTeams.sort()).toEqual(['Eagles', 'Lions', 'Sharks']);
  });

  it('seeds a top4_two_weeks playoff bracket: semifinal week, then final/consolation week', () => {
    const s0 = {
      name: 'Winter 2027 (6-team)',
      config: sixTeamConfig,
      standings: [
        { team: 'Wolves', pts: 20 },
        { team: 'Sharks', pts: 16 },
        { team: 'Hawks', pts: 14 },
        { team: 'Bears', pts: 10 },
        { team: 'Lions', pts: 8 },
        { team: 'Eagles', pts: 4 }
      ],
      champion: null,
      fixtures: [
        // Regular season, week 10 (fully played)
        { week: 10, time: '10:00 AM', gym: 'Court A', home: 'Wolves', away: 'Eagles', hg: 6, ag: 2 },
        { week: 10, time: '10:00 AM', gym: 'Court B', home: 'Sharks', away: 'Lions', hg: 5, ag: 3 },
        { week: 10, time: '11:00 AM', gym: 'Court A', home: 'Hawks', away: 'Bears', hg: 4, ag: 4 },

        // Semifinal week 11 (unplayed)
        { week: 11, time: '10:00 AM', gym: 'Court A', home: 'TBD', away: 'TBD', hg: null, ag: null },
        { week: 11, time: '10:00 AM', gym: 'Court B', home: 'TBD', away: 'TBD', hg: null, ag: null },

        // Final week 12 (unplayed)
        { week: 12, time: '10:00 AM', gym: 'Court A', home: 'TBD', away: 'TBD', hg: null, ag: null },
        { week: 12, time: '10:00 AM', gym: 'Court B', home: 'TBD', away: 'TBD', hg: null, ag: null }
      ]
    };

    // 1. Regular season finished -> semifinals seeded in week 11, final week untouched
    updatePlayoffSchedule(s0);
    const semis = s0.fixtures.filter(f => f.week === 11);
    const finals = s0.fixtures.filter(f => f.week === 12);
    const f1v4 = semis.find(f => f.gym === 'Court A');
    const f2v3 = semis.find(f => f.gym === 'Court B');

    expect(f1v4.home).toBe('Wolves'); // 1st
    expect(f1v4.away).toBe('Bears');  // 4th
    expect(f2v3.home).toBe('Sharks'); // 2nd
    expect(f2v3.away).toBe('Hawks');  // 3rd
    expect(finals.every(f => f.home === 'TBD')).toBe(true);

    // 2. Play the semis: Wolves beat Bears, Hawks upset Sharks
    f1v4.hg = 5; f1v4.ag = 2;
    f2v3.hg = 3; f2v3.ag = 4;
    updatePlayoffSchedule(s0);

    const fFinal = finals.find(f => f.gym === 'Court A');
    const fConsol = finals.find(f => f.gym === 'Court B');
    expect(fFinal.home).toBe('Wolves');
    expect(fFinal.away).toBe('Hawks');
    expect(fConsol.home).toBe('Bears');
    expect(fConsol.away).toBe('Sharks');
    expect(s0.champion).toBeNull();

    // 3. Play the final: Wolves win it all
    fFinal.hg = 6; fFinal.ag = 3;
    fFinal.date = 'Sunday March 1, 2027';
    updatePlayoffSchedule(s0);

    expect(s0.champion).toBe('Wolves');
    expect(s0.last_game).toBe('Sunday March 1, 2027');
  });

  it('does nothing when the season\'s playoffFormat is "none"', () => {
    const s0 = {
      name: 'No Playoffs Season',
      config: { ...sixTeamConfig, playoffFormat: 'none' },
      fixtures: [
        { week: 10, time: '10:00 AM', gym: 'Court A', home: 'Wolves', away: 'Bears', hg: 5, ag: 2 },
        { week: 11, time: '10:00 AM', gym: 'Court A', home: 'TBD', away: 'TBD', hg: null, ag: null },
        { week: 11, time: '10:00 AM', gym: 'Court B', home: 'TBD', away: 'TBD', hg: null, ag: null }
      ]
    };
    updatePlayoffSchedule(s0);
    expect(s0.fixtures[1].home).toBe('TBD');
    expect(s0.fixtures[2].home).toBe('TBD');
    expect(s0.champion).toBeUndefined();
  });

  it('falls back to SMBHL defaults when a season has no config at all', () => {
    expect(getSeasonConfig(undefined)).toEqual({
      teams: expect.any(Array),
      goaliesPerTeam: 1,
      // Live-testing task, Part 5: maxGoalies defaults to goaliesPerTeam
      // (min===max) for every league that's never set a real, distinct
      // maximum -- see normalizeSeasonConfig's own comment.
      maxGoalies: 1,
      skatersPerTeam: 8,
      minSkaters: 5,
      playoffFormat: 'top4_single_day',
      league: {
        name: 'SMBHL',
        tagline: 'Sunday Morning Ball Hockey League',
        fromEmail: 'SMBHL - Hockey <joueur@smbhl.com>',
        replyToEmail: 'info@smbhl.com',
        siteUrl: 'https://smbhl.com',
        faviconUrl: 'https://smbhl.com/img/favicon-32.svg',
        languageMode: 'both',
        color: '#b3122e'
      },
      tracksStats: true,
      teamStructure: 'fixed',
      sportType: 'hockey'
    });
    expect(getTeamNames(getSeasonConfig({ name: 'Configless Season', standings: [], fixtures: [] })))
      .toEqual(['Red', 'Blue', 'White', 'Black']);

    // A season object with no .config and no dataJson falls back to the same
    // SMBHL-default single-day (Gym-based) behaviour as the original 4-team season.
    const s0 = {
      name: 'Configless Season',
      standings: [
        { team: 'Blue', pts: 10 }, { team: 'Black', pts: 8 },
        { team: 'Red', pts: 6 }, { team: 'White', pts: 4 }
      ],
      fixtures: [
        { week: 1, time: '10:00 AM', gym: 'Gym #1', home: 'Blue', away: 'Red', hg: 3, ag: 1 },
        { week: 2, time: '10:00 AM', gym: 'Gym #1', home: 'TBD', away: 'TBD', hg: null, ag: null },
        { week: 2, time: '10:00 AM', gym: 'Gym #2', home: 'TBD', away: 'TBD', hg: null, ag: null },
        { week: 2, time: '11:00 AM', gym: 'Gym #1', home: 'TBD', away: 'TBD', hg: null, ag: null },
        { week: 2, time: '11:00 AM', gym: 'Gym #2', home: 'TBD', away: 'TBD', hg: null, ag: null }
      ]
    };
    updatePlayoffSchedule(s0);
    const semis = s0.fixtures.filter(f => f.week === 2 && f.time === '10:00 AM');
    expect(semis.find(f => f.gym === 'Gym #1').home).toBe('Blue');
    expect(semis.find(f => f.gym === 'Gym #2').home).toBe('Black');
  });
});

describe('Admin nav tabs hide stats-only links when tracksStats is false', () => {
  const attendanceConfig = getSeasonConfig({
    name: 'AttendanceOnly2026',
    standings: [],
    config: {
      teams: [
        { name: 'Alpha', name_fr: 'Alpha', colour: '#334155', aliases: [] },
        { name: 'Beta', name_fr: 'Beta', colour: '#64748b', aliases: [] }
      ],
      tracksStats: false
    }
  });
  const statsConfig = getSeasonConfig(undefined); // SMBHL default, tracksStats: true

  const baseReview = {
    id: 1,
    week: 3,
    season: 'AttendanceOnly2026',
    status: 'draft',
    images_json: '[]',
    validated_json: '[]',
    extracted_json: '[]'
  };

  it('renderReviewPage: hides Scoresheets and Season Recap tabs when the review\'s season config has tracksStats: false', () => {
    const html = renderReviewPage(baseReview, [], { config: attendanceConfig });
    expect(html).not.toContain('data-tab="review"');
    expect(html).not.toContain('data-tab="recap"');
    expect(html).toContain('data-tab="subs"');
    expect(html).toContain('data-tab="finances"');
    expect(html).toContain('data-tab="polls"');
  });

  it('renderReviewPage: still shows Scoresheets and Season Recap tabs for a stats-tracking season (Fall 2026 default unaffected)', () => {
    const html = renderReviewPage({ ...baseReview, season: 'Fall 2026' }, [], { config: statsConfig });
    expect(html).toContain('data-tab="review"');
    expect(html).toContain('data-tab="recap"');
  });

  it('renderReviewIndex: hides Scoresheets and Season Recap tabs when showStatsTabs is false', () => {
    const html = renderReviewIndex([], [], false);
    expect(html).not.toContain('data-tab="review"');
    expect(html).not.toContain('data-tab="recap"');
    expect(html).toContain('data-tab="subs"');
    expect(html).toContain('data-tab="finances"');
    expect(html).toContain('data-tab="polls"');
  });

  it('renderReviewIndex: shows Scoresheets and Season Recap tabs by default (Fall 2026 default unaffected)', () => {
    const html = renderReviewIndex([], []);
    expect(html).toContain('data-tab="review"');
    expect(html).toContain('data-tab="recap"');
  });
});

describe('Manual (no-photo) entry: add-player affordance on the review-editing screen', () => {
  const blankGameReview = {
    id: 'rev_manual_1',
    week: 1,
    season: 'AttendanceOnly2026',
    status: 'draft',
    images_json: '[]',
    validated_json: '[]',
    extracted_json: '[]'
  };

  it('renders an "add player" button per team per game, even for a blank (manually-started, no-photo) game with zero players', () => {
    const games = [{
      id: 'game_1_Hawks_Wolves', week: 1, home_team: 'Hawks', away_team: 'Wolves',
      home_score: null, away_score: null, home_sheet_score: null, away_sheet_score: null,
      has_home_sheet: false, has_away_sheet: false,
      home_goalie: { name: '', id: null, ga: null, is_sub: false },
      away_goalie: { name: '', id: null, ga: null, is_sub: false },
      home_players: [], away_players: []
    }];
    const review = { ...blankGameReview, validated_json: JSON.stringify(games) };
    const html = renderReviewPage(review, [], { config: getSeasonConfig(undefined) });
    // The button must appear regardless of how many players a game currently has (zero here,
    // as for a manually-started review with no photo at all).
    expect(html).toContain("addPlayerRow(0, 'home')");
    expect(html).toContain("addPlayerRow(0, 'away')");
    expect(html).toContain('function addPlayerRow(gIdx, side)');
  });

  it('addPlayerRow pushes into the same array recalc()/stepVal() index by DOM position (appendChild keeps array length and DOM child count in sync)', () => {
    const html = renderReviewPage(blankGameReview, [], { config: getSeasonConfig(undefined) });
    // Extract the addPlayerRow function body and confirm it (a) pushes a blank player object
    // into the same gamesData array that recalc()/stepVal() read by index, and (b) appends the
    // new row as the tbody's last child — so its DOM position always matches the array index,
    // which is the invariant recalc()/stepVal() rely on (they index via tbody.children[pIdx]).
    const fnMatch = html.match(/function addPlayerRow\(gIdx, side\) \{[\s\S]*?\n\}/);
    expect(fnMatch).toBeTruthy();
    const fnSrc = fnMatch[0];
    expect(fnSrc).toContain("g[side + '_players'] || (g[side + '_players'] = [])");
    expect(fnSrc).toContain('arr.push({ name: \'\', id: null, is_sub: false, absent: false, goals: 0, assists: 0 })');
    expect(fnSrc).toContain(".getElementById('tbody_' + gIdx + '_' + side).appendChild(row)");
    expect(fnSrc).toContain('recalc();');
  });
});



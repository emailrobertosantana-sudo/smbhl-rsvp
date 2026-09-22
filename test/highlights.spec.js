import { describe, it, expect } from 'vitest';
import {
  isFullName,
  cleanPlayerName,
  computeWeeklyRecap,
  computeAllTimeRankMovements,
  computeClosingIn,
  getWeek1BaselineRecap,
  getWeeklyHighlights,
  renderHighlightsHtml,
  renderHighlightsText
} from '../src/highlights.js';

describe('Weekly Highlights & Honors Engine', () => {
  it('validates full names and rejects single-word names and TBD', () => {
    expect(isFullName('Guillaume Thibault')).toBe(true);
    expect(isFullName('Max Latreille')).toBe(true);
    expect(isFullName('Jean-Francois Beaucaire')).toBe(true);
    expect(isFullName('Mike')).toBe(false);
    expect(isFullName('')).toBe(false);
    expect(isFullName(null)).toBe(false);
    expect(isFullName('TBD')).toBe(false);
    expect(isFullName('Emile TBD')).toBe(false);
    expect(isFullName('TBD Player')).toBe(false);
  });

  it('computes player of week, goalie of week, sub of week, and firsts from game sheets', () => {
    const mockDataJson = {
      current_season: 'Fall 2026',
      seasons: [{ name: 'Fall 2026', fixtures: [] }],
      players: [
        {
          id: 'P0001',
          name: 'Anthony Coventry',
          seasons: { 'Fall 2026': { team: 'Black', pos: 'F', gp: 2, g: 5, a: 6, pts: 11 } },
          career: { gp: 100, g: 150, a: 100, pts: 250 }
        },
        {
          id: 'P0002',
          name: 'Anthony Saragoca',
          gseasons: { 'Fall 2026': { team: 'Blue', gp: 2, ga: 9, w: 2, l: 0, t: 0 } },
          gcareer: { gp: 100, w: 50, ga: 500 }
        },
        {
          id: 'P0003',
          name: 'Armando Tempestilli',
          seasons: { 'Fall 2026': { team: null, pos: null, gp: 2, g: 2, a: 2, pts: 4 } },
          career: { gp: 2, g: 2, a: 2, pts: 4 } // First career assist & sub
        },
        {
          id: 'P0004',
          name: 'Max Latreille',
          seasons: { 'Fall 2026': { team: 'White', pos: 'F', gp: 2, g: 2, a: 0, pts: 2 } },
          career: { gp: 2, g: 2, a: 0, pts: 2 } // First career goal
        },
        {
          id: 'P0005',
          name: 'Guillaume Thibault',
          seasons: { 'Fall 2026': { team: 'White', pos: 'D', gp: 2, g: 3, a: 3, pts: 6 } },
          career: { gp: 200, g: 282, a: 218, pts: 500 } // Crossed 500 career points!
        },
        {
          id: 'P0006',
          name: 'Henrik Santana',
          seasons: { 'Fall 2026': { team: 'Black', pos: 'F', gp: 1, g: 0, a: 1, pts: 1 } },
          career: { gp: 1, g: 0, a: 1, pts: 1 } // True rookie first assist
        }
      ]
    };

    const mockGames = [
      {
        home_team: 'Black',
        away_team: 'Red',
        home_score: 9,
        away_score: 6,
        home_players: [
          { id: 'P0001', name: 'Anthony Coventry', goals: 5, assists: 6, absent: false },
          { id: 'P0006', name: 'Henrik Santana', goals: 0, assists: 1, absent: false }
        ],
        away_players: [],
        home_goalie: { name: 'Francois Taillefer', ga: 7 },
        away_goalie: { name: 'Sean Pichette', ga: 9 }
      },
      {
        home_team: 'Blue',
        away_team: 'White',
        home_score: 10,
        away_score: 4,
        home_players: [
          { id: 'P0003', name: 'Armando Tempestilli', goals: 2, assists: 2, absent: false }
        ],
        away_players: [
          { id: 'P0004', name: 'Max Latreille', goals: 2, assists: 0, absent: false },
          { id: 'P0005', name: 'Guillaume Thibault', goals: 3, assists: 3, absent: false }
        ],
        home_goalie: { id: 'P0002', name: 'Anthony Saragoca', ga: 4 },
        away_goalie: { name: 'JP Flood', ga: 10 }
      }
    ];

    const recap = computeWeeklyRecap(mockDataJson, 1, mockGames);

    // Player of the week
    expect(recap.playerOfTheWeek?.name).toBe('Anthony Coventry');
    expect(recap.playerOfTheWeek?.pts).toBe(11);

    // Goalie of the week
    expect(recap.goalieOfTheWeek?.name).toBe('Anthony Saragoca');
    expect(recap.goalieOfTheWeek?.ga).toBe(4);

    // Sub of the week
    expect(recap.subOfTheWeek?.name).toBe('Armando Tempestilli');
    expect(recap.subOfTheWeek?.pts).toBe(4);

    // Firsts
    expect(recap.firsts.goals).toContain('Max Latreille');
    expect(recap.firsts.assists).toContain('Henrik Santana');
    expect(recap.firsts.assists).toContain('Armando Tempestilli');

    // Milestone reached
    const gt = recap.achievements.find(a => a.name === 'Guillaume Thibault');
    expect(gt).toBeDefined();
    expect(gt?.mark).toBe(500);
  });

  it('computes closing in milestones only for active players or subs who played this year', () => {
    const mockDataJson = {
      current_season: 'Fall 2026',
      seasons: [{ name: 'Fall 2026' }],
      players: [
        {
          id: 'P0010',
          name: 'Alex Romanello',
          seasons: { 'Winter 2026': { gp: 20 } }, // inactive this year
          career: { pts: 999, g: 450, a: 549, gp: 300 },
          gcareer: { gp: 0, w: 0 }
        },
        {
          id: 'P0020',
          name: 'Jerry Lalli',
          seasons: { 'Fall 2026': { team: 'Black', gp: 2 } }, // active rostered
          career: { pts: 721, g: 425, a: 298, gp: 330 },
          gcareer: { gp: 0, w: 0 }
        },
        {
          id: 'P0030',
          name: 'Active Sub',
          seasons: { 'Fall 2026': { team: null, gp: 1 } }, // sub who played this year
          career: { pts: 498, g: 250, a: 248, gp: 200 },
          gcareer: { gp: 0, w: 0 }
        },
        {
          id: 'P0040',
          name: 'Inactive Sub',
          seasons: { 'Fall 2026': { team: null, gp: 0 } }, // sub who hasn't played this year
          career: { pts: 499, g: 250, a: 249, gp: 200 },
          gcareer: { gp: 0, w: 0 }
        }
      ]
    };

    const closing = computeClosingIn(mockDataJson);
    // Alex Romanello and Inactive Sub must be excluded
    const names = closing.map(c => c.name);
    expect(names).not.toContain('Alex Romanello');
    expect(names).not.toContain('Inactive Sub');
    expect(names).toContain('Jerry Lalli');
    expect(names).toContain('Active Sub');
    expect(closing[0].name).toBe('Active Sub'); // 2 from 500 pts (higher target 500 vs 300)
    expect(closing[1].name).toBe('Jerry Lalli');  // 2 from 300 assists
  });

  it('aggregates Week 1 & 2 milestones for Week 3 invites, but keeps Week 2 stars isolated', async () => {
    const fakeKV = new Map();
    fakeKV.set('recap:week_1', JSON.stringify({
      week: 1,
      achievements: [{ name: 'Guillaume Thibault', mark: 500, fr: 'Guillaume Thibault a atteint 500 points en carrière!', en: 'Guillaume Thibault reached 500 career points!' }],
      playerOfTheWeek: { name: 'Anthony Coventry', pts: 11, g: 5, a: 6 },
      goalieOfTheWeek: { name: 'Anthony Saragoca', gaa: 4.5 },
      subOfTheWeek: { name: 'Armando Tempestilli', pts: 4 },
      firsts: { goals: ['Max Latreille'], assists: ['Armando Tempestilli'] }
    }));
    fakeKV.set('recap:week_2', JSON.stringify({
      week: 2,
      achievements: [{ name: 'Jerry Lalli', mark: 300, fr: 'Jerry Lalli a atteint 300 passes en carrière!', en: 'Jerry Lalli reached 300 career assists!' }],
      playerOfTheWeek: { name: 'Brad Mackenzie', pts: 8, g: 4, a: 4 },
      goalieOfTheWeek: { name: 'Sean Pichette', gaa: 3.5 },
      subOfTheWeek: { name: 'Sam Cartwright', pts: 5 },
      firsts: { goals: ['Player New'], assists: [] }
    }));

    const mockEnv = {
      SHEETS_KV: {
        get: async k => fakeKV.get(k) || null
      }
    };

    // Week 3 should combine milestones from Week 1 and Week 2
    const w3Highlights = await getWeeklyHighlights(mockEnv, 3);
    expect(w3Highlights).not.toBeNull();
    expect(w3Highlights?.milestoneWeeks).toEqual([1, 2]);
    expect(w3Highlights?.starsWeek).toBe(2);
    expect(w3Highlights?.achievements.length).toBe(2);
    expect(w3Highlights?.firsts.goals).toContain('Max Latreille');
    expect(w3Highlights?.firsts.goals).toContain('Player New');

    // Stars of the week for Week 3 MUST be strictly from Week 2 (Brad Mackenzie, Sean Pichette, Sam Cartwright)
    // NOT combined with Week 1 (Anthony Coventry, Anthony Saragoca, Armando Tempestilli)
    expect(w3Highlights?.playerOfTheWeek?.name).toBe('Brad Mackenzie');
    expect(w3Highlights?.playerOfTheWeek?.pts).toBe(8);
    expect(w3Highlights?.goalieOfTheWeek?.name).toBe('Sean Pichette');
    expect(w3Highlights?.subOfTheWeek?.name).toBe('Sam Cartwright');

    // Week 4 should only include Week 3
    const w4Highlights = await getWeeklyHighlights(mockEnv, 4);
    // Week 3 recap isn't in fakeKV so returns null
    expect(w4Highlights).toBeNull();

    // Week 2 should only include Week 1
    const w2Highlights = await getWeeklyHighlights(mockEnv, 2);
    expect(w2Highlights?.milestoneWeeks).toEqual([1]);
    expect(w2Highlights?.starsWeek).toBe(1);
    expect(w2Highlights?.playerOfTheWeek?.name).toBe('Anthony Coventry');
    expect(w2Highlights?.achievements.length).toBe(1);
    expect(w2Highlights?.achievements[0].name).toBe('Guillaume Thibault');
  });

  it('in future seasons (e.g. Winter 2027), Week 2 and Week 3 fire normally without multi-week combination', async () => {
    const fakeKV = new Map();
    fakeKV.set('recap:Winter 2027:week_1', JSON.stringify({
      week: 1,
      achievements: [{ name: 'Player A', mark: 100 }],
      playerOfTheWeek: { name: 'Player A', pts: 5 },
      goalieOfTheWeek: { name: 'Goalie A', gaa: 2.0 },
      subOfTheWeek: null,
      firsts: { goals: [], assists: [] }
    }));
    fakeKV.set('recap:Winter 2027:week_2', JSON.stringify({
      week: 2,
      achievements: [{ name: 'Player B', mark: 200 }],
      playerOfTheWeek: { name: 'Player B', pts: 6 },
      goalieOfTheWeek: { name: 'Goalie B', gaa: 1.5 },
      subOfTheWeek: null,
      firsts: { goals: [], assists: [] }
    }));

    const mockEnv = {
      SHEETS_KV: {
        get: async k => fakeKV.get(k) || null
      }
    };

    // Week 1 invite: no games yet, returns null
    const w1 = await getWeeklyHighlights(mockEnv, 1, 'Winter 2027');
    expect(w1).toBeNull();

    // Week 2 invite: normal 1-week recap of Week 1
    const w2 = await getWeeklyHighlights(mockEnv, 2, 'Winter 2027');
    expect(w2).not.toBeNull();
    expect(w2?.milestoneWeeks).toEqual([1]);
    expect(w2?.starsWeek).toBe(1);
    expect(w2?.achievements.length).toBe(1);
    expect(w2?.achievements[0].name).toBe('Player A');
    expect(w2?.playerOfTheWeek?.name).toBe('Player A');

    // Week 3 invite: normal 1-week recap of Week 2 (does NOT combine week 1 and 2!)
    const w3 = await getWeeklyHighlights(mockEnv, 3, 'Winter 2027');
    expect(w3).not.toBeNull();
    expect(w3?.milestoneWeeks).toEqual([2]);
    expect(w3?.starsWeek).toBe(2);
    expect(w3?.achievements.length).toBe(1);
    expect(w3?.achievements[0].name).toBe('Player B');
    expect(w3?.playerOfTheWeek?.name).toBe('Player B');
  });

  it('renders HTML and plain text highlights cleanly', () => {
    const highlights = {
      starsWeek: 2,
      milestoneWeeks: [1, 2],
      sourceWeeks: [1, 2],
      achievements: [{ name: 'Guillaume Thibault', mark: 500, fr: 'Guillaume Thibault a atteint 500 points en carrière!', en: 'Guillaume Thibault reached 500 career points!' }],
      playerOfTheWeek: { name: 'Brad Mackenzie', team: 'Black', pts: 8, g: 4, a: 4 },
      goalieOfTheWeek: { name: 'Sean Pichette', team: 'Blue', gaa: 3.5, ga: 7, w: 2 },
      subOfTheWeek: { name: 'Sam Cartwright', pts: 5, g: 2, a: 3 },
      firsts: { goals: ['Max Latreille'], assists: ['Armando Tempestilli'] },
      closingIn: [{ name: 'Jerry Lalli', need: 2, type: 'a', target: 300 }]
    };

    const html = renderHighlightsHtml(highlights);
    expect(html).toContain('Faits saillants / Highlights · Sem. / Wk 1-2');
    expect(html).toContain('<b>Guillaume Thibault</b> : 500 pts');
    expect(html).toContain('Joueur / Player');
    expect(html).toContain('<b>Brad Mackenzie</b>, 8 pts');
    expect(html).toContain('Gardien / Goalie');
    expect(html).toContain('<b>Sean Pichette</b>, 3.50 MOY');
    expect(html).toContain('Substitut / Sub');
    expect(html).toContain('<b>Sam Cartwright</b>, 5 pts');
    expect(html).toContain('But / Goal');
    expect(html).toContain('<b>Max Latreille</b>');
    expect(html).toContain('<b>Jerry Lalli</b> : 300 passes (-2)');
    expect(html).toContain('Tout voir sur smbhl.com / See all on smbhl.com');

    const text = renderHighlightsText(highlights);
    expect(text).toContain('Faits saillants / Highlights · Sem. / Wk 1-2');
    expect(text).toContain('Guillaume Thibault : 500 pts');
    expect(text).toContain('Joueur / Player : Brad Mackenzie, 8 pts');
    expect(text).toContain('Gardien / Goalie : Sean Pichette, 3.50 MOY');
    expect(text).toContain('Substitut / Sub : Sam Cartwright, 5 pts');
    expect(text).toContain('But / Goal\nMax Latreille');
    expect(text).toContain('Jerry Lalli : 300 passes (-2)');
    expect(text).toContain('Tout voir sur smbhl.com / See all on smbhl.com : https://smbhl.com');
  });

  it('renders the "see all" footer link under a custom league config instead of smbhl.com', () => {
    const highlights = {
      starsWeek: 1,
      milestoneWeeks: [1],
      sourceWeeks: [1],
      playerOfTheWeek: { name: 'Test Player', team: 'Hawks', pts: 5, g: 2, a: 3 }
    };
    const leagueCfg = {
      name: 'TestLeague2026',
      tagline: 'Test League of the Testing Suite',
      fromEmail: 'test@testleague.example',
      replyToEmail: 'reply@testleague.example',
      siteUrl: 'https://testleague.example',
      faviconUrl: 'https://testleague.example/favicon.svg'
    };

    const html = renderHighlightsHtml(highlights, leagueCfg);
    expect(html).toContain('Tout voir sur testleague.example / See all on testleague.example');
    expect(html).toContain('href="https://testleague.example"');
    expect(html).not.toContain('smbhl.com');

    const text = renderHighlightsText(highlights, leagueCfg);
    expect(text).toContain('Tout voir sur testleague.example / See all on testleague.example : https://testleague.example');
    expect(text).not.toContain('smbhl.com');
  });

  it('tracks 75 milestones, infinite 1000+ ladder, and goalie first win / shutout', () => {
    const mockData = {
      current_season: 'Fall 2026',
      seasons: [{ name: 'Fall 2026' }],
      players: [
        {
          id: 'P_LEGEND',
          name: 'Super Legend',
          seasons: { 'Fall 2026': { team: 'Red', gp: 1, g: 2, a: 3, pts: 5 } },
          career: { gp: 450, g: 800, a: 700, pts: 1500 } // Crossed 1500 points!
        },
        {
          id: 'P_RISING',
          name: 'Rising Star',
          seasons: { 'Fall 2026': { team: 'Blue', gp: 1, g: 3, a: 1, pts: 4 } },
          career: { gp: 50, g: 75, a: 25, pts: 100 } // Crossed 75 goals!
        },
        {
          id: 'G_NEW',
          name: 'Fresh Goalie',
          gseasons: { 'Fall 2026': { team: 'White', gp: 1, ga: 0, w: 1, l: 0, t: 0 } },
          gcareer: { gp: 1, w: 1, so: 1, ga: 0 } // First career win & first career shutout!
        }
      ]
    };

    const mockGame = [
      {
        home_team: 'Red',
        away_team: 'Black',
        home_score: 5,
        away_score: 2,
        home_players: [{ id: 'P_LEGEND', name: 'Super Legend', goals: 2, assists: 3, absent: false }],
        away_players: [],
        home_goalie: { name: 'Some Goalie', ga: 2 },
        away_goalie: { name: 'Other Goalie', ga: 5 }
      },
      {
        home_team: 'Blue',
        away_team: 'White',
        home_score: 4,
        away_score: 0,
        home_players: [{ id: 'P_RISING', name: 'Rising Star', goals: 3, assists: 1, absent: false }],
        away_players: [],
        home_goalie: { id: 'G_NEW', name: 'Fresh Goalie', ga: 0 },
        away_goalie: { name: 'Sean Pichette', ga: 4 }
      }
    ];

    const recap = computeWeeklyRecap(mockData, 2, mockGame);

    // Legend crossed 1500 points
    const legAch = recap.achievements.find(a => a.name === 'Super Legend' && a.mark === 1500);
    expect(legAch).toBeDefined();

    // Rising star crossed 75 goals
    const riseAch = recap.achievements.find(a => a.name === 'Rising Star' && a.mark === 75);
    expect(riseAch).toBeDefined();

    // Goalie first win & first shutout
    expect(recap.firsts.wins).toContain('Fresh Goalie');
    expect(recap.firsts.shutouts).toContain('Fresh Goalie');

    // Rendering test
    const html = renderHighlightsHtml({
      starsWeek: 2,
      achievements: recap.achievements,
      firsts: recap.firsts,
      closingIn: []
    });
    expect(html).toContain('Victoire / Win');
    expect(html).toContain('Blanchissage / Shutout');
    expect(html).toContain('Fresh Goalie');
  });

  it('detects all-time Top 25 skater points and Top 10 goalie wins movements (Option C)', () => {
    // Generate 30 skaters
    const players = [];
    for (let i = 1; i <= 30; i++) {
      players.push({
        id: `P_${i}`,
        name: i === 9 ? 'Carlo Mirarchi' : i === 10 ? 'Nicola Tiberio' : `Skater ${i}`,
        career: {
          pts: 1000 - i * 10, // Rank 1: 990, Rank 9 (Carlo): 910, Rank 10 (Nicola): 900
          g: 300,
          a: 700 - i * 10
        }
      });
    }
    // Add 15 goalies
    for (let i = 1; i <= 15; i++) {
      players.push({
        id: `G_${i}`,
        name: i === 10 ? 'Michael Pacheco' : i === 11 ? 'Fabio Russo' : `Goalie ${i}`,
        gcareer: {
          w: 50 - i * 2, // Rank 1: 48, Rank 10 (Michael): 30, Rank 11 (Fabio): 28
          gp: 100 + i * 2,
          ga: 400
        }
      });
    }

    const skaterStats = new Map();
    skaterStats.set('P_10', { id: 'P_10', name: 'Nicola Tiberio', g: 5, a: 10, pts: 15 });

    const goalieStats = new Map();
    goalieStats.set('G_11', { id: 'G_11', name: 'Fabio Russo', gp: 3, ga: 6, w: 3 });

    // Update player career cumulative stats to reflect post-game numbers (as data.json does)
    const nicola = players.find(p => p.id === 'P_10');
    nicola.career.pts += 15;
    nicola.career.g += 5;
    nicola.career.a += 10;

    const fabio = players.find(p => p.id === 'G_11');
    fabio.gcareer.w += 3;
    fabio.gcareer.gp += 3;
    fabio.gcareer.ga += 6;

    const movements = computeAllTimeRankMovements(players, skaterStats, goalieStats);
    expect(movements).toHaveLength(2);

    const nicolaMove = movements.find(m => m.name === 'Nicola Tiberio');
    expect(nicolaMove).toBeDefined();
    expect(nicolaMove.rank).toBe(9);
    expect(nicolaMove.priorRank).toBe(10);
    expect(nicolaMove.passedNames).toEqual(['Carlo Mirarchi']);
    expect(nicolaMove.fr).toBe('9e rang historique · 915 pts (dépasse Carlo Mirarchi)');

    const fabioMove = movements.find(m => m.name === 'Fabio Russo');
    expect(fabioMove).toBeDefined();
    expect(fabioMove.rank).toBe(10);
    expect(fabioMove.priorRank).toBe(11);
    expect(fabioMove.passedNames).toEqual(['Michael Pacheco']);
    expect(fabioMove.fr).toBe('10e rang historique · 31 victoires (dépasse Michael Pacheco)');

    // HTML Rendering test
    const html = renderHighlightsHtml({
      starsWeek: 2,
      achievements: movements,
      firsts: { goals: [], assists: [] },
      closingIn: []
    });
    expect(html).toContain('Plateaux / Milestones');
    expect(html).toContain('<b>Nicola Tiberio</b> : 9e rang historique · 915 pts (dépasse Carlo Mirarchi)');
    expect(html).toContain('<b>Fabio Russo</b> : 10e rang historique · 31 victoires (dépasse Michael Pacheco)');

    // Plain text Rendering test
    const text = renderHighlightsText({
      starsWeek: 2,
      achievements: movements,
      firsts: { goals: [], assists: [] },
      closingIn: []
    });
    expect(text).toContain('Plateaux / Milestones');
    expect(text).toContain('Nicola Tiberio : 9e rang historique · 915 pts (dépasse Carlo Mirarchi)');
    expect(text).toContain('Fabio Russo : 10e rang historique · 31 victoires (dépasse Michael Pacheco)');
  });

  it('handles goal tiebreaker for skaters and games-played tiebreaker for goalies', () => {
    const players = [
      {
        id: 'P_A',
        name: 'Player Alpha',
        career: { pts: 500, g: 150, a: 350 }
      },
      {
        id: 'P_B',
        name: 'Player Beta',
        career: { pts: 500, g: 160, a: 340 }
      },
      {
        id: 'G_A',
        name: 'Goalie Alpha',
        gcareer: { w: 20, gp: 50, ga: 150 }
      },
      {
        id: 'G_B',
        name: 'Goalie Beta',
        gcareer: { w: 20, gp: 40, ga: 120 }
      }
    ];

    const skaterStats = new Map();
    skaterStats.set('P_B', { id: 'P_B', name: 'Player Beta', g: 2, a: 0, pts: 2 });

    const goalieStats = new Map();
    goalieStats.set('G_B', { id: 'G_B', name: 'Goalie Beta', gp: 1, ga: 2, w: 1 });

    const movements = computeAllTimeRankMovements(players, skaterStats, goalieStats);
    const skaterMove = movements.find(m => m.name === 'Player Beta');
    expect(skaterMove).toBeDefined();
    expect(skaterMove.rank).toBe(1);
    expect(skaterMove.passedNames).toEqual(['Player Alpha']);
    expect(skaterMove.fr).toBe('1er rang historique · 500 pts (dépasse Player Alpha)');

    const goalieMove = movements.find(m => m.name === 'Goalie Beta');
    expect(goalieMove).toBeDefined();
    expect(goalieMove.rank).toBe(1);
    expect(goalieMove.passedNames).toEqual(['Goalie Alpha']);
    expect(goalieMove.fr).toBe('1er rang historique · 20 victoires (dépasse Goalie Alpha)');
  });

  it('requires passing someone ("only passing counts") and enforces Top 25 / Top 10 boundaries', () => {
    const players = [
      {
        id: 'P_SOLO',
        name: 'Solo Leader',
        career: { pts: 1000, g: 400, a: 600 }
      },
      {
        id: 'P_OUTSIDE',
        name: 'Outside Player',
        career: { pts: 100, g: 30, a: 70 }
      },
      {
        id: 'G_OUTSIDE',
        name: 'Outside Goalie',
        gcareer: { w: 5, gp: 15, ga: 45 }
      }
    ];

    // Pad players so Outside Player is well outside Top 25
    for (let i = 1; i <= 35; i++) {
      players.push({
        id: `P_PAD_${i}`,
        name: `Pad Skater ${i}`,
        career: { pts: 500 - i * 5, g: 100, a: 400 - i * 5 }
      });
    }
    // Pad goalies so Outside Goalie is well outside Top 10
    for (let i = 1; i <= 15; i++) {
      players.push({
        id: `G_PAD_${i}`,
        name: `Pad Goalie ${i}`,
        gcareer: { w: 30 - i, gp: 50, ga: 150 }
      });
    }

    const skaterStats = new Map();
    skaterStats.set('P_SOLO', { id: 'P_SOLO', name: 'Solo Leader', g: 2, a: 3, pts: 5 });
    skaterStats.set('P_OUTSIDE', { id: 'P_OUTSIDE', name: 'Outside Player', g: 5, a: 5, pts: 10 });

    const goalieStats = new Map();
    goalieStats.set('G_OUTSIDE', { id: 'G_OUTSIDE', name: 'Outside Goalie', gp: 1, ga: 1, w: 1 });

    const movements = computeAllTimeRankMovements(players, skaterStats, goalieStats);
    expect(movements.find(m => m.name === 'Solo Leader')).toBeUndefined();
    expect(movements.find(m => m.name === 'Outside Player')).toBeUndefined();
    expect(movements.find(m => m.name === 'Outside Goalie')).toBeUndefined();
  });

  it('lists all passed players when jumping multiple ranks in one week', () => {
    const players = [
      { id: 'P_1', name: 'Leader Skater', career: { pts: 900, g: 300, a: 600 } },
      { id: 'P_2', name: 'Second Skater', career: { pts: 800, g: 250, a: 550 } },
      { id: 'P_3', name: 'Third Skater', career: { pts: 790, g: 240, a: 550 } },
      { id: 'P_4', name: 'Jumping Skater', career: { pts: 810, g: 260, a: 550 } }
    ];

    const skaterStats = new Map();
    skaterStats.set('P_4', { id: 'P_4', name: 'Jumping Skater', g: 10, a: 20, pts: 30 });

    const movements = computeAllTimeRankMovements(players, skaterStats, new Map());
    expect(movements).toHaveLength(1);
    const jump = movements[0];
    expect(jump.name).toBe('Jumping Skater');
    expect(jump.rank).toBe(2);
    expect(jump.passedNames).toEqual(['Second Skater', 'Third Skater']);
    expect(jump.fr).toBe('2e rang historique · 810 pts (dépasse Second Skater, Third Skater)');
  });
});

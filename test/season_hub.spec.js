import { describe, it, expect } from 'vitest';
import {
  computePlayerMetrics,
  stratifySkaters,
  evaluateRosterCost,
  autoDraftTeams,
  suggestCounterSwap,
  generateScheduleMatrix,
  generateRoundRobinRounds,
  renderSeasonPage
} from '../src/season_hub.js';

describe('Season Hub - Valuation & Stratification', () => {
  it('computes metrics for a top skater with high recent attendance', () => {
    const player = { id: 'P0001', name: 'Adam Albanese', pos: 'F' };
    const career = { gp: 100, pts: 200 };
    const recentSeasons = [
      { gp: 22, pts: 44, sched: 28 },
      { gp: 20, pts: 40, sched: 28 }
    ];
    const m = computePlayerMetrics(player, career, recentSeasons);
    expect(m.isGoalie).toBe(false);
    expect(m.pos).toBe('F');
    expect(m.carPpg).toBe(2.0);
    expect(m.recPpg).toBe(2.0);
    expect(m.weightedPpg).toBe(2.0);
    expect(m.reliability).toBeGreaterThanOrEqual(0.95);
    expect(m.evm).toBeGreaterThan(1.8);
  });

  it('computes goalie metrics correctly with GAA', () => {
    const goalie = {
      id: 'G0001',
      name: 'Anthony Saragoca',
      is_goalie: 1,
      gcareer: { gp: 20, ga: 96 }
    };
    const m = computePlayerMetrics(goalie, null);
    expect(m.isGoalie).toBe(true);
    expect(m.pos).toBe('G');
    expect(m.gaa).toBe(4.8);
    expect(m.evm).toBe(5.2);
  });

  it('stratifies 28 skaters into tiers 1, 2, 3, 4', () => {
    const mockSkaters = Array.from({ length: 28 }, (_, i) => ({
      playerId: `P${i + 1}`,
      name: `Player ${i + 1}`,
      evm: 3.5 - (i * 0.1),
      pos: i % 3 === 0 ? 'D' : 'F'
    }));

    const stratified = stratifySkaters(mockSkaters);
    expect(stratified).toHaveLength(28);

    const t1 = stratified.filter(s => s.tier === 1);
    const t2 = stratified.filter(s => s.tier === 2);
    const t3 = stratified.filter(s => s.tier === 3);
    const t4 = stratified.filter(s => s.tier === 4);

    expect(t1).toHaveLength(4);
    expect(t2).toHaveLength(8);
    expect(t3).toHaveLength(8);
    expect(t4).toHaveLength(8);
  });
});

describe('Season Hub - Auto-Draft & Parity Engine', () => {
  it('drafts 4 balanced teams respecting tier distribution and goalie assignments', () => {
    // 28 skaters: 4 T1, 8 T2, 8 T3, 8 T4 (some D, some F)
    const skaters = Array.from({ length: 28 }, (_, i) => ({
      playerId: `P${i + 1}`,
      name: `Player ${i + 1}`,
      evm: parseFloat((3.8 - (i * 0.11)).toFixed(2)),
      weightedPpg: parseFloat((3.5 - (i * 0.10)).toFixed(2)),
      carPpg: parseFloat((3.5 - (i * 0.10)).toFixed(2)),
      pos: (i % 3 === 0) ? 'D' : 'F'
    }));

    const goalies = [
      { playerId: 'G1', name: 'Saragoca', isGoalie: true, gaa: 4.8 },
      { playerId: 'G2', name: 'Pichette', isGoalie: true, gaa: 5.2 },
      { playerId: 'G3', name: 'Flood', isGoalie: true, gaa: 5.4 },
      { playerId: 'G4', name: 'Taillefer', isGoalie: true, gaa: 5.1 }
    ];

    // Pin a captain and a goalie
    const pinned = {
      P1: 'Red',
      G1: 'Blue'
    };

    // Tandem brothers
    const tandems = [['P2', 'P15']];

    const result = autoDraftTeams({
      skaters,
      goalies,
      pinned,
      tandems,
      maxIterations: 2000
    });

    expect(result.rosters.Red).toHaveLength(7);
    expect(result.rosters.Blue).toHaveLength(7);
    expect(result.rosters.White).toHaveLength(7);
    expect(result.rosters.Black).toHaveLength(7);

    // Goalies assigned
    expect(result.goalies.Blue.playerId).toBe('G1');
    expect(result.goalies.Red).toBeDefined();

    // P1 pinned to Red
    expect(result.rosters.Red.some(p => p.playerId === 'P1')).toBe(true);

    // Tandem P2 and P15 together on same team
    const teamP2 = Object.keys(result.rosters).find(t => result.rosters[t].some(p => p.playerId === 'P2'));
    const teamP15 = Object.keys(result.rosters).find(t => result.rosters[t].some(p => p.playerId === 'P15'));
    expect(teamP2).toBe(teamP15);

    // Parity spread should be tight
    expect(result.spread).toBeLessThanOrEqual(1.5);
    expect(result.parityScore).toBeGreaterThanOrEqual(80);
  });

  it('respects custom skatersPerTeam quota during auto-draft', () => {
    // 24 skaters across 4 teams with skatersPerTeam: 6
    const skaters = Array.from({ length: 24 }, (_, i) => ({
      playerId: `P${i + 1}`,
      name: `Player ${i + 1}`,
      evm: parseFloat((3.5 - (i * 0.1)).toFixed(2)),
      weightedPpg: parseFloat((3.2 - (i * 0.1)).toFixed(2)),
      pos: (i % 2 === 0) ? 'D' : 'F'
    }));

    const result = autoDraftTeams({
      skaters,
      skatersPerTeam: 6,
      maxIterations: 1000
    });

    expect(result.rosters.Red).toHaveLength(6);
    expect(result.rosters.Blue).toHaveLength(6);
    expect(result.rosters.White).toHaveLength(6);
    expect(result.rosters.Black).toHaveLength(6);
  });

  it('supports custom and renamed teams during auto-draft and roster evaluation', () => {
    const customTeams = ['Canadiens', 'Bruins', 'Rangers', 'Leafs'];
    const skaters = Array.from({ length: 28 }, (_, i) => ({
      playerId: `P${i + 1}`,
      name: `Player ${i + 1}`,
      evm: parseFloat((3.8 - (i * 0.11)).toFixed(2)),
      weightedPpg: parseFloat((3.5 - (i * 0.10)).toFixed(2)),
      pos: (i % 3 === 0) ? 'D' : 'F'
    }));
    const goalies = [
      { playerId: 'G1', name: 'Roy', isGoalie: true, gaa: 4.5 },
      { playerId: 'G2', name: 'Brodeur', isGoalie: true, gaa: 4.8 },
      { playerId: 'G3', name: 'Hasek', isGoalie: true, gaa: 4.2 },
      { playerId: 'G4', name: 'Price', isGoalie: true, gaa: 4.6 }
    ];

    const result = autoDraftTeams({
      skaters,
      goalies,
      teams: customTeams,
      maxIterations: 1000
    });

    expect(Object.keys(result.rosters).sort()).toEqual(customTeams.sort());
    for (const t of customTeams) {
      expect(result.rosters[t]).toHaveLength(7);
      expect(result.goalies[t]).toBeDefined();
    }
  });

  it('suggests an effective counter-swap when teams become unbalanced', () => {
    const currentRosters = {
      Red: [
        { playerId: 'P1', name: 'Elite 1', tier: 1, evm: 3.5, pos: 'F' },
        { playerId: 'P2', name: 'Elite 2', tier: 1, evm: 3.4, pos: 'F' } // Imbalance: 2 Tier 1s
      ],
      Blue: [
        { playerId: 'P3', name: 'Mid 1', tier: 3, evm: 1.5, pos: 'F' },
        { playerId: 'P4', name: 'Mid 2', tier: 3, evm: 1.4, pos: 'F' }
      ],
      White: [],
      Black: []
    };

    const swap = suggestCounterSwap({
      currentRosters,
      teamA: 'Red',
      teamB: 'Blue',
      pinned: { P1: 'Red' }
    });

    expect(swap).not.toBeNull();
    // Should suggest swapping P2 from Red to Blue in exchange for a player from Blue
    expect(swap.fromA.id).toBe('P2');
    expect(swap.newSpread).toBeLessThan(swap.oldSpread);
  });

  it('drafts 6 balanced teams when provided 42 skaters and 6 goalies', () => {
    const teams6 = ['Red', 'Blue', 'White', 'Black', 'Green', 'Gold'];
    const skaters = Array.from({ length: 42 }, (_, i) => ({
      playerId: `P${i + 1}`,
      name: `Player ${i + 1}`,
      evm: parseFloat((3.8 - (i * 0.07)).toFixed(2)),
      weightedPpg: parseFloat((3.5 - (i * 0.06)).toFixed(2)),
      carPpg: parseFloat((3.5 - (i * 0.06)).toFixed(2)),
      pos: (i % 3 === 0) ? 'D' : 'F'
    }));

    const goalies = teams6.map((t, idx) => ({
      playerId: `G${idx + 1}`,
      name: `Goalie ${t}`,
      isGoalie: true,
      gaa: 4.5 + (idx * 0.2)
    }));

    const result = autoDraftTeams({
      skaters,
      goalies,
      teams: teams6,
      maxIterations: 3000
    });

    expect(Object.keys(result.rosters)).toHaveLength(6);
    teams6.forEach(t => {
      expect(result.rosters[t]).toHaveLength(7);
      expect(result.goalies[t]).toBeDefined();
    });
    expect(result.spread).toBeLessThanOrEqual(2.0);
    expect(result.parityScore).toBeGreaterThanOrEqual(75);
  });
});

describe('Season Hub - Schedule Generator', () => {
  it('generates Berger round robin rounds correctly for 4 and 6 teams', () => {
    const rounds4 = generateRoundRobinRounds(['Red', 'Blue', 'White', 'Black']);
    expect(rounds4).toHaveLength(3);
    rounds4.forEach(r => expect(r).toHaveLength(2));

    const rounds6 = generateRoundRobinRounds(['Red', 'Blue', 'White', 'Black', 'Green', 'Gold']);
    expect(rounds6).toHaveLength(5);
    rounds6.forEach(r => expect(r).toHaveLength(3));
  });

  it('generates 56 fixtures for 14 weeks of Letendre doubleheaders', () => {
    const { fixtures, events } = generateScheduleMatrix({
      seasonName: 'Winter 2027',
      startDate: '2027-01-10',
      weeksCount: 14,
      byeDates: ['2027-02-07'] // e.g. Super Bowl Sunday bye
    });

    expect(events).toHaveLength(14);
    expect(fixtures).toHaveLength(14 * 4); // 56 fixtures

    // Verify Week 1 fixtures
    const w1Fixtures = fixtures.filter(f => f.week === 1);
    expect(w1Fixtures).toHaveLength(4);
    expect(w1Fixtures.filter(f => f.time === '10:30 AM')).toHaveLength(2);
    expect(w1Fixtures.filter(f => f.time === '11:30 AM')).toHaveLength(2);
    expect(w1Fixtures[0].stays).toBeDefined();

    // Verify the bye date was skipped and total weeks is still 14
    expect(events.some(e => e.id === '2027-02-07')).toBe(false);
    expect(events[events.length - 1].week).toBe(14);
  });

  it('generates schedule from custom slots across weekends (Saturday & Sunday) with playoffs', () => {
    const customSlots = [
      {
        date: '2027-01-09',
        venue: 'Letendre',
        slots: [
          { time: '19:00', gym: 'Gym #1' },
          { time: '20:00', gym: 'Gym #1' }
        ]
      },
      {
        date: '2027-01-10',
        venue: 'Letendre',
        slots: [
          { time: '10:30 AM', gym: 'Gym #1' },
          { time: '11:30 AM', gym: 'Gym #1' }
        ]
      },
      {
        date: '2027-01-17',
        venue: 'Letendre',
        slots: [
          { time: '10:30 AM', gym: 'Gym #1' },
          { time: '10:30 AM', gym: 'Gym #2' },
          { time: '11:30 AM', gym: 'Gym #1' },
          { time: '11:30 AM', gym: 'Gym #2' }
        ]
      }
    ];

    const { fixtures, events } = generateScheduleMatrix({
      seasonName: 'Hiver 2027',
      customSlots,
      playoffFormat: 'top4_single_day'
    });

    expect(events).toHaveLength(3);
    // Regular dates: date 0 (2 fixtures), date 1 (2 fixtures)
    // Playoff date: date 2 (week 3 has 4 playoff fixtures)
    const playoffFixtures = fixtures.filter(f => f.is_playoff);
    expect(playoffFixtures).toHaveLength(4);

    const semi1 = playoffFixtures.find(f => f.playoff_round === 'semi_1');
    const semi2 = playoffFixtures.find(f => f.playoff_round === 'semi_2');
    const final = playoffFixtures.find(f => f.playoff_round === 'final');
    const cons = playoffFixtures.find(f => f.playoff_round === 'consolation');

    expect(semi1.home).toBe('1st Seed');
    expect(semi1.away).toBe('4th Seed');
    expect(semi2.home).toBe('2nd Seed');
    expect(semi2.away).toBe('3rd Seed');
    expect(final.home).toBe('Winner SF1');
    expect(final.away).toBe('Winner SF2');
    expect(cons.home).toBe('Loser SF1');
    expect(cons.away).toBe('Loser SF2');
  });

  it('generates schedule for single gym with 6 teams', () => {
    const teams6 = ['Red', 'Blue', 'White', 'Black', 'Green', 'Gold'];
    const customSlots = [
      {
        date: '2027-01-10',
        venue: 'Letendre',
        slots: [
          { time: '10:30 AM', gym: 'Gym #1' },
          { time: '11:30 AM', gym: 'Gym #1' },
          { time: '12:30 PM', gym: 'Gym #1' }
        ]
      }
    ];

    const { fixtures } = generateScheduleMatrix({
      seasonName: 'Winter 2027',
      teams: teams6,
      customSlots,
      playoffFormat: 'none'
    });

    expect(fixtures).toHaveLength(3);
    fixtures.forEach(f => {
      expect(teams6).toContain(f.home);
      expect(teams6).toContain(f.away);
      expect(f.home).not.toBe(f.away);
      expect(f.gym).toBe('Gym #1');
    });
  });
});

describe('Season Hub - 1-Click Publishing & Database Sync', () => {
  it('publishes a new season to D1 events, contacts, and KV data.json', async () => {
    const { publishSeasonToProduction } = await import('../src/season_hub.js');
    
    // In-memory mock DB
    const dbEvents = [];
    const dbContacts = [
      { player_id: 'P1', role: 'roster', is_sub: 0, preferred_team: 'Red' },
      { player_id: 'P2', role: 'roster', is_sub: 0, preferred_team: 'Blue' },
      { player_id: 'P3', role: 'roster', is_sub: 0, preferred_team: 'White' },
      { player_id: 'P4', role: 'roster', is_sub: 0, preferred_team: 'Black' },
      { player_id: 'P5', role: 'roster', is_sub: 0, preferred_team: 'Red' } // not drafted
    ];
    const dbRsvp = [];
    const dbSettings = {};
    const dbPricing = [];

    const mockDb = {
      prepare: (sql) => {
        return {
          bind: (...args) => ({
            run: async () => {
              if (sql.includes('INSERT INTO events')) {
                dbEvents.push({ id: args[0], season: args[1], week: args[2] });
              } else if (sql.includes("role = 'roster'")) {
                const c = dbContacts.find(x => x.player_id === args[2]);
                if (c) { c.role = 'roster'; c.preferred_team = args[0]; c.is_sub = 0; }
              } else if (sql.includes("role = 'sub'")) {
                const c = dbContacts.find(x => x.player_id === args[0]);
                if (c) { c.role = 'sub'; c.is_sub = 1; }
              } else if (sql.includes('INSERT INTO rsvp')) {
                dbRsvp.push({ event_id: args[0], player_id: args[1], team: args[2] });
              } else if (sql.includes('INSERT INTO settings')) {
                dbSettings[args[0]] = args[1];
              } else if (sql.includes('INSERT INTO season_pricing')) {
                dbPricing.push({ season: args[0], price_player: args[1], price_sub_player: args[2] });
              }
              return {};
            },
            first: async () => null,
            all: async () => {
              if (sql.includes('SELECT player_id, role FROM contacts')) {
                return { results: dbContacts };
              }
              return { results: [] };
            }
          }),
          all: async () => ({ results: dbContacts }),
          first: async () => null,
          run: async () => ({})
        };
      }
    };

    const mockKv = {
      store: {},
      get: async (k) => mockKv.store[k] || null,
      put: async (k, v) => { mockKv.store[k] = v; }
    };

    // Pre-populate data_json in mockKv
    mockKv.store['data_json'] = JSON.stringify({
      current_season: 'Fall 2026',
      seasons: { '0': { name: 'Fall 2026', current: true } },
      players: { P1: {}, P2: {}, P3: {}, P4: {} }
    });

    const rosters = {
      Red: [{ playerId: 'P1', pos: 'F' }],
      Blue: [{ playerId: 'P2', pos: 'D' }],
      White: [{ playerId: 'P3', pos: 'F' }],
      Black: [{ playerId: 'P4', pos: 'D' }]
    };

    const events = [
      { id: '2027-01-10', season: 'Winter 2027', week: 1, date: 'Sunday Jan 10', venue: 'Letendre', state: 'open', start_time: '10:30', end_time: '12:30' }
    ];

    const fixtures = [
      { week: 1, date: 'Sunday Jan 10', venue: 'Letendre', time: '10:30 AM', gym: 'Gym #1', home: 'Red', away: 'Blue' }
    ];

    const res = await publishSeasonToProduction({ DB: mockDb, SHEETS_KV: mockKv }, {
      seasonName: 'Winter 2027',
      startDate: '2027-01-10',
      rosters,
      fixtures,
      events,
      fees: { regularDues: 220, subFee: 15 }
    });

    expect(res.ok).toBe(true);
    expect(res.seasonName).toBe('Winter 2027');
    expect(dbEvents).toHaveLength(1);
    expect(dbRsvp).toHaveLength(4);

    // Auto-sync into season_pricing verified
    expect(dbPricing).toHaveLength(1);
    expect(dbPricing[0].season).toBe('Winter 2027');
    expect(dbPricing[0].price_player).toBe(220);
    expect(dbPricing[0].price_sub_player).toBe(15);

    // P5 wasn't drafted so they become sub
    const p5 = dbContacts.find(x => x.player_id === 'P5');
    expect(p5.role).toBe('sub');
    expect(p5.is_sub).toBe(1);

    // Check data_json in KV
    const updatedData = JSON.parse(mockKv.store['data_json']);
    expect(updatedData.current_season).toBe('Winter 2027');
    expect(updatedData.players.P1.seasons['Winter 2027'].team).toBe('Red');
  });

  it('renders Season Hub with comprehensive bilingual data-i18n tags and client dictionary', async () => {
    const html = await renderSeasonPage(null, true, '<div id="tabs"></div>', '<div id="gate"></div>');

    // Navigation and headers
    expect(html).toContain('data-i18n="hubTitle"');
    expect(html).toContain('data-i18n="step1Nav"');
    expect(html).toContain('data-i18n="step2Nav"');
    expect(html).toContain('data-i18n="step3Nav"');
    expect(html).toContain('data-i18n="step4Nav"');
    expect(html).toContain('data-i18n="step5Nav"');

    // Controls and tables
    expect(html).toContain('data-i18n="step1CardTitle"');
    expect(html).toContain('data-i18n="rosterCardTitle"');
    expect(html).toContain('data-i18n="parityTitle"');
    expect(html).toContain('data-i18n="schedTitle"');
    expect(html).toContain('data-i18n="step5Title"');
    expect(html).toContain('data-i18n="launchOfficialBtn"');

    // Client script I18N and language handler
    expect(html).toContain('const I18N = {');
    expect(html).toContain('fr: {');
    expect(html).toContain('en: {');
    expect(html).toContain("hubTitle: 'Season Launch Hub 🏒'");
    expect(html).toContain('function applyLanguage(lang)');
    expect(html).toContain("window.addEventListener('admin_lang_changed'");
    expect(html).toContain('labelEn:');
  });
});


// Publishing a scoresheet never changes or clears a regular's season team.
// A game for another team is a sub appearance, recorded in "with" only.
//
// Production, Fall 2026 week 3: Carlo Russo (White) played one game for White
// and one as a flagged sub for Red the same night. The publish merged both
// games into one record (team = his first game's, sub = any game flagged),
// set his season team to null for the rest of the season, and filed both
// games under "with White". Brandon Cummings (Black) played for Red and was
// nulled the same way. Finance, awards, highlights and the people view all
// read that null as "sub".
import { describe, it, expect } from 'vitest';
import { updateLeagueDataWithReview } from '../src/review.js';

const SEASON = 'Fall 2026';
const fixtures = [
  { week: 3, time: '10:30 AM', home: 'Red', away: 'Black' }, { week: 3, time: '10:30 AM', home: 'Blue', away: 'White' },
  { week: 3, time: '11:30 AM', home: 'Red', away: 'White' }, { week: 3, time: '11:30 AM', home: 'Blue', away: 'Black' },
  { week: 4, time: '10:30 AM', home: 'Red', away: 'Black' }
];
const skater = (id, name, goals = 0, isSub = false) => ({ id, name, goals, assists: 0, absent: false, is_sub: isSub });
const game = (home, away, hs, as, homePlayers, awayPlayers) => ({
  home_team: home, away_team: away, home_score: hs, away_score: as,
  home_goalie: { name: `${home} Goalie`, id: null, ga: as }, away_goalie: { name: `${away} Goalie`, id: null, ga: hs },
  home_players: homePlayers, away_players: awayPlayers
});
function league() {
  return {
    current_season: SEASON,
    seasons: [{ name: SEASON, fixtures: JSON.parse(JSON.stringify(fixtures)), standings: [] }],
    players: [
      { id: 'P0050', name: 'Carlo Russo', seasons: { [SEASON]: { team: 'White', pos: 'D', gp: 4, g: 2, a: 3, pts: 5 } }, gseasons: {}, career: { gp: 4, g: 2, a: 3, pts: 5 }, gcareer: { gp: 0, w: 0, l: 0, t: 0, ga: 0, so: 0 } },
      { id: 'P0291', name: 'Brandon Cummings', seasons: { [SEASON]: { team: 'Black', pos: 'F', gp: 0, g: 0, a: 0, pts: 0 } }, gseasons: {}, career: { gp: 0, g: 0, a: 0, pts: 0 }, gcareer: { gp: 0, w: 0, l: 0, t: 0, ga: 0, so: 0 } }
    ]
  };
}
// Week 3 as it happened: Carlo for White (10:30) and as a sub for Red (11:30); Brandon a sub for Red twice;
// a brand-new player (a genuine sub) for Black.
const week3 = [
  game('Red', 'Black', 2, 1, [skater('P0291', 'Brandon Cummings', 1, true)], [skater(null, 'Nouveau Sub', 1, true)]),
  game('Blue', 'White', 1, 2, [], [skater('P0050', 'Carlo Russo', 1)]),
  game('Red', 'White', 3, 2, [skater('P0050', 'Carlo Russo', 1, true), skater('P0291', 'Brandon Cummings', 0, true)], []),
  game('Blue', 'Black', 0, 0, [], [])
];

describe('Publishing keeps a regular\'s season team', () => {
  const d = updateLeagueDataWithReview(league(), 3, week3, new Set());
  const season = id => d.players.find(p => p.id === id).seasons[SEASON];

  it('Carlo stays White; his game for Red is recorded under "with Red" only; totals count both games', () => {
    expect(season('P0050')).toEqual({ team: 'White', pos: 'D', gp: 6, g: 4, a: 3, pts: 7, with: { Red: { gp: 1, g: 1, a: 0, pts: 1 } } });
  });

  it('Brandon stays Black, with both Red games under "with Red"', () => {
    expect(season('P0291')).toEqual({ team: 'Black', pos: 'F', gp: 2, g: 1, a: 0, pts: 1, with: { Red: { gp: 2, g: 1, a: 0, pts: 1 } } });
  });

  it('a genuine sub (no season entry, every game flagged) still has no team and a "with" entry', () => {
    const sub = d.players.find(p => p.name === 'Nouveau Sub').seasons[SEASON];
    expect(sub).toMatchObject({ team: null, gp: 1, with: { Black: { gp: 1, g: 1, a: 0, pts: 1 } } });
  });

  it('a later publish still does not touch the team: Carlo appears on White for week 4 as usual', () => {
    const d4 = updateLeagueDataWithReview(d, 4, [game('Red', 'Black', 1, 1, [], [])], new Set());
    expect(d4.players.find(p => p.id === 'P0050').seasons[SEASON].team).toBe('White');
    expect(d4.players.find(p => p.id === 'P0291').seasons[SEASON].team).toBe('Black');
  });
});

// D1 (nights), decided 2026-09-30, revised: an admin marking a player IN
// or OUT covers the player's NIGHT, as the player's own answer does. One
// game is changed with the admin's per-game "Not this game".
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must, one, installMailCapture, removeMailCapture } from './support/league_season.js';

beforeAll(async () => {
  env.AUTH_SECRET = 'p171'; env.RSVP_SECRET = 'p171r'; env.RESEND_API_KEY = 'p171'; env.MAIL_DAILY_CAP = '';
  await applyRealSchema(env);
  installMailCapture();
});
afterAll(() => removeMailCapture());

const DATE = '2099-07-07';
async function league(tag, create) {
  const a = await admin(tag);
  await must(a.post('/leagues/create', { name: 'Admin night ' + tag, ...create }), 'create');
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  let rink = 0;
  const game = async (start_time, end_time, extra = {}) => (await must(a.post('/league/events', { date: DATE, season: 'S1', venue: 'Rink ' + (++rink), start_time, end_time, ...extra }), 'game')).event;
  const player = async (name, extra = {}) => (await must(a.post('/league/contacts', { name, email: name.toLowerCase().replace(/ /g, '.') + '@example.com', role: 'roster', ...extra }), 'contact')).contact;
  const set = (ev, p, status, scope) => a.post('/league/rsvp/admin', { event_id: ev.id, player_id: p.player_id, status, ...(scope ? { scope } : {}) });
  return { a, game, player, set };
}
const statusOf = async (ev, p) => { const r = await one('SELECT status, status_by FROM rsvp WHERE event_id = ? AND player_id = ?', ev.id, p.player_id); return r ? (r.status === 'out' && r.status_by === 'night' ? 'elsewhere' : r.status) : null; };

describe('An admin\'s IN or OUT is for the night', () => {
  it('fixed teams: IN from one game puts the player in each of their team\'s games; OUT takes them out of all', async () => {
    const { game, player, set } = await league('p171fixed', { teamNames: ['Bears', 'Otters', 'Wolves', 'Owls'] });
    const A = await game('19:00', '20:00', { home_team: 'Bears', away_team: 'Otters' });
    const B = await game('20:00', '21:00', { home_team: 'Bears', away_team: 'Wolves' });
    const C = await game('20:00', '21:00', { home_team: 'Otters', away_team: 'Owls' });
    const p = await player('Ada Admin', { team: 'Bears' });
    await must(set(A, p, 'in'), 'in');
    expect([await statusOf(A, p), await statusOf(B, p), await statusOf(C, p)]).toEqual(['in', 'in', null]);
    expect((await one('SELECT status_by FROM rsvp WHERE event_id = ? AND player_id = ?', B.id, p.player_id)).status_by).toBe('manager');
    await must(set(B, p, 'out'), 'out');
    expect([await statusOf(A, p), await statusOf(B, p)]).toEqual(['out', 'out']);
  });

  it('"Not this game" is this game only, and the admin can reach it on the game page', async () => {
    const { a, game, player, set } = await league('p171game', { teamNames: ['Bears', 'Otters', 'Wolves', 'Owls'] });
    const A = await game('19:00', '20:00', { home_team: 'Bears', away_team: 'Otters' });
    const B = await game('20:00', '21:00', { home_team: 'Bears', away_team: 'Wolves' });
    const p = await player('Gus Game', { team: 'Bears' });
    await must(set(A, p, 'in'), 'in');
    await must(set(B, p, 'out', 'game'), 'not this game');
    expect([await statusOf(A, p), await statusOf(B, p)]).toEqual(['in', 'out']);
    const html = (await a.get(`/league/events/detail?e=${encodeURIComponent(B.id)}`)).text;
    expect(html).toContain(`data-game-out="${p.player_id}"`);
    expect(html).toContain('data-i18n="nightScopeHelp"');
    expect(html).toContain("setPlayerStatus('" + p.player_id + "','out',this,'game')");
    // A one-game night's page has neither.
    const { a: a2, game: game2, player: player2 } = await league('p171single', { teamNames: ['Bears', 'Otters'] });
    const S = await game2('19:00', '20:00', { home_team: 'Bears', away_team: 'Otters' });
    await player2('Sol Single', { team: 'Bears' });
    const single = (await a2.get(`/league/events/detail?e=${encodeURIComponent(S.id)}`)).text;
    expect(single).not.toContain('data-game-out=');
    expect(single).not.toContain('data-i18n="nightScopeHelp"');
    // Only OUT can be for one game.
    expect((await set(A, p, 'in', 'game')).status).toBe(400);
  });

  it('no teams, games at the same time: IN puts the player in the admin\'s game, and never moves anyone', async () => {
    const { game, player, set } = await league('p171pool', { teamStructure: 'headcount', minPlayers: 1, maxPlayers: 4, minGoalies: 0 });
    const A = await game('10:30', '11:30'), B = await game('10:30', '11:30'), C = await game('11:30', '12:30');
    const p = await player('Pat Pool');
    await must(set(B, p, 'in'), 'in B');
    expect([await statusOf(A, p), await statusOf(B, p), await statusOf(C, p)]).toEqual(['elsewhere', 'in', 'in']);
    // Already in B: IN from A's page is refused, not a move.
    const r = await set(A, p, 'in');
    expect(r.status).toBe(409);
    expect(r.json.errorKey).toBe('PLAYER_IN_OVERLAPPING_GAME');
    expect([await statusOf(A, p), await statusOf(B, p)]).toEqual(['elsewhere', 'in']);
  });
});

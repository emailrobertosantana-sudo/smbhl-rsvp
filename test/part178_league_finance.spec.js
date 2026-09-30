// Finance, phase 2: the league product's Finances. Games played come from
// D1 -- a game that has started with the player marked in is charged, no
// admin work; stats entered confirm it; the admin's "didn't show" on the
// game page removes it. Two pricing modes per season: season fee for
// regulars and per game for subs, or per game for everyone. SMBHL's rules
// for credits, partial payments and exempt players. Session + league
// access; never SMBHL.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { DAY, H, local, admin, must, one, installMailCapture, removeMailCapture } from './support/league_season.js';

const START = Date.UTC(2026, 10, 2, 16, 0); // Mon 2026-11-02 12:00 Toronto
beforeAll(async () => {
  env.AUTH_SECRET = 'p178'; env.RSVP_SECRET = 'p178r'; env.RESEND_API_KEY = 'x'; env.MAIL_DAILY_CAP = '';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(START));
  await applyRealSchema(env);
  installMailCapture();
});
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

// A league with three games, a week apart from 20 days out; people by
// role; everyone's answer set by the admin before the games.
async function league(tag, { structure = 'headcount' } = {}) {
  const a = await admin(tag);
  const create = structure === 'headcount' ? { teamStructure: 'headcount', minPlayers: 1, maxPlayers: 20, minGoalies: 0 } : { teamNames: ['Red', 'Blue'] };
  const lg = (await must(a.post('/leagues/create', { name: 'Money ' + tag, ...create }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  // From the clock now (earlier fixtures moved it): sessions last 30 days.
  const base = Date.now() + 20 * DAY;
  const games = [];
  for (let w = 0; w < 3; w++) {
    const date = local(base + 7 * w * DAY).date;
    games.push((await must(a.post('/league/events', { date, season: 'S1', venue: 'Rink', start_time: '19:00', end_time: '20:00', ...(structure === 'fixed' ? { home_team: 'Red', away_team: 'Blue' } : {}) }), 'game')).event);
  }
  const person = async (name, role, extra = {}) => (await must(a.post('/league/contacts', { name, email: `${name.toLowerCase().replace(/ /g, '.')}.${tag}@example.com`, role, ...extra }), 'contact')).contact;
  const setIn = (p, g, status = 'in') => must(a.post('/league/rsvp/admin', { event_id: g.id, player_id: p.player_id, status }), 'answer');
  // Past the first two games (the third has not started).
  const afterTwo = () => vi.setSystemTime(new Date(Date.parse(`${games[1].date}T21:00:00-05:00`)));
  const data = async (season = 'S1') => (await a.get(`/league/finances/data?season=${encodeURIComponent(season)}`)).json;
  const byName = (d, name) => d.players.find(p => p.name === name);
  return { a, lg, games, person, setIn, afterTwo, data, byName };
}

describe('A season-fee league: regulars pay the season fee, subs pay per game played', () => {
  it('charges from D1: started games marked in; not the game to come; "didn\'t show" removes one; stats confirm', async () => {
    const { a, games, person, setIn, afterTwo, data, byName } = await league('p178season');
    const reg = await person('Rita Regular', 'roster');
    const goalie = await person('Gil Goalie', 'roster', { is_goalie: true });
    const sub = await person('Sam Sub', 'sub_skater');
    const subG = await person('Gus Subgoalie', 'sub_skater', { is_goalie: true });
    const idle = await person('Ivy Idle', 'sub_skater');
    await must(a.post('/league/finances/pricing', { season: 'S1', mode: 'season', price_player: 200, price_goalie: 50, price_game_player: 15, price_game_goalie: 5 }), 'pricing');
    await setIn(reg, games[0]);
    for (const g of games) await setIn(sub, g);
    await setIn(subG, games[0]);
    afterTwo();

    let d = await data();
    expect(d.pricing).toMatchObject({ configured: true, mode: 'season', price_player: 200, price_goalie: 50, price_game_player: 15, price_game_goalie: 5 });
    expect(byName(d, 'Rita Regular')).toMatchObject({ is_sub: false, games_played: 1, total_due: 200, status: 'unpaid' });
    expect(byName(d, 'Gil Goalie')).toMatchObject({ is_sub: false, is_goalie: true, games_played: 0, total_due: 50 }); // owes the fee before playing
    expect(byName(d, 'Sam Sub')).toMatchObject({ is_sub: true, games_played: 2, total_due: 30 }); // the third game has not started
    expect(byName(d, 'Gus Subgoalie')).toMatchObject({ is_sub: true, is_goalie: true, games_played: 1, total_due: 5 });
    expect(byName(d, 'Ivy Idle')).toBeUndefined(); // a sub with no game and no dues is not listed
    expect(d.startedGames).toBe(2);

    // "Didn't show" on game 2: one game less.
    await must(a.post('/league/events/no-show', { event_id: games[1].id, player_id: sub.player_id, no_show: true }), 'no-show');
    d = await data();
    expect(byName(d, 'Sam Sub')).toMatchObject({ games_played: 1, total_due: 15 });
    // The game page shows it, with the way back.
    const page = (await a.get(`/league/events/detail?e=${encodeURIComponent(games[1].id)}`)).text;
    expect(page).toContain('id="ev_subs_card"');
    expect(page).toContain(`data-no-show="${sub.player_id}"`);
    expect(page).toContain('data-i18n="noShowUndo"');
    await must(a.post('/league/events/no-show', { event_id: games[1].id, player_id: sub.player_id, no_show: false }), 'played after all');
    expect(byName(await data(), 'Sam Sub').games_played).toBe(2);

    // Stats entered confirm attendance: the mark is then refused.
    await env.DB.prepare('UPDATE leagues SET tracks_player_stats = 1 WHERE id = (SELECT league_id FROM contacts WHERE player_id = ?)').bind(sub.player_id).run();
    await must(a.post('/league/events/player-stats', { event_id: games[0].id, entries: [{ player_id: sub.player_id, role: 'skater', goals: 1, assists: 0 }] }), 'stats');
    const refused = await a.post('/league/events/no-show', { event_id: games[0].id, player_id: sub.player_id, no_show: true });
    expect(refused.status).toBe(409);
    expect(refused.json.errorKey).toBe('NO_SHOW_HAS_STATS');
    // ...and keep the game counted even if the answer is changed afterwards.
    await must(a.post('/league/rsvp/admin', { event_id: games[0].id, player_id: sub.player_id, status: 'out', scope: 'game' }), 'out after');
    expect(byName(await data(), 'Sam Sub').games_played).toBe(2);

    // Not before a game starts, and not for someone who wasn't marked in.
    const early = await a.post('/league/events/no-show', { event_id: games[2].id, player_id: sub.player_id, no_show: true });
    expect([early.status, early.json.errorKey]).toEqual([409, 'NO_SHOW_NOT_STARTED']);
    const notIn = await a.post('/league/events/no-show', { event_id: games[0].id, player_id: idle.player_id, no_show: true });
    expect([notIn.status, notIn.json.errorKey]).toEqual([409, 'NO_SHOW_NOT_IN']);
  });
});

describe('A per-game-for-all league', () => {
  it('charges everyone per game played, regulars included; a regular who never played is not listed', async () => {
    const { a, games, person, setIn, afterTwo, data, byName } = await league('p178pergame');
    const r1 = await person('Pat Pickup', 'roster');
    await person('Nel Never', 'roster');
    const s1 = await person('Sol Sub', 'sub_skater');
    const g1 = await person('Gia Goalie', 'roster', { is_goalie: true });
    await must(a.post('/league/finances/pricing', { season: 'S1', mode: 'per_game', price_player: 999, price_goalie: 999, price_game_player: 12, price_game_goalie: 0 }), 'pricing');
    await setIn(r1, games[0]); await setIn(r1, games[1]); await setIn(r1, games[2]);
    await setIn(s1, games[1]);
    await setIn(g1, games[0]);
    afterTwo();
    const d = await data();
    expect(d.pricing.mode).toBe('per_game');
    expect(byName(d, 'Pat Pickup')).toMatchObject({ is_sub: false, games_played: 2, total_due: 24 }); // the season fee does not apply
    expect(byName(d, 'Sol Sub')).toMatchObject({ is_sub: true, games_played: 1, total_due: 12 });
    expect(byName(d, 'Gia Goalie')).toMatchObject({ games_played: 1, total_due: 0, status: 'exempt' }); // goalies free here
    expect(byName(d, 'Nel Never')).toBeUndefined();
    expect(d.summary).toMatchObject({ totalDue: 36, totalPaid: 0, totalOutstanding: 36 });
  });
});

describe('Payments, credits and costs: SMBHL\'s rules', () => {
  it('partial, paid, credit, custom due, exempt; costs and the balance', async () => {
    const { a, games, person, setIn, afterTwo, data, byName } = await league('p178pay');
    const reg = await person('Paul Partial', 'roster');
    const over = await person('Olga Overpaid', 'roster');
    const custom = await person('Cal Custom', 'roster');
    const sub = await person('Sid Sub', 'sub_skater');
    await must(a.post('/league/finances/pricing', { season: 'S1', mode: 'season', price_player: 200, price_goalie: 0, price_game_player: 15, price_game_goalie: 0 }), 'pricing');
    await setIn(sub, games[0]);
    afterTwo();
    const pay = (p, body) => must(a.post('/league/finances/player', { season: 'S1', player_id: p.player_id, ...body }), 'pay');
    await pay(reg, { amount_paid: 80, notes: 'first half' });
    await pay(over, { amount_paid: 250 });
    await pay(custom, { custom_due: 120, amount_paid: 120, notes: 'late start' });
    await pay(sub, { amount_paid: 15 });
    await must(a.post('/league/finances/cost', { season: 'S1', category: 'rental', description: 'Ice', amount: 400 }), 'cost');
    const gone = await must(a.post('/league/finances/cost', { season: 'S1', category: 'other', description: 'Oops', amount: 9 }), 'cost 2');
    await must(a.post('/league/finances/cost/delete', { id: gone.id }), 'delete cost');
    const d = await data();
    expect(byName(d, 'Paul Partial')).toMatchObject({ total_due: 200, amount_paid: 80, outstanding: 120, credit: 0, status: 'partial', notes: 'first half' });
    expect(byName(d, 'Olga Overpaid')).toMatchObject({ total_due: 200, amount_paid: 250, outstanding: -50, credit: 50, status: 'paid' });
    expect(byName(d, 'Cal Custom')).toMatchObject({ custom_due: 120, total_due: 120, status: 'paid' });
    expect(byName(d, 'Sid Sub')).toMatchObject({ total_due: 15, status: 'paid' });
    expect(d.costs.map(c => [c.category, c.description, c.amount])).toEqual([['rental', 'Ice', 400]]);
    expect(d.summary).toMatchObject({ totalDue: 535, totalPaid: 465, totalOutstanding: 120, totalCredit: 50, totalCosts: 400, netBalance: 65, countPaid: 3, countUnpaid: 1 });
    // Bad input is refused.
    expect((await a.post('/league/finances/player', { season: 'S1', player_id: reg.player_id, amount_paid: -5 })).json.errorKey).toBe('FINANCE_BAD_AMOUNT');
    expect((await a.post('/league/finances/pricing', { season: 'S1', mode: 'monthly' })).json.errorKey).toBe('FINANCE_BAD_MODE');
  });
});

describe('Access and isolation', () => {
  it('another league\'s admin sees and changes only their own; a player of another league is refused; writes need the CSRF token', async () => {
    const one1 = await league('p178iso1');
    const two = await league('p178iso2');
    const p1 = await one1.person('Ana One', 'roster');
    await must(one1.a.post('/league/finances/pricing', { season: 'S1', mode: 'season', price_player: 300, price_goalie: 0, price_game_player: 20, price_game_goalie: 0 }), 'pricing 1');
    await must(two.a.post('/league/finances/pricing', { season: 'S1', mode: 'per_game', price_player: 0, price_goalie: 0, price_game_player: 7, price_game_goalie: 0 }), 'pricing 2');
    expect((await one1.data()).pricing).toMatchObject({ mode: 'season', price_player: 300 });
    expect((await two.data()).pricing).toMatchObject({ mode: 'per_game', price_game_player: 7 });
    // League two cannot record a payment for league one's player.
    const r = await two.a.post('/league/finances/player', { season: 'S1', player_id: p1.player_id, amount_paid: 1 });
    expect([r.status, r.json.errorKey]).toEqual([404, 'PLAYER_NOT_FOUND']);
    // No CSRF token: refused.
    const noCsrf = await SELF.fetch('http://example.com/league/finances/pricing', { method: 'POST', headers: { cookie: one1.a.s.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ season: 'S1', mode: 'season' }) });
    expect(noCsrf.status).toBe(403);
    // Signed out: refused.
    expect((await SELF.fetch('http://example.com/league/finances/data')).status).toBe(401);
  });
});

describe('The Finances page', () => {
  it('is in the league nav, in both languages, with its own browser code', async () => {
    const { a } = await league('p178page');
    const html = (await a.get('/league/finances')).text;
    expect(html).toContain('href="/league/finances" aria-current="page"');
    expect(html).toContain('id="fin-pricing"');
    const dict = JSON.parse(html.match(/window\.__I18N\s*=\s*(\{[\s\S]*?\});/)?.[1] || 'null');
    if (dict) {
      expect([dict.fr.modePerGame, dict.en.modePerGame]).toEqual(['Par match pour tout le monde', 'Per game for everyone']);
    } else {
      expect(html).toContain('Par match pour tout le monde');
      expect(html).toContain('Per game for everyone');
    }
    expect(html).not.toContain('__name(');
    // Every league page has the tab.
    expect((await a.get('/league/schedule')).text).toContain('href="/league/finances"');
  });
});

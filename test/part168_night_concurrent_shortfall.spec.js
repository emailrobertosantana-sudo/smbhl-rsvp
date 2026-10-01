// D1 (nights): a no-teams night with two games at the same time. A player
// who hasn't answered yet can play only one of them, and a yes goes to the
// game with the fewest (balanced, part170) -- so the shortfall check counts
// them that way too, instead of counting every waiting player as available
// for both games (which hid the second game's shortage).
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { wideSubCallWindow } from './support/wide_sub_call_window.js'; // the 8-day sub-call window this test was written for
import { admin, must, rows, local, DAY } from './support/league_season.js';

beforeAll(async () => { env.AUTH_SECRET = 'p168'; env.RSVP_SECRET = 'p168r'; env.RESEND_API_KEY = 'p168'; env.MAIL_DAILY_CAP = ''; await applyRealSchema(env); await wideSubCallWindow(env); });

describe('Games at the same time share the players who haven\'t answered', () => {
  it('3 waiting players, max 2 a game, min 2: the first game counts 2 of them and is fine; the second counts 1 and calls a sub', async () => {
    const a = await admin('p168');
    await must(a.post('/leagues/create', { name: 'Shared', teamStructure: 'headcount', minPlayers: 2, maxPlayers: 2, minGoalies: 0 }), 'create');
    await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
    for (let i = 1; i <= 3; i++) await must(a.post('/league/contacts', { name: `Wait Player${i}`, email: `wait.p${i}@example.com`, role: 'roster' }), 'player');
    await must(a.post('/league/contacts', { name: 'Sue Sub', email: 'sue.sub@example.com', role: 'sub_skater' }), 'sub');
    const date = local(Date.now() + 3 * DAY).date;
    const A = (await must(a.post('/league/events', { date, season: 'S1', venue: 'Rink 1', start_time: '19:00', end_time: '20:00' }), 'A')).event;
    const B = (await must(a.post('/league/events', { date, season: 'S1', venue: 'Rink 2', start_time: '19:00', end_time: '20:00' }), 'B')).event;
    const calls = async ev => (await rows("SELECT player_id FROM outbox WHERE event_id = ? AND kind = 'sub_call'", ev.id)).length;
    expect(await calls(A)).toBe(0);
    expect(await calls(B)).toBe(1);
    // A game that follows instead takes everyone: no call.
    const C = (await must(a.post('/league/events', { date, season: 'S1', venue: 'Rink 1', start_time: '20:00', end_time: '21:00' }), 'C')).event;
    expect(await calls(C)).toBe(0);
  });
});

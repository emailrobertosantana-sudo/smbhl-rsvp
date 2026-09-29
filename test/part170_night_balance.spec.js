// D1 (nights), decided 2026-09-30, revised: games at the same time are
// BALANCED -- each yes goes to the game with the fewest players of that
// position that still has room -- and when every one is full the player
// goes on a WAITLIST and the admin is told; nobody is pushed past a
// maximum. A waitlisted player gets the first spot that opens. The
// shortfall check counts the players who haven't answered the same way.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must, one, rows, mail, installMailCapture, removeMailCapture, local, DAY } from './support/league_season.js';
import { hmac } from '../src/crypto_utils.js';

beforeAll(async () => {
  env.AUTH_SECRET = 'p170'; env.RSVP_SECRET = 'p170r'; env.RESEND_API_KEY = 'p170'; env.MAIL_DAILY_CAP = '';
  await applyRealSchema(env);
  installMailCapture();
});
afterAll(() => removeMailCapture());

const DATE = '2099-06-06';
async function league(tag, create, date = DATE) {
  const a = await admin(tag);
  const lg = (await must(a.post('/leagues/create', { name: 'Balance ' + tag, ...create }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  let rink = 0;
  const game = async (start_time, end_time, extra = {}) => (await must(a.post('/league/events', { date, season: 'S1', venue: 'Rink ' + (++rink), start_time, end_time, ...extra }), 'game')).event;
  const player = async (name, extra = {}) => {
    const c = (await must(a.post('/league/contacts', { name, email: name.toLowerCase().replace(/ /g, '.') + '@example.com', role: 'roster', ...extra }), 'contact')).contact;
    const salt = (await one('SELECT token_salt FROM contacts WHERE player_id = ?', c.player_id)).token_salt;
    c.qs = async ev => `league=${encodeURIComponent(lg.id)}&e=${encodeURIComponent(ev.id)}&p=${encodeURIComponent(c.player_id)}&t=${await hmac(env.RSVP_SECRET, `lr:${lg.id}:${ev.id}:${c.player_id}:${salt}`)}`;
    return c;
  };
  return { a, lg, game, player };
}
const answer = async (p, ev, status) => SELF.fetch(`http://example.com/league/rsvp?${await p.qs(ev)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
const gameAnswer = async (p, ev, game, status) => SELF.fetch(`http://example.com/league/rsvp/game?${await p.qs(ev)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ game: game.id, status }) });
const page = async (p, ev) => (await SELF.fetch(`http://example.com/league/rsvp?${await p.qs(ev)}`)).text();
const statusOf = async (ev, p) => { const r = await one('SELECT status, status_by FROM rsvp WHERE event_id = ? AND player_id = ?', ev.id, p.player_id); return r ? (r.status === 'out' && r.status_by === 'night' ? 'elsewhere' : r.status === 'out' && r.status_by === 'waitlist' ? 'waitlist' : r.status) : null; };
const inIds = async ev => (await rows("SELECT player_id FROM rsvp WHERE event_id = ? AND status = 'in' ORDER BY player_id", ev.id)).map(r => r.player_id);
const dictOf = html => JSON.parse(html.match(/var RV_I18N = (\{[\s\S]*?\});\n/)[1]);

describe('Games at the same time are balanced', () => {
  it('two 10:30 games (max 3 each): yeses alternate, the 11:30 game takes everyone', async () => {
    const { game, player } = await league('p170even', { teamStructure: 'headcount', minPlayers: 1, maxPlayers: 3, minGoalies: 0 });
    const A = await game('10:30', '11:30'), B = await game('10:30', '11:30'), C = await game('11:30', '12:30');
    const ps = [];
    for (let i = 1; i <= 5; i++) ps.push(await player(`Even Player${i}`));
    for (const p of ps) expect((await answer(p, A, 'in')).status).toBe(200);
    const id = i => ps[i].player_id;
    expect(await inIds(A)).toEqual([id(0), id(2), id(4)].sort());
    expect(await inIds(B)).toEqual([id(1), id(3)].sort());
    expect(await inIds(C)).toEqual(ps.map(p => p.player_id).sort());
  });

  it('a game already ahead gets the next yes only once the other has caught up', async () => {
    const { a, game, player } = await league('p170ahead', { teamStructure: 'headcount', minPlayers: 1, maxPlayers: 6, minGoalies: 0 });
    const A = await game('19:00', '20:00'), B = await game('19:00', '20:00');
    const early = [await player('Early One'), await player('Early Two')];
    // The admin puts two in A by hand (per game, below).
    for (const p of early) await must(a.post('/league/rsvp/admin', { event_id: A.id, player_id: p.player_id, status: 'in' }), 'in A');
    expect((await inIds(A)).length).toBe(2);
    const late = [await player('Late One'), await player('Late Two'), await player('Late Three')];
    for (const p of late) await answer(p, B, 'in');
    // B catches up (2, 2), then the tie goes to the first game.
    expect(await inIds(B)).toEqual([late[0].player_id, late[1].player_id].sort());
    expect((await inIds(A)).length).toBe(3);
  });

  it('the player\'s page says so, in both languages', async () => {
    const { game, player } = await league('p170copy', { teamStructure: 'headcount', minPlayers: 1, maxPlayers: 5, minGoalies: 0 });
    const A = await game('10:30', '11:30'); await game('10:30', '11:30');
    const p = await player('Cora Copy');
    const d = dictOf(await page(p, A));
    expect(d.fr.nightNoteConcurrent).toBe('Des matchs se jouent en même temps : on répartit les joueurs également entre eux.');
    expect(d.en.nightNoteConcurrent).toBe('Some games are at the same time: we spread players evenly across them.');
  });
});

describe('Every game at that time full: the waitlist', () => {
  it('the extra yes waits instead of going past a maximum, the admin is told once, and gets the first spot that opens', async () => {
    const { a, game, player } = await league('p170wait', { teamStructure: 'headcount', minPlayers: 1, maxPlayers: 2, minGoalies: 0 });
    const A = await game('10:30', '11:30'), B = await game('10:30', '11:30'), C = await game('11:30', '12:30');
    const ps = [];
    for (let i = 1; i <= 4; i++) ps.push(await player(`Full Player${i}`));
    for (const p of ps) await answer(p, A, 'in');
    const before = mail.sent.length;
    const w = await player('Wes Waiting');
    expect((await answer(w, A, 'in')).status).toBe(200);
    expect((await inIds(A)).length).toBe(2);
    expect((await inIds(B)).length).toBe(2);
    expect([await statusOf(A, w), await statusOf(B, w), await statusOf(C, w)]).toEqual(['waitlist', 'waitlist', 'in']);
    const alerts = mail.sent.slice(before).filter(m => /Waitlist|Liste d'attente/.test(m.subject));
    expect(alerts.length).toBe(1);
    expect(alerts[0].to).toBe('admin.p170wait@example.com');
    expect(alerts[0].text).toContain('Wes Waiting');
    // Answering again: no second alert, still waiting.
    await answer(w, B, 'in');
    expect(mail.sent.slice(before).filter(m => /Waitlist|Liste d'attente/.test(m.subject)).length).toBe(1);
    // Not chased: a waitlisted player has answered.
    expect(await one("SELECT 1 AS x FROM rsvp WHERE event_id = ? AND player_id = ? AND status = 'pending'", A.id, w.player_id)).toBeNull();
    // The page says it.
    const html = await page(w, A);
    expect(html).toContain('data-game-state="waitlist"');
    const d = dictOf(html);
    expect(d.fr.gameWaitlist).toBe("Complet : tu es sur la liste d'attente");
    expect(d.en.gameWaitlist).toBe("Full: you're on the waitlist");
    // The admin's game page shows it.
    const detail = (await a.get(`/league/events/detail?e=${encodeURIComponent(A.id)}`)).text;
    expect(detail).toContain('data-i18n="statusWaitlist"');
    // A spot opens in B: Wes takes it, and A still has two.
    const inB = (await inIds(B))[0];
    const leaving = ps.find(p => p.player_id === inB);
    // With the 12h details email on, it would tell Wes; turned off, placing
    // him must.
    await must(a.post('/league/reminders/settings', { reminder72h: true, reminder24h: true, reminder12h: false }), '12h off');
    const beforePlaced = mail.sent.length;
    await answer(leaving, A, 'out');
    expect([await statusOf(A, w), await statusOf(B, w)]).toEqual(['elsewhere', 'in']);
    const told = mail.sent.slice(beforePlaced).filter(m => m.to === 'wes.waiting@example.com');
    expect(told.length).toBe(1);
    expect(told[0].subject).toMatch(/details for/);
    expect((await inIds(A)).length).toBe(2);
    expect((await inIds(B)).length).toBe(2);
  });

  it('pickup: the pool maximum is the limit', async () => {
    const { game, player } = await league('p170pick', { teamStructure: 'weekly_draw', teamNames: ['Dark', 'Light'], minPlayers: 2, maxPlayers: 4, minGoalies: 0 });
    const A = await game('20:30', '21:30'), B = await game('20:30', '21:30');
    const ps = [];
    for (let i = 1; i <= 10; i++) ps.push(await player(`Pick Player${i}`));
    for (const p of ps) await answer(p, A, 'in');
    const nA = (await inIds(A)).length, nB = (await inIds(B)).length;
    expect(Math.abs(nA - nB)).toBeLessThanOrEqual(1);
    const waiting = (await rows("SELECT player_id FROM rsvp WHERE event_id = ? AND status = 'out' AND status_by = 'waitlist'", A.id)).length;
    expect(nA + nB + waiting).toBe(10);
  });
});

describe("The shortfall check counts the players who haven't answered the same way", () => {
  it('A has 2 (max 3), B has 0, 2 waiting, minimum 2: balanced, both reach 2 -- no sub call for B', async () => {
    // Far enough out that nothing is checked while it is set up.
    const far = local(Date.now() + 20 * DAY).date;
    const { a, game, player } = await league('p170short', { teamStructure: 'headcount', minPlayers: 2, maxPlayers: 3, minGoalies: 0 }, far);
    const A = await game('19:00', '20:00'), B = await game('19:00', '20:00');
    const ps = [];
    for (let i = 1; i <= 4; i++) ps.push(await player(`Short Player${i}`));
    // Two in A: the first yes goes to A, the second to B, who then swaps to A.
    await answer(ps[0], A, 'in');
    await answer(ps[1], A, 'in');
    expect(await statusOf(B, ps[1])).toBe('in');
    await gameAnswer(ps[1], A, B, 'out');
    expect((await gameAnswer(ps[1], A, A, 'in')).status).toBe(200);
    expect((await inIds(A)).length).toBe(2);
    expect(await inIds(B)).toEqual([]);
    // Now the night is 3 days out; adding a sub checks every game.
    const near = local(Date.now() + 3 * DAY).date;
    await env.DB.prepare('UPDATE events SET date = ? WHERE id IN (?, ?)').bind(near, A.id, B.id).run();
    await must(a.post('/league/contacts', { name: 'Sue Sub', email: 'sue.sub170@example.com', role: 'sub_skater' }), 'sub');
    const calls = async ev => (await rows("SELECT player_id FROM outbox WHERE event_id = ? AND kind = 'sub_call'", ev.id)).length;
    expect(await calls(A)).toBe(0);
    expect(await calls(B)).toBe(0); // filled in order, B would count 1 of the 2 and call a sub
  });
});

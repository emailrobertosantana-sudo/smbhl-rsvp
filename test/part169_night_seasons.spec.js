// D1 (nights), decided 2026-09-30: games of two seasons on the same day
// are two nights. One answer never spans them, and each night gets its own
// emails. (No one can still be in two games at once, whatever the season.)
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { H, DAY, local, mail, installMailCapture, removeMailCapture, linksIn, admin, must, pass, rows, one } from './support/league_season.js';

const START = Date.UTC(2026, 9, 5, 16, 0); // Mon 2026-10-05 12:00 Toronto
const GAME_DAY = local(START + 5 * DAY).date; // Sat 2026-10-10
const FIRST = Date.parse(`${GAME_DAY}T19:00:00-04:00`);

beforeAll(async () => {
  env.LEAGUE_PRODUCT = 'true';
  env.RESEND_API_KEY = 'x'; env.RSVP_SECRET = 'p169'; env.AUTH_SECRET = 'p169-auth';
  env.MAIL_DAILY_CAP = '';
  env.PUBLIC_URL = 'https://rsvp.example.com';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(START));
  await applyRealSchema(env);
  installMailCapture();
});
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

describe('Two seasons on one day are two nights', () => {
  it('each night gets its own ask; a yes to one season\'s game leaves the other season\'s alone', async () => {
    const a = await admin('p169');
    await must(a.post('/leagues/create', { name: 'Two Seasons', teamStructure: 'headcount', minPlayers: 1, maxPlayers: 10, minGoalies: 0 }), 'create');
    await must(a.post('/league/season/publish', { season_name: 'Summer' }), 'publish Summer');
    await must(a.post('/league/season/publish', { season_name: 'Fall' }), 'publish Fall');
    await must(a.post('/league/reminders/settings', { reminder72h: true, reminder24h: true, reminder12h: true }), 'reminders');
    const email = 'two.seasons@example.com';
    await must(a.post('/league/contacts', { name: 'Sam Seasons', email, role: 'roster' }), 'contact');
    const A = (await must(a.post('/league/events', { date: GAME_DAY, season: 'Summer', venue: 'Gym', start_time: '19:00', end_time: '20:00' }), 'A')).event;
    const B = (await must(a.post('/league/events', { date: GAME_DAY, season: 'Fall', venue: 'Gym', start_time: '20:00', end_time: '21:00' }), 'B')).event;

    const seen = mail.sent.length;
    await pass(FIRST - 70.5 * H); // both games inside 72 h
    const asks = mail.sent.slice(seen).filter(m => m.to === email);
    expect(asks.length).toBe(2);
    const forGame = ev => asks.find(m => linksIn(m, '/league/rsvp').every(l => new URL(l).searchParams.get('e') === ev.id));
    expect(forGame(A).text).toContain('7 PM');
    expect(forGame(A).text).not.toContain('8 PM');
    expect(forGame(B).text).toContain('8 PM');
    expect(forGame(B).text).not.toContain('7 PM');

    // Yes from the Summer email: Summer's game only.
    const yes = new URL(linksIn(forGame(A), '/league/rsvp').find(l => new URL(l).searchParams.get('v') === 'in'));
    const page = await (await SELF.fetch(`http://example.com/league/rsvp?${yes.searchParams.toString()}`)).text();
    expect(page).not.toContain('rv-games'); // a one-game night
    const post = await SELF.fetch(`http://example.com/league/rsvp/confirm?${yes.searchParams.toString()}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'status=in', redirect: 'manual' });
    expect(post.status).toBe(303);
    const pid = (await one('SELECT player_id FROM contacts WHERE email = ?', email)).player_id;
    expect((await rows('SELECT event_id, status FROM rsvp WHERE player_id = ?', pid)).map(r => [r.event_id, r.status])).toEqual([[A.id, 'in']]);
  });

  it('no one is in two games at once, even of two seasons', async () => {
    const a = await admin('p169b');
    const lg = (await must(a.post('/leagues/create', { name: 'Two Seasons B', teamStructure: 'headcount', minPlayers: 1, maxPlayers: 10, minGoalies: 0 }), 'create')).league;
    await must(a.post('/league/season/publish', { season_name: 'Summer' }), 'publish Summer');
    await must(a.post('/league/season/publish', { season_name: 'Fall' }), 'publish Fall');
    const c = (await must(a.post('/league/contacts', { name: 'Olly Overlap', email: 'olly@example.com', role: 'roster' }), 'contact')).contact;
    const A = (await must(a.post('/league/events', { date: GAME_DAY, season: 'Summer', venue: 'Gym 1', start_time: '19:00', end_time: '20:00' }), 'A')).event;
    const B = (await must(a.post('/league/events', { date: GAME_DAY, season: 'Fall', venue: 'Gym 2', start_time: '19:30', end_time: '20:30' }), 'B')).event;
    await must(a.post('/league/rsvp/admin', { event_id: A.id, player_id: c.player_id, status: 'in' }), 'in A');
    const r = await a.post('/league/rsvp/admin', { event_id: B.id, player_id: c.player_id, status: 'in' });
    expect(r.status).toBe(409);
    expect(r.json.errorKey).toBe('PLAYER_IN_OVERLAPPING_GAME');
    expect(lg.id).toBeTruthy();
  });
});

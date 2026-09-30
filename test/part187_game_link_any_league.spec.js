// A game link opens the game in any league the signed-in admin runs.
//
// Before, the game page looked the game up in the admin's most recent
// league only: an admin of two leagues who clicked an email about the older
// one got "Game not found". Now the league that owns the game is used when
// the admin runs it, and it becomes the current league (the nl_league
// cookie), so the page's own actions act on it. A game of a league the
// admin does not run is answered exactly like a game that does not exist.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must } from './support/league_season.js';

const BASE = 'http://example.com';
let a, b, older, newer, other, gOlder, gOther;

beforeAll(async () => {
  env.AUTH_SECRET = 'p187-auth'; env.RSVP_SECRET = 'p187-rsvp'; env.LEAGUE_PRODUCT = 'true';
  await applyRealSchema(env);
  a = await admin('p187.two');
  older = (await must(a.post('/leagues/create', { name: 'Older League', teamNames: ['A', 'B'] }), 'older')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'season');
  gOlder = (await must(a.post('/league/events', { date: '2099-05-05', start_time: '19:00', end_time: '20:00', venue: 'Gym' }), 'g')).event;
  // Created a second later: the most recent league from now on.
  await new Promise(r => setTimeout(r, 1100));
  newer = (await must(a.post('/leagues/create', { name: 'Newer League', teamNames: ['C', 'D'] }), 'newer')).league;
  expect(newer.id).not.toBe(older.id);
  b = await admin('p187.other');
  other = (await must(b.post('/leagues/create', { name: 'Someone Else League', teamNames: ['E', 'F'] }), 'other')).league;
  await must(b.post('/league/season/publish', { season_name: 'S1' }), 'season b');
  gOther = (await must(b.post('/league/events', { date: '2099-05-06', start_time: '19:00', end_time: '20:00', venue: 'Gym' }), 'g b')).event;
});

const get = (path, cookie) => SELF.fetch(BASE + path, { redirect: 'manual', headers: { cookie } });
const detail = id => `/league/events/detail?e=${encodeURIComponent(id)}`;

describe('A game link, for an admin of two leagues', () => {
  it('before: the most recent league is the current one', async () => {
    const html = await (await get('/league/schedule', a.s.cookie)).text();
    expect(html).toContain('Newer League');
  });

  it('a game of the older league opens, and that league becomes the current one', async () => {
    const res = await get(detail(gOlder.id), a.s.cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(gOlder.id);
    expect(html).toContain('Older League');
    const set = res.headers.getSetCookie().find(c => c.startsWith('nl_league='));
    expect(set).toContain(`nl_league=${encodeURIComponent(older.id)}`);
    expect(set).toContain('HttpOnly');
    // The pages and actions that follow act on that league.
    const cookie = `${a.s.cookie}; ${set.split(';')[0]}`;
    expect(await (await get('/league/schedule', cookie)).text()).toContain('Older League');
    const status = await (await get(`/league/events/status?e=${encodeURIComponent(gOlder.id)}`, cookie)).json();
    expect(status.ok).toBe(true);
    expect(status.league_id).toBe(older.id);
  });

  it('a game of a league they do not run: exactly the page for a game that does not exist', async () => {
    const res = await get(detail(gOther.id), a.s.cookie);
    const missing = await get(detail(other.id + ':2099-05-06-nothing'), a.s.cookie);
    expect(res.status).toBe(404);
    expect(missing.status).toBe(404);
    const strip = s => s.replace(/[0-9a-f-]{36}:[^"&<\s]*/g, 'ID');
    expect(strip(await res.text())).toBe(strip(await missing.text()));
    expect(res.headers.getSetCookie().some(c => c.startsWith('nl_league='))).toBe(false);
  });

  it('a cookie naming a league the user does not run is ignored', async () => {
    const html = await (await get('/league/schedule', `${a.s.cookie}; nl_league=${encodeURIComponent(other.id)}`)).text();
    expect(html).toContain('Newer League');
    expect(html).not.toContain('Someone Else League');
  });
});

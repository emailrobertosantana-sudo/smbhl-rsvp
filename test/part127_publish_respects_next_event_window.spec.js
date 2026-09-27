// Publishing a scoresheet no longer creates a game beyond the 8-day window.
// Production, 27 Sept: publishing week 3 called ensureNextEvent(env, true);
// forcing skipped both 8-day guards, and with week 4 already created (the
// cron creates the next game when the current one starts) it created week 5
// two weeks early. Publish now calls it unforced, like the cron.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { ensureNextEvent } from '../src/index.js';

const ADMIN_KEY = 'test-part127-admin';
const SEASON = 'P127 Season';
const label = days => new Date(Date.now() + days * 86400000).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' }).replace(/,/g, '');
const isoOf = days => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() + days * 86400000)); const g = t => p.find(x => x.type === t).value; return `${g('year')}-${g('month')}-${g('day')}`; };
const events = () => env.DB.prepare(`SELECT id, week, state FROM events WHERE season = ? ORDER BY week`).bind(SEASON).all().then(r => r.results);

beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  await applyRealSchema(env);
  // Week 3 was yesterday; week 4 in 5 days (inside the window); week 5 in 12 days (outside it).
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: SEASON, seasons: [{ name: SEASON, standings: [], fixtures: [
    { week: 3, date: label(-1), time: '10:30 AM', home: 'Red', away: 'Blue' },
    { week: 4, date: label(5), time: '10:30 AM', home: 'Red', away: 'Blue' },
    { week: 5, date: label(12), time: '10:30 AM', home: 'Red', away: 'Blue' }
  ] }], players: [] }));
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, state, start_time, league_id) VALUES (?, ?, 3, ?, 'locked', '10:30', 'smbhl')`).bind(`smbhl:${isoOf(-1)}`, SEASON, label(-1)).run();
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, state, start_time, league_id) VALUES (?, ?, 4, ?, 'open', '10:30', 'smbhl')`).bind(`smbhl:${isoOf(5)}`, SEASON, label(5)).run();
});

describe('Publish respects the 8-day window', () => {
  it('publishing week 3 while week 4 is open does NOT create week 5', async () => {
    const start = await SELF.fetch('http://example.com/admin/review/manual-start', { method: 'POST', headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ season: SEASON, week: 3 }) });
    const { id } = await start.json();
    const pub = await SELF.fetch('http://example.com/admin/review/publish', { method: 'POST', headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ review_id: id, week: 3, games: [{ home_team: 'Red', away_team: 'Blue', home_score: 2, away_score: 1, home_players: [], away_players: [] }] }) });
    expect((await pub.json()).ok).toBe(true);
    expect((await events()).map(e => e.week)).toEqual([3, 4]);
  });

  it('the legitimate caller still works: with no game open in the window, the next one inside it is created -- and nothing beyond it', async () => {
    await env.DB.prepare(`DELETE FROM events WHERE season = ? AND week = 4`).bind(SEASON).run();
    const made = await ensureNextEvent(env);
    expect(made && made.week).toBe(4);
    expect(await ensureNextEvent(env)).toBeNull(); // week 4 is open now; week 5 stays outside the window
    expect((await events()).map(e => e.week)).toEqual([3, 4]);
  });
});

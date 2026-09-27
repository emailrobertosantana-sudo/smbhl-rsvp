// Sub calls for a team that is short when its game is created go out WITH
// the roster's initial invite, not before it. The invite is the 'invite'
// step of SMBHL's cadence: invite_hours (120) before the game once
// invite_hour_of_day (18:00 Montreal) is reached -- Tuesday 18:00 for a
// Sunday 10:30 game. The shortfall check waits for that step's job; in each
// pass the invite runs first, so both go out in the same pass. A game
// within 48 h calls at once; a real cancellation still calls promptly; an
// admin can release the calls early ("send sub calls now").
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { runSchedule } from '../src/index.js';
import { hmac } from '../src/crypto_utils.js';

const ADMIN_KEY = 'test-part118-admin';
const RSVP_SECRET = 'test-part118-rsvp';
const SEASON = 'P118';
let originalFetch;
const at = iso => vi.setSystemTime(new Date(iso));
const rows = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then(r => r.results);
const subCalls = ev => rows(`SELECT player_id, team, send_after, sent_at FROM outbox WHERE event_id = ? AND kind = 'sub_call' ORDER BY id`, ev);
const invites = ev => rows(`SELECT player_id, sent_at FROM outbox WHERE event_id = ? AND kind = 'invite' ORDER BY id`, ev);
const inviteJob = ev => env.DB.prepare(`SELECT ran_at FROM jobs WHERE event_id = ? AND job = 'invite'`).bind(ev).first();
const admin = (path, body) => SELF.fetch('http://example.com' + path, { method: body ? 'POST' : 'GET', headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

// Red: a goalie + `redSkaters`; Blue: a goalie + 8 skaters.
async function game(id, date, redSkaters) {
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, ?, 1, ?, 'Aréna', 'open', '10:30', 'smbhl')`).bind(id, SEASON, date).run();
  for (const [team, n] of [['Red', redSkaters], ['Blue', 8]]) {
    for (let i = 0; i <= n; i++) {
      await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, ?, 'pending', 'roster', '2026-11-01T00:00:00Z', 'smbhl')`).bind(id, `${team}${i}`, team).run();
    }
  }
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-11-07T12:00:00Z');
  env.ADMIN_KEY = ADMIN_KEY;
  env.RSVP_SECRET = RSVP_SECRET;
  env.RESEND_API_KEY = 'test-part118-resend';
  env.MAIL_DAILY_CAP = '200';
  delete env.LEAGUE_PRODUCT;
  await applyRealSchema(env);
  await env.DB.prepare('DELETE FROM contacts').run();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes('api.resend.com') ? new Response('{"id":"x"}', { status: 200 }) : new Response('{}', { status: 404 });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: SEASON, seasons: [{ name: SEASON, config: { teams: [{ name: 'Red' }, { name: 'Blue' }], goaliesPerTeam: 1, skatersPerTeam: 8 }, fixtures: [], standings: [] }], players: [] }));
  for (const team of ['Red', 'Blue']) for (let i = 0; i <= 8; i++) {
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, 'roster', 0, ?, 'salt', 'smbhl')`).bind(`${team}${i}`, `${team} ${i}`, `${team.toLowerCase()}${i}@example.com`, i === 0 ? 1 : 0).run();
  }
  for (let i = 1; i <= 7; i++) await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, 'sub_skater', 1, 0, 'salt', 'smbhl')`).bind(`S${i}`, `Sub ${i}`, `s${i}@example.com`).run();
});
afterAll(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Shortfall sub calls go out with the roster invite', () => {
  const E1 = 'smbhl:2026-11-15'; // Sunday 10:30 Montreal = 15:30Z; Red is short (3 skaters of 7)

  it('no shortfall sub call before the roster invite -- not at creation, not on later passes', async () => {
    at('2026-11-07T16:45:00Z'); // Sat 11:45, 190.75 h out: the game exists and Red is short
    await game(E1, 'Sunday November 15 2026', 3);
    await runSchedule(env);
    at('2026-11-10T22:05:00Z'); // Tue 17:05: inside 120 h, before 18:00 -- no invite yet
    await runSchedule(env);
    expect(await inviteJob(E1)).toBeNull();
    expect(await subCalls(E1)).toEqual([]);
    const board = await (await admin(`/admin/subs/data?e=${encodeURIComponent(E1)}`)).json();
    expect(board.subCallsHeld).toBe(true);
  });

  it('the invite and the sub calls go out in the same pass (Tuesday 18:05), subs in waves', async () => {
    at('2026-11-10T23:05:00Z');
    await runSchedule(env);
    expect((await inviteJob(E1)).ran_at).toBe('2026-11-10T23:05:00.000Z');
    const inv = await invites(E1), calls = await subCalls(E1);
    expect(inv.length).toBeGreaterThan(0);
    expect(inv.every(r => r.sent_at === '2026-11-10T23:05:00.000Z')).toBe(true);
    expect(calls).toHaveLength(7);
    expect(new Set(calls.map(c => c.team))).toEqual(new Set(['Red']));
    // First wave of five sent in that same pass; the rest an hour later (>48 h out).
    expect(calls.filter(c => c.sent_at === '2026-11-10T23:05:00.000Z')).toHaveLength(5);
    expect(calls.filter(c => c.send_after === '2026-11-11T00:05:00.000Z')).toHaveLength(2);
    expect((await (await admin(`/admin/subs/data?e=${encodeURIComponent(E1)}`)).json()).subCallsHeld).toBe(false);
  });

  it('a sub call triggered by a real cancellation is unaffected: before the invite, a regular going out still calls subs', async () => {
    const E2 = 'smbhl:2026-11-22'; // full roster, 163 h out; nothing short until someone cancels
    at('2026-11-15T20:00:00Z');
    await game(E2, 'Sunday November 22 2026', 8);
    await runSchedule(env);
    expect(await subCalls(E2)).toEqual([]);
    const t = await hmac(RSVP_SECRET, `p:${E2}:Red3:salt`);
    await SELF.fetch(`http://example.com/rsvp?e=${encodeURIComponent(E2)}&p=Red3&t=${t}&v=out`);
    at('2026-11-15T21:05:00Z'); // the cancellation's one-hour hold (>48 h out) has passed
    await runSchedule(env);
    expect(await inviteJob(E2)).toBeNull(); // still before the invite...
    expect((await subCalls(E2)).length).toBeGreaterThan(0); // ...and subs are called anyway
  });

  it('a game created inside 48 hours calls subs at once, without waiting for any invite', async () => {
    const E3 = 'smbhl:2026-11-17'; // Tuesday 10:30 = 15:30Z; created 24.5 h before, at 10:00 -- the invite (18:00) is not due
    at('2026-11-16T15:00:00Z');
    await game(E3, 'Tuesday November 17 2026', 3);
    await runSchedule(env);
    expect(await inviteJob(E3)).toBeNull();
    const calls = await subCalls(E3);
    expect(calls.length).toBe(7);
    expect(calls.every(c => c.sent_at)).toBe(true); // inside 48 h: no waves, all at once
  });

  it('the admin override sends the held sub calls immediately', async () => {
    const E4 = 'smbhl:2026-11-29'; // 5 days out on the Tuesday morning: Red short, invite not yet due
    at('2026-11-24T14:00:00Z'); // Tue 09:00
    await game(E4, 'Sunday November 29 2026', 3);
    await runSchedule(env);
    expect(await subCalls(E4)).toEqual([]);
    expect((await (await admin(`/admin/subs/data?e=${encodeURIComponent(E4)}`)).json()).subCallsHeld).toBe(true);
    const res = await admin('/admin/subs/release', { event_id: E4 });
    expect(res.status).toBe(200);
    expect((await res.json()).queued).toBe(7);
    const calls = await subCalls(E4);
    expect(calls.filter(c => c.sent_at === '2026-11-24T14:00:00.000Z')).toHaveLength(5); // first wave, now
    expect(await inviteJob(E4)).toBeNull(); // the roster invite itself is not moved
    expect((await (await admin(`/admin/subs/data?e=${encodeURIComponent(E4)}`)).json()).subCallsHeld).toBe(false);
  });
});

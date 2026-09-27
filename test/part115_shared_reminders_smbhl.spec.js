// Ending the reminder fork (SMBHL side). SMBHL's reminders now run from
// the one shared module, src/reminders.js, on the advanced model:
// hours-before + hour-of-day steps, mail held for quiet hours, sub calls
// in waves, dormant subs left out. (The full before/after equivalence is
// part114's golden record; this file checks the pieces by name.)
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import * as idx from '../src/index.js';
import * as R from '../src/reminders.js';
import * as RS from '../src/reminder_scheduling.js';
import indexSource from '../src/index.js?raw';

const EV = 'smbhl:2026-11-15'; // Sunday 10:30 (15:30Z)
let originalFetch;

const at = iso => vi.setSystemTime(new Date(iso));
const rows = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then(r => r.results);
const contact = (pid, role, { goalie = 0, dormant = 0 } = {}) => env.DB.prepare(
  `INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, dormant, league_id) VALUES (?, ?, ?, ?, ?, ?, 's', ?, 'smbhl')`
).bind(pid, pid, `${pid.toLowerCase()}@example.com`, role, role === 'roster' ? 0 : 1, goalie, dormant).run();

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-11-10T12:00:00Z');
  env.RSVP_SECRET = 'p115-rsvp';
  env.RESEND_API_KEY = 'p115-resend';
  env.MAIL_DAILY_CAP = '100';
  delete env.LEAGUE_PRODUCT;
  await applyRealSchema(env);
  await env.DB.prepare(`DELETE FROM contacts`).run();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes('api.resend.com') ? new Response('{"id":"x"}', { status: 200 }) : new Response('{}', { status: 404 });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // No fixtures: the pass never creates a game here.
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: 'Fall 2026', seasons: [{ name: 'Fall 2026', standings: [], fixtures: [] }], players: [] }));
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'Fall 2026', 6, 'Sunday November 15 2026', 'Aréna', 'open', '10:30', 'smbhl')`).bind(EV).run();
  // Red: a goalie and 3 skaters -- short of SMBHL's 7.
  for (const [pid, goalie] of [['R1', 1], ['R2', 0], ['R3', 0], ['R4', 0]]) {
    await contact(pid, 'roster', { goalie });
    await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, 'Red', 'pending', 'roster', '2026-11-08T00:00:00Z', 'smbhl')`).bind(EV, pid).run();
  }
  for (let i = 1; i <= 7; i++) await contact(`S${i}`, 'sub_skater');
  await contact('SDORM', 'sub_skater', { dormant: 1 });
  // The roster invite has gone, so shortfall calls are not held for it
  // (sub-call alignment task) -- these tests are about waves and quiet hours.
  await env.DB.prepare(`INSERT INTO jobs (event_id, job, ran_at) VALUES (?, 'invite', '2026-11-10T12:00:00.000Z')`).bind(EV).run();
});
afterAll(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); vi.useRealTimers(); });

describe('The fork is gone: one reminder module', () => {
  it('index.js re-exports the shared functions -- the same function objects, not copies', () => {
    expect(idx.runSchedule).toBe(R.runSchedule);
    expect(idx.runLeagueReminders).toBe(R.runLeagueReminders);
    expect(idx.sendLeagueReminderWave).toBe(R.sendLeagueReminderWave);
    expect(idx.afterQuiet).toBe(R.afterQuiet);
    expect(idx.getEmailSettings).toBe(R.getEmailSettings);
    expect(idx.DEFAULT_EMAIL_SETTINGS).toBe(R.DEFAULT_EMAIL_SETTINGS);
    expect(RS.applyReminderWindowSkipRule).toBe(R.applyReminderWindowSkipRule);
    expect(RS.REMINDER_WINDOW_THRESHOLD_HOURS).toBe(R.REMINDER_WINDOW_THRESHOLD_HOURS);
  });

  it('index.js no longer defines either runner, and its cron goes through runReminderPass', () => {
    for (const def of ['async function runSchedule(', 'async function runLeagueReminders(', 'async function sendLeagueReminderWave(', 'async function afterQuiet(', 'async function getEmailSettings(']) {
      expect(indexSource.includes(def)).toBe(false);
    }
    expect(indexSource).toContain('ctx.waitUntil(runReminderPass(env)');
  });

  it('SMBHL is always on the advanced model -- a flag row cannot turn it off, and the super-admin refuses to', async () => {
    expect(await R.usesAdvancedReminders(env, 'smbhl')).toBe(true);
    await env.DB.prepare(`INSERT INTO league_capability_flags (league_id, flag_key, enabled, updated_at) VALUES ('smbhl', 'advanced_reminders', 0, '2026-11-10T00:00:00Z')`).run();
    expect(await R.usesAdvancedReminders(env, 'smbhl')).toBe(true);
    await env.DB.prepare(`DELETE FROM league_capability_flags WHERE league_id = 'smbhl'`).run();
  });
});

describe("SMBHL's advanced features, through the shared module", () => {
  it('hour of day: 69 h out at 13:05, the 72 h chase waits for 15:00; at 15:05 it goes', async () => {
    at('2026-11-12T18:05:00Z'); // Thu 13:05 Montreal, 69.4 h out
    expect((await R.runReminderPass(env)).product).toBe('smbhl');
    expect(await rows(`SELECT job FROM jobs WHERE event_id = ? AND job = 'r72'`, EV)).toEqual([]);
    at('2026-11-12T20:05:00Z'); // Thu 15:05
    await R.runReminderPass(env);
    expect(await rows(`SELECT job FROM jobs WHERE event_id = ? AND job = 'r72'`, EV)).toEqual([{ job: 'r72' }]);
    expect((await rows(`SELECT count(*) n FROM outbox WHERE event_id = ? AND kind = 'chase'`, EV))[0].n).toBe(4);
  });

  it('waves: more than 48 h out, subs are called five at a time, an hour apart; the dormant sub is never called', async () => {
    const calls = await rows(`SELECT player_id, send_after FROM outbox WHERE event_id = ? AND kind = 'sub_call' ORDER BY id`, EV);
    expect(calls.map(c => c.player_id)).not.toContain('SDORM');
    expect(calls).toHaveLength(7);
    const first = Date.parse(calls[0].send_after);
    const offsets = calls.map(c => Math.round((Date.parse(c.send_after) - first) / 60000));
    expect(offsets).toEqual([0, 0, 0, 0, 0, 60, 60]);
  });

  it('quiet hours: a sub added at 23:30 is called at 07:00, not in the night', async () => {
    at('2026-11-13T04:30:00Z'); // Thu 23:30 Montreal
    await contact('S8', 'sub_skater');
    await R.runReminderPass(env);
    const row = (await rows(`SELECT send_after, created_at FROM outbox WHERE event_id = ? AND kind = 'sub_call' AND player_id = 'S8'`, EV))[0];
    expect(row.created_at).toBe('2026-11-13T04:30:00.000Z');
    expect(row.send_after).toBe('2026-11-13T12:00:00.000Z'); // 07:00 Montreal
  });
});

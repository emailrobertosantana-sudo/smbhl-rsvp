// Quiet hours in the league's LOCAL time, when waves are laid out AND when
// anything is sent. Production's settings: quiet 00:00-06:00, invite 144 h
// before at 13:00. The week-4 sub calls were all pushed exactly 12 h, some
// into 01:30-05:30 Montreal: afterQuiet only understood a window that wraps
// midnight (23 -> 7); for 0 -> 6 it could never find an allowed hour and
// gave up after 24 half-hour steps. Fixed, and drain() now also holds a row
// that comes due inside the window (a retry, a row queued before a
// settings change) unless it was deliberately sent straight away
// (outbox.quiet_exempt, migrate-053).
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { runSchedule, drain } from '../src/index.js';
import { afterQuiet, inQuietHours } from '../src/reminders.js';
import { localParts } from '../src/league_ids.js';

let originalFetch;
const sent = [];
const at = iso => vi.setSystemTime(new Date(iso));
const montrealHour = iso => localParts(new Date(iso)).hour;
const PROD_SETTINGS = { quiet_hours_enabled: true, quiet_hours_start: 0, quiet_hours_end: 6, invite_hours: 144, invite_hour_of_day: 13, pool_hours: 48, short48_hours: 48 };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-09-27T14:30:00Z');
  env.RSVP_SECRET = 'p119'; env.RESEND_API_KEY = 'p119'; env.MAIL_DAILY_CAP = '500';
  delete env.LEAGUE_PRODUCT;
  await applyRealSchema(env);
  await env.DB.prepare('DELETE FROM contacts').run();
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('email_cadence_settings', ?)`).bind(JSON.stringify(PROD_SETTINGS)).run();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) { sent.push({ to: JSON.parse(opts.body).to[0], at: new Date().toISOString() }); return new Response('{"id":"x"}', { status: 200 }); }
    return new Response('{}', { status: 404 });
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: 'Fall 2026', seasons: [{ name: 'Fall 2026', config: { teams: [{ name: 'Red' }, { name: 'Blue' }], goaliesPerTeam: 1, skatersPerTeam: 8 }, fixtures: [], standings: [] }], players: [] }));
});
afterAll(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); vi.useRealTimers(); });

describe('The quiet window itself', () => {
  it('is local time; wrapping (23-7) and non-wrapping (0-6) windows both work; start = end means none', () => {
    expect([0, 1, 5].map(h => inQuietHours(h, 0, 6))).toEqual([true, true, true]);
    expect([6, 13, 22, 23].map(h => inQuietHours(h, 0, 6))).toEqual([false, false, false, false]);
    expect([23, 0, 6].map(h => inQuietHours(h, 23, 7))).toEqual([true, true, true]);
    expect([7, 22].map(h => inQuietHours(h, 23, 7))).toEqual([false, false]);
    expect(inQuietHours(3, 4, 4)).toBe(false);
  });

  it('with production settings (0-6), 01:30 Montreal moves to 06:00 Montreal; 22:30 and 13:00 stay put', async () => {
    // 2026-09-28 01:30 EDT = 05:30Z; 06:00 EDT = 10:00Z.
    expect((await afterQuiet(env, new Date('2026-09-28T05:30:00Z'))).toISOString()).toBe('2026-09-28T10:00:00.000Z');
    expect((await afterQuiet(env, new Date('2026-09-28T02:30:00Z'))).toISOString()).toBe('2026-09-28T02:30:00.000Z'); // 22:30 EDT
    expect((await afterQuiet(env, new Date('2026-09-27T17:00:00Z'))).toISOString()).toBe('2026-09-27T17:00:00.000Z'); // 13:00 EDT
  });
});

describe('Sub-call waves are laid out around quiet hours (week-4 shape)', () => {
  const EV = 'smbhl:2026-10-04';
  it('an hourly wave that would land between 00:00 and 06:00 Montreal waits for 06:00; none is pushed a blind 12 h', async () => {
    // Monday 20:30 Montreal (00:30Z), game Sunday 10:30: invite already gone, Red short, 30 subs.
    at('2026-09-29T00:30:00Z');
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'Fall 2026', 4, 'Sunday October 4, 2026', 'Aréna', 'open', '10:30', 'smbhl')`).bind(EV).run();
    await env.DB.prepare(`INSERT INTO jobs (event_id, job, ran_at) VALUES (?, 'invite', '2026-09-28T17:00:00Z')`).bind(EV).run();
    for (const [team, n] of [['Red', 5], ['Blue', 7]]) for (let i = 0; i <= n; i++) {
      await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, 'roster', 0, ?, 's', 'smbhl')`).bind(`${team}${i}`, `${team}${i}`, `${team.toLowerCase()}${i}@example.com`, i === 0 ? 1 : 0).run();
      await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, ?, 'pending', 'roster', '2026-09-27T14:30:00Z', 'smbhl')`).bind(EV, `${team}${i}`, team).run();
    }
    for (let i = 1; i <= 30; i++) await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, 'sub_skater', 1, 0, 's', 'smbhl')`).bind(`S${i}`, `Sub ${i}`, `s${i}@example.com`).run();
    await runSchedule(env);
    const calls = (await env.DB.prepare(`SELECT send_after FROM outbox WHERE event_id = ? AND kind = 'sub_call' ORDER BY id`).bind(EV).all()).results;
    expect(calls).toHaveLength(30);
    const hours = calls.map(c => montrealHour(c.send_after));
    expect(hours.filter(h => h >= 0 && h < 6)).toEqual([]);
    // Waves of five, an hour apart, from 20:30 Montreal; the two that would fall at 00:30 and 01:30 wait for 06:00.
    const byTime = calls.reduce((m, c) => (m[c.send_after] = (m[c.send_after] || 0) + 1, m), {});
    expect(byTime).toEqual({ '2026-09-29T00:30:00.000Z': 5, '2026-09-29T01:30:00.000Z': 5, '2026-09-29T02:30:00.000Z': 5, '2026-09-29T03:30:00.000Z': 5, '2026-09-29T10:00:00.000Z': 10 });
  });
});

describe('Quiet hours at send time', () => {
  it('a retry that comes due at 02:00 Montreal is held until 06:00; a row sent straight away on purpose is not', async () => {
    at('2026-09-30T06:00:00Z'); // 02:00 Montreal
    const ins = (id, exempt) => env.DB.prepare(
      `INSERT INTO outbox (kind, event_id, player_id, dedup_key, payload, send_after, created_at, league_id, quiet_exempt, attempts, next_attempt_at, error)
       VALUES ('summary', 'smbhl:2026-10-04', NULL, ?, '{"text":"t"}', '2026-09-29T20:00:00Z', '2026-09-29T20:00:00Z', 'smbhl', ?, 1, '2026-09-30T05:55:00Z', 'resend 500')`
    ).bind(id, exempt).run();
    await ins('p119-held', 0);
    await ins('p119-exempt', 1);
    sent.length = 0;
    await drain(env);
    const row = id => env.DB.prepare(`SELECT sent_at, send_after, next_attempt_at FROM outbox WHERE dedup_key = ?`).bind(id).first();
    expect(await row('p119-held')).toEqual({ sent_at: null, send_after: '2026-09-30T10:00:00.000Z', next_attempt_at: '2026-09-30T10:00:00.000Z' });
    expect((await row('p119-exempt')).sent_at).toBe('2026-09-30T06:00:00.000Z');
    // At 06:00 Montreal the held one goes.
    at('2026-09-30T10:00:00Z');
    await drain(env);
    expect((await row('p119-held')).sent_at).toBe('2026-09-30T10:00:00.000Z');
  });

  it('enqueue records the exemption: a real-time league sub invite is exempt, SMBHL cron mail is not', async () => {
    const rows = (await env.DB.prepare(`SELECT kind, quiet_exempt, count(*) n FROM outbox WHERE event_id = 'smbhl:2026-10-04' AND kind = 'sub_call' GROUP BY kind, quiet_exempt`).all()).results;
    expect(rows).toEqual([{ kind: 'sub_call', quiet_exempt: 0, n: 30 }]);
  });
});

// GOLDEN RECORD of SMBHL's cron, taken on the code BEFORE the reminder
// fork was ended (commit 7c2f04d, runSchedule in src/index.js). The
// snapshot next to this file was written by that code and committed on
// its own; the migrated code must reproduce it exactly, without -u.
//
// One SMBHL game week is driven through the real scheduled() entry point
// at fixed clock times (America/Toronto), from the pass that creates the
// game eight days out to the lock after it: every cadence step (invite,
// r72, r49, short48, pool36, friday_board, r24/gameday24, summary,
// gameday_morning, lock), quiet hours (default 23:00-07:00), sub-call
// waves and the responsiveness order, dormancy, the daily send cap and
// its deferral, and a transient and a permanent send failure (retry and
// failed states). After every pass: the log line, every email sent (to,
// subject, a hash of its content) and the outbox by state; at the end,
// every outbox, jobs, contacts-bookkeeping and events row.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import worker from '../src/index.js';

const SEASON = 'Fall 2026';
const EV = 'smbhl:2026-11-15';
const TEAMS = { Red: [1, 8], Blue: [1, 8], White: [1, 6], Black: [0, 8] }; // [goalies, skaters]

const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);

let sent = [];
let originalFetch;
const logs = [];
let logSpy;

async function pass(isoUtc) {
  vi.setSystemTime(new Date(isoUtc));
  sent = [];
  logs.length = 0;
  const ctx = createExecutionContext();
  await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env, ctx);
  await waitOnExecutionContext(ctx);
  const outbox = (await env.DB.prepare(
    `SELECT kind,
            CASE WHEN sent_at IS NOT NULL THEN 'sent' WHEN cancelled = 1 THEN 'cancelled' WHEN failed_at IS NOT NULL THEN 'failed'
                 WHEN defer_reason IS NOT NULL THEN 'deferred:' || defer_reason WHEN attempts > 0 THEN 'retrying' ELSE 'queued' END AS state,
            count(*) AS n
       FROM outbox GROUP BY 1, 2 ORDER BY 1, 2`).all()).results;
  return { at: isoUtc, log: logs.slice(), sent: sent.slice(), outbox };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
  env.RSVP_SECRET = 'golden-rsvp-secret';
  env.RESEND_API_KEY = 'golden-resend';
  env.ADMIN_EMAIL = 'admin@smbhl.test';
  env.MAIL_DAILY_CAP = '40';
  delete env.LEAGUE_PRODUCT;
  // The recorded passes are the reminder pass alone; the health pass
  // (src/health.js, added after the record) is tested on its own.
  env.HEALTH_ALERTS = 'off';
  await applyRealSchema(env);
  // migrate-002.sql seeds three real sub goalies; keep real addresses out of the snapshot.
  await env.DB.prepare(`DELETE FROM contacts`).run();

  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      const b = JSON.parse(opts.body);
      const to = Array.isArray(b.to) ? b.to[0] : b.to;
      sent.push({ to, subject: b.subject, h: await sha(`${b.text || ''}|${b.html || ''}|${b.from || ''}|${b.reply_to || ''}`) });
      if (to.startsWith('flaky')) return new Response('{"message":"upstream"}', { status: 500 });
      if (to.startsWith('bounce')) return new Response('{"message":"invalid"}', { status: 422 });
      return new Response('{"id":"x"}', { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  // The league's records: three weeks of fixtures, two games a night.
  const fixtures = [];
  for (const [week, date] of [[5, 'Sunday November 8 2026'], [6, 'Sunday November 15 2026'], [7, 'Sunday November 22 2026']]) {
    fixtures.push({ week, date, time: '10:30 AM', home: 'Red', away: 'Blue', venue: 'Aréna Golden' });
    fixtures.push({ week, date, time: '11:30 AM', home: 'White', away: 'Black', venue: 'Aréna Golden' });
  }
  const players = [];
  const add = async (pid, name, email, role, { goalie = false, dormant = 0, optedOut = 0, streak = 0, answered = 0 } = {}) => {
    await env.DB.prepare(
      `INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, dormant, opted_out, asked_streak, answered_ever, league_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'smbhl')`
    ).bind(pid, name, email, role, role === 'roster' ? 0 : 1, goalie ? 1 : 0, 'salt-' + pid, dormant, optedOut, streak, answered).run();
  };
  let n = 0;
  for (const [team, [g, s]] of Object.entries(TEAMS)) {
    for (let i = 0; i < g + s; i++) {
      const pid = `R${String(++n).padStart(4, '0')}`;
      const goalie = i < g;
      // One regular's address fails transiently, one permanently.
      const email = pid === 'R0003' ? 'flaky-r0003@example.com' : pid === 'R0012' ? 'bounce-r0012@example.com' : `${pid.toLowerCase()}@example.com`;
      await add(pid, `${team} ${goalie ? 'Goalie' : 'Skater ' + i}`, email, 'roster', { goalie });
      players.push({ id: pid, name: `${team} ${i}`, seasons: { [SEASON]: { team, pos: goalie ? 'G' : 'F', gp: 8 } } });
    }
  }
  // Subs: enough for several waves of five, in every responsiveness tier.
  for (let i = 1; i <= 12; i++) {
    const pid = `S${String(i).padStart(4, '0')}`;
    await add(pid, `Sub ${i}`, `${pid.toLowerCase()}@example.com`, 'sub_skater', { streak: i % 4, answered: i % 3 === 0 ? 1 : 0 });
  }
  await add('SG001', 'Sub Goalie 1', 'sg001@example.com', 'sub_goalie', { goalie: true, answered: 1 });
  await add('SG002', 'Sub Goalie 2', 'sg002@example.com', 'sub_goalie', { goalie: true, streak: 9 }); // one invite from dormant
  await add('SD001', 'Dormant Sub', 'sd001@example.com', 'sub_skater', { dormant: 1, streak: 12 });
  await add('SO001', 'Opted-out Sub', 'so001@example.com', 'sub_skater', { optedOut: 1 });
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: SEASON, seasons: [{ name: SEASON, fixtures, standings: [] }], players }));
  // Team links are signed with a per-team salt created at random on first use: fixed here so the record is repeatable.
  for (const team of Object.keys(TEAMS)) await env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).bind(`teamsalt:${SEASON}:${team}`, `golden-salt-${team}`).run();

  // Last week's game, already played: S0001 subbed and played.
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, end_time, league_id) VALUES ('smbhl:2026-11-08', ?, 5, 'Sunday November 8 2026', 'Aréna Golden', 'done', '10:30', '12:30', 'smbhl')`).bind(SEASON).run();
  await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES ('smbhl:2026-11-08', 'S0001', 'Red', 'in', 'sub', '2026-11-08T14:00:00.000Z', 'smbhl')`).run();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  logSpy?.mockRestore();
  vi.useRealTimers();
});

describe("SMBHL's cron over one game week, recorded before the migration", () => {
  it('reproduces the recorded passes exactly', async () => {
    const passes = [];
    // Sat 11:00 (8 days + 30 min out): nothing yet.
    passes.push(await pass('2026-11-07T15:00:00Z'));
    // Sat 11:45: inside the 8-day window -- the game is created, roster seeded, short teams call subs (in waves).
    passes.push(await pass('2026-11-07T16:45:00Z'));
    // Replies trickle in.
    await env.DB.prepare(`UPDATE rsvp SET status = 'in', updated_at = '2026-11-08T12:00:00.000Z' WHERE event_id = ? AND player_id IN ('R0001','R0002','R0004','R0010','R0011')`).bind(EV).run();
    await env.DB.prepare(`UPDATE rsvp SET status = 'out', updated_at = '2026-11-08T12:00:00.000Z' WHERE event_id = ? AND player_id IN ('R0005','R0013')`).bind(EV).run();
    // Mon 07:00, Tue 13:05: later waves and retries.
    passes.push(await pass('2026-11-09T12:00:00Z'));
    passes.push(await pass('2026-11-10T18:05:00Z'));
    // Tue 17:05 (inside the 120 h window, before 18:00): no invite yet. Tue 18:05: invite.
    passes.push(await pass('2026-11-10T22:05:00Z'));
    passes.push(await pass('2026-11-10T23:05:00Z'));
    // A team message for the Friday board, an availability "yes" for the waitlist.
    await env.DB.prepare(`INSERT INTO team_messages (event_id, team, player_name, player_id, message, created_at, league_id) VALUES (?, 'Red', 'Red 1', 'R0002', 'Qui apporte les rondelles?', '2026-11-11T15:00:00.000Z', 'smbhl')`).bind(EV).run();
    await env.DB.prepare(`INSERT INTO availability (event_id, player_id, need, status, answered_at) VALUES (?, 'S0003', 'skater', 'yes', '2026-11-11T16:00:00.000Z')`).bind(EV).run();
    // Thu 14:05 (before 15:00) then Thu 15:05: r72.
    passes.push(await pass('2026-11-12T19:05:00Z'));
    passes.push(await pass('2026-11-12T20:05:00Z'));
    // Fri 09:35: r49. Fri 10:35: short48. Fri 14:05: friday_board.
    passes.push(await pass('2026-11-13T14:35:00Z'));
    passes.push(await pass('2026-11-13T15:35:00Z'));
    passes.push(await pass('2026-11-13T19:05:00Z'));
    // Fri 22:35: pool36 (sub reminders + calls). Fri 23:30: inside quiet hours.
    passes.push(await pass('2026-11-14T03:35:00Z'));
    passes.push(await pass('2026-11-14T04:30:00Z'));
    // Sat 07:05 (quiet hours over), Sat 18:05: r24 + gameday24. Sat 20:05: summary.
    passes.push(await pass('2026-11-14T12:05:00Z'));
    passes.push(await pass('2026-11-14T23:05:00Z'));
    await env.DB.prepare(`INSERT INTO team_messages (event_id, team, player_name, player_id, message, created_at, league_id) VALUES (?, 'Blue', 'Blue 1', 'R0011', 'Maillots foncés', '2026-11-15T00:30:00.000Z', 'smbhl')`).bind(EV).run();
    passes.push(await pass('2026-11-15T01:05:00Z'));
    // Sun 08:35: gameday_morning. Sun 13:05: lock. Sun 14:00: nothing left open.
    passes.push(await pass('2026-11-15T13:35:00Z'));
    passes.push(await pass('2026-11-15T18:05:00Z'));
    passes.push(await pass('2026-11-15T19:00:00Z'));

    const final = {
      outbox: (await env.DB.prepare(
        `SELECT id, kind, event_id, player_id, team, dedup_key, payload, send_after, created_at, sent_at, cancelled, attempts, failed_at, next_attempt_at, defer_reason, error, league_id FROM outbox ORDER BY id`).all()).results,
      jobs: (await env.DB.prepare(`SELECT event_id, job, ran_at FROM jobs ORDER BY event_id, job`).all()).results,
      contacts: (await env.DB.prepare(`SELECT player_id, asked_streak, dormant, last_asked, answered_ever FROM contacts ORDER BY player_id`).all()).results,
      events: (await env.DB.prepare(`SELECT id, season, week, state, start_time, end_time FROM events ORDER BY id`).all()).results,
      rsvp: (await env.DB.prepare(`SELECT event_id, player_id, team, status, role FROM rsvp ORDER BY event_id, player_id`).all()).results,
      dailyCount: (await env.DB.prepare(`SELECT * FROM mail_daily_count ORDER BY day`).all()).results,
      alerts: (await env.DB.prepare(`SELECT key, value FROM settings WHERE key LIKE 'alert:%' ORDER BY key`).all()).results
    };
    expect({ passes, final }).toMatchSnapshot();
  }, 60000);
});

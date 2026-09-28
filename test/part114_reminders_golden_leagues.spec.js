// GOLDEN RECORD of the league product's cron, taken on the code BEFORE
// the reminder fork was ended (commit 7c2f04d, runLeagueReminders in
// src/index.js). The snapshot next to this file was written by that code
// and committed on its own; after the migration, a league WITHOUT the
// advanced-reminders flag must reproduce it exactly, without -u.
//
// Driven through the real scheduled() entry point (LEAGUE_PRODUCT=true,
// as on demo) at fixed clock times: a fixed-teams league with all three
// waves on, a weekly-draw league with only the 72 h wave and a scheduled
// auto-draw, a deactivated league, an SMBHL event in the same database
// (never touched), a game created inside its reminder windows (the
// window-skip rule, 6ed0ee8), shortfall sub calls, the per-league drain
// and the system drain, and a transient and a permanent send failure.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import worker from '../src/index.js';
import { applyReminderWindowSkipRule } from '../src/reminder_scheduling.js';

const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);

let sent = [];
let originalFetch;
const logs = [];

async function pass(isoUtc) {
  vi.setSystemTime(new Date(isoUtc));
  sent = [];
  logs.length = 0;
  const ctx = createExecutionContext();
  await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, env, ctx);
  await waitOnExecutionContext(ctx);
  const outbox = (await env.DB.prepare(
    `SELECT league_id, kind,
            CASE WHEN sent_at IS NOT NULL THEN 'sent' WHEN cancelled = 1 THEN 'cancelled' WHEN failed_at IS NOT NULL THEN 'failed'
                 WHEN defer_reason IS NOT NULL THEN 'deferred:' || defer_reason WHEN attempts > 0 THEN 'retrying' ELSE 'queued' END AS state,
            count(*) AS n
       FROM outbox GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`).all()).results;
  return { at: isoUtc, log: logs.slice(), sent: sent.slice(), outbox };
}

const ev = (id, league, date, time) => env.DB.prepare(
  `INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, ?, 1, ?, 'Golden Gym', 'open', ?, ?)`
).bind(id, `${league} Season`, date, time, league).run();
const contact = (pid, league, name, email, role, team, { goalie = 0, active = 1 } = {}) => env.DB.prepare(
  `INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, preferred_team, token_salt, is_active, league_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).bind(pid, name, email, role, role === 'roster' ? 0 : 1, goalie, team, 'salt-' + pid, active, league).run();
const rsvp = (eventId, pid, team, status, league) => env.DB.prepare(
  `INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, ?, ?, 'roster', '2026-11-10T12:00:00.000Z', ?)`
).bind(eventId, pid, team, status, league).run();

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
  env.RSVP_SECRET = 'golden-rsvp-secret';
  env.RESEND_API_KEY = 'golden-resend';
  env.ADMIN_EMAIL = 'admin@smbhl.test';
  env.PUBLIC_URL = 'https://golden.example';
  env.MAIL_DAILY_CAP = '60';
  env.LEAGUE_PRODUCT = 'true';
  // The recorded passes are the reminder pass alone; the health pass
  // (src/health.js, added after the record) is tested on its own.
  env.HEALTH_ALERTS = 'off';
  await applyRealSchema(env);
  await env.DB.prepare(`DELETE FROM contacts`).run(); // migrate-002.sql's real SMBHL sub goalies

  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      const b = JSON.parse(opts.body);
      const to = Array.isArray(b.to) ? b.to[0] : b.to;
      sent.push({ to, subject: b.subject, from: b.from, h: await sha(`${b.text || ''}|${b.html || ''}|${b.reply_to || ''}`) });
      if (to.startsWith('flaky')) return new Response('{"message":"upstream"}', { status: 500 });
      if (to.startsWith('bounce')) return new Response('{"message":"invalid"}', { status: 422 });
      return new Response('{"id":"x"}', { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  // The weekly draw shuffles with Math.random: seeded here so the record is repeatable.
  let seed = 114;
  vi.spyOn(Math, 'random').mockImplementation(() => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; });
  vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at, email_verified_at) VALUES ('u-golden', 'owner@golden.example', 'x', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`).run();
  const league = (id, name, slug, structure, teams, r72, r24, r12, extra = '') => env.DB.prepare(
    `INSERT INTO leagues (id, name, division_label, tracks_stats, team_count, team_names, created_by, created_at, slug, team_structure, min_players, max_players, min_goalies, reminder_72h_enabled, reminder_24h_enabled, reminder_12h_enabled, color, language_mode${extra ? ', ' + extra.split('=')[0] : ''})
     VALUES (?, ?, NULL, 1, ?, ?, 'u-golden', '2026-10-01T00:00:00Z', ?, ?, 3, 6, 1, ?, ?, ?, '#2a5fa8', 'both'${extra ? ', ' + extra.split('=')[1] : ''})`
  ).bind(id, name, teams.length, JSON.stringify(teams), slug, structure, r72, r24, r12).run();
  await league('lg-fixed', 'Golden Fixed', 'golden-fixed', 'fixed', ['Otters', 'Bears'], 1, 1, 1);
  await league('lg-draw', 'Golden Draw', 'golden-draw', 'weekly_draw', ['Light', 'Dark'], 1, 0, 0);
  await env.DB.prepare(`UPDATE leagues SET auto_draw_enabled = 1, auto_draw_hours_before = 30 WHERE id = 'lg-draw'`).run();
  await league('lg-off', 'Golden Off', 'golden-off', 'fixed', ['A', 'B'], 1, 1, 1);
  await env.DB.prepare(`UPDATE leagues SET deactivated_at = '2026-10-05T00:00:00Z' WHERE id = 'lg-off'`).run();
  for (const id of ['lg-fixed', 'lg-draw', 'lg-off']) await env.DB.prepare(`INSERT INTO league_admins (league_id, user_id, created_at) VALUES (?, 'u-golden', '2026-10-01T00:00:00Z')`).bind(id).run().catch(() => {});

  // Fixed league: game Sun 2026-11-15 19:00 (00:00Z Mon). Otters: goalie + 4, Bears: goalie + 2 (short).
  let n = 0;
  const pid = p => `${p}${String(++n).padStart(3, '0')}`;
  const fixedIds = [];
  for (const [team, g, s] of [['Otters', 1, 4], ['Bears', 1, 2]]) {
    for (let i = 0; i < g + s; i++) {
      const id = pid('F');
      const email = id === 'F002' ? 'flaky-f002@example.com' : id === 'F008' ? 'bounce-f008@example.com' : `${id.toLowerCase()}@example.com`;
      await contact(id, 'lg-fixed', `${team} Player ${i}`, email, 'roster', team, { goalie: i < g ? 1 : 0 });
      fixedIds.push([id, team]);
    }
  }
  for (let i = 1; i <= 7; i++) await contact(pid('FS'), 'lg-fixed', `Fixed Sub ${i}`, `fs${i}@example.com`, 'sub_skater', null);
  await contact(pid('FS'), 'lg-fixed', 'Fixed Sub Goalie', 'fsg@example.com', 'sub_skater', null, { goalie: 1 });
  await contact(pid('FS'), 'lg-fixed', 'Inactive Sub', 'fsx@example.com', 'sub_skater', null, { active: 0 });
  await ev('lg-fixed:2026-11-15', 'lg-fixed', '2026-11-15', '19:00');
  await rsvp('lg-fixed:2026-11-15', 'F001', 'Otters', 'in', 'lg-fixed');
  await rsvp('lg-fixed:2026-11-15', 'F003', 'Otters', 'out', 'lg-fixed');

  // Draw league: game Sat 2026-11-14 10:00, draw 30 h before.
  for (let i = 1; i <= 8; i++) await contact(pid('D'), 'lg-draw', `Draw Player ${i}`, `d${i}@example.com`, 'roster', null, { goalie: i <= 2 ? 1 : 0 });
  await ev('lg-draw:2026-11-14', 'lg-draw', '2026-11-14', '10:00');
  for (const p of ['D018', 'D019', 'D020', 'D021']) await rsvp('lg-draw:2026-11-14', p, null, 'in', 'lg-draw').catch(() => {});

  // Deactivated league: never reminded.
  await contact('O001', 'lg-off', 'Off Player', 'off@example.com', 'roster', 'A');
  await ev('lg-off:2026-11-15', 'lg-off', '2026-11-15', '19:00');

  // SMBHL event in the same database: never touched by the league cron.
  await contact('R9001', 'smbhl', 'SMBHL Player', 'smbhl-player@example.com', 'roster', 'Red');
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES ('smbhl:2026-11-15', 'Fall 2026', 6, 'Sunday November 15 2026', 'Aréna', 'open', '10:30', 'smbhl')`).run();

  // A deferred account email (belongs to no league): the system drain delivers it.
  await env.DB.prepare(
    `INSERT INTO outbox (kind, event_id, player_id, dedup_key, payload, send_after, created_at, league_id)
     VALUES ('direct_mail', 'system', NULL, 'golden-system-1', ?, '2026-11-09T11:00:00.000Z', '2026-11-09T11:00:00.000Z', 'system')`
  ).bind(JSON.stringify({ prerendered: { to: 'newuser@example.com', subject: 'Confirm your email', text: 'Confirm', html: null, identity: null } })).run();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete env.LEAGUE_PRODUCT;
});

describe("The league product's cron, recorded before the migration", () => {
  it('reproduces the recorded passes exactly', async () => {
    const passes = [];
    // Mon 07:00: the system drain; nothing inside a window yet.
    passes.push(await pass('2026-11-09T12:00:00Z'));
    // Wed 10:00: the draw game (Sat 10:00) is 72 h out -> its 72 h wave. The fixed league's short team calls subs (in waves).
    passes.push(await pass('2026-11-11T15:00:00Z'));
    // Thu 18:30: the fixed Sunday game is 72.5 h out -> nothing yet.
    passes.push(await pass('2026-11-12T23:30:00Z'));
    // Thu 20:00: 71 h out -> its 72 h wave.
    passes.push(await pass('2026-11-13T01:00:00Z'));
    // Fri 05:00: the draw game is 29 h out -> scheduled auto-draw (30 h).
    passes.push(await pass('2026-11-13T10:00:00Z'));
    // Fri 23:00: a game created 20 h before it starts (Sat 19:00): the
    // window-skip rule marks its 72 h and 24 h steps skipped, so they never fire.
    vi.setSystemTime(new Date('2026-11-14T04:00:00Z'));
    await ev('lg-fixed:2026-11-14', 'lg-fixed', '2026-11-14', '19:00');
    await applyReminderWindowSkipRule(env, 'lg-fixed', { id: 'lg-fixed:2026-11-14', start_time: '19:00' });
    passes.push(await pass('2026-11-14T04:05:00Z'));
    // Sat 08:00: the new game is 11 h out -> its 12 h logistics only.
    passes.push(await pass('2026-11-14T13:00:00Z'));
    // Sat 19:30: the Sunday game is 23.5 h out -> 24 h wave. Sun 08:00: 11 h -> logistics.
    passes.push(await pass('2026-11-15T00:30:00Z'));
    passes.push(await pass('2026-11-15T13:00:00Z'));
    // Mon 01:00: after the game.
    passes.push(await pass('2026-11-16T01:00:00Z'));

    const norm = s => String(s ?? '').replace(/t=[0-9a-f]{16,}/g, 't=*');
    const final = {
      outbox: (await env.DB.prepare(
        `SELECT id, kind, event_id, player_id, team, dedup_key, payload, send_after, created_at, sent_at, cancelled, attempts, failed_at, next_attempt_at, defer_reason, error, league_id FROM outbox ORDER BY id`).all()).results
        .map(r => ({ ...r, payload: norm(r.payload) })),
      reminderLog: (await env.DB.prepare(`SELECT event_id, kind, league_id, sent_at, recipient_count, skipped FROM league_reminder_log ORDER BY event_id, kind`).all()).results,
      drawLog: (await env.DB.prepare(`SELECT event_id, league_id, drawn_at, assigned_count FROM league_auto_draw_log ORDER BY event_id`).all()).results,
      rsvp: (await env.DB.prepare(`SELECT event_id, player_id, team, status FROM rsvp ORDER BY event_id, player_id`).all()).results,
      contacts: (await env.DB.prepare(`SELECT player_id, asked_streak, dormant, last_asked FROM contacts ORDER BY player_id`).all()).results,
      failures: (await env.DB.prepare(`SELECT league_id, event_id, player_id, kind FROM league_mail_failure_log ORDER BY id`).all()).results,
      jobs: (await env.DB.prepare(`SELECT event_id, job FROM jobs ORDER BY event_id, job`).all()).results
    };
    expect({ passes, final }).toMatchSnapshot();
  }, 60000);
});

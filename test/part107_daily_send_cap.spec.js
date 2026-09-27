// Sub-call rework, Part 1: never exceed the daily send cap (the Resend
// plan's emails per UTC day, MAIL_DAILY_CAP).
//   - roster mail (anything that is not a sub call) always sends, first;
//   - sub calls get what is left after reserving room for the roster mail
//     still to come today, and DEFER to the next UTC day when it is gone;
//   - the day's count lives in D1 (mail_daily_count), so it survives a
//     Worker restart, and a Resend quota refusal marks the day full.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { drain } from '../src/index.js';
import { utcDay, nextUtcMidnight, ADMIN_ALERT_RESERVE } from '../src/mail_queue.js';

const ADMIN_KEY = 'test-part107-admin';
let EVENT_ID;

function eastern(h) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(Date.now() + h * 3600000));
  const g = t => parts.find(p => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}
async function withResend(fn, status = () => 200, body = '{"id":"x"}') {
  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      const b = JSON.parse(opts.body);
      const st = status(b.to[0]);
      if (st === 200) sent.push(b.to[0]);
      return new Response(st === 200 ? '{"id":"x"}' : body, { status: st });
    }
    return new Response('{}', { status: 200 });
  };
  try { return { result: await fn(), sent }; } finally { globalThis.fetch = original; }
}
async function queue(kind, pid) {
  await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, payload, send_after, created_at, league_id) VALUES (?, ?, ?, 'Red', ?, ?, ?, 'smbhl')`)
    .bind(kind, EVENT_ID, pid, kind === 'sub_call' ? '{"need":"skater"}' : '{}', new Date(0).toISOString(), new Date().toISOString()).run();
}
const setCount = (sent, subCalls) => env.DB.prepare(`INSERT OR REPLACE INTO mail_daily_count (day, sent, sub_calls) VALUES (?, ?, ?)`).bind(utcDay(), sent, subCalls).run();
const count = async () => env.DB.prepare(`SELECT sent, sub_calls FROM mail_daily_count WHERE day = ?`).bind(utcDay()).first();
const rows = async kind => (await env.DB.prepare(`SELECT * FROM outbox WHERE kind = ? ORDER BY id`).bind(kind).all()).results;

beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  env.RSVP_SECRET = 'test-part107-rsvp';
  env.RESEND_API_KEY = 'test-part107-resend';
  await applyRealSchema(env);
  const { date, time } = eastern(30);
  EVENT_ID = `p107:${date}`;
  await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, 'Fall 2026', 5, 'open', ?, 'smbhl')`).bind(EVENT_ID, date, time).run();
  // Two rostered players on Red (each confirmed in, so gameday mail is eligible) ...
  for (const pid of ['R107A', 'R107B']) {
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, 'roster', 0, 0, 'salt', 'smbhl')`).bind(pid, pid, `${pid.toLowerCase()}@example.com`).run();
    await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, 'Red', 'in', 'roster', ?, 'smbhl')`).bind(EVENT_ID, pid, new Date().toISOString()).run();
  }
  // ... and eight subs.
  for (let i = 1; i <= 8; i++) {
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, 'sub_skater', 1, 0, 'salt', 'smbhl')`).bind(`S107${i}`, `Sub ${i}`, `s107.${i}@example.com`).run();
  }
});
beforeEach(async () => {
  env.MAIL_DAILY_CAP = '10';
  await env.DB.prepare('DELETE FROM outbox').run();
  await env.DB.prepare('DELETE FROM mail_daily_count').run();
});
afterEach(() => { vi.useRealTimers(); env.MAIL_DAILY_CAP = '100'; });

describe('Daily send cap', () => {
  it('roster mail still sends when the day is already used up by sub calls; the sub calls defer to the next UTC day, not dropped', async () => {
    await setCount(10, 10); // the whole cap went to sub calls
    await queue('sub_call', 'S1071');
    await queue('gameday', 'R107A');
    await queue('sub_call', 'S1072');
    await queue('gameday', 'R107B');
    const { sent, result } = await withResend(() => drain(env));
    expect(sent.sort()).toEqual(['r107a@example.com', 'r107b@example.com']);
    expect(result.deferred).toBe(2);
    for (const r of await rows('sub_call')) {
      expect(r.sent_at).toBeNull();
      expect(r.cancelled).toBe(0);
      expect(r.error).toBeNull();
      expect(r.attempts).toBe(0);
      expect(r.defer_reason).toBe('daily_cap');
      expect(r.next_attempt_at).toBe(nextUtcMidnight().toISOString());
    }
    expect(await count()).toEqual({ sent: 12, sub_calls: 10 });
  });

  it('the deferred sub calls go out on the next UTC day', async () => {
    await setCount(10, 10);
    await queue('sub_call', 'S1071');
    await queue('sub_call', 'S1072');
    await withResend(() => drain(env));
    expect((await rows('sub_call')).every(r => r.defer_reason === 'daily_cap')).toBe(true);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(nextUtcMidnight().getTime() + 5 * 60000)); // 00:05 UTC tomorrow
    const { sent } = await withResend(() => drain(env));
    expect(sent.sort()).toEqual(['s107.1@example.com', 's107.2@example.com']);
    for (const r of await rows('sub_call')) { expect(r.sent_at).not.toBeNull(); expect(r.defer_reason).toBeNull(); }
    const tomorrow = await env.DB.prepare(`SELECT sent, sub_calls FROM mail_daily_count WHERE day = ?`).bind(utcDay()).first();
    expect(tomorrow).toEqual({ sent: 2, sub_calls: 2 });
  });

  it('sub calls stop short of the cap, leaving room for the roster mail still to come today', async () => {
    // cap 10; reserve = 2 rostered players on today's open game + admin reserve.
    const reserve = 2 + ADMIN_ALERT_RESERVE;
    for (let i = 1; i <= 8; i++) await queue('sub_call', `S107${i}`);
    const first = await withResend(() => drain(env));
    expect(first.sent.length).toBe(10 - reserve);
    expect(first.result.deferred).toBe(8 - (10 - reserve));
    // The roster mail that arrives later still fits under the cap.
    await queue('gameday', 'R107A');
    await queue('gameday', 'R107B');
    const later = await withResend(() => drain(env));
    expect(later.sent.sort()).toEqual(['r107a@example.com', 'r107b@example.com']);
    expect((await count()).sent).toBeLessThanOrEqual(10);
  });

  it('when Resend itself refuses for quota, the sub call is deferred (not failed) and the day is marked full', async () => {
    await queue('sub_call', 'S1071');
    await queue('sub_call', 'S1072');
    const quota = '{"name":"daily_quota_exceeded","message":"You have reached your daily email sending quota."}';
    await withResend(() => drain(env), () => 429, quota);
    const [a, b] = await rows('sub_call');
    expect(a.defer_reason).toBe('resend_quota');
    expect(a.failed_at).toBeNull();
    expect(a.error).toBeNull();
    expect(a.attempts).toBe(0);
    expect((await count()).sent).toBe(10); // day marked full
    expect(b.defer_reason).toBe('daily_cap'); // nothing else attempted today
  });

  it('with no cap configured, nothing is deferred', async () => {
    env.MAIL_DAILY_CAP = '';
    await setCount(500, 500);
    await queue('sub_call', 'S1071');
    const { sent } = await withResend(() => drain(env));
    expect(sent).toEqual(['s107.1@example.com']);
  });

  it('Comms shows deferred sub calls and the day\'s count against the cap, in both languages', async () => {
    await setCount(10, 10);
    await queue('sub_call', 'S1071');
    await withResend(() => drain(env));
    const data = await (await SELF.fetch('http://example.com/admin/emails/data', { headers: { 'x-admin': ADMIN_KEY } })).json();
    expect(data.outbox.find(o => o.player_id === 'S1071').status).toBe('deferred');
    expect(data.daily).toEqual({ cap: 10, sent: 10, subCalls: 10 });
    const html = await (await SELF.fetch('http://example.com/admin/emails', { headers: { 'x-admin': ADMIN_KEY } })).text();
    expect(html).toContain('badgeDeferred: "⏸ Reporté (plafond quotidien)"');
    expect(html).toContain('badgeDeferred: "⏸ Deferred (daily cap)"');
    expect(html).toContain(`dailyCount: "Envois aujourd'hui (UTC) : {sent} / {cap}, dont {sub} appels aux remplaçants"`);
    expect(html).toContain('dailyCount: "Sent today (UTC): {sent} / {cap}, including {sub} sub calls"');
  });
});

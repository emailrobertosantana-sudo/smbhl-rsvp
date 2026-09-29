// Demo shares production's Resend account (90 a day), and MAIL_DAILY_CAP
// only holds back sub calls: roster mail went past demo's 10 (11 and 13 on
// Sept 27-28). MAIL_HARD_DAILY_CAP (set on demo only, wrangler.jsonc) caps
// EVERY kind: once the day's count reaches it, mail waits for the next UTC
// day -- queued mail deferred, a direct send queued as deferred -- as when
// Resend refuses for its own quota.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { mail, installMailCapture, removeMailCapture, rows, one } from './support/league_season.js';
import { drain, sendMail } from '../src/index.js';
import { hardDailyCapFromEnv, isMailDeferred, nextUtcMidnight, utcDay } from '../src/mail_queue.js';

const NOW = Date.UTC(2026, 9, 5, 16, 0);
beforeAll(async () => {
  env.RESEND_API_KEY = 'x'; env.RSVP_SECRET = 'p163'; env.MAIL_DAILY_CAP = '10';
  vi.useFakeTimers({ toFake: ['Date'] });
  await applyRealSchema(env);
  installMailCapture();
});
beforeEach(async () => {
  vi.setSystemTime(new Date(NOW)); mail.sent.length = 0;
  await env.DB.prepare('DELETE FROM outbox').run();
  await env.DB.prepare('DELETE FROM mail_daily_count').run();
});
afterAll(() => { delete env.MAIL_HARD_DAILY_CAP; removeMailCapture(); vi.useRealTimers(); });

const queue = async n => {
  for (let i = 0; i < n; i++) {
    const payload = JSON.stringify({ prerendered: { to: `hc.p${i}@example.com`, subject: `Reminder ${i}`, text: 'x', html: null } });
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, payload, send_after, created_at, league_id, quiet_exempt) VALUES ('reminder_24h', 'lg:e', NULL, ?, ?, ?, 'lg', 1)`).bind(payload, new Date(0).toISOString(), new Date().toISOString()).run();
  }
};

describe('A hard daily cap covers every kind of email', () => {
  it('reads MAIL_HARD_DAILY_CAP; unset means none', () => {
    expect(hardDailyCapFromEnv({})).toBeNull();
    expect(hardDailyCapFromEnv({ MAIL_HARD_DAILY_CAP: '10' })).toBe(10);
  });

  it('roster mail stops at the cap and waits for the next UTC day', async () => {
    env.MAIL_HARD_DAILY_CAP = '3';
    await env.DB.prepare('INSERT INTO mail_daily_count (day, sent, sub_calls) VALUES (?, 2, 0)').bind(utcDay()).run();
    await queue(3);
    await drain(env);
    expect(mail.sent.map(m => m.subject)).toEqual(['Reminder 0']);
    const waiting = await rows(`SELECT defer_reason, next_attempt_at FROM outbox WHERE sent_at IS NULL`);
    expect(waiting).toHaveLength(2);
    for (const w of waiting) { expect(w.defer_reason).toBe('resend_quota'); expect(Date.parse(w.next_attempt_at)).toBeGreaterThanOrEqual(nextUtcMidnight(new Date(NOW)).getTime()); }
    // A direct send (an alert, a sign-up email) waits too: queued, not lost.
    let err = null;
    try { await sendMail(env, 'someone@example.com', 'Direct', 'x'); } catch (e) { err = e; }
    expect(isMailDeferred(err)).toBe(true);
    expect(mail.sent).toHaveLength(1);
    // The next day, it all goes.
    vi.setSystemTime(new Date(nextUtcMidnight(new Date(NOW)).getTime() + 12 * 3600000));
    await drain(env);
    expect(mail.sent.map(m => m.subject).sort()).toEqual(['Direct', 'Reminder 0', 'Reminder 1', 'Reminder 2']);
  });

  it('without it (production), the same queue all goes out', async () => {
    delete env.MAIL_HARD_DAILY_CAP;
    await env.DB.prepare('INSERT INTO mail_daily_count (day, sent, sub_calls) VALUES (?, 2, 0)').bind(utcDay()).run();
    await queue(3);
    await drain(env);
    expect(mail.sent).toHaveLength(3);
  });
});

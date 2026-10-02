// Billing fixes, item 4: Montreal time (America/Toronto) for every date or
// "today" a person sees (src/montreal_time.js).
//   - the trial covers whole Montreal days: its last day is the start's
//     Montreal day plus 2 months, and it ends at 00:00 Montreal the day
//     after (also the trial_end sent to Checkout);
//   - the notices show Montreal days, and "on the day" is the Montreal day;
//   - around midnight Montreal and midnight UTC, and across the change to
//     standard time on 2026-11-01.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { trialWindow, billingLaunchAt } from '../src/billing.js';
import { montrealDate, montrealMidnight, addCalendarMonths, dayDiff, lastDayBefore } from '../src/montreal_time.js';
import { noticeDate } from '../src/billing_notices.js';
import { runBillingEnforcement } from '../src/billing_enforcement.js';
import { createCheckout } from '../src/billing_actions.js';

describe('the Montreal day of an instant', () => {
  it('around midnight UTC and midnight Montreal, in daylight and standard time', () => {
    // Daylight time (UTC-4).
    expect(montrealDate('2026-10-05T03:59:00.000Z')).toBe('2026-10-04');
    expect(montrealDate('2026-10-05T04:00:00.000Z')).toBe('2026-10-05');
    expect(montrealDate('2026-10-05T23:59:00.000Z')).toBe('2026-10-05');
    expect(montrealDate('2026-10-06T00:01:00.000Z')).toBe('2026-10-05');
    // November 1, 2026: back to standard time at 2 am (06:00 UTC).
    expect(montrealDate('2026-11-01T03:59:00.000Z')).toBe('2026-10-31');
    expect(montrealDate('2026-11-01T04:00:00.000Z')).toBe('2026-11-01');
    expect(montrealDate('2026-11-02T04:59:00.000Z')).toBe('2026-11-01');
    expect(montrealDate('2026-11-02T05:00:00.000Z')).toBe('2026-11-02');
    // Standard time (UTC-5).
    expect(montrealDate('2026-12-02T04:59:00.000Z')).toBe('2026-12-01');
    expect(montrealDate('2026-12-02')).toBe('2026-12-02');
    expect(montrealMidnight('2026-11-01').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(montrealMidnight('2026-11-02').toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(montrealMidnight('2027-03-14').toISOString()).toBe('2027-03-14T05:00:00.000Z');
    expect(montrealMidnight('2027-03-15').toISOString()).toBe('2027-03-15T04:00:00.000Z');
    expect(addCalendarMonths('2026-12-31', 2)).toBe('2027-02-28');
    expect(addCalendarMonths('2027-12-31', 2)).toBe('2028-02-29');
    expect(dayDiff('2026-10-31', '2026-11-02')).toBe(2);
    expect(lastDayBefore('2026-11-02T05:00:00.000Z')).toBe('2026-11-01');
  });

  it('notices write the Montreal day', () => {
    expect(noticeDate('2026-12-02T04:30:00.000Z', 'fr')).toBe('mardi 1er décembre 2026');
    expect(noticeDate('2026-12-02T05:30:00.000Z', 'fr')).toBe('mercredi 2 décembre 2026');
    expect(noticeDate('2026-11-02T04:30:00.000Z', 'en')).toBe('Sunday, November 1, 2026');
    expect(noticeDate('2026-12-01', 'fr')).toBe('mardi 1er décembre 2026');
  });
});

describe('the trial: whole Montreal days', () => {
  const env1 = { BILLING_LAUNCH_AT: '2026-08-01' };
  const end = createdAt => trialWindow(env1, { id: 'x', created_at: createdAt }, null).end;

  it('a bare launch date is that Montreal day', () => {
    expect(billingLaunchAt({ BILLING_LAUNCH_AT: '2026-10-02' }).toISOString()).toBe('2026-10-02T04:00:00.000Z');
    expect(trialWindow({ BILLING_LAUNCH_AT: '2026-10-02' }, { id: 'x', created_at: '2026-09-01T00:00:00Z' }, null).end).toBe('2026-12-03T05:00:00.000Z');
  });

  it('created around midnight Montreal and midnight UTC', () => {
    // October 4, 23:30 in Montreal: last day December 4.
    expect(end('2026-10-05T03:30:00Z')).toBe('2026-12-05T05:00:00.000Z');
    // October 5, 00:30 in Montreal: last day December 5.
    expect(end('2026-10-05T04:30:00Z')).toBe('2026-12-06T05:00:00.000Z');
    // Either side of midnight UTC, the same Montreal day (October 5).
    expect(end('2026-10-05T23:30:00Z')).toBe('2026-12-06T05:00:00.000Z');
    expect(end('2026-10-06T00:30:00Z')).toBe('2026-12-06T05:00:00.000Z');
  });

  it('across the change to standard time on 2026-11-01', () => {
    // August 31, 23:59 in Montreal: last day October 31, ends 00:00 November 1 (daylight time).
    expect(end('2026-09-01T03:59:00Z')).toBe('2026-11-01T04:00:00.000Z');
    // September 1, 00:00 in Montreal: last day November 1 (a 25-hour day), ends 00:00 November 2 (standard time).
    expect(end('2026-09-01T04:00:00Z')).toBe('2026-11-02T05:00:00.000Z');
    expect(lastDayBefore(end('2026-09-01T04:00:00Z'))).toBe('2026-11-01');
  });
});

const DAY = 86400000;
const VARS = {
  BILLING_LAUNCH_AT: '2026-08-01',
  STRIPE_SECRET_KEY: 'rk_test_p220_not_real',
  STRIPE_API_VERSION: '2026-08-26.dahlia',
  STRIPE_PRICE_STANDARD_MONTHLY: 'price_std_m', STRIPE_PRICE_STANDARD_YEARLY: 'price_std_y',
  STRIPE_PRICE_PLUS_MONTHLY: 'price_plus_m', STRIPE_PRICE_PLUS_YEARLY: 'price_plus_y',
  LEAGUE_PRODUCT: 'true'
};
const originalFetch = globalThis.fetch;
let calls = [];
let queued = [];
const host = {
  enqueue: async m => { queued.push(m); },
  drainLeague: async () => {},
  adminEmails: async id => (await env.DB.prepare('SELECT u.email FROM league_admins la JOIN users u ON u.id = la.user_id WHERE la.league_id = ?').bind(id).all()).results,
  ownerEmail: async id => { const r = await env.DB.prepare('SELECT u.email FROM leagues l JOIN users u ON u.id = l.created_by WHERE l.id = ?').bind(id).first(); return r ? r.email : null; },
  publicUrl: 'https://rsvp.notreligue.example'
};
async function mkLeague(id, createdAt, billing = {}) {
  await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', ?)`).bind(`u-${id}`, `u-${id}@example.com`, createdAt).run();
  await env.DB.prepare(`INSERT INTO leagues (id, name, team_count, team_names, created_by, created_at, language_mode) VALUES (?, ?, 2, '["A","B"]', ?, ?, 'fr')`)
    .bind(id, `Ligue ${id}`, `u-${id}`, createdAt).run();
  await env.DB.prepare(`INSERT INTO league_admins (user_id, league_id, created_at) VALUES (?, ?, ?)`).bind(`u-${id}`, id, createdAt).run();
  const values = { owner_user_id: `u-${id}`, status: 'trial', regular_count: 20, count_tier: 'standard', updated_at: createdAt, ...billing };
  const cols = Object.keys(values);
  await env.DB.prepare(`INSERT INTO league_billing (league_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).bind(id, ...cols.map(c => values[c])).run();
}
const kinds = async id => (await env.DB.prepare('SELECT kind FROM billing_notices WHERE league_id = ? ORDER BY sent_at').bind(id).all()).results.map(r => r.kind);
const only = id => env.DB.prepare('UPDATE leagues SET deactivated_at = CASE WHEN id = ? THEN NULL ELSE ? END').bind(id, '2026-01-01T00:00:00Z').run();

describe('"on the day" is the Montreal day', () => {
  beforeAll(async () => {
    Object.assign(env, VARS);
    env.HEALTH_ALERTS = 'off';
    await applyRealSchema(env);
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (!u.startsWith('https://api.stripe.com/')) return originalFetch(url, opts);
      calls.push({ path: new URL(u).pathname.replace('/v1', ''), body: String(opts.body || '') });
      return Response.json({ id: 'cs_p220', url: 'https://checkout.stripe.com/c/pay/cs_p220' });
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('standard time: the last day starts at 05:00 UTC, not at midnight UTC', async () => {
    // Created October 1 (Montreal): last day December 1, ends 00:00 December 2 (05:00 UTC).
    await mkLeague('m1', '2026-10-01T16:00:00.000Z');
    await only('m1');
    queued = [];
    await runBillingEnforcement(env, host, new Date('2026-11-25T05:00:00Z'));
    expect(await kinds('m1')).toEqual(['trial_7d']);
    expect(queued[0].mail.subject).toBe('Ligue m1 : ton essai gratuit se termine le mardi 1er décembre 2026');
    // December 1 at 00:30 UTC is still November 30 in Montreal: not yet.
    await runBillingEnforcement(env, host, new Date('2026-12-01T00:30:00Z'));
    await runBillingEnforcement(env, host, new Date('2026-12-01T04:59:00Z'));
    expect(await kinds('m1')).toEqual(['trial_7d']);
    // December 1 at 00:01 in Montreal: the last day.
    await runBillingEnforcement(env, host, new Date('2026-12-01T05:01:00Z'));
    expect(await kinds('m1')).toEqual(['trial_7d', 'trial_day']);
    expect(queued[1].mail.subject).toBe('Ligue m1 : dernier rappel, ton essai gratuit se termine le mardi 1er décembre 2026');
    // The trial ends at 00:00 Montreal on December 2: read-only only then.
    await runBillingEnforcement(env, host, new Date('2026-12-02T04:59:00Z'));
    expect(await kinds('m1')).toEqual(['trial_7d', 'trial_day']);
    await runBillingEnforcement(env, host, new Date('2026-12-02T05:00:00Z'));
    expect(await kinds('m1')).toEqual(['trial_7d', 'trial_day', 'trial_end']);
  });

  it('across the change to standard time: November 1 is a 25-hour day, all of it the last day', async () => {
    // Created September 1, 00:00 Montreal: last day November 1, ends 00:00 November 2 (05:00 UTC).
    await mkLeague('m2', '2026-09-01T04:00:00.000Z');
    await only('m2');
    queued = [];
    await runBillingEnforcement(env, host, new Date('2026-10-27T12:00:00Z'));
    expect(await kinds('m2')).toEqual(['trial_7d']);
    // October 31, 23:30 in Montreal (daylight time): not yet.
    await runBillingEnforcement(env, host, new Date('2026-11-01T03:30:00Z'));
    expect(await kinds('m2')).toEqual(['trial_7d']);
    // November 1, 00:30 in Montreal: 24.5 hours before the end, already the last day.
    await runBillingEnforcement(env, host, new Date('2026-11-01T04:30:00Z'));
    expect(await kinds('m2')).toEqual(['trial_7d', 'trial_day']);
    expect(queued[1].mail.subject).toBe('Ligue m2 : dernier rappel, ton essai gratuit se termine le dimanche 1er novembre 2026');
  });

  it('Checkout sends the trial end as 00:00 Montreal', async () => {
    await mkLeague('m3', '2026-10-05T03:30:00.000Z', { regular_count: 20 });
    // 20 regular players, so the count refresh keeps it at Standard.
    for (let i = 0; i < 20; i++) await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, token_salt, league_id, is_active) VALUES (?, ?, ?, 'roster', 0, 's', 'm3', 1)`).bind(`m3:r${i}`, `R${i}`, `r${i}.p220@example.com`).run();
    calls = [];
    const r = await createCheckout(env, 'm3', 'month', { origin: 'https://x.example', lang: 'fr', now: new Date('2026-11-01T12:00:00Z') });
    expect(r.ok).toBe(true);
    const form = Object.fromEntries(calls[0].body.split('&').map(kv => kv.split('=').map(decodeURIComponent)));
    // Created October 4 at 23:30 in Montreal: last day December 4, first charge 00:00 December 5 Montreal.
    expect(Number(form['subscription_data[trial_end]'])).toBe(Date.parse('2026-12-05T05:00:00.000Z') / 1000);
  });
});

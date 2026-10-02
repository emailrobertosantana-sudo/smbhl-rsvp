// Billing fixes, item 3: a paid league that drops under 15 regular players,
// and the free slot that never swaps (src/billing_enforcement.js
// freeDropStep, src/billing.js freeSlotsByOwner).
//   - the slot free: the subscription is set to end at the next billing
//     date (cancel_at_period_end, idempotency key, metadata), the owner is
//     told once; at the period end the league is free, not read-only, no
//     12-month clock;
//   - the slot taken by another league of the owner: nothing changes, and
//     the younger league keeps the slot;
//   - back at 15 or more before the date: the app withdraws its own
//     cancellation, never one the owner chose.
// Stripe is a local stub (no real call); mail is captured by a fake host.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { runBillingEnforcement } from '../src/billing_enforcement.js';
import { noticeContent, noticeDate } from '../src/billing_notices.js';
import { loadLeagueState, freeSlotsByOwner } from '../src/billing.js';
import { processStripeEvent } from '../src/stripe_webhook.js';

const VARS = {
  BILLING_LAUNCH_AT: '2026-10-01T00:00:00Z',
  STRIPE_SECRET_KEY: 'rk_test_p219_not_real',
  STRIPE_API_VERSION: '2026-08-26.dahlia',
  STRIPE_PRICE_STANDARD_MONTHLY: 'price_std_m', STRIPE_PRICE_STANDARD_YEARLY: 'price_std_y',
  STRIPE_PRICE_PLUS_MONTHLY: 'price_plus_m', STRIPE_PRICE_PLUS_YEARLY: 'price_plus_y',
  LEAGUE_PRODUCT: 'true'
};
const DAY = 86400000;
const T0 = Date.now();
const at = ms => new Date(T0 + ms);
const iso = ms => at(ms).toISOString();
const PERIOD_END = 10 * DAY;

// The Stripe stub: a POST to a subscription applies cancel_at_period_end
// and metadata, and stamps canceled_at as Stripe does.
const originalFetch = globalThis.fetch;
let calls = [];
let objects = {};
let stampSeq = 1800000000;
const parseForm = body => Object.fromEntries(String(body || '').split('&').filter(Boolean).map(kv => kv.split('=').map(decodeURIComponent)));
function stub() {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('api.resend.com')) return new Response('{"id":"x"}', { status: 200 });
    if (!u.startsWith('https://api.stripe.com/')) return originalFetch(url, opts);
    const path = new URL(u).pathname.replace('/v1', '');
    const call = { method: opts.method || 'GET', path, form: parseForm(opts.body), headers: opts.headers || {} };
    calls.push(call);
    const o = objects[path];
    if (!o) return Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing' } }, { status: 404 });
    if (call.method === 'POST') {
      if ('cancel_at_period_end' in call.form) {
        o.cancel_at_period_end = call.form.cancel_at_period_end === 'true';
        o.canceled_at = o.cancel_at_period_end ? ++stampSeq : null;
      }
      if ('metadata[nl_cancel_reason]' in call.form) {
        o.metadata = { ...o.metadata };
        if (call.form['metadata[nl_cancel_reason]']) o.metadata.nl_cancel_reason = call.form['metadata[nl_cancel_reason]'];
        else delete o.metadata.nl_cancel_reason;
      }
    }
    return Response.json(o);
  };
}
const sub = (id, leagueId, over = {}) => ({
  id, object: 'subscription', status: 'active', customer: `cus_${id}`, cancel_at_period_end: false, cancel_at: null, canceled_at: null, pause_collection: null,
  metadata: { league_id: leagueId }, trial_start: null, trial_end: null, default_payment_method: 'pm_1',
  items: { data: [{ id: 'si_1', current_period_end: Math.floor((T0 + PERIOD_END) / 1000), price: { id: 'price_std_m', recurring: { interval: 'month' } } }] },
  ...over
});

let queued = [];
const host = {
  enqueue: async m => { queued.push(m); },
  drainLeague: async () => {},
  adminEmails: async id => (await env.DB.prepare('SELECT u.email FROM league_admins la JOIN users u ON u.id = la.user_id WHERE la.league_id = ? ORDER BY u.email').bind(id).all()).results,
  ownerEmail: async id => { const r = await env.DB.prepare('SELECT u.email FROM leagues l JOIN users u ON u.id = l.created_by WHERE l.id = ?').bind(id).first(); return r ? r.email : null; },
  publicUrl: 'https://rsvp.notreligue.example'
};
const run = (ms = 0) => runBillingEnforcement(env, host, at(ms));
const mailsFor = id => queued.filter(m => m.leagueId === id);
const row = id => env.DB.prepare('SELECT * FROM league_billing WHERE league_id = ?').bind(id).first();
const setCount = (id, n) => env.DB.prepare('UPDATE league_billing SET regular_count = ?, count_tier = ?, regular_count_at = ? WHERE league_id = ?')
  .bind(n, n <= 14 ? 'free' : n <= 50 ? 'standard' : 'plus', new Date().toISOString() + Math.random(), id).run();
const subPosts = (subId) => calls.filter(c => c.method === 'POST' && c.path === `/subscriptions/${subId}`);

async function mkLeague(id, { createdAt = '2026-10-05T00:00:00.000Z', coAdmins = 0, owner = null, billing = {} } = {}) {
  const ownerId = owner || `u-${id}`;
  await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', ?)`).bind(ownerId, `${ownerId}@example.com`, createdAt).run();
  await env.DB.prepare(`INSERT INTO leagues (id, name, team_count, team_names, created_by, created_at, language_mode) VALUES (?, ?, 2, '["A","B"]', ?, ?, 'fr')`)
    .bind(id, `Les ${id}`, ownerId, createdAt).run();
  await env.DB.prepare(`INSERT INTO league_admins (user_id, league_id, created_at) VALUES (?, ?, ?)`).bind(ownerId, id, createdAt).run();
  for (let i = 1; i <= coAdmins; i++) {
    const uid = `u-${id}-co${i}`;
    await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', ?)`).bind(uid, `${uid}@example.com`, createdAt).run();
    await env.DB.prepare(`INSERT INTO league_admins (user_id, league_id, created_at) VALUES (?, ?, ?)`).bind(uid, id, createdAt).run();
  }
  const values = { owner_user_id: ownerId, status: 'trial', updated_at: new Date(T0).toISOString(), ...billing };
  const cols = Object.keys(values);
  await env.DB.prepare(`INSERT INTO league_billing (league_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).bind(id, ...cols.map(c => values[c])).run();
  return id;
}
const PAST = count => ({ regular_count: count, count_tier: count <= 14 ? 'free' : count <= 50 ? 'standard' : 'plus', regular_count_at: iso(0), trial_started_at: iso(-90 * DAY), trial_ends_at: iso(-30 * DAY) });
const LIVE = id => ({ stripe_customer_id: `cus_sub_${id}`, stripe_subscription_id: `sub_${id}`, tier: 'standard', billing_interval: 'month', current_period_end: iso(PERIOD_END), status: 'active', stripe_status: 'active', last_paid_at: iso(-20 * DAY) });
async function paid(id, count, opts = {}) {
  await mkLeague(id, { ...opts, billing: { ...PAST(count), ...LIVE(id) } });
  objects[`/subscriptions/sub_${id}`] = sub(`sub_${id}`, id);
  return id;
}

beforeAll(async () => {
  Object.assign(env, VARS);
  env.AUTH_SECRET = 'test-p219-auth';
  env.RSVP_SECRET = 'test-p219-rsvp';
  env.RESEND_API_KEY = 'mock-key';
  env.HEALTH_ALERTS = 'off';
  await applyRealSchema(env);
  stub();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('the notice, as written', () => {
  it('French and English, owner only, dates in words', () => {
    const v = { leagueName: 'Les Hiboux', date: '2026-12-01', count: 12 };
    const c = noticeContent('free_drop', v);
    expect(c.fr.subject).toBe('Les Hiboux : ta ligue redevient gratuite le mardi 1er décembre 2026');
    expect(c.fr.paragraphs).toEqual([
      'Les Hiboux compte maintenant 12 joueurs réguliers, moins de 15 : une ligue de cette taille est gratuite. Ton abonnement prendra fin le mardi 1er décembre 2026, ta prochaine date de facturation, et tu ne paieras plus rien.',
      "Si la ligue revient à 15 joueurs réguliers ou plus avant cette date, l'abonnement continue."
    ]);
    expect(c.fr.button).toBe("Voir l'abonnement");
    expect(c.en.subject).toBe('Les Hiboux: your league becomes free on Tuesday, December 1, 2026');
    expect(c.en.paragraphs).toEqual([
      'Les Hiboux now has 12 regular players, fewer than 15: a league this size is free. Your subscription will end on Tuesday, December 1, 2026, your next billing date, and you will pay nothing more.',
      'If the league is back at 15 or more regular players before then, the subscription continues.'
    ]);
    expect(c.en.button).toBe('See the subscription');
  });
});

describe('a paid league drops under 15', () => {
  it('the slot is free: the subscription ends at the next billing date, the owner is told once; then the league is free', async () => {
    const id = await paid('fa', 20, { coAdmins: 1 });
    queued = []; calls = [];
    await run();
    expect(subPosts('sub_fa')).toHaveLength(0);
    await setCount(id, 11);
    await run(3600000);
    const posts = subPosts('sub_fa');
    expect(posts).toHaveLength(1);
    expect(posts[0].form).toEqual({ cancel_at_period_end: 'true', 'metadata[nl_cancel_reason]': 'under_15' });
    expect(posts[0].headers['idempotency-key']).toMatch(/^free-drop:on:sub_fa:/);
    expect(await row(id)).toMatchObject({ cancel_at_period_end: 1, status: 'active' });
    expect(mailsFor(id).map(m => m.to)).toEqual(['u-fa@example.com']);
    expect(mailsFor(id)[0].mail.subject).toBe(`Les fa : ta ligue redevient gratuite le ${noticeDate(iso(PERIOD_END), 'fr')}`);
    expect(mailsFor(id)[0].mail.text).toContain('Les fa compte maintenant 11 joueurs réguliers, moins de 15');
    expect(mailsFor(id)[0].mail.text).toContain("Voir l'abonnement : https://rsvp.notreligue.example/league/billing?league_id=fa");
    // Idempotent: nothing more on the next passes.
    await run(2 * 3600000); await run(DAY);
    expect(subPosts('sub_fa')).toHaveLength(1);
    expect(mailsFor(id)).toHaveLength(1);
    // The period ends: Stripe cancels it. The league is free, never read-only,
    // no 12-month clock.
    objects['/subscriptions/sub_fa'].status = 'canceled';
    await processStripeEvent(env, { id: 'evt_fa_end', type: 'customer.subscription.deleted', data: { object: { id: 'sub_fa' } } });
    expect((await row(id)).status).toBe('inactive');
    expect(await loadLeagueState(env, id, at(PERIOD_END + 60000))).toMatchObject({ status: 'free', readOnly: false, inactive: false, mailStopped: false });
    await run(PERIOD_END + 60000);
    expect(await row(id)).toMatchObject({ status: 'free', inactive_since: null, read_only_since: null });
    expect(mailsFor(id)).toHaveLength(1);
  });

  it('the slot is taken by a younger league: nothing changes, and the younger league keeps it', async () => {
    const old = await paid('fb-old', 20, { owner: 'u-fb', createdAt: '2026-10-01T00:00:00.000Z' });
    const young = await mkLeague('fb-young', { owner: 'u-fb', createdAt: '2026-10-03T00:00:00.000Z', billing: PAST(6) });
    queued = []; calls = [];
    await run();
    expect((await row(young)).status).toBe('free');
    await setCount(old, 9);
    await run(3600000); await run(DAY);
    expect(subPosts('sub_fb-old')).toHaveLength(0);
    expect(await row(old)).toMatchObject({ status: 'active', cancel_at_period_end: 0 });
    expect(mailsFor(old)).toHaveLength(0);
    expect(await loadLeagueState(env, young, at(DAY))).toMatchObject({ status: 'free', readOnly: false, freeEligible: true });
    expect(await loadLeagueState(env, old, at(DAY))).toMatchObject({ status: 'active', freeEligible: false });
  });

  it('back at 15 or more before the date: the app withdraws its own cancellation', async () => {
    const id = await paid('fc', 20);
    await setCount(id, 12);
    queued = []; calls = [];
    await run();
    expect(subPosts('sub_fc')).toHaveLength(1);
    await setCount(id, 16);
    await run(DAY);
    const posts = subPosts('sub_fc');
    expect(posts).toHaveLength(2);
    expect(posts[1].form).toEqual({ cancel_at_period_end: 'false', 'metadata[nl_cancel_reason]': '' });
    expect(posts[1].headers['idempotency-key']).toMatch(/^free-drop:off:sub_fc:\d+$/);
    expect(objects['/subscriptions/sub_fc']).toMatchObject({ cancel_at_period_end: false });
    expect(objects['/subscriptions/sub_fc'].metadata.nl_cancel_reason).toBeUndefined();
    expect(await row(id)).toMatchObject({ status: 'active', cancel_at_period_end: 0 });
    await run(2 * DAY);
    expect(subPosts('sub_fc')).toHaveLength(2);
  });

  it("a cancellation the owner chose is never withdrawn, even one made after the app's", async () => {
    // The owner cancelled in the portal: no record, no Stripe call at all.
    const own = await paid('fd', 20);
    objects['/subscriptions/sub_fd'] = sub('sub_fd', own, { cancel_at_period_end: true, canceled_at: 1790000000 });
    await env.DB.prepare('UPDATE league_billing SET cancel_at_period_end = 1 WHERE league_id = ?').bind(own).run();
    calls = [];
    await run();
    expect(calls.filter(c => c.path === '/subscriptions/sub_fd')).toHaveLength(0);
    // The app scheduled one; the owner renewed, then cancelled again in the
    // portal (a new canceled_at), and the league grew back: left alone.
    const id = await paid('fe', 12);
    await run();
    expect(subPosts('sub_fe')).toHaveLength(1);
    objects['/subscriptions/sub_fe'].canceled_at = 1890000000;
    await setCount(id, 18);
    calls = [];
    await run(DAY);
    expect(subPosts('sub_fe')).toHaveLength(0);
    expect(objects['/subscriptions/sub_fe'].cancel_at_period_end).toBe(true);
  });
});

describe('the free slot never swaps', () => {
  it('an older league dropping back under 15 does not take the slot (pure)', () => {
    const leagues = [{ id: 'a', created_at: '2026-10-01', created_by: 'o' }, { id: 'b', created_at: '2026-10-02', created_by: 'o' }];
    const rows = new Map([['a', { regular_count: 9 }], ['b', { regular_count: 5 }]]);
    expect(freeSlotsByOwner(leagues, rows).get('o')).toBe('a');
    expect(freeSlotsByOwner(leagues, rows, new Map([['o', 'b']])).get('o')).toBe('b');
    // The holder grows to 15: it no longer qualifies, the slot goes to the other.
    rows.set('b', { regular_count: 15 });
    expect(freeSlotsByOwner(leagues, rows, new Map([['o', 'b']])).get('o')).toBe('a');
  });

  it('two leagues of one owner without subscriptions: the younger keeps the slot when the older drops under 15', async () => {
    const old = await mkLeague('fs-old', { owner: 'u-fs', createdAt: '2026-10-01T00:00:00.000Z', billing: PAST(20) });
    const young = await mkLeague('fs-young', { owner: 'u-fs', createdAt: '2026-10-03T00:00:00.000Z', billing: PAST(4) });
    await run();
    expect(await loadLeagueState(env, old, at(0))).toMatchObject({ status: 'unpaid', readOnly: true });
    expect(await loadLeagueState(env, young, at(0))).toMatchObject({ status: 'free', readOnly: false });
    await setCount(old, 7);
    await run(DAY);
    expect(await loadLeagueState(env, young, at(DAY))).toMatchObject({ status: 'free', readOnly: false });
    expect(await loadLeagueState(env, old, at(DAY))).toMatchObject({ status: 'unpaid', readOnly: true, freeEligible: false });
    expect((await row(young)).status).toBe('free');
  });
});

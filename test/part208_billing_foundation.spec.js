// Batch 7 item 4: Notre Ligue billing, batch 1 of 3 (src/billing.js,
// src/stripe.js, src/stripe_webhook.js, migrate-056.sql).
//   - the migration on a fresh and an existing schema; code from before it
//     on the new schema;
//   - the regular-player count: subs, inactive, no email, opted out,
//     duplicates; SMBHL never counted; refreshed by the roster routes and
//     the daily job;
//   - the webhook: signature valid, invalid, expired, duplicate; each
//     handled event writing league_billing from the object fetched fresh;
//   - billing off (BILLING_LAUNCH_AT unset) changes nothing: no Stripe
//     call, the webhook is not there, nothing gated.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { applyRealSchema, getRealMigrationQueries } from './support/real_schema.js';
import { regularCount, refreshRegularCount, refreshDailyRegularCounts, tierForCount, billingSummary, freeSlotLeagueId, trialWindow, addMonths } from '../src/billing.js';
import { stripeRequest, formEncode, StripeError } from '../src/stripe.js';
import { verifyStripeSignature } from '../src/stripe_webhook.js';

const WHSEC = 'whsec_test_p208';
const LAUNCH = '2026-10-15T00:00:00Z';
const enc = new TextEncoder();
const hex = async (secret, msg) => {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))].map(b => b.toString(16).padStart(2, '0')).join('');
};
const signed = async (payload, { secret = WHSEC, t = Math.floor(Date.now() / 1000) } = {}) => {
  const raw = JSON.stringify(payload);
  return { raw, header: `t=${t},v1=${await hex(secret, `${t}.${raw}`)}` };
};

const BILLING_VARS = ['BILLING_LAUNCH_AT', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_API_VERSION', 'STRIPE_PRICE_STANDARD_MONTHLY', 'STRIPE_PRICE_PLUS_YEARLY', 'LEAGUE_PRODUCT'];
const billingOn = () => {
  env.BILLING_LAUNCH_AT = LAUNCH;
  env.STRIPE_SECRET_KEY = 'rk_test_p208_not_real';
  env.STRIPE_WEBHOOK_SECRET = WHSEC;
  env.STRIPE_API_VERSION = '2025-09-30.clover';
  env.STRIPE_PRICE_STANDARD_MONTHLY = 'price_std_m';
  env.STRIPE_PRICE_PLUS_YEARLY = 'price_plus_y';
  env.LEAGUE_PRODUCT = 'true';
};
const billingOff = () => { for (const k of BILLING_VARS) delete env[k]; };

// Stripe, answered locally: the objects the handlers fetch, and every call
// they make.
const originalFetch = globalThis.fetch;
let stripeCalls = [];
let stripeObjects = {};
function stubStripe() {
  stripeCalls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.stripe.com/')) {
      stripeCalls.push({ url: u, method: opts.method, headers: opts.headers });
      const path = new URL(u).pathname.replace('/v1', '');
      const obj = stripeObjects[path];
      if (!obj) return new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such object: rk_live_secret_leak_check' } }), { status: 404 });
      return new Response(JSON.stringify(obj), { status: 200 });
    }
    return originalFetch(url, opts);
  };
}
afterEach(() => { globalThis.fetch = originalFetch; billingOff(); });

const user = id => env.DB.prepare(
  `INSERT OR IGNORE INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', '2026-09-01T00:00:00Z')`
).bind(id, `${id}@example.com`).run();
const league = async (id, createdBy = 'u-owner', createdAt = '2026-09-01T00:00:00Z', deactivatedAt = null) => {
  await user(createdBy);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO leagues (id, name, team_count, team_names, created_by, created_at, deactivated_at) VALUES (?, ?, 2, '["A","B"]', ?, ?, ?)`
  ).bind(id, `League ${id}`, createdBy, createdAt, deactivatedAt).run();
};
let pid = 0;
const contact = (leagueId, { role = 'roster', email = null, active = 1, optedOut = 0 } = {}) => env.DB.prepare(
  `INSERT INTO contacts (player_id, name, email, role, is_sub, token_salt, league_id, is_active, opted_out) VALUES (?, ?, ?, ?, ?, 's', ?, ?, ?)`
).bind(`p208-${++pid}`, `P ${pid}`, email, role, role === 'roster' ? 0 : 1, leagueId, active, optedOut).run();
const row = id => env.DB.prepare('SELECT * FROM league_billing WHERE league_id = ?').bind(id).first();

beforeAll(async () => {
  env.AUTH_SECRET = 'test-p208-auth';
  env.RSVP_SECRET = 'test-p208-rsvp';
  env.RESEND_API_KEY = 'mock-key';
  env.ADMIN_KEY = 'test-p208-admin';
  await applyRealSchema(env);
});

describe('migrate-056', () => {
  it('a fresh schema has the three tables and their columns', async () => {
    const cols = async t => ((await env.DB.prepare(`PRAGMA table_info(${t})`).all()).results || []).map(r => r.name);
    expect(await cols('league_billing')).toEqual(expect.arrayContaining(['league_id', 'owner_user_id', 'stripe_customer_id', 'stripe_subscription_id', 'tier', 'status', 'trial_ends_at', 'regular_count', 'count_tier', 'free_exception', 'billing_exempt', 'updated_at']));
    expect(await cols('stripe_events')).toEqual(expect.arrayContaining(['id', 'type', 'league_id', 'object_id', 'created', 'received_at', 'processed_at', 'attempts', 'error']));
    expect(await cols('billing_notices')).toEqual(['league_id', 'kind', 'period_key', 'sent_at']);
  });

  it('on an existing schema with data: applies again cleanly and keeps every row', async () => {
    await league('lg-m1');
    await env.DB.prepare(`INSERT INTO league_billing (league_id, regular_count, updated_at) VALUES ('lg-m1', 7, '2026-10-01')`).run();
    for (const q of getRealMigrationQueries(56)) await env.DB.prepare(q).run();
    expect((await row('lg-m1')).regular_count).toBe(7);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM leagues').first()).n).toBeGreaterThan(0);
  });

  it('additive only: no ALTER, no DROP, no foreign key', () => {
    const qs = getRealMigrationQueries(56).join('\n');
    expect(qs).not.toMatch(/ALTER TABLE|DROP |REFERENCES/i);
  });

  it('code from before it runs on the new schema: a league with a billing row is deleted as before (no foreign key)', async () => {
    await league('lg-old');
    await env.DB.prepare(`INSERT INTO league_billing (league_id, updated_at) VALUES ('lg-old', '2026-10-01')`).run();
    // What hard_delete.js did before 056: the league row itself, last.
    await env.DB.prepare('DELETE FROM leagues WHERE id = ?').bind('lg-old').run();
    expect(await env.DB.prepare(`SELECT 1 FROM leagues WHERE id = 'lg-old'`).first()).toBeNull();
    // The old explicit-column INSERT into leagues still works.
    await env.DB.prepare(`INSERT INTO leagues (id, name, team_count, team_names, created_by, created_at) VALUES ('lg-old2', 'Old', 2, '["A","B"]', 'u-owner', '2026-10-01')`).run();
  });
});

describe('the regular-player count', () => {
  it('counts regulars with an email once each; not subs, inactive, opted out or without email', async () => {
    await league('lg-c1');
    await contact('lg-c1', { email: 'a@example.com' });
    await contact('lg-c1', { email: ' A@Example.com ' }); // the same person
    await contact('lg-c1', { email: 'b@example.com' });
    await contact('lg-c1', { email: null });
    await contact('lg-c1', { email: '  ' });
    await contact('lg-c1', { role: 'sub_skater', email: 'sub@example.com' });
    await contact('lg-c1', { email: 'gone@example.com', active: 0 });
    await contact('lg-c1', { email: 'out@example.com', optedOut: 1 });
    await contact('lg-c1', { role: 'archived', email: 'arch@example.com' });
    expect(await regularCount(env.DB, 'lg-c1')).toBe(2);
    expect(await refreshRegularCount(env, 'lg-c1')).toBe(2);
    expect(await row('lg-c1')).toMatchObject({ regular_count: 2, count_tier: 'free', owner_user_id: 'u-owner' });
  });

  it('the tiers: under 15 free, 15 to 50 Standard, 51 to 100 Plus, over 100 custom', () => {
    expect([0, 14, 15, 50, 51, 100, 101].map(tierForCount)).toEqual(['free', 'free', 'standard', 'standard', 'plus', 'plus', 'custom']);
  });

  it('SMBHL is never counted', async () => {
    await contact('smbhl', { email: 'smbhl.p@example.com' });
    expect(await refreshRegularCount(env, 'smbhl')).toBeNull();
    expect(await row('smbhl')).toBeNull();
    await refreshDailyRegularCounts(env);
    expect(await row('smbhl')).toBeNull();
  });

  it('the daily job counts every league not counted today, deactivated ones aside', async () => {
    await league('lg-d1');
    await contact('lg-d1', { email: 'd1@example.com' });
    await league('lg-d2', 'u-owner', '2026-09-01T00:00:00Z', '2026-09-20T00:00:00Z');
    await refreshDailyRegularCounts(env);
    expect((await row('lg-d1')).regular_count).toBe(1);
    expect(await row('lg-d2')).toBeNull();
  });

  it('the roster routes refresh it: adding a regular with an email, then making them inactive', async () => {
    const signup = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.208' },
      body: JSON.stringify({ accept_terms: true, email: 'owner.p208@example.com', password: 'a-strong-password-1' })
    });
    const cookie = (signup.headers.get('set-cookie') || '').split(';')[0];
    const csrf = ((signup.headers.getSetCookie ? signup.headers.getSetCookie() : []).find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] || '';
    const h = { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf };
    const leagueId = (await (await SELF.fetch('http://example.com/leagues/create', { method: 'POST', headers: h, body: JSON.stringify({ name: 'P208 Route', teamNames: ['A', 'B'] }) })).json()).league.id;
    const add = await SELF.fetch('http://example.com/league/contacts', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Rita Regular', team: 'A', email: 'rita.p208@example.com', emailChoice: 'skip' }) });
    expect(add.status).toBe(200);
    const playerId = (await add.json()).contact.player_id;
    expect((await row(leagueId)).regular_count).toBe(1);
    const off = await SELF.fetch('http://example.com/league/contacts/active', { method: 'POST', headers: h, body: JSON.stringify({ player_id: playerId, is_active: false }) });
    expect(off.status).toBe(200);
    expect((await row(leagueId)).regular_count).toBe(0);
  });
});

describe('the super-admin summary', () => {
  it('off while BILLING_LAUNCH_AT is unset; SMBHL exempt', () => {
    expect(billingSummary(env, { id: 'lg-x', created_at: '2026-09-01' }, { regular_count: 20 }).status).toBe('off');
    expect(billingSummary(env, { id: 'smbhl' }, null).status).toBe('exempt');
  });

  it('with billing on: trial from the launch (or the creation, if later) for 2 months, then free or no subscription', () => {
    billingOn();
    const l = { id: 'lg-s', created_at: '2026-09-01T00:00:00Z' };
    expect(trialWindow(env, l, null)).toEqual({ start: '2026-10-15T00:00:00.000Z', end: '2026-12-15T00:00:00.000Z' });
    expect(billingSummary(env, l, { regular_count: 30 }, { now: new Date('2026-11-01') }).status).toBe('trial');
    expect(billingSummary(env, l, { regular_count: 30 }, { now: new Date('2027-01-01') }).status).toBe('unpaid');
    expect(billingSummary(env, l, { regular_count: 5 }, { freeSlot: 'lg-s', now: new Date('2027-01-01') }).status).toBe('free');
    expect(billingSummary(env, l, { regular_count: 5 }, { freeSlot: 'other', now: new Date('2027-01-01') }).status).toBe('unpaid');
    expect(billingSummary(env, l, { regular_count: 5, free_exception: 1 }, { freeSlot: 'other', now: new Date('2027-01-01') }).status).toBe('free');
    expect(addMonths(new Date('2027-12-31T00:00:00Z'), 2).toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('the oldest small league keeps the free slot', () => {
    expect(freeSlotLeagueId([{ id: 'b', created_at: '2026-05-01', count: 3 }, { id: 'a', created_at: '2026-04-01', count: 9 }, { id: 'c', created_at: '2026-01-01', count: 40 }])).toBe('a');
  });

  it('the page data carries billing; the free exception is set by a super-admin, never for SMBHL', async () => {
    await league('lg-sa');
    const post = body => SELF.fetch('http://example.com/super-admin/leagues/update', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin': 'test-p208-admin' }, body: JSON.stringify(body) });
    expect((await post({ leagueId: 'lg-sa', freeException: true })).status).toBe(200);
    expect((await row('lg-sa')).free_exception).toBe(1);
    expect((await post({ leagueId: 'smbhl', freeException: true })).status).toBe(400);
    const data = await (await SELF.fetch('http://example.com/super-admin/leagues/data', { headers: { 'x-admin': 'test-p208-admin' } })).json();
    expect(data.leagues.find(l => l.id === 'lg-sa').billing).toMatchObject({ freeException: true, status: 'off' });
    expect(data.leagues.find(l => l.id === 'smbhl').billing.status).toBe('exempt');
  });
});

describe('the Stripe client', () => {
  it('refuses while billing is off: no request at all', async () => {
    stubStripe();
    await expect(stripeRequest(env, 'GET', '/subscriptions/sub_1')).rejects.toMatchObject({ code: 'billing_off' });
    expect(stripeCalls).toHaveLength(0);
  });

  it('form encoded, pinned version, idempotency key; an error never shows the key or Stripe\'s message', async () => {
    billingOn();
    stubStripe();
    stripeObjects = { '/subscriptions/sub_ok': { id: 'sub_ok' } };
    await stripeRequest(env, 'POST', '/subscriptions/sub_ok', { items: [{ id: 'si_1', price: 'price_x' }], pause_collection: '' }, { idempotencyKey: 'k1' });
    const call = stripeCalls[0];
    expect(call.headers['stripe-version']).toBe('2025-09-30.clover');
    expect(call.headers['idempotency-key']).toBe('k1');
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(formEncode({ items: [{ id: 'si_1', price: 'price_x' }], pause_collection: '', skip: null })).toBe('items%5B0%5D%5Bid%5D=si_1&items%5B0%5D%5Bprice%5D=price_x&pause_collection=');
    const err = await stripeRequest(env, 'GET', '/subscriptions/sub_missing').catch(e => e);
    expect(err).toBeInstanceOf(StripeError);
    expect(err.message).toContain('404');
    expect(err.message).not.toMatch(/rk_|whsec_|No such object/);
  });
});

describe('the webhook', () => {
  const hook = (raw, header) => SELF.fetch('http://example.com/billing/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': header || '', 'content-type': 'application/json' }, body: raw });
  const subscription = (id, over = {}) => ({
    id, object: 'subscription', status: 'active', customer: 'cus_1', cancel_at_period_end: false, pause_collection: null,
    metadata: { league_id: 'lg-w' },
    items: { data: [{ id: 'si_1', current_period_end: 1798761600, price: { id: 'price_std_m', recurring: { interval: 'month' } } }] },
    ...over
  });
  let n = 0;
  const event = (type, objectId, extra = {}) => ({ id: `evt_p208_${++n}`, type, livemode: true, created: 1790000000 + n, data: { object: { id: objectId } }, ...extra });

  it('is not there while billing is off (404), and makes no Stripe call', async () => {
    stubStripe();
    const { raw, header } = await signed(event('customer.subscription.updated', 'sub_1'));
    env.LEAGUE_PRODUCT = 'true';
    expect((await hook(raw, header)).status).toBe(404);
    expect(stripeCalls).toHaveLength(0);
  });

  it('signature: invalid, expired and malformed answer 400; several v1 values, one right, pass', async () => {
    billingOn();
    stubStripe();
    await league('lg-w');
    stripeObjects = { '/subscriptions/sub_sig': subscription('sub_sig') };
    const ev = event('customer.subscription.updated', 'sub_sig');
    const bad = await signed(ev, { secret: 'whsec_wrong' });
    expect((await hook(bad.raw, bad.header)).status).toBe(400);
    const old = await signed(ev, { t: Math.floor(Date.now() / 1000) - 301 });
    expect((await hook(old.raw, old.header)).status).toBe(400);
    expect((await hook(JSON.stringify(ev), 'v1=abc')).status).toBe(400);
    const good = await signed(ev);
    const two = `${good.header.split(',')[0]},v1=${'0'.repeat(64)},${good.header.split(',')[1]}`;
    expect((await hook(good.raw, two)).status).toBe(200);
    // The pure check, at the edge of the tolerance.
    const t = 1790000000;
    expect((await verifyStripeSignature('x', `t=${t},v1=${await hex(WHSEC, `${t}.x`)}`, WHSEC, t + 300)).ok).toBe(true);
    expect((await verifyStripeSignature('x', `t=${t},v1=${await hex(WHSEC, `${t}.x`)}`, WHSEC, t + 301)).reason).toBe('expired');
    expect((await verifyStripeSignature('y', `t=${t},v1=${await hex(WHSEC, `${t}.x`)}`, WHSEC, t)).reason).toBe('mismatch');
  });

  it('each event once: a duplicate answers 200 and fetches nothing', async () => {
    billingOn();
    stubStripe();
    await league('lg-w');
    stripeObjects = { '/subscriptions/sub_dup': subscription('sub_dup') };
    const { raw, header } = await signed(event('customer.subscription.created', 'sub_dup'));
    expect((await hook(raw, header)).status).toBe(200);
    const calls = stripeCalls.length;
    const again = await hook(raw, header);
    expect(again.status).toBe(200);
    expect((await again.json()).duplicate).toBe(true);
    expect(stripeCalls.length).toBe(calls);
  });

  it('a failure answers 500 and is processed when Stripe sends it again', async () => {
    billingOn();
    stubStripe();
    stripeObjects = {};
    const ev = event('customer.subscription.updated', 'sub_later');
    const s1 = await signed(ev);
    expect((await hook(s1.raw, s1.header)).status).toBe(500);
    const rec = await env.DB.prepare('SELECT attempts, processed_at, error FROM stripe_events WHERE id = ?').bind(ev.id).first();
    expect(rec).toMatchObject({ attempts: 1, processed_at: null });
    expect(rec.error).not.toMatch(/rk_|No such object/);
    await league('lg-w');
    stripeObjects = { '/subscriptions/sub_later': subscription('sub_later') };
    const s2 = await signed(ev);
    expect((await hook(s2.raw, s2.header)).status).toBe(200);
  });

  it('subscription events write the state fetched from Stripe, not the event\'s copy', async () => {
    billingOn();
    stubStripe();
    await league('lg-w');
    stripeObjects = { '/subscriptions/sub_w': subscription('sub_w') };
    // The event carries a stale copy; the fetched one wins.
    const s = await signed(event('customer.subscription.updated', 'sub_w', { data: { object: { id: 'sub_w', status: 'canceled' } } }));
    expect((await hook(s.raw, s.header)).status).toBe(200);
    expect(await row('lg-w')).toMatchObject({ stripe_subscription_id: 'sub_w', stripe_customer_id: 'cus_1', tier: 'standard', billing_interval: 'month', stripe_status: 'active', status: 'active', current_period_end: '2027-01-01T00:00:00.000Z', inactive_since: null });
    // Paused (monthly pause_collection), then resumed.
    stripeObjects['/subscriptions/sub_w'] = subscription('sub_w', { pause_collection: { behavior: 'void' } });
    const p = await signed(event('customer.subscription.updated', 'sub_w'));
    await hook(p.raw, p.header);
    expect((await row('lg-w')).status).toBe('paused');
    expect((await row('lg-w')).paused_at).toBeTruthy();
    stripeObjects['/subscriptions/sub_w'] = subscription('sub_w');
    const r = await signed(event('customer.subscription.resumed', 'sub_w'));
    await hook(r.raw, r.header);
    expect(await row('lg-w')).toMatchObject({ status: 'active', paused_at: null });
    // Plus yearly.
    stripeObjects['/subscriptions/sub_w'] = subscription('sub_w', { items: { data: [{ id: 'si_1', current_period_end: 1798761600, price: { id: 'price_plus_y', recurring: { interval: 'year' } } }] } });
    const u = await signed(event('customer.subscription.updated', 'sub_w'));
    await hook(u.raw, u.header);
    expect(await row('lg-w')).toMatchObject({ tier: 'plus', billing_interval: 'year' });
    // Past due, then deleted: inactive from then on.
    stripeObjects['/subscriptions/sub_w'] = subscription('sub_w', { status: 'past_due' });
    const pd = await signed(event('customer.subscription.updated', 'sub_w'));
    await hook(pd.raw, pd.header);
    expect((await row('lg-w')).status).toBe('past_due');
    stripeObjects['/subscriptions/sub_w'] = subscription('sub_w', { status: 'canceled' });
    const d = await signed(event('customer.subscription.deleted', 'sub_w'));
    await hook(d.raw, d.header);
    expect((await row('lg-w')).status).toBe('inactive');
    expect((await row('lg-w')).inactive_since).toBeTruthy();
  });

  it('checkout completed: the league from the session, the subscription fetched', async () => {
    billingOn();
    stubStripe();
    await league('lg-co');
    stripeObjects = {
      '/checkout/sessions/cs_1': { id: 'cs_1', client_reference_id: 'lg-co', customer: 'cus_co', subscription: 'sub_co', metadata: {} },
      '/subscriptions/sub_co': subscription('sub_co', { customer: 'cus_co', metadata: {} })
    };
    const s = await signed(event('checkout.session.completed', 'cs_1'));
    expect((await hook(s.raw, s.header)).status).toBe(200);
    expect(await row('lg-co')).toMatchObject({ stripe_subscription_id: 'sub_co', stripe_customer_id: 'cus_co', status: 'active' });
    const logged = await env.DB.prepare(`SELECT league_id, object_id, processed_at FROM stripe_events WHERE type = 'checkout.session.completed'`).first();
    expect(logged).toMatchObject({ league_id: 'lg-co', object_id: 'cs_1' });
  });

  it('invoices: paid sets last_paid_at (amount above 0); failed makes the league past due', async () => {
    billingOn();
    stubStripe();
    await league('lg-inv');
    stripeObjects = {
      '/invoices/in_paid': { id: 'in_paid', customer: 'cus_inv', amount_paid: 999, status_transitions: { paid_at: 1790000000 }, parent: { subscription_details: { subscription: 'sub_inv' } } },
      '/invoices/in_zero': { id: 'in_zero', customer: 'cus_inv', amount_paid: 0, subscription: 'sub_inv' },
      '/subscriptions/sub_inv': subscription('sub_inv', { customer: 'cus_inv', metadata: { league_id: 'lg-inv' } })
    };
    const z = await signed(event('invoice.paid', 'in_zero'));
    await hook(z.raw, z.header);
    expect((await row('lg-inv')).last_paid_at).toBeNull();
    const p = await signed(event('invoice.paid', 'in_paid'));
    await hook(p.raw, p.header);
    expect((await row('lg-inv')).last_paid_at).toBe(new Date(1790000000 * 1000).toISOString());
    stripeObjects['/subscriptions/sub_inv'] = subscription('sub_inv', { customer: 'cus_inv', status: 'past_due', metadata: { league_id: 'lg-inv' } });
    stripeObjects['/invoices/in_fail'] = { id: 'in_fail', customer: 'cus_inv', amount_paid: 0, subscription: 'sub_inv' };
    const f = await signed(event('invoice.payment_failed', 'in_fail'));
    await hook(f.raw, f.header);
    expect((await row('lg-inv')).status).toBe('past_due');
  });

  it('SMBHL is never written, even when a subscription names it', async () => {
    billingOn();
    stubStripe();
    stripeObjects = { '/subscriptions/sub_smbhl': subscription('sub_smbhl', { metadata: { league_id: 'smbhl' } }) };
    const s = await signed(event('customer.subscription.created', 'sub_smbhl'));
    expect((await hook(s.raw, s.header)).status).toBe(200);
    expect(await row('smbhl')).toBeNull();
  });

  it('a test-mode event is acknowledged and ignored', async () => {
    billingOn();
    stubStripe();
    const s = await signed({ ...event('customer.subscription.created', 'sub_t'), livemode: false });
    const res = await hook(s.raw, s.header);
    expect(res.status).toBe(200);
    expect((await res.json()).ignored).toBe('test_mode');
    expect(stripeCalls).toHaveLength(0);
  });

  it('the SMBHL worker (no LEAGUE_PRODUCT) has no webhook, even with billing on', async () => {
    billingOn();
    delete env.LEAGUE_PRODUCT;
    const s = await signed(event('customer.subscription.created', 'sub_x'));
    expect((await hook(s.raw, s.header)).status).toBe(404);
  });
});

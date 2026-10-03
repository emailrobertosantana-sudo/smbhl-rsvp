// Overnight batch, stage 1 (src/operator_alerts.js): Roberto's instant
// alerts through the operator webhook.
//   1a. a new Notre Ligue league: once per league, never for a co-admin
//       joining, never for SMBHL, never twice for a retried creation; the
//       owner's second league is said; the owner's address masked.
//   1b. a subscription that becomes active (the Stripe webhook): once per
//       league and subscription, never for a replayed or later event; a
//       100 %-off promotion code labelled.
// Both: no full email address in any title or body; the daily digest as
// before. Every outbound call is answered here (globalThis.fetch).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must } from './support/league_season.js';
import { alertLeagueCreated, alertSubscriptionActive, subscriptionIsFullyDiscounted, LEAGUE_CREATED_TITLE, SUBSCRIBED_TITLE } from '../src/operator_alerts.js';
import { prepareOpsDigest, renderOpsDigest, DIGEST_CUTOFF_KEY } from '../src/ops_digest.js';

const NOW = Date.UTC(2026, 9, 14, 16, 0); // Wednesday 2026-10-14, 12:00 Montreal
const HOOK = 'https://ntfy.sh/p235-test-topic';
const BASE = 'https://rsvp.p235.example';
const WHSEC = 'whsec_test_p235';
const hooks = [];
const mails = [];
let stripeObjects = {};
let stripeExpanded = {};
let originalFetch;

// Any full address (not the masked o***@example.com form).
const FULL_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

beforeAll(async () => {
  Object.assign(env, { LEAGUE_PRODUCT: 'true', RESEND_API_KEY: 'x', RSVP_SECRET: 'p235', AUTH_SECRET: 'p235-auth', ALERT_WEBHOOK_URL: HOOK, PUBLIC_URL: BASE, ADMIN_KEY: 'p235-admin-key' });
  delete env.MAIL_DAILY_CAP; delete env.MAIL_HARD_DAILY_CAP;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  await applyRealSchema(env);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url && url.url ? url.url : url);
    if (u.includes('api.resend.com')) { const b = JSON.parse(opts.body); mails.push({ to: Array.isArray(b.to) ? b.to[0] : b.to, subject: b.subject, text: b.text || '', html: b.html || '' }); return new Response('{"id":"x"}', { status: 200 }); }
    if (u === HOOK) { hooks.push({ title: decodeURIComponent((opts.headers && opts.headers.Title) || ''), tags: opts.headers && opts.headers.Tags, body: String(opts.body || '') }); return new Response('ok', { status: 200 }); }
    if (u.startsWith('https://api.stripe.com/')) {
      const parsed = new URL(u);
      const path = parsed.pathname.replace('/v1', '');
      const expanded = parsed.search.includes('expand') && stripeExpanded[path];
      const obj = expanded || stripeObjects[path];
      if (!obj) return new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'resource_missing' } }), { status: 404 });
      return new Response(JSON.stringify(obj), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
});
afterAll(() => { globalThis.fetch = originalFetch; vi.useRealTimers(); });
beforeEach(() => { vi.setSystemTime(new Date(NOW)); hooks.length = 0; mails.length = 0; });

const one = async (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const noFullAddress = list => { for (const h of list) { expect(h.title).not.toMatch(FULL_ADDRESS); expect(h.body).not.toMatch(FULL_ADDRESS); } };

describe('1a. A new league', () => {
  let first;
  it('one alert: the name, structure, language, masked owner and the super-admin link', async () => {
    const a = await admin('p235one');
    const created = await must(a.post('/leagues/create', { name: 'Les Castors', teamNames: ['A', 'B'], languageMode: 'fr', slug: 'les-castors' }), 'create');
    first = { a, id: created.league.id };
    expect(hooks).toHaveLength(1);
    expect(hooks[0].title).toBe('Notre Ligue : nouvelle ligue / new league');
    expect(hooks[0].title).toBe(LEAGUE_CREATED_TITLE);
    const link = `${BASE}/super-admin/league?id=${first.id}`;
    expect(hooks[0].body).toBe(
      `Les Castors : Équipes fixes, Français, créée par a***@example.com. Fiche : ${link}\n\n---\n\n`
      + `Les Castors: Fixed teams, French, created by a***@example.com. Details: ${link}`);
    expect(hooks[0].tags).toBe('tada');
    expect(hooks[0].body).not.toContain('admin.p235one@example.com');
    noFullAddress(hooks);
    // Not an email: nothing to Roberto through Resend or the outbox (the
    // only email is the new account's verification).
    expect(mails.map(m => m.to)).toEqual(['admin.p235one@example.com']);
    expect((await one("SELECT COUNT(*) AS n FROM outbox WHERE kind LIKE '%alert%' OR kind LIKE 'ops%'")).n).toBe(0);
    expect(await one('SELECT league_id FROM settings WHERE key = ?', `ops_alert:league_created:${first.id}`)).toEqual({ league_id: first.id });
  });

  it('a retried creation does not alert twice', async () => {
    // The same request again: the slug is taken now, no second league.
    const again = await first.a.post('/leagues/create', { name: 'Les Castors', teamNames: ['A', 'B'], languageMode: 'fr', slug: 'les-castors' });
    expect(again.status).toBe(409);
    // The alert itself asked again for the same league.
    expect(await alertLeagueCreated(env, first.id)).toBe(false);
    expect(hooks).toHaveLength(0);
  });

  it("the owner's second league is said", async () => {
    await must(first.a.post('/leagues/create', { name: 'Les Hiboux', teamNames: ['Rouges', 'Bleus'], teamStructure: 'weekly_draw', languageMode: 'en' }), 'second');
    expect(hooks).toHaveLength(1);
    expect(hooks[0].body).toContain("Les Hiboux : Équipes formées à chaque match, Anglais, créée par a***@example.com. C'est la 2e ligue créée par ce compte. Fiche : ");
    expect(hooks[0].body).toContain('Les Hiboux: Teams formed every game, English, created by a***@example.com. This is the 2nd league this account has created. Details: ');
    noFullAddress(hooks);
  });

  it('a first league says nothing about a second; no teams, both languages', async () => {
    const b = await admin('p235two');
    await must(b.post('/leagues/create', { name: 'Drop-in du mardi', teamStructure: 'headcount' }), 'headcount');
    expect(hooks).toHaveLength(1);
    expect(hooks[0].body).toContain('Drop-in du mardi : Sans équipes, Français et anglais, créée par a***@example.com. Fiche : ');
    expect(hooks[0].body).toContain('Drop-in du mardi: No teams, French and English, created by a***@example.com. Details: ');
    expect(hooks[0].body).not.toMatch(/2e ligue|2nd league/);
  });

  it('a co-admin joining is not a new league: no alert', async () => {
    const c = await admin('p235co');
    await must(c.post('/leagues/create', { name: 'Les Loups', teamNames: ['A', 'B'] }), 'create');
    hooks.length = 0; mails.length = 0;
    await must(c.post('/league/admins/invite', { email: 'coadmin.p235@example.com' }), 'invite');
    const inviteMail = mails.find(m => m.to === 'coadmin.p235@example.com');
    const token = decodeURIComponent(/accept\?token=([A-Za-z0-9._%-]+)/.exec(inviteMail.text)[1]);
    const res = await SELF.fetch('http://example.com/league/admins/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accept_terms: true, token, password: 'co-admin-password-1' })
    });
    expect((await res.json()).ok).toBe(true);
    expect(hooks).toHaveLength(0);
  });

  it('SMBHL never alerts', async () => {
    expect(await alertLeagueCreated(env, 'smbhl')).toBe(false);
    expect(await alertSubscriptionActive(env, { leagueId: 'smbhl', sub: { id: 'sub_x' }, status: 'active' })).toBe(false);
    expect(hooks).toHaveLength(0);
  });

  it('without the webhook: nothing sent, nothing written', async () => {
    delete env.ALERT_WEBHOOK_URL;
    try {
      const d = await admin('p235nohook');
      const created = await must(d.post('/leagues/create', { name: 'Sans alerte', teamNames: ['A', 'B'] }), 'create');
      expect(hooks).toHaveLength(0);
      expect(await one('SELECT key FROM settings WHERE key = ?', `ops_alert:league_created:${created.league.id}`)).toBeNull();
    } finally { env.ALERT_WEBHOOK_URL = HOOK; }
  });

  it('the daily digest is unchanged: the new leagues are still there, owners masked', async () => {
    await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(DIGEST_CUTOFF_KEY).run();
    const pending = await prepareOpsDigest(env, null, new Date(NOW + 60000));
    const names = pending.items.signups.map(s => s.name);
    expect(names).toEqual(expect.arrayContaining(['Les Castors', 'Les Hiboux', 'Drop-in du mardi', 'Les Loups']));
    expect(pending.items.signups.find(s => s.name === 'Les Castors').owner).toBe('a***@example.com');
    expect(Object.keys(pending.items).sort()).toEqual(['crossed', 'custom', 'payments', 'signups', 'trials', 'trips', 'worsened']);
    const mail = renderOpsDigest(pending, BASE);
    expect(mail.text).toContain('Nouvelles inscriptions');
    expect(mail.text).toContain('Les Castors : inscrite le ');
    expect(mail.text).not.toMatch(/abonnement|subscription/i);
  });
});

describe('1b. A league subscribes (the Stripe webhook)', () => {
  const enc = new TextEncoder();
  const hex = async (secret, msg) => {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))].map(b => b.toString(16).padStart(2, '0')).join('');
  };
  let n = 0;
  const event = (type, objectId) => ({ id: `evt_p235_${++n}`, type, livemode: true, created: 1790000000 + n, data: { object: { id: objectId } } });
  const send = async ev => {
    const raw = JSON.stringify(ev);
    const t = Math.floor(Date.now() / 1000);
    return SELF.fetch('http://example.com/billing/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${await hex(WHSEC, `${t}.${raw}`)}`, 'content-type': 'application/json' }, body: raw });
  };
  const subscription = (id, leagueId, over = {}) => ({
    id, object: 'subscription', status: 'active', customer: `cus_${id}`, cancel_at_period_end: false, pause_collection: null,
    metadata: { league_id: leagueId }, discounts: [],
    items: { data: [{ id: 'si_1', current_period_end: 1798761600, price: { id: 'price_std_m', unit_amount: 999, recurring: { interval: 'month' } } }] },
    ...over
  });
  const plusYearly = { data: [{ id: 'si_2', current_period_end: 1798761600, price: { id: 'price_plus_y', unit_amount: 19990, recurring: { interval: 'year' } } }] };
  let leagueA, leagueB, leagueC;

  beforeAll(async () => {
    const o = await admin('p235bill');
    leagueA = (await must(o.post('/leagues/create', { name: 'Ligue Abonnée', teamNames: ['A', 'B'] }), 'A')).league.id;
    const p = await admin('p235promo');
    leagueB = (await must(p.post('/leagues/create', { name: 'Ligue Promo', teamNames: ['A', 'B'] }), 'B')).league.id;
    const q = await admin('p235late');
    leagueC = (await must(q.post('/leagues/create', { name: 'Ligue Tardive', teamNames: ['A', 'B'] }), 'C')).league.id;
    Object.assign(env, {
      BILLING_LAUNCH_AT: '2026-10-01', STRIPE_SECRET_KEY: 'rk_test_p235_not_real', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_VERSION: '2026-08-26.dahlia',
      STRIPE_PRICE_STANDARD_MONTHLY: 'price_std_m', STRIPE_PRICE_STANDARD_YEARLY: 'price_std_y', STRIPE_PRICE_PLUS_MONTHLY: 'price_plus_m', STRIPE_PRICE_PLUS_YEARLY: 'price_plus_y'
    });
  });
  afterAll(() => { for (const k of ['BILLING_LAUNCH_AT', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_API_VERSION', 'STRIPE_PRICE_STANDARD_MONTHLY', 'STRIPE_PRICE_STANDARD_YEARLY', 'STRIPE_PRICE_PLUS_MONTHLY', 'STRIPE_PRICE_PLUS_YEARLY']) delete env[k]; });

  it('the first active subscription: one alert with the plan and the interval', async () => {
    stripeObjects = { '/subscriptions/sub_p235a': subscription('sub_p235a', leagueA) };
    const ev = event('customer.subscription.created', 'sub_p235a');
    expect((await send(ev)).status).toBe(200);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].title).toBe('Notre Ligue : nouvel abonnement / new subscription');
    expect(hooks[0].title).toBe(SUBSCRIBED_TITLE);
    expect(hooks[0].body).toBe('Ligue Abonnée : forfait Standard, mensuel\n\n---\n\nLigue Abonnée: Standard plan, monthly');
    expect(hooks[0].tags).toBe('moneybag');
    noFullAddress(hooks);
    expect(mails).toHaveLength(0);
    // A replayed event, then later events for the same subscription: nothing more.
    expect((await (await send(ev)).json()).duplicate).toBe(true);
    expect((await send(event('customer.subscription.updated', 'sub_p235a'))).status).toBe(200);
    // Past due, then active again: the same subscription, still once.
    stripeObjects['/subscriptions/sub_p235a'] = subscription('sub_p235a', leagueA, { status: 'past_due' });
    await send(event('customer.subscription.updated', 'sub_p235a'));
    stripeObjects['/subscriptions/sub_p235a'] = subscription('sub_p235a', leagueA);
    await send(event('customer.subscription.updated', 'sub_p235a'));
    expect(hooks).toHaveLength(1);
    expect(await one('SELECT league_id FROM settings WHERE key = ?', `ops_alert:subscribed:${leagueA}:sub_p235a`)).toEqual({ league_id: leagueA });
  });

  it('a 100%-off promotion code is labelled (code promo) / (promo code)', async () => {
    stripeObjects = {
      '/subscriptions/sub_p235b': subscription('sub_p235b', leagueB, { items: plusYearly, discounts: ['di_p235b'] }),
      '/coupons/TESTFREE100': { id: 'TESTFREE100', object: 'coupon', percent_off: 100, amount_off: null }
    };
    stripeExpanded = {
      '/subscriptions/sub_p235b': subscription('sub_p235b', leagueB, { items: plusYearly, discounts: [{ id: 'di_p235b', object: 'discount', promotion_code: 'promo_1', source: { type: 'coupon', coupon: 'TESTFREE100' } }] })
    };
    expect((await send(event('customer.subscription.created', 'sub_p235b'))).status).toBe(200);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].body).toBe('Ligue Promo : forfait Plus, annuel (code promo)\n\n---\n\nLigue Promo: Plus plan, yearly (promo code)');
  });

  it('not active yet: no alert until it becomes active', async () => {
    stripeObjects = { '/subscriptions/sub_p235c': subscription('sub_p235c', leagueC, { status: 'incomplete' }) };
    await send(event('customer.subscription.created', 'sub_p235c'));
    expect(hooks).toHaveLength(0);
    stripeObjects['/subscriptions/sub_p235c'] = subscription('sub_p235c', leagueC, { status: 'trialing', trial_end: 1795000000 });
    await send(event('customer.subscription.updated', 'sub_p235c'));
    expect(hooks).toHaveLength(1);
    expect(hooks[0].body).toBe('Ligue Tardive : forfait Standard, mensuel\n\n---\n\nLigue Tardive: Standard plan, monthly');
  });

  it('a discount that leaves something to pay is not a promo label; both API shapes read', async () => {
    const req = (objs) => async (_env, _m, path) => objs[path];
    const unit = { items: { data: [{ price: { unit_amount: 999 } }] } };
    expect(await subscriptionIsFullyDiscounted(env, { id: 'sub_1', ...unit, discounts: [] }, req({}))).toBe(false);
    expect(await subscriptionIsFullyDiscounted(env, { id: 'sub_1', ...unit, discounts: [{ coupon: { percent_off: 50 } }] }, req({}))).toBe(false);
    expect(await subscriptionIsFullyDiscounted(env, { id: 'sub_1', ...unit, discount: { coupon: { percent_off: 100 } } }, req({}))).toBe(true);
    expect(await subscriptionIsFullyDiscounted(env, { id: 'sub_1', ...unit, discounts: [{ source: { coupon: { amount_off: 999 } } }] }, req({}))).toBe(true);
    expect(await subscriptionIsFullyDiscounted(env, { id: 'sub_1', ...unit, discounts: [{ source: { coupon: 'HALF' } }] }, req({ '/coupons/HALF': { percent_off: 50 } }))).toBe(false);
  });
});

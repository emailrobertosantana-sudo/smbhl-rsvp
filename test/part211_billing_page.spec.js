// Billing batch 2: the billing page, Checkout, the portal, refunds, pause
// and resume, the tier change at renewal (src/billing_actions.js,
// src/stripe_webhook.js). Stripe is a local stub: every request is recorded
// and answered from canned objects. No real Stripe call.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { billingView, runTierChanges, priceIdFor, money } from '../src/billing_actions.js';
import { processStripeEvent } from '../src/stripe_webhook.js';

const VARS = {
  BILLING_LAUNCH_AT: '2026-10-01T00:00:00Z',
  STRIPE_SECRET_KEY: 'rk_test_p211_not_real',
  STRIPE_WEBHOOK_SECRET: 'whsec_p211',
  STRIPE_API_VERSION: '2026-08-26.dahlia',
  STRIPE_PRICE_STANDARD_MONTHLY: 'price_std_m', STRIPE_PRICE_STANDARD_YEARLY: 'price_std_y',
  STRIPE_PRICE_PLUS_MONTHLY: 'price_plus_m', STRIPE_PRICE_PLUS_YEARLY: 'price_plus_y',
  LEAGUE_PRODUCT: 'true'
};
const on = () => Object.assign(env, VARS);

// The Stripe stub.
const originalFetch = globalThis.fetch;
let calls = [];
let objects = {};
const parseForm = body => Object.fromEntries(String(body || '').split('&').filter(Boolean).map(kv => kv.split('=').map(decodeURIComponent)));
function stub() {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.stripe.com/')) return originalFetch(url, opts);
    const path = new URL(u).pathname.replace('/v1', '');
    const call = { method: opts.method || 'GET', path, form: parseForm(opts.body), headers: opts.headers || {} };
    calls.push(call);
    if (call.method === 'POST' && path === '/checkout/sessions') return Response.json({ id: 'cs_new', url: 'https://checkout.stripe.com/c/pay/cs_new' });
    if (call.method === 'POST' && path === '/billing_portal/sessions') return Response.json({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/bps_1' });
    if (call.method === 'DELETE' && objects[path]) { objects[path] = { ...objects[path], status: 'canceled' }; return Response.json(objects[path]); }
    if (call.method === 'POST' && objects[path]) {
      const f = call.form;
      const cur = objects[path];
      if ('pause_collection[behavior]' in f) cur.pause_collection = { behavior: f['pause_collection[behavior]'] };
      if (f.pause_collection === '') cur.pause_collection = null;
      if (f['items[0][price]']) cur.items.data[0].price = { id: f['items[0][price]'], recurring: cur.items.data[0].price.recurring };
      return Response.json(cur);
    }
    if (objects[path]) return Response.json(objects[path]);
    return Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing' } }, { status: 404 });
  };
}
afterEach(() => { globalThis.fetch = originalFetch; });

const sub = (id, leagueId, over = {}) => ({
  id, object: 'subscription', status: 'active', customer: 'cus_p211', cancel_at_period_end: false, cancel_at: null, pause_collection: null,
  metadata: { league_id: leagueId }, trial_start: null, trial_end: null,
  items: { data: [{ id: 'si_1', current_period_end: Math.floor(Date.now() / 1000) + 20 * 86400, price: { id: 'price_std_m', recurring: { interval: 'month' } } }] },
  ...over
});

// An owner with a league, and a co-admin who is not the owner.
let n = 0;
async function account(tag) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${++n}` },
    body: JSON.stringify({ accept_terms: true, email: `p211.${tag}@example.com`, password: 'a-strong-password-1' })
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const csrf = ((res.headers.getSetCookie ? res.headers.getSetCookie() : []).find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] || '';
  return { cookie, csrf, h: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf } };
}
async function league(tag, regulars) {
  const owner = await account(tag);
  const leagueId = (await (await SELF.fetch('http://example.com/leagues/create', { method: 'POST', headers: owner.h, body: JSON.stringify({ name: `P211 ${tag}`, teamNames: ['A', 'B'] }) })).json()).league.id;
  for (let i = 0; i < regulars; i++) {
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, token_salt, league_id, is_active) VALUES (?, ?, ?, 'roster', 0, 's', ?, 1)`)
      .bind(`${leagueId}:r${i}`, `R ${i}`, `r${i}.${tag}@example.com`, leagueId).run();
  }
  return { owner, leagueId };
}
const page = (who, query = '', lang = 'fr') => SELF.fetch(`http://example.com/league/billing${query}`, { headers: { cookie: who.cookie, 'accept-language': lang === 'en' ? 'en-CA' : 'fr-CA' }, redirect: 'manual' });
const act = (who, action, body = {}) => SELF.fetch(`http://example.com/league/billing/${action}`, { method: 'POST', headers: who.h, body: JSON.stringify(body) });
const row = id => env.DB.prepare('SELECT * FROM league_billing WHERE league_id = ?').bind(id).first();
const text = html => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/[ \t\r\n]+/g, ' ');

beforeAll(async () => {
  env.AUTH_SECRET = 'test-p211-auth';
  env.RSVP_SECRET = 'test-p211-rsvp';
  env.RESEND_API_KEY = 'mock-key';
  await applyRealSchema(env);
});

describe('billing off', () => {
  it('the page goes back to the settings, the actions answer 404, no Stripe call', async () => {
    for (const k of Object.keys(VARS)) delete env[k];
    env.LEAGUE_PRODUCT = 'true';
    stub();
    const { owner } = await league('off', 20);
    const res = await page(owner);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/league/settings');
    expect((await act(owner, 'checkout', { interval: 'month' })).status).toBe(404);
    expect(calls).toHaveLength(0);
    on();
  });
});

describe('the page and Checkout', () => {
  it('a Standard league in its trial: count, plan, trial, prices, subscribe (French and English)', async () => {
    on(); stub();
    const { owner } = await league('std', 20);
    const fr = text(await (await page(owner)).text());
    for (const s of ['Abonnement', 'Ta ligue compte 20 joueurs réguliers\u00a0: forfait Standard.', 'Essai gratuit\u00a0: il reste', 'Mensuel\u00a0: 9,99\u00a0$ par mois', 'Annuel\u00a0: 99,90\u00a0$ par année (2 mois gratuits)', 'Prix avant taxes.', "S'abonner"]) expect(fr).toContain(s);
    const en = text(await (await page(owner, '', 'en')).text());
    for (const s of ['Subscription', 'Your league has 20 regular players: Standard plan.', 'Free trial:', 'days left.', 'Monthly: $9.99 per month', 'Yearly: $99.90 per year (2 months free)', 'Prices before tax.', 'Subscribe']) expect(en).toContain(s);
    expect(fr + en).not.toMatch(/js\.stripe\.com|\u2014/);
  });

  it('Checkout: hosted, subscription mode, the price, the league, the owner, promotion codes, no card when nothing is due, the trial kept', async () => {
    on(); stub();
    const { owner, leagueId } = await league('co', 20);
    const res = await act(owner, 'checkout', { interval: 'month', lang: 'fr' });
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe('https://checkout.stripe.com/c/pay/cs_new');
    const c = calls.find(x => x.path === '/checkout/sessions');
    const f = c.form;
    expect(f.mode).toBe('subscription');
    expect(f['line_items[0][price]']).toBe('price_std_m');
    expect(f['line_items[0][quantity]']).toBe('1');
    expect(f.client_reference_id).toBe(leagueId);
    expect(f['metadata[league_id]']).toBe(leagueId);
    expect(f['subscription_data[metadata][league_id]']).toBe(leagueId);
    expect(f.customer_email).toMatch(/@example\.com$/);
    expect(f.allow_promotion_codes).toBe('true');
    expect(f.payment_method_collection).toBe('if_required');
    expect(f.locale).toBe('fr-CA');
    expect(f.ui_mode).toBeUndefined();
    expect(f.success_url).toBe('http://example.com/league/billing?status=success&session_id={CHECKOUT_SESSION_ID}');
    expect(f.cancel_url).toBe('http://example.com/league/billing?status=cancel');
    const trialEnd = (await billingView(env, leagueId)).trial.end;
    expect(Number(f['subscription_data[trial_end]'])).toBe(Math.floor(Date.parse(trialEnd) / 1000));
    expect(f['subscription_data[trial_settings][end_behavior][missing_payment_method]']).toBe('pause');
    expect(c.headers['idempotency-key']).toBeTruthy();
    await act(owner, 'checkout', { interval: 'year', lang: 'en' });
    const y = calls.filter(x => x.path === '/checkout/sessions')[1].form;
    expect(y['line_items[0][price]']).toBe('price_std_y');
    expect(y.locale).toBe('en');
  });

  it('Plus prices above 50 and above 100 (until a custom price is agreed); free under 15 has no Checkout', async () => {
    on(); stub();
    const plus = await league('plus', 60);
    const pt = text(await (await page(plus.owner)).text());
    expect(pt).toContain('forfait Plus.');
    expect(pt).toContain('Mensuel\u00a0: 19,99\u00a0$ par mois');
    expect(pt).toContain('Annuel\u00a0: 199,90\u00a0$ par année (2 mois gratuits)');
    await act(plus.owner, 'checkout', { interval: 'month' });
    expect(calls.find(x => x.path === '/checkout/sessions').form['line_items[0][price]']).toBe('price_plus_m');
    const free = await league('free', 5);
    const ft = text(await (await page(free.owner)).text());
    expect(ft).toContain('Ta ligue est gratuite (moins de 15 joueurs réguliers).');
    expect(ft).not.toContain("S'abonner");
    expect((await act(free.owner, 'checkout', { interval: 'month' })).status).toBe(409);
    const big = await league('big', 101);
    const bt = text(await (await page(big.owner)).text());
    expect(bt).toContain("Plus de 100 joueurs réguliers : écris-nous à bonjour@notreligue.ca pour un prix sur mesure. D'ici là, le forfait Plus s'applique.");
    expect(bt).toContain('Ta ligue compte 101 joueurs réguliers : forfait Plus.');
    expect(bt).toContain('Mensuel : 19,99 $ par mois');
    expect(bt).toContain("S'abonner");
    const be = text(await (await page(big.owner, '', 'en')).text());
    expect(be).toContain('More than 100 regular players: write to bonjour@notreligue.ca for a custom price. Until then, the Plus plan applies.');
    expect(be).toContain('Subscribe');
    calls = [];
    expect((await act(big.owner, 'checkout', { interval: 'year' })).status).toBe(200);
    expect(calls.find(x => x.path === '/checkout/sessions').form['line_items[0][price]']).toBe('price_plus_y');
    expect(text(await (await page(free.owner, '', 'en')).text())).toContain('Your league is free (fewer than 15 regular players).');
  });

  it('a co-admin sees the page but cannot subscribe', async () => {
    on(); stub();
    const { leagueId } = await league('own', 20);
    const co = await account('coadmin');
    const uid = (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind('p211.coadmin@example.com').first()).id;
    await env.DB.prepare(`INSERT INTO league_admins (user_id, league_id, role, created_at) VALUES (?, ?, 'admin', ?)`).bind(uid, leagueId, new Date().toISOString()).run();
    const html = text(await (await page(co)).text());
    expect(html).toContain("Seul le propriétaire de la ligue peut gérer l'abonnement.");
    expect(html).not.toContain("S'abonner");
    expect((await act(co, 'checkout', { interval: 'month' })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('back from Checkout: the subscription is written and thanked; a cancelled Checkout says so', async () => {
    on(); stub();
    const { owner, leagueId } = await league('back', 20);
    objects = {
      '/checkout/sessions/cs_done': { id: 'cs_done', status: 'complete', client_reference_id: leagueId, customer: 'cus_back', subscription: 'sub_back', metadata: { league_id: leagueId } },
      '/subscriptions/sub_back': sub('sub_back', leagueId, { customer: 'cus_back', status: 'trialing', trial_start: 1790000000, trial_end: Math.floor(Date.now() / 1000) + 30 * 86400 })
    };
    const ok = text(await (await page(owner, '?status=success&session_id=cs_done')).text());
    expect(ok).toContain('Merci! Ton abonnement est actif.');
    expect(await row(leagueId)).toMatchObject({ stripe_subscription_id: 'sub_back', stripe_customer_id: 'cus_back', status: 'active', tier: 'standard', billing_interval: 'month' });
    expect((await row(leagueId)).trial_ends_at).toBeTruthy();
    expect(ok).toContain('Premier paiement le');
    expect(ok).toContain('Gérer mon abonnement');
    expect(ok).not.toContain("S'abonner");
    // No second subscription.
    expect((await act(owner, 'checkout', { interval: 'month' })).status).toBe(409);
    expect(text(await (await page(owner, '?status=cancel')).text())).toContain("L'abonnement n'a pas été complété.");
    expect(text(await (await page(owner, '?status=cancel', 'en')).text())).toContain('The subscription was not completed.');
  });
});

describe('the portal, cancellation and refunds', () => {
  it('the portal opens for the customer and comes back to the billing page (default configuration)', async () => {
    on(); stub();
    const { owner, leagueId } = await league('portal', 20);
    objects = { '/subscriptions/sub_p': sub('sub_p', leagueId) };
    await processStripeEvent(env, { id: 'evt_x1', type: 'customer.subscription.created', created: 1, data: { object: { id: 'sub_p' } } });
    const res = await act(owner, 'portal', { lang: 'en' });
    expect((await res.json()).url).toBe('https://billing.stripe.com/p/session/bps_1');
    const f = calls.find(x => x.path === '/billing_portal/sessions').form;
    expect(f).toMatchObject({ customer: 'cus_p211', return_url: 'http://example.com/league/billing', locale: 'en' });
    expect(f.configuration).toBeUndefined();
    // Cancelled from the portal: at the end of the period.
    const end = Math.floor(Date.now() / 1000) + 12 * 86400;
    objects['/subscriptions/sub_p'] = sub('sub_p', leagueId, { cancel_at: end, cancel_at_period_end: false });
    await processStripeEvent(env, { id: 'evt_x2', type: 'customer.subscription.updated', created: 2, data: { object: { id: 'sub_p' } } });
    expect((await row(leagueId)).cancel_at_period_end).toBe(1);
    const fr = text(await (await page(owner)).text());
    expect(fr).toMatch(/Ton abonnement prend fin le \S+ \d+ \S+ \d{4}\./);
    expect(text(await (await page(owner, '', 'en')).text())).toContain('Your subscription ends on');
  });

  it('a full refund ends the subscription at once; a partial refund changes nothing', async () => {
    on(); stub();
    const { leagueId } = await league('refund', 20);
    objects = {
      '/subscriptions/sub_r': sub('sub_r', leagueId, { customer: 'cus_r' }),
      '/charges/ch_part': { id: 'ch_part', customer: 'cus_r', amount: 999, amount_refunded: 500, refunded: false },
      '/charges/ch_full': { id: 'ch_full', customer: 'cus_r', amount: 999, amount_refunded: 999, refunded: true }
    };
    await processStripeEvent(env, { id: 'evt_r0', type: 'customer.subscription.created', created: 1, data: { object: { id: 'sub_r' } } });
    await processStripeEvent(env, { id: 'evt_r1', type: 'charge.refunded', created: 2, data: { object: { id: 'ch_part' } } });
    expect(calls.some(x => x.method === 'DELETE')).toBe(false);
    expect((await row(leagueId)).status).toBe('active');
    await processStripeEvent(env, { id: 'evt_r2', type: 'charge.refunded', created: 3, data: { object: { id: 'ch_full' } } });
    const del = calls.find(x => x.method === 'DELETE');
    expect(del.path).toBe('/subscriptions/sub_r');
    expect((await row(leagueId)).status).toBe('inactive');
  });
});

describe('pause, resume, tier change', () => {
  it('monthly: pause with a confirmation, no charge while paused; resume restarts billing that day', async () => {
    on(); stub();
    const { owner, leagueId } = await league('pause', 20);
    objects = { '/subscriptions/sub_m': sub('sub_m', leagueId) };
    await processStripeEvent(env, { id: 'evt_p0', type: 'customer.subscription.created', created: 1, data: { object: { id: 'sub_m' } } });
    const before = await (await page(owner)).text();
    expect(before).toContain('id="bl-pause-ask"');
    expect(before).toContain('Mettre en pause');
    expect(text(before)).toContain("Mettre l'abonnement en pause? Aucun paiement tant qu'il est en pause.");
    expect((await act(owner, 'pause')).status).toBe(200);
    const p = calls.find(x => x.method === 'POST' && x.path === '/subscriptions/sub_m').form;
    expect(p['pause_collection[behavior]']).toBe('void');
    expect((await row(leagueId)).status).toBe('paused');
    const paused = text(await (await page(owner)).text());
    expect(paused).toContain('Abonnement en pause. Ta ligue est en lecture seule.');
    expect(paused).toContain('Reprendre');
    expect(text(await (await page(owner, '', 'en')).text())).toContain('Subscription paused. Your league is read-only.');
    calls = [];
    expect((await act(owner, 'resume')).status).toBe(200);
    const r = calls.find(x => x.method === 'POST' && x.path === '/subscriptions/sub_m').form;
    expect(r).toMatchObject({ pause_collection: '', billing_cycle_anchor: 'now', proration_behavior: 'none' });
    expect((await row(leagueId)).status).toBe('active');
  });

  it('yearly: no pause button, and pausing is refused', async () => {
    on(); stub();
    const { owner, leagueId } = await league('year', 20);
    objects = { '/subscriptions/sub_y': sub('sub_y', leagueId, { items: { data: [{ id: 'si_y', current_period_end: Math.floor(Date.now() / 1000) + 200 * 86400, price: { id: 'price_std_y', recurring: { interval: 'year' } } }] } }) };
    await processStripeEvent(env, { id: 'evt_y0', type: 'customer.subscription.created', created: 1, data: { object: { id: 'sub_y' } } });
    const html = await (await page(owner)).text();
    expect(html).not.toContain('id="bl-pause-ask"');
    expect(text(html)).toContain('Forfait Standard, annuel.');
    expect((await act(owner, 'pause')).status).toBe(409);
  });

  it('the tier changes for the next billing date only, with no proration, and the page says when', async () => {
    on(); stub();
    const { owner, leagueId } = await league('tier', 60);
    const far = Math.floor(Date.now() / 1000) + 10 * 86400;
    objects = { '/subscriptions/sub_t': sub('sub_t', leagueId, { items: { data: [{ id: 'si_t', current_period_end: far, price: { id: 'price_std_m', recurring: { interval: 'month' } } }] } }) };
    await processStripeEvent(env, { id: 'evt_t0', type: 'customer.subscription.created', created: 1, data: { object: { id: 'sub_t' } } });
    const fr = text(await (await page(owner)).text());
    expect(fr).toMatch(/Ton forfait passera à Plus le \S+ \d+ \S+ \d{4}\./);
    expect(text(await (await page(owner, '', 'en')).text())).toContain('Your plan changes to Plus on');
    // Ten days before the renewal: nothing yet.
    calls = [];
    expect(await runTierChanges(env)).toBe(0);
    expect(calls.filter(x => x.method === 'POST')).toHaveLength(0);
    // A day before: the price for the next period, no proration.
    const soon = Math.floor(Date.now() / 1000) + 20 * 3600;
    objects['/subscriptions/sub_t'].items.data[0].current_period_end = soon;
    await processStripeEvent(env, { id: 'evt_t1', type: 'customer.subscription.updated', created: 2, data: { object: { id: 'sub_t' } } });
    expect(await runTierChanges(env)).toBe(1);
    const post = calls.find(x => x.method === 'POST' && x.path === '/subscriptions/sub_t');
    expect(post.form).toMatchObject({ 'items[0][id]': 'si_t', 'items[0][price]': 'price_plus_m', proration_behavior: 'none' });
    expect(post.headers['idempotency-key']).toMatch(/^tier:sub_t:price_plus_m:/);
    expect((await row(leagueId)).tier).toBe('plus');
    expect(await runTierChanges(env)).toBe(0);
  });
});

describe('helpers', () => {
  it('money and prices; SMBHL has no view', async () => {
    on();
    expect(money(999, 'fr')).toBe('9,99\u00a0$');
    expect(money(999, 'en')).toBe('$9.99');
    expect(priceIdFor(env, 'plus', 'year')).toBe('price_plus_y');
    expect(await billingView(env, 'smbhl')).toBeNull();
  });
});

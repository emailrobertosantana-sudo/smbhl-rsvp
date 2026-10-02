// Billing stage 1, item 1a: resume during a trial. Stripe refuses to move
// the billing cycle anchor of a trialing subscription (400,
// invalid_request_error / billing_cycle_anchor), so resume only clears the
// pause in the trial and restarts the cycle today past it
// (src/billing_actions.js resumeSubscription). Stripe is a local stub that
// answers that 400 the way Stripe does. No real Stripe call.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { subscriptionInTrial } from '../src/billing_actions.js';
import { processStripeEvent } from '../src/stripe_webhook.js';

const VARS = {
  BILLING_LAUNCH_AT: '2026-10-01T00:00:00Z',
  STRIPE_SECRET_KEY: 'rk_test_p212_not_real',
  STRIPE_WEBHOOK_SECRET: 'whsec_p212',
  STRIPE_API_VERSION: '2026-08-26.dahlia',
  STRIPE_PRICE_STANDARD_MONTHLY: 'price_std_m', STRIPE_PRICE_STANDARD_YEARLY: 'price_std_y',
  STRIPE_PRICE_PLUS_MONTHLY: 'price_plus_m', STRIPE_PRICE_PLUS_YEARLY: 'price_plus_y',
  LEAGUE_PRODUCT: 'true'
};
const on = () => Object.assign(env, VARS);

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
    if (call.method === 'POST' && objects[path]) {
      const f = call.form;
      const cur = objects[path];
      // What Stripe answers to an anchor reset during a trial.
      if (cur.status === 'trialing' && 'billing_cycle_anchor' in f) {
        return Response.json({ error: { type: 'invalid_request_error', param: 'billing_cycle_anchor', message: 'trialing' } }, { status: 400 });
      }
      if ('pause_collection[behavior]' in f) cur.pause_collection = { behavior: f['pause_collection[behavior]'] };
      if (f.pause_collection === '') cur.pause_collection = null;
      return Response.json(cur);
    }
    if (objects[path]) return Response.json(objects[path]);
    return Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing' } }, { status: 404 });
  };
}
afterEach(() => { globalThis.fetch = originalFetch; });

const DAY = 86400;
const nowS = () => Math.floor(Date.now() / 1000);
const sub = (id, leagueId, over = {}) => ({
  id, object: 'subscription', status: 'active', customer: 'cus_p212', cancel_at_period_end: false, cancel_at: null, pause_collection: null,
  metadata: { league_id: leagueId }, trial_start: null, trial_end: null,
  items: { data: [{ id: 'si_1', current_period_end: nowS() + 20 * DAY, price: { id: 'price_std_m', recurring: { interval: 'month' } } }] },
  ...over
});

let n = 0;
async function account(tag) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${++n}` },
    body: JSON.stringify({ accept_terms: true, email: `p212.${tag}@example.com`, password: 'a-strong-password-1' })
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const csrf = ((res.headers.getSetCookie ? res.headers.getSetCookie() : []).find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] || '';
  return { cookie, csrf, h: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf } };
}
async function league(tag, regulars) {
  const owner = await account(tag);
  const leagueId = (await (await SELF.fetch('http://example.com/leagues/create', { method: 'POST', headers: owner.h, body: JSON.stringify({ name: `P212 ${tag}`, teamNames: ['A', 'B'] }) })).json()).league.id;
  for (let i = 0; i < regulars; i++) {
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, token_salt, league_id, is_active) VALUES (?, ?, ?, 'roster', 0, 's', ?, 1)`)
      .bind(`${leagueId}:r${i}`, `R ${i}`, `r${i}.${tag}@example.com`, leagueId).run();
  }
  return { owner, leagueId };
}
const act = (who, action, body = {}) => SELF.fetch(`http://example.com/league/billing/${action}`, { method: 'POST', headers: who.h, body: JSON.stringify(body) });
const row = id => env.DB.prepare('SELECT * FROM league_billing WHERE league_id = ?').bind(id).first();
const posts = id => calls.filter(x => x.method === 'POST' && x.path === `/subscriptions/${id}`);

beforeAll(async () => {
  env.AUTH_SECRET = 'test-p212-auth';
  env.RSVP_SECRET = 'test-p212-rsvp';
  env.RESEND_API_KEY = 'mock-key';
  await applyRealSchema(env);
});

describe('resume', () => {
  it('in the trial: only the pause is cleared, the trial and its first charge are kept', async () => {
    on(); stub();
    const { owner, leagueId } = await league('trial', 20);
    objects = { '/subscriptions/sub_tr': sub('sub_tr', leagueId, { status: 'trialing', trial_start: nowS() - 5 * DAY, trial_end: nowS() + 20 * DAY }) };
    await processStripeEvent(env, { id: 'evt_tr0', type: 'customer.subscription.created', created: 1, data: { object: { id: 'sub_tr' } } });
    expect((await row(leagueId)).status).toBe('active');
    expect((await act(owner, 'pause')).status).toBe(200);
    expect((await row(leagueId)).status).toBe('paused');
    calls = [];
    const res = await act(owner, 'resume');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The live subscription is read before anything is changed.
    const first = calls.findIndex(x => x.path === '/subscriptions/sub_tr');
    expect(calls[first].method).toBe('GET');
    const p = posts('sub_tr');
    expect(p).toHaveLength(1);
    expect(p[0].form).toEqual({ pause_collection: '' });
    expect(p[0].headers['idempotency-key']).toMatch(/^resume:sub_tr:\d{4}-\d{2}-\d{2}:trial$/);
    const r = await row(leagueId);
    expect(r.status).toBe('active');
    expect(r.stripe_status).toBe('trialing');
    expect(Date.parse(r.trial_ends_at)).toBeGreaterThan(Date.now());
  });

  it('past the trial: the pause is cleared and the cycle restarts today, no proration', async () => {
    on(); stub();
    const { owner, leagueId } = await league('past', 20);
    objects = { '/subscriptions/sub_pa': sub('sub_pa', leagueId, { trial_start: nowS() - 40 * DAY, trial_end: nowS() - 10 * DAY }) };
    await processStripeEvent(env, { id: 'evt_pa0', type: 'customer.subscription.created', created: 1, data: { object: { id: 'sub_pa' } } });
    expect((await act(owner, 'pause')).status).toBe(200);
    expect((await row(leagueId)).status).toBe('paused');
    calls = [];
    expect((await act(owner, 'resume')).status).toBe(200);
    const p = posts('sub_pa');
    expect(p).toHaveLength(1);
    expect(p[0].form).toEqual({ pause_collection: '', billing_cycle_anchor: 'now', proration_behavior: 'none' });
    expect(p[0].headers['idempotency-key']).toMatch(/^resume:sub_pa:\d{4}-\d{2}-\d{2}:cycle$/);
    expect((await row(leagueId)).status).toBe('active');
  });

  it('a yearly subscription cannot be paused: refused, nothing sent to Stripe, and resume has nothing to do', async () => {
    on(); stub();
    const { owner, leagueId } = await league('year', 20);
    objects = { '/subscriptions/sub_yr': sub('sub_yr', leagueId, { items: { data: [{ id: 'si_y', current_period_end: nowS() + 200 * DAY, price: { id: 'price_std_y', recurring: { interval: 'year' } } }] } }) };
    await processStripeEvent(env, { id: 'evt_yr0', type: 'customer.subscription.created', created: 1, data: { object: { id: 'sub_yr' } } });
    calls = [];
    const res = await act(owner, 'pause');
    expect(res.status).toBe(409);
    expect((await res.json()).errorKey).toBe('BILLING_PAUSE_MONTHLY_ONLY');
    expect(calls).toHaveLength(0);
    expect((await row(leagueId)).status).toBe('active');
    expect((await act(owner, 'resume')).status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});

describe('subscriptionInTrial', () => {
  it('trialing, or a trial that ends later', () => {
    const now = new Date('2026-10-01T12:00:00Z');
    const t = Math.floor(now.getTime() / 1000);
    expect(subscriptionInTrial({ status: 'trialing' }, now)).toBe(true);
    expect(subscriptionInTrial({ status: 'active', trial_end: t + 60 }, now)).toBe(true);
    expect(subscriptionInTrial({ status: 'active', trial_end: t - 60 }, now)).toBe(false);
    expect(subscriptionInTrial({ status: 'active', trial_end: null }, now)).toBe(false);
    expect(subscriptionInTrial(null, now)).toBe(false);
  });
});

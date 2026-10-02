// Billing batch 3, items 3a and 3b: the read-only league and the free slot
// (src/billing.js classifyLeague, src/write_guard.js mode 'billing',
// index.js billingWriteRefusal and billingBanner).
//   - each read-only trigger (trial ended unpaid, paused, payment failed)
//     and its unlock (an active subscription);
//   - every write route refuses, server-side, before it runs (the route list
//     approach of part214); the billing page, the account and players'
//     answers still go through; admin pages say so;
//   - players answer through their links in a read-only league;
//   - automatic emails stop (the reminder waves), another league's go on;
//   - one free league per owner: the oldest; the super-admin exception;
//   - billing off and SMBHL: nothing changes.
// Stripe is never called here (a stub that records every request).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import INDEX_SRC from '../src/index.js?raw';
import { applyRealSchema } from './support/real_schema.js';
import { classifyLeague, freeSlotsByOwner, loadLeagueState, leagueAutoMailStopped, setFreeException, billingSummary, billingSummaries } from '../src/billing.js';
import { WRITE_MODES, writeAllowed } from '../src/write_guard.js';
import { BILLING_BANNER_TEXT } from '../src/index.js';
import { runLeagueReminders } from '../src/reminders.js';
import { createSendBudget } from '../src/mail_queue.js';
import { localParts, makeEventId } from '../src/league_ids.js';

const BASE = 'http://example.com';
const LAUNCH = '2026-10-01T00:00:00Z';
const DAY = 86400000;
const originalFetch = globalThis.fetch;
let stripeCalls = 0;

const on = () => { env.BILLING_LAUNCH_AT = LAUNCH; env.LEAGUE_PRODUCT = 'true'; };
const off = () => { delete env.BILLING_LAUNCH_AT; };

function cookiesOf(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.get('set-cookie') || '').split(', ');
  return list.filter(Boolean);
}
let ipN = 0;
async function account(tag) {
  const res = await SELF.fetch(`${BASE}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.217.${++ipN}` },
    body: JSON.stringify({ accept_terms: true, email: `p217.${tag}@example.com`, password: 'a-strong-password-1' })
  });
  const cookies = cookiesOf(res);
  const session = cookies.find(c => c.startsWith('user_session=')).split(';')[0];
  const csrf = cookies.find(c => c.startsWith('csrf_token=')).split(';')[0].split('=')[1];
  const cookie = `${session}; csrf_token=${csrf}`;
  return { cookie, csrf, h: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf } };
}
async function createLeague(who, name) {
  const res = await SELF.fetch(`${BASE}/leagues/create`, { method: 'POST', headers: who.h, body: JSON.stringify({ name, teamNames: ['A', 'B'], tracksStats: true }) });
  return (await res.json()).league.id;
}
const iso = ms => new Date(Date.now() + ms).toISOString();
// The billing row as each state needs it (the count written straight in).
async function setRow(leagueId, values) {
  await env.DB.prepare(`INSERT INTO league_billing (league_id, updated_at) VALUES (?, ?) ON CONFLICT(league_id) DO NOTHING`).bind(leagueId, new Date().toISOString()).run();
  const cols = Object.keys(values);
  await env.DB.prepare(`UPDATE league_billing SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE league_id = ?`).bind(...cols.map(c => values[c]), leagueId).run();
}
const PAST_TRIAL = { trial_started_at: iso(-80 * DAY), trial_ends_at: iso(-20 * DAY) };
const IN_TRIAL = { trial_started_at: iso(-5 * DAY), trial_ends_at: iso(50 * DAY) };
const NO_SUB = { stripe_subscription_id: null, stripe_customer_id: null, stripe_status: null, status: 'trial', tier: 'free', read_only_since: null, grace_ends_at: null, emails_paused_since: null };
const LIVE = { stripe_customer_id: 'cus_p217', stripe_subscription_id: 'sub_p217', tier: 'standard', billing_interval: 'month' };
const count = async (table, where = '1=1', ...b) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...b).first()).n;

// Every literal write route of the router (src/index.js), as part214 finds them.
function writeRoutes() {
  const out = new Set();
  const re = /url\.pathname === '([^']+)'(?:\s*\|\|\s*url\.pathname === '[^']+')*\)?\s*&&\s*req\.method === '(POST|PUT|PATCH|DELETE)'/g;
  let m;
  while ((m = re.exec(INDEX_SRC))) out.add(`${m[2]} ${m[1]}`);
  return [...out];
}

let owner, other, leagueRO, leagueOther;

beforeAll(async () => {
  env.AUTH_SECRET = 'test-p217-auth';
  env.RSVP_SECRET = 'test-p217-rsvp';
  env.RESEND_API_KEY = 'mock-key';
  env.ADMIN_KEY = 'test-p217-admin';
  on();
  await applyRealSchema(env);
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('api.stripe.com')) { stripeCalls++; return Response.json({ error: { type: 'api_error' } }, { status: 500 }); }
    if (u.includes('api.resend.com')) return new Response('{"id":"x"}', { status: 200 });
    return originalFetch(url, opts);
  };
  owner = await account('owner');
  leagueRO = await createLeague(owner, 'Ligue Lecture Seule');
  other = await account('other');
  leagueOther = await createLeague(other, 'Ligue Active');
  for (const [lg, tag] of [[leagueRO, 'ro'], [leagueOther, 'ok']]) {
    for (let i = 0; i < 20; i++) {
      await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, token_salt, league_id, is_active) VALUES (?, ?, ?, 'roster', 0, 's', ?, 1)`)
        .bind(`${lg}:r${i}`, `R${i} ${tag}`, `r${i}.${tag}.p217@example.com`, lg).run();
    }
  }
  await setRow(leagueRO, { ...NO_SUB, ...PAST_TRIAL, regular_count: 20, count_tier: 'standard' });
  await setRow(leagueOther, { ...NO_SUB, ...IN_TRIAL, regular_count: 20, count_tier: 'standard' });
});
afterAll(() => { globalThis.fetch = originalFetch; });

describe('the state (classifyLeague)', () => {
  const league = { id: 'lg-x', created_at: '2026-10-05T00:00:00Z', created_by: 'u1' };
  const st = (row, opts = {}) => classifyLeague({ BILLING_LAUNCH_AT: LAUNCH }, league, { regular_count: 20, ...row }, opts);

  it('each read-only trigger, and what is not one', () => {
    expect(st({ ...NO_SUB, ...IN_TRIAL })).toMatchObject({ status: 'trial', readOnly: false, mailStopped: false });
    expect(st({ ...NO_SUB, ...PAST_TRIAL })).toMatchObject({ status: 'unpaid', readOnly: true, reason: 'trial_ended', mailStopped: true, inactive: true });
    expect(st({ ...LIVE, ...PAST_TRIAL, status: 'paused', stripe_status: 'active' })).toMatchObject({ status: 'paused', readOnly: true, reason: 'paused', inactive: false });
    expect(st({ ...LIVE, ...PAST_TRIAL, status: 'paused', stripe_status: 'paused' })).toMatchObject({ status: 'paused', readOnly: true, reason: 'trial_no_card', inactive: true });
    expect(st({ ...LIVE, ...PAST_TRIAL, status: 'past_due', stripe_status: 'past_due' })).toMatchObject({ status: 'past_due', readOnly: true, reason: 'payment_failed', inactive: false });
    expect(st({ ...LIVE, ...PAST_TRIAL, status: 'inactive', stripe_status: 'canceled', last_paid_at: iso(-40 * DAY) })).toMatchObject({ status: 'unpaid', readOnly: true, reason: 'cancelled', inactive: true });
    expect(st({ ...LIVE, ...PAST_TRIAL, status: 'active', stripe_status: 'active' })).toMatchObject({ status: 'active', readOnly: false });
    // Above 100: like any other league (Roberto, 2026-10-02): read-only once the trial ends unpaid.
    expect(st({ ...NO_SUB, ...PAST_TRIAL, regular_count: 120 })).toMatchObject({ status: 'unpaid', readOnly: true, reason: 'trial_ended', inactive: true });
    expect(st({ ...NO_SUB, ...IN_TRIAL, regular_count: 120 })).toMatchObject({ status: 'trial', readOnly: false });
    expect(st({ ...LIVE, ...PAST_TRIAL, regular_count: 120, status: 'active', stripe_status: 'active', tier: 'plus' })).toMatchObject({ status: 'active', readOnly: false });
    // Under 15 and the owner's free league.
    expect(st({ ...NO_SUB, ...PAST_TRIAL, regular_count: 10 }, { freeEligible: true })).toMatchObject({ status: 'free', readOnly: false });
    expect(st({ ...NO_SUB, ...PAST_TRIAL, regular_count: 10 }, { freeEligible: false })).toMatchObject({ status: 'unpaid', readOnly: true });
    // Billing off, SMBHL, never billed.
    expect(classifyLeague({}, league, { ...NO_SUB, ...PAST_TRIAL })).toMatchObject({ status: 'off', readOnly: false });
    expect(classifyLeague({ BILLING_LAUNCH_AT: LAUNCH }, { id: 'smbhl' }, { ...NO_SUB, ...PAST_TRIAL })).toMatchObject({ status: 'exempt', readOnly: false });
    expect(st({ ...NO_SUB, ...PAST_TRIAL, billing_exempt: 1 })).toMatchObject({ status: 'exempt', readOnly: false });
  });

  it('a free league that reaches 15 is in its grace, never read-only; its emails stop after it', () => {
    expect(st({ ...NO_SUB, ...PAST_TRIAL, status: 'free', regular_count: 16 })).toMatchObject({ status: 'grace', readOnly: false, mailStopped: false });
    expect(st({ ...NO_SUB, ...PAST_TRIAL, status: 'free', regular_count: 16, grace_ends_at: iso(5 * DAY) })).toMatchObject({ status: 'grace', readOnly: false, mailStopped: false });
    expect(st({ ...NO_SUB, ...PAST_TRIAL, status: 'free', regular_count: 16, grace_ends_at: iso(-1 * DAY) })).toMatchObject({ status: 'grace', readOnly: false, mailStopped: true });
  });

  // Item C (2026-10-02): the TEST league's test subscription was cancelled
  // inside its trial; the super-admin said "Inactive" while the billing
  // page showed the trial. Cancelling keeps the trial; read-only starts at
  // the later of the trial end and the end of any paid period.
  it('a subscription cancelled during the trial keeps the trial; read-only only from the later of the trial end and the paid period end', () => {
    const CANCELLED = { ...LIVE, status: 'inactive', stripe_status: 'canceled', cancel_at_period_end: 0 };
    // Cancelled at once, inside the trial: still the trial, nothing locked.
    expect(st({ ...CANCELLED, ...IN_TRIAL })).toMatchObject({ status: 'trial', readOnly: false, mailStopped: false, inactive: false, trialEnd: IN_TRIAL.trial_ends_at });
    // Even after a payment (a paid period that ended inside the trial).
    expect(st({ ...CANCELLED, ...IN_TRIAL, last_paid_at: iso(-3 * DAY) })).toMatchObject({ status: 'trial', readOnly: false });
    // Once the trial is over: an unpaid trial.
    expect(st({ ...CANCELLED, ...PAST_TRIAL })).toMatchObject({ status: 'unpaid', readOnly: true, reason: 'trial_ended' });
    // Cancelled from the portal inside the trial: Stripe keeps it until the
    // period end (the trial end), so it stays live until then.
    const AT_END = { ...LIVE, status: 'active', stripe_status: 'trialing', cancel_at_period_end: 1, current_period_end: IN_TRIAL.trial_ends_at };
    expect(st({ ...AT_END, ...IN_TRIAL })).toMatchObject({ status: 'active', readOnly: false });
    // A paid period running past the trial end: live (not read-only) until
    // the period ends, then cancelled and read-only.
    const PAID = { ...LIVE, status: 'active', stripe_status: 'active', cancel_at_period_end: 1, current_period_end: iso(10 * DAY), last_paid_at: iso(-20 * DAY) };
    expect(st({ ...PAID, ...PAST_TRIAL })).toMatchObject({ status: 'active', readOnly: false });
    expect(st({ ...PAID, ...PAST_TRIAL, status: 'inactive', stripe_status: 'canceled', current_period_end: iso(-1 * DAY) })).toMatchObject({ status: 'unpaid', readOnly: true, reason: 'cancelled' });
  });

  it('the super-admin summary is the same state, never the raw Stripe status', () => {
    const env1 = { BILLING_LAUNCH_AT: LAUNCH };
    const sum = (row, opts = {}) => billingSummary(env1, league, { regular_count: 20, ...row }, opts);
    const CANCELLED = { ...LIVE, status: 'inactive', stripe_status: 'canceled' };
    expect(sum({ ...CANCELLED, ...IN_TRIAL })).toMatchObject({ status: 'trial', readOnly: false, trialEndsAt: IN_TRIAL.trial_ends_at });
    expect(sum({ ...CANCELLED, ...PAST_TRIAL })).toMatchObject({ status: 'unpaid', readOnly: true });
    expect(sum({ ...CANCELLED, ...PAST_TRIAL, last_paid_at: iso(-40 * DAY) })).toMatchObject({ status: 'inactive', readOnly: true });
    expect(sum({ ...LIVE, ...IN_TRIAL, status: 'active', stripe_status: 'trialing' })).toMatchObject({ status: 'active', readOnly: false });
    expect(sum({ ...LIVE, ...PAST_TRIAL, status: 'past_due', stripe_status: 'past_due' })).toMatchObject({ status: 'past_due', readOnly: true });
    expect(sum({ ...NO_SUB, ...PAST_TRIAL, status: 'free', regular_count: 16 })).toMatchObject({ status: 'grace', readOnly: false });
    expect(sum({ ...NO_SUB, ...PAST_TRIAL, regular_count: 10 }, { freeSlot: 'lg-x' })).toMatchObject({ status: 'free', readOnly: false });
    expect(sum({ ...NO_SUB, ...PAST_TRIAL, regular_count: 10 }, { freeSlot: 'other' })).toMatchObject({ status: 'unpaid', readOnly: true });
  });
});

describe('the super-admin, the billing page and the gate agree (item C)', () => {
  it('a league whose subscription was cancelled during its trial: trial everywhere, no read-only', async () => {
    const lg = await createLeague(await account('cancel'), 'Ligue Annulée Pendant Essai');
    await setRow(lg, { ...LIVE, stripe_subscription_id: 'sub_p217c', status: 'inactive', stripe_status: 'canceled', ...IN_TRIAL, regular_count: 20, count_tier: 'standard' });
    const leagues = (await env.DB.prepare('SELECT id, created_at, created_by, deactivated_at FROM leagues').all()).results;
    const summary = (await billingSummaries(env, leagues)).get(lg);
    const state = await loadLeagueState(env, lg);
    expect(state).toMatchObject({ status: 'trial', readOnly: false });
    expect(summary).toMatchObject({ status: state.status, readOnly: state.readOnly, trialEndsAt: state.trialEnd });
    // The read-only league of this file: the same answer on both sides too.
    const ro = (await billingSummaries(env, leagues)).get(leagueRO);
    expect(ro).toMatchObject({ status: 'unpaid', readOnly: true });
    expect((await loadLeagueState(env, leagueRO)).readOnly).toBe(true);
    await env.DB.prepare('DELETE FROM league_billing WHERE league_id = ?').bind(lg).run();
  });
});

describe('the free slot: one free league per owner, the oldest', () => {
  it('goes to the oldest league under 15; deactivated and excepted leagues never hold it', () => {
    const leagues = [
      { id: 'old', created_at: '2026-10-01T00:00:00Z', created_by: 'u1' },
      { id: 'mid', created_at: '2026-10-03T00:00:00Z', created_by: 'u1' },
      { id: 'new', created_at: '2026-10-05T00:00:00Z', created_by: 'u1' },
      { id: 'big', created_at: '2026-09-01T00:00:00Z', created_by: 'u1' }
    ];
    const rows = new Map([['old', { regular_count: 5 }], ['mid', { regular_count: 8 }], ['new', { regular_count: 3 }], ['big', { regular_count: 30 }]]);
    expect(freeSlotsByOwner(leagues, rows).get('u1')).toBe('old');
    expect(freeSlotsByOwner([{ ...leagues[0], deactivated_at: '2026-10-10T00:00:00Z' }, ...leagues.slice(1)], rows).get('u1')).toBe('mid');
    expect(freeSlotsByOwner(leagues, new Map([...rows, ['old', { regular_count: 5, free_exception: 1 }]])).get('u1')).toBe('mid');
  });

  it('an owner with two small leagues past their trials: the oldest is free, the other read-only until the exception switch', async () => {
    const solo = await account('solo');
    const first = await createLeague(solo, 'Petite Une');
    const second = await createLeague(solo, 'Petite Deux');
    await env.DB.prepare('UPDATE leagues SET created_at = ? WHERE id = ?').bind('2026-10-01T00:00:00.000Z', first).run();
    await env.DB.prepare('UPDATE leagues SET created_at = ? WHERE id = ?').bind('2026-10-02T00:00:00.000Z', second).run();
    for (const id of [first, second]) await setRow(id, { ...NO_SUB, ...PAST_TRIAL, regular_count: 8, count_tier: 'free' });
    expect(await loadLeagueState(env, first)).toMatchObject({ status: 'free', readOnly: false, freeEligible: true });
    expect(await loadLeagueState(env, second)).toMatchObject({ status: 'unpaid', readOnly: true, freeEligible: false });
    // The newest league is the one the session acts on: refused.
    const add = () => SELF.fetch(`${BASE}/league/contacts`, { method: 'POST', headers: solo.h, body: JSON.stringify({ name: 'Nouveau Joueur' }) });
    expect((await add()).status).toBe(403);
    // Its billing page asks for the Standard plan.
    const page = await (await SELF.fetch(`${BASE}/league/billing`, { headers: { cookie: solo.cookie, 'accept-language': 'fr-CA' } })).text();
    expect(page).toContain('Tu as déjà une ligue gratuite : celle-ci demande un forfait.');
    expect(page).toContain('forfait Standard.');
    expect(page).toContain('data-billing="checkout"');
    // The super-admin's exception: free, unlocked at once.
    expect((await setFreeException(env, second, true)).ok).toBe(true);
    expect(await loadLeagueState(env, second)).toMatchObject({ status: 'free', readOnly: false });
    expect((await add()).status).toBe(200);
    expect(stripeCalls).toBe(0);
  });
});

describe('a read-only league (trial ended unpaid)', () => {
  it('every write route refuses, server-side, before it runs', async () => {
    const routes = writeRoutes();
    expect(routes.length).toBeGreaterThan(80);
    const before = { contacts: await count('contacts'), events: await count('events'), outbox: await count('outbox'), settings: await count('settings'), leagues: await count('leagues') };
    const refused = [];
    for (const r of routes) {
      const [method, path] = r.split(' ');
      if (writeAllowed(new URL(BASE + path), 'billing')) continue;
      const res = await SELF.fetch(`${BASE}${path}`, {
        method, headers: owner.h,
        body: JSON.stringify({ name: 'X', email: 'x@example.com', confirm: 'Ligue Lecture Seule' })
      });
      const body = await res.json().catch(() => null);
      if (res.status === 403 && body && body.errorKey === 'LEAGUE_READ_ONLY' && body.billingUrl === '/league/billing') refused.push(r);
      else throw new Error(`${r} answered ${res.status}`);
    }
    expect(refused.length).toBeGreaterThan(70);
    expect(refused).toContain('POST /league/contacts');
    expect(refused).toContain('POST /league/rsvp/admin');
    expect(refused).toContain('POST /league/comms/broadcast');
    // A route the router does not know is refused the same way.
    expect((await SELF.fetch(`${BASE}/league/anything-new`, { method: 'POST', headers: owner.h })).status).toBe(403);
    expect({ contacts: await count('contacts'), events: await count('events'), outbox: await count('outbox'), settings: await count('settings'), leagues: await count('leagues') }).toEqual(before);
  });

  it('what still goes through: the billing page and its actions, the account, players, leaving', async () => {
    const exact = WRITE_MODES.billing.exact;
    for (const p of ['/league/rsvp', '/league/rsvp/confirm', '/league/rsvp/game', '/avail', '/rsvp', '/rsvp/confirm', '/team-rsvp', '/api/poll/vote', '/leagues/create', '/league/hard-delete']) expect(exact).toContain(p);
    for (const p of ['/league/billing/checkout', '/league/billing/portal', '/billing/stripe-webhook', '/auth/logout', '/super-admin/leagues/update', '/health/client-error']) expect(writeAllowed(new URL(BASE + p), 'billing'), p).toBe(true);
    for (const p of ['/league/rsvp/admin', '/league/contacts', '/league/billing']) expect(writeAllowed(new URL(BASE + p), 'billing'), p).toBe(false);
    // The portal action reaches its handler (no customer yet: its own answer).
    const portal = await SELF.fetch(`${BASE}/league/billing/portal`, { method: 'POST', headers: owner.h, body: '{}' });
    expect((await portal.json()).errorKey).toBe('BILLING_NO_CUSTOMER');
  });

  it('the admin pages show everything, with the banner pointing to the billing page', async () => {
    for (const path of ['/dashboard', '/league/roster', '/league/schedule', '/league/settings']) {
      const res = await SELF.fetch(`${BASE}${path}`, { headers: { cookie: owner.cookie }, redirect: 'manual' });
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain('id="nl-billing-banner"');
      expect(html).toContain(BILLING_BANNER_TEXT.fr.readOnly.replace(/'/g, '&#39;'));
      expect(html).toContain(BILLING_BANNER_TEXT.en.readOnly.replace(/'/g, '&#39;'));
      expect(html).toContain('href="/league/billing"');
    }
    const players = await (await SELF.fetch(`${BASE}/league/contacts`, { headers: { cookie: owner.cookie } })).json();
    expect(JSON.stringify(players)).toContain('R0 ro');
    // The billing page: its own line, no banner.
    const billing = await (await SELF.fetch(`${BASE}/league/billing`, { headers: { cookie: owner.cookie, 'accept-language': 'fr-CA' } })).text();
    expect(billing).not.toContain('nl-billing-banner');
    expect(billing).toContain('Ta ligue est en lecture seule. Abonne-toi pour la réactiver.');
    // The other league (in its trial) has neither.
    const okPage = await (await SELF.fetch(`${BASE}/dashboard`, { headers: { cookie: other.cookie } })).text();
    expect(okPage).not.toContain('nl-billing-banner');
    expect((await SELF.fetch(`${BASE}/league/contacts`, { method: 'POST', headers: other.h, body: JSON.stringify({ name: 'Autre Joueur' }) })).status).toBe(200);
  });

  it('players still answer through the links they already have', async () => {
    const date = localParts(new Date(Date.now() + 5 * DAY)).date;
    const eventId = makeEventId(leagueRO, date);
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'S1', 1, ?, 'Aréna', 'open', '19:00', ?)`).bind(eventId, date, leagueRO).run();
    const pid = `${leagueRO}:r3`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(env.RSVP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`lr:${leagueRO}:${eventId}:${pid}:s`));
    const token = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
    // Even from a browser that also holds the admin's session.
    const res = await SELF.fetch(`${BASE}/league/rsvp?league=${encodeURIComponent(leagueRO)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(pid)}&t=${token}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: owner.cookie }, body: JSON.stringify({ status: 'in' })
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect((await env.DB.prepare('SELECT status FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, pid).first()).status).toBe('in');
    // The public league page stays visible.
    const pub = await SELF.fetch(`${BASE}/league/public?league=${encodeURIComponent(leagueRO)}`);
    expect(pub.status).toBe(200);
    expect(await pub.text()).not.toContain('nl-billing-banner');
  });

  it('paused and payment failed are read-only too; an active subscription unlocks each at once', async () => {
    let k = 0;
    const add = () => SELF.fetch(`${BASE}/league/contacts`, { method: 'POST', headers: owner.h, body: JSON.stringify({ name: `Débloqué ${++k}` }) });
    for (const state of [
      { ...LIVE, ...PAST_TRIAL, status: 'paused', stripe_status: 'active' },
      { ...LIVE, ...PAST_TRIAL, status: 'paused', stripe_status: 'paused' },
      { ...LIVE, ...PAST_TRIAL, status: 'past_due', stripe_status: 'past_due' },
      { ...NO_SUB, ...PAST_TRIAL }
    ]) {
      await setRow(leagueRO, state);
      const res = await add();
      expect(res.status, JSON.stringify(state)).toBe(403);
      expect((await res.json()).errorKey).toBe('LEAGUE_READ_ONLY');
      expect(await leagueAutoMailStopped(env, leagueRO)).toBe(true);
      // Subscribing or paying: Stripe's state written as active.
      await setRow(leagueRO, { ...LIVE, status: 'active', stripe_status: 'active' });
      expect((await add()).status).toBe(200);
      expect(await leagueAutoMailStopped(env, leagueRO)).toBe(false);
    }
    await setRow(leagueRO, { ...NO_SUB, ...PAST_TRIAL });
  });
});

describe('automatic emails stop in a read-only league', () => {
  it('no reminder wave for it; the league next door gets its own', async () => {
    const soon = new Date(Date.now() + 20 * 3600000);
    const parts = localParts(soon);
    const time = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
    for (const lg of [leagueRO, leagueOther]) {
      await env.DB.prepare('UPDATE leagues SET reminder_72h_enabled = 1, reminder_24h_enabled = 1, reminder_12h_enabled = 1 WHERE id = ?').bind(lg).run();
      await env.DB.prepare('UPDATE contacts SET preferred_team = ? WHERE league_id = ?').bind('A', lg).run();
      await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, home_team, away_team) VALUES (?, 'S1', 2, ?, 'Aréna', 'open', ?, ?, 'A', 'B')`)
        .bind(makeEventId(lg, parts.date, 7), parts.date, time, lg).run().catch(async () => {
          await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'S1', 2, ?, 'Aréna', 'open', ?, ?)`)
            .bind(makeEventId(lg, parts.date, 7), parts.date, time, lg).run();
        });
    }
    expect(await leagueAutoMailStopped(env, leagueRO)).toBe(true);
    expect(await leagueAutoMailStopped(env, leagueOther)).toBe(false);
    await runLeagueReminders(env, createSendBudget(100), []);
    const waves = async lg => count('outbox', `league_id = ? AND kind IN ('reminder_72h', 'reminder_24h')`, lg);
    expect(await waves(leagueRO)).toBe(0);
    expect(await waves(leagueOther)).toBeGreaterThan(0);
  });

  it('billing off: nothing is read, nothing stops', async () => {
    off();
    try {
      expect(await leagueAutoMailStopped(env, leagueRO)).toBe(false);
      expect(await loadLeagueState(env, leagueRO)).toBe(null);
      const res = await SELF.fetch(`${BASE}/league/contacts`, { method: 'POST', headers: owner.h, body: JSON.stringify({ name: 'Billing Off' }) });
      expect(res.status).toBe(200);
      const html = await (await SELF.fetch(`${BASE}/dashboard`, { headers: { cookie: owner.cookie } })).text();
      expect(html).not.toContain('nl-billing-banner');
    } finally { on(); }
  });

  it('SMBHL (no LEAGUE_PRODUCT): never read-only', async () => {
    delete env.LEAGUE_PRODUCT;
    try {
      expect(await leagueAutoMailStopped(env, leagueRO)).toBe(false);
      expect(await leagueAutoMailStopped(env, 'smbhl')).toBe(false);
      expect(await loadLeagueState(env, 'smbhl')).toBe(null);
    } finally { env.LEAGUE_PRODUCT = 'true'; }
  });
});

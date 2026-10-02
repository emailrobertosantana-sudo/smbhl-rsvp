// Billing batch 3, items 3c to 3f and decision 3: the daily enforcement
// (src/billing_enforcement.js) and its notices (src/billing_notices.js).
//   - each notice once, to the right people (payment and card notices to
//     the owner; read-only and deletion warnings to every admin), in the
//     league's language, dates in words;
//   - the trial notices (7 days, the day; subscribe, or add a card);
//   - the free league at 15: 14 days, then its automatic emails stop;
//   - the tier change, the failed payment, over 100 (and the digest);
//   - the 12-month clock: its notices, the deletion, the stop on
//     subscribing, the paused exemption;
//   - a subscription Stripe paused for want of a card: the billing page's
//     Add a card, and the resume once a card is on file (page, cron,
//     invoice.paid);
//   - idempotent (run twice); nothing while billing is off.
// Stripe is a local stub (no real call); mail is captured by a fake host,
// except in the one test through the real cron entry point.
import { env, SELF, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import worker from '../src/index.js';
import { runBillingEnforcement, deletionDates } from '../src/billing_enforcement.js';
import { renderBillingNotice, noticeContent, noticeDate, NOTICE_KINDS, OWNER_NOTICES } from '../src/billing_notices.js';
import { leagueAutoMailStopped, loadLeagueState } from '../src/billing.js';
import { processStripeEvent } from '../src/stripe_webhook.js';
import { prepareOpsDigest, renderOpsDigest } from '../src/ops_digest.js';

const VARS = {
  BILLING_LAUNCH_AT: '2026-10-01T00:00:00Z',
  STRIPE_SECRET_KEY: 'rk_test_p218_not_real',
  STRIPE_API_VERSION: '2026-08-26.dahlia',
  STRIPE_PRICE_STANDARD_MONTHLY: 'price_std_m', STRIPE_PRICE_STANDARD_YEARLY: 'price_std_y',
  STRIPE_PRICE_PLUS_MONTHLY: 'price_plus_m', STRIPE_PRICE_PLUS_YEARLY: 'price_plus_y',
  LEAGUE_PRODUCT: 'true'
};
const DAY = 86400000;
const T0 = Date.now();
const at = ms => new Date(T0 + ms);
const iso = ms => at(ms).toISOString();

// The Stripe stub.
const originalFetch = globalThis.fetch;
let calls = [];
let objects = {};
let resendTo = [];
const parseForm = body => Object.fromEntries(String(body || '').split('&').filter(Boolean).map(kv => kv.split('=').map(decodeURIComponent)));
function stub() {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('api.resend.com')) { const b = JSON.parse(opts.body); resendTo.push(Array.isArray(b.to) ? b.to[0] : b.to); return new Response('{"id":"x"}', { status: 200 }); }
    if (!u.startsWith('https://api.stripe.com/')) return originalFetch(url, opts);
    const path = new URL(u).pathname.replace('/v1', '');
    const call = { method: opts.method || 'GET', path, form: parseForm(opts.body), headers: opts.headers || {} };
    calls.push(call);
    const resume = path.match(/^(\/subscriptions\/[A-Za-z0-9_]+)\/resume$/);
    if (call.method === 'POST' && resume && objects[resume[1]]) { objects[resume[1]].status = 'active'; return Response.json(objects[resume[1]]); }
    if (call.method === 'DELETE' && objects[path]) { objects[path] = { ...objects[path], status: 'canceled' }; return Response.json(objects[path]); }
    if (objects[path]) return Response.json(objects[path]);
    return Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing' } }, { status: 404 });
  };
}
const sub = (id, leagueId, over = {}) => ({
  id, object: 'subscription', status: 'active', customer: `cus_${id}`, cancel_at_period_end: false, cancel_at: null, pause_collection: null,
  metadata: { league_id: leagueId }, trial_start: null, trial_end: null, default_payment_method: null,
  items: { data: [{ id: 'si_1', current_period_end: Math.floor((T0 + 20 * DAY) / 1000), price: { id: 'price_std_m', recurring: { interval: 'month' } } }] },
  ...over
});

// The fake host: what would be queued, to whom.
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
const notices = async id => (await env.DB.prepare('SELECT kind, period_key FROM billing_notices WHERE league_id = ? ORDER BY sent_at, kind').bind(id).all()).results;
const row = id => env.DB.prepare('SELECT * FROM league_billing WHERE league_id = ?').bind(id).first();

// A league with its owner (and co-admins), and its billing row.
async function mkLeague(id, { lang = 'fr', createdAt = '2026-10-05T00:00:00.000Z', coAdmins = 0, owner = null, billing = {} } = {}) {
  const ownerId = owner || `u-${id}`;
  await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', ?)`).bind(ownerId, `${ownerId}@example.com`, createdAt).run();
  await env.DB.prepare(`INSERT INTO leagues (id, name, team_count, team_names, created_by, created_at, language_mode) VALUES (?, ?, 2, '["A","B"]', ?, ?, ?)`)
    .bind(id, `Ligue ${id}`, ownerId, createdAt, lang).run();
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
const NO_SUB = (count, trialEndsMs) => ({ regular_count: count, count_tier: count <= 14 ? 'free' : count <= 50 ? 'standard' : count <= 100 ? 'plus' : 'custom', trial_started_at: iso(trialEndsMs - 61 * DAY), trial_ends_at: iso(trialEndsMs) });
const LIVE = (id, over = {}) => ({ stripe_customer_id: `cus_sub_${id}`, stripe_subscription_id: `sub_${id}`, tier: 'standard', billing_interval: 'month', current_period_end: iso(10 * DAY), ...over });

beforeAll(async () => {
  Object.assign(env, VARS);
  env.AUTH_SECRET = 'test-p218-auth';
  env.RSVP_SECRET = 'test-p218-rsvp';
  env.RESEND_API_KEY = 'mock-key';
  env.HEALTH_ALERTS = 'off';
  await applyRealSchema(env);
  stub();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('the notices, as written', () => {
  it('every kind renders in French, English and both; tu, remplaçant, no em dash, dates in words', () => {
    const v = { leagueName: 'Les Hiboux', date: '2026-12-01T00:00:00.000Z', since: '2025-11-01T00:00:00.000Z', count: 16, oldTier: 'standard', newTier: 'plus', interval: 'month', billingUrl: 'https://x.example/league/billing?league_id=a' };
    for (const kind of NOTICE_KINDS) for (const variant of ['subscribe', 'card']) {
      const both = renderBillingNotice(kind, { ...v, variant, languageMode: 'both' });
      const fr = renderBillingNotice(kind, { ...v, variant, languageMode: 'fr' });
      const en = renderBillingNotice(kind, { ...v, variant, languageMode: 'en' });
      for (const m of [both, fr, en]) {
        expect(m.subject + m.text + m.html, kind).not.toMatch(/\u2014|vous |votre |·e|\(e\)| [?!]|\d{4}-\d{2}-\d{2}/);
        expect(m.text).toContain('Les Hiboux');
      }
      expect(fr.text).toContain('Bonjour,');
      expect(fr.text).not.toContain('Hi,');
      expect(en.text).toContain('Hi,');
      expect(en.text).not.toContain('Bonjour');
      expect(both.subject).toContain(' / ');
      expect(fr.html).toContain('lang="fr-CA"');
    }
    expect(noticeDate('2026-12-01', 'fr')).toBe('mardi 1er décembre 2026');
    expect(noticeDate('2026-12-02', 'en')).toBe('Wednesday, December 2, 2026');
    expect(noticeContent('grace_start', v).fr.paragraphs.join(' ')).toContain('remplaçants');
    expect(noticeContent('payment_failed', v).fr.paragraphs.join(' ')).toContain('« Gérer mon abonnement »');
    expect(noticeContent('trial_end', v).fr.subject).toBe('Les Hiboux : la ligue est en lecture seule');
  });
});

describe('the trial: 7 days before, and on the day (the owner only)', () => {
  it('not subscribed: subscribe before the date; once each', async () => {
    const id = await mkLeague('t1', { coAdmins: 1, billing: NO_SUB(20, 6 * DAY) });
    queued = [];
    await run();
    expect(mailsFor(id).map(m => m.to)).toEqual(['u-t1@example.com']);
    const m = mailsFor(id)[0].mail;
    expect(m.subject).toBe(`Ligue t1 : ton essai gratuit se termine le ${noticeDate(iso(6 * DAY), 'fr')}`);
    expect(m.text).toContain("S'abonner : https://rsvp.notreligue.example/league/billing?league_id=t1");
    await run(); await run(DAY);
    expect(mailsFor(id)).toHaveLength(1);
    await run(5.5 * DAY);
    expect(mailsFor(id)).toHaveLength(2);
    expect(mailsFor(id)[1].mail.subject).toContain('dernier rappel, ton essai gratuit se termine le');
    await run(5.7 * DAY);
    expect(mailsFor(id)).toHaveLength(2);
    expect((await notices(id)).map(n => n.kind)).toEqual(['trial_7d', 'trial_day']);
  });

  it('subscribed without a card: add a card (the portal from the billing page); with one: nothing', async () => {
    const a = await mkLeague('t2', { lang: 'en', billing: { ...NO_SUB(20, 3 * DAY), ...LIVE('t2'), status: 'active', stripe_status: 'trialing' } });
    const b = await mkLeague('t3', { billing: { ...NO_SUB(20, 3 * DAY), ...LIVE('t3'), status: 'active', stripe_status: 'trialing' } });
    objects['/subscriptions/sub_t2'] = sub('sub_t2', a, { status: 'trialing', customer: 'cus_t2' });
    objects['/customers/cus_t2'] = { id: 'cus_t2', invoice_settings: { default_payment_method: null } };
    objects['/subscriptions/sub_t3'] = sub('sub_t3', b, { status: 'trialing', customer: 'cus_t3' });
    objects['/customers/cus_t3'] = { id: 'cus_t3', invoice_settings: { default_payment_method: 'pm_1' } };
    queued = []; calls = [];
    await run();
    expect(mailsFor(a).map(m => m.to)).toEqual(['u-t2@example.com']);
    expect(mailsFor(a)[0].mail.subject).toBe(`Ligue t2: add a card before ${noticeDate(iso(3 * DAY), 'en')}`);
    expect(mailsFor(a)[0].mail.text).toContain('“Manage my subscription”');
    expect(mailsFor(b)).toHaveLength(0);
    expect((await notices(b)).map(n => n.kind)).toEqual(['trial_7d']);
    const stripeBefore = calls.length;
    await run();
    expect(calls.length).toBe(stripeBefore);
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });

  it("an owner's second small league gets them; the free one does not", async () => {
    const free = await mkLeague('t4', { owner: 'u-two', createdAt: '2026-10-01T00:00:00.000Z', billing: NO_SUB(8, 5 * DAY) });
    const second = await mkLeague('t5', { owner: 'u-two', createdAt: '2026-10-03T00:00:00.000Z', billing: NO_SUB(9, 5 * DAY) });
    queued = [];
    await run();
    expect(mailsFor(free)).toHaveLength(0);
    expect(mailsFor(second).map(m => m.to)).toEqual(['u-two@example.com']);
  });
});

describe('the trial ends unpaid: read-only, every admin told', () => {
  it('read-only, the clock starts at the trial end, every admin, once', async () => {
    const id = await mkLeague('e1', { coAdmins: 2, billing: NO_SUB(20, -3600000) });
    queued = [];
    await run();
    expect(mailsFor(id).map(m => m.to).sort()).toEqual(['u-e1-co1@example.com', 'u-e1-co2@example.com', 'u-e1@example.com']);
    expect(mailsFor(id)[0].mail.subject).toBe('Ligue e1 : la ligue est en lecture seule');
    expect(mailsFor(id)[0].mail.text).toContain('Les joueurs peuvent encore répondre');
    const r = await row(id);
    expect(r.read_only_since).toBeTruthy();
    expect(r.inactive_since).toBe(iso(-3600000));
    expect((await loadLeagueState(env, id, at(0))).readOnly).toBe(true);
    await run(); await run(DAY);
    expect(mailsFor(id)).toHaveLength(3);
  });
});

describe('a free league at 15 regular players', () => {
  it('14 days to subscribe (the owner), then its automatic emails stop (every admin); never read-only; back under 15, all clear', async () => {
    const id = await mkLeague('g1', { coAdmins: 1, billing: NO_SUB(10, -10 * DAY) });
    queued = [];
    await run();
    expect((await row(id)).status).toBe('free');
    expect(mailsFor(id)).toHaveLength(0);
    await env.DB.prepare('UPDATE league_billing SET regular_count = 16, count_tier = ? WHERE league_id = ?').bind('standard', id).run();
    await run(DAY);
    const r = await row(id);
    expect(r.grace_ends_at).toBe(iso(15 * DAY));
    expect(r.read_only_since).toBe(null);
    expect(mailsFor(id).map(m => m.to)).toEqual(['u-g1@example.com']);
    expect(mailsFor(id)[0].mail.text).toContain(`Abonne-toi d'ici le ${noticeDate(iso(15 * DAY), 'fr')}`);
    expect(mailsFor(id)[0].mail.text).toContain('Ligue g1 compte maintenant 16 joueurs réguliers.');
    expect(await leagueAutoMailStopped(env, id, at(DAY))).toBe(false);
    await run(10 * DAY);
    expect(mailsFor(id)).toHaveLength(1);
    await run(15 * DAY + 60000);
    expect(mailsFor(id).slice(1).map(m => m.to).sort()).toEqual(['u-g1-co1@example.com', 'u-g1@example.com']);
    expect(mailsFor(id)[1].mail.subject).toBe('Ligue g1 : les courriels automatiques sont arrêtés');
    expect((await row(id)).emails_paused_since).toBeTruthy();
    const st = await loadLeagueState(env, id, at(16 * DAY));
    expect(st).toMatchObject({ status: 'grace', readOnly: false, mailStopped: true });
    await run(16 * DAY);
    expect(mailsFor(id)).toHaveLength(3);
    // Back under 15: free again, nothing stopped.
    await env.DB.prepare('UPDATE league_billing SET regular_count = 12, count_tier = ? WHERE league_id = ?').bind('free', id).run();
    await run(17 * DAY);
    expect(await row(id)).toMatchObject({ grace_ends_at: null, emails_paused_since: null, status: 'free' });
  });
});

describe('a paid league', () => {
  it('crossing into the other tier: the owner is told once; the change is at the next billing date', async () => {
    const id = await mkLeague('l1', { coAdmins: 1, billing: { ...NO_SUB(60, -30 * DAY), ...LIVE('l1'), status: 'active', stripe_status: 'active' } });
    queued = [];
    await run(); await run(DAY);
    expect(mailsFor(id).map(m => m.to)).toEqual(['u-l1@example.com']);
    const m = mailsFor(id)[0].mail;
    expect(m.subject).toBe(`Ligue l1 : ton forfait passe à Plus le ${noticeDate(iso(10 * DAY), 'fr')}`);
    expect(m.text).toContain('de Standard à Plus');
    expect(m.text).toContain('19,99 $ par mois avant taxes');
  });

  it('a failed payment: read-only, the owner told once', async () => {
    const id = await mkLeague('p1', { coAdmins: 1, billing: { ...NO_SUB(20, -30 * DAY), ...LIVE('p1'), status: 'past_due', stripe_status: 'past_due' } });
    queued = [];
    await run(); await run(DAY);
    expect(mailsFor(id).map(m => m.to)).toEqual(['u-p1@example.com']);
    expect(mailsFor(id)[0].mail.subject).toBe("Ligue p1 : le paiement n'a pas passé");
    expect((await row(id)).read_only_since).toBeTruthy();
    expect((await row(id)).inactive_since).toBe(null);
  });

  it('over 100 regular players: the owner once, the digest lists it, nothing gated', async () => {
    const id = await mkLeague('c1', { coAdmins: 1, billing: NO_SUB(120, -30 * DAY) });
    queued = [];
    await run(); await run(DAY);
    expect(mailsFor(id).map(m => m.to)).toEqual(['u-c1@example.com']);
    expect(mailsFor(id)[0].mail.text).toContain('Ligue c1 compte maintenant 120 joueurs réguliers.');
    expect((await loadLeagueState(env, id, at(0)))).toMatchObject({ status: 'custom', readOnly: false, mailStopped: false });
    const pending = await prepareOpsDigest(env, { day: '2026-10-03' }, at(DAY - 1000));
    expect(pending.items.custom.map(c => c.id)).toContain(id);
    expect(renderOpsDigest(pending).text).toContain('Ligue c1 : 120 joueurs réguliers');
  });
});

describe('decision 3: a subscription Stripe paused for want of a card', () => {
  it('read-only, every admin told to add a card; once a card is on file, the cron resumes it and the league unlocks', async () => {
    const id = await mkLeague('s1', { coAdmins: 1, billing: { ...NO_SUB(20, -2 * DAY), ...LIVE('s1'), status: 'paused', stripe_status: 'paused' } });
    objects['/subscriptions/sub_s1'] = sub('sub_s1', id, { status: 'paused', customer: 'cus_s1' });
    objects['/customers/cus_s1'] = { id: 'cus_s1', invoice_settings: { default_payment_method: null } };
    queued = []; calls = [];
    await run();
    expect(mailsFor(id)).toHaveLength(2);
    expect(mailsFor(id)[0].mail.text).toContain('Pour la réactiver, ajoute une carte depuis la page Abonnement.');
    expect(calls.some(c => c.path.endsWith('/resume'))).toBe(false);
    expect((await loadLeagueState(env, id, at(0))).readOnly).toBe(true);
    // The owner adds a card in the portal.
    objects['/customers/cus_s1'].invoice_settings.default_payment_method = 'pm_s1';
    await run(3600000);
    const resumes = calls.filter(c => c.path === '/subscriptions/sub_s1/resume');
    expect(resumes).toHaveLength(1);
    expect(resumes[0].form).toEqual({ billing_cycle_anchor: 'now', proration_behavior: 'none' });
    expect(resumes[0].headers['idempotency-key']).toMatch(/^resume-paused:sub_s1:/);
    expect(await row(id)).toMatchObject({ status: 'active', stripe_status: 'active', read_only_since: null });
    expect((await loadLeagueState(env, id, at(3600000))).readOnly).toBe(false);
  });

  it('invoice.paid resumes it too', async () => {
    const id = await mkLeague('s2', { billing: { ...NO_SUB(20, -2 * DAY), ...LIVE('s2'), status: 'paused', stripe_status: 'paused' } });
    objects['/subscriptions/sub_s2'] = sub('sub_s2', id, { status: 'paused', customer: 'cus_s2', default_payment_method: 'pm_s2' });
    objects['/invoices/in_s2'] = { id: 'in_s2', customer: 'cus_s2', subscription: 'sub_s2', amount_paid: 0, status: 'paid' };
    calls = [];
    await processStripeEvent(env, { id: 'evt_s2', type: 'invoice.paid', data: { object: { id: 'in_s2' } } });
    expect(calls.filter(c => c.path === '/subscriptions/sub_s2/resume')).toHaveLength(1);
    expect((await row(id)).status).toBe('active');
  });

  it('the billing page: « Ajouter une carte » opens the portal; back from it with a card, the page resumes it', async () => {
    const signup = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.218.9' },
      body: JSON.stringify({ accept_terms: true, email: 'p218.page@example.com', password: 'a-strong-password-1' })
    });
    const cookie = (signup.headers.getSetCookie ? signup.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
    const csrf = (cookie.match(/csrf_token=([^;]+)/) || [])[1];
    const leagueId = (await (await SELF.fetch('http://example.com/leagues/create', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ name: 'Ligue Carte', teamNames: ['A', 'B'] }) })).json()).league.id;
    for (let i = 0; i < 20; i++) await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, token_salt, league_id, is_active) VALUES (?, ?, ?, 'roster', 0, 's', ?, 1)`).bind(`${leagueId}:r${i}`, `R${i}`, `r${i}.card.p218@example.com`, leagueId).run();
    await env.DB.prepare(`INSERT INTO league_billing (league_id, updated_at) VALUES (?, ?) ON CONFLICT(league_id) DO NOTHING`).bind(leagueId, new Date().toISOString()).run();
    await env.DB.prepare(`UPDATE league_billing SET stripe_customer_id = 'cus_pg', stripe_subscription_id = 'sub_pg', tier = 'standard', billing_interval = 'month', status = 'paused', stripe_status = 'paused', trial_started_at = ?, trial_ends_at = ? WHERE league_id = ?`)
      .bind(iso(-62 * DAY), iso(-2 * DAY), leagueId).run();
    objects['/subscriptions/sub_pg'] = sub('sub_pg', leagueId, { status: 'paused', customer: 'cus_pg' });
    objects['/customers/cus_pg'] = { id: 'cus_pg', invoice_settings: { default_payment_method: null } };
    calls = [];
    const fr = await (await SELF.fetch('http://example.com/league/billing', { headers: { cookie, 'accept-language': 'fr-CA' } })).text();
    expect(fr).toContain('Ton essai est terminé. Ajoute une carte pour réactiver ton abonnement.');
    expect(fr).toMatch(/data-billing="portal" data-i18n="addCard">Ajouter une carte</);
    expect(fr).not.toContain('data-billing="resume"');
    expect(calls.some(c => c.path.endsWith('/resume'))).toBe(false);
    const en = await (await SELF.fetch('http://example.com/league/billing', { headers: { cookie, 'accept-language': 'en-CA' } })).text();
    expect(en).toContain('Your trial has ended. Add a card to reactivate your subscription.');
    expect(en).toContain('>Add a card<');
    // Back from the portal with a card.
    objects['/customers/cus_pg'].invoice_settings.default_payment_method = 'pm_pg';
    const back = await (await SELF.fetch('http://example.com/league/billing', { headers: { cookie, 'accept-language': 'fr-CA' } })).text();
    expect(calls.filter(c => c.path === '/subscriptions/sub_pg/resume')).toHaveLength(1);
    expect(back.replace(/<script[\s\S]*?<\/script>/g, '')).not.toContain('Ajoute une carte pour réactiver');
    expect(back).toContain('data-billing="portal" data-i18n="manage"');
    expect((await row(leagueId)).status).toBe('active');
  });
});

describe('the 12-month clock', () => {
  it('the dates: a late notice moves the deletion, never earlier than 30 and 7 days after each', () => {
    const r = { inactive_since: '2025-10-01T00:00:00.000Z' };
    const d = deletionDates(r, null, null);
    expect(new Date(d.deleteAt).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    const late = deletionDates(r, { sent_at: '2026-09-25T00:00:00.000Z' }, { sent_at: '2026-10-20T00:00:00.000Z' });
    expect(new Date(late.after30).toISOString()).toBe('2026-10-25T00:00:00.000Z');
    expect(new Date(late.after7).toISOString()).toBe('2026-10-27T00:00:00.000Z');
  });

  it('notices at 30 and 7 days (every admin), then the deletion; subscribing stops it; a paused league is never deleted', async () => {
    // Only this test's leagues from here on.
    await env.DB.prepare(`UPDATE leagues SET deactivated_at = ? WHERE deactivated_at IS NULL`).bind(iso(0)).run();
    const gone = await mkLeague('d1', { coAdmins: 1, billing: NO_SUB(20, -395 * DAY) });
    const saved = await mkLeague('d2', { billing: NO_SUB(20, -395 * DAY) });
    const paused = await mkLeague('d3', { billing: { ...NO_SUB(20, -430 * DAY), ...LIVE('d3'), status: 'paused', stripe_status: 'active', paused_at: iso(-420 * DAY) } });
    const noCard = await mkLeague('d4', { billing: { ...NO_SUB(20, -395 * DAY), ...LIVE('d4'), status: 'paused', stripe_status: 'paused' } });
    objects['/subscriptions/sub_d4'] = sub('sub_d4', noCard, { status: 'paused', customer: 'cus_d4' });
    objects['/customers/cus_d4'] = { id: 'cus_d4', invoice_settings: { default_payment_method: null } };
    queued = []; calls = [];
    await run();
    const deletionMails = id => mailsFor(id).filter(m => /suppression prévue/.test(m.mail.subject));
    expect(deletionMails(gone).map(m => m.to).sort()).toEqual(['u-d1-co1@example.com', 'u-d1@example.com']);
    expect(deletionMails(gone)[0].mail.subject).toBe(`Ligue d1 : suppression prévue le ${noticeDate(iso(30 * DAY), 'fr')}`);
    expect(deletionMails(gone)[0].mail.text).toContain(`depuis le ${noticeDate(iso(-395 * DAY), 'fr')}`);
    expect(deletionMails(paused)).toHaveLength(0);
    expect((await row(paused)).inactive_since).toBe(null);
    await run(DAY);
    expect(deletionMails(gone)).toHaveLength(2);
    // Saved: the owner subscribes (Stripe's state written as active).
    await env.DB.prepare(`UPDATE league_billing SET stripe_subscription_id = 'sub_d2', stripe_customer_id = 'cus_d2', status = 'active', stripe_status = 'active', inactive_since = NULL, read_only_since = NULL WHERE league_id = ?`).bind(saved).run();
    await run(23 * DAY);
    expect(deletionMails(gone)).toHaveLength(4);
    expect(deletionMails(gone)[2].mail.subject).toBe(`Ligue d1 : suppression prévue le ${noticeDate(iso(30 * DAY), 'fr')}`);
    expect(deletionMails(saved)).toHaveLength(1);
    await run(29 * DAY);
    expect(await env.DB.prepare('SELECT id FROM leagues WHERE id = ?').bind(gone).first()).not.toBe(null);
    await run(30 * DAY + 60000);
    expect(await env.DB.prepare('SELECT id FROM leagues WHERE id = ?').bind(gone).first()).toBe(null);
    expect(await row(gone)).toBe(null);
    expect(await notices(gone)).toEqual([]);
    const log = await env.DB.prepare('SELECT deleted_via, deleted_by_user_id FROM league_hard_delete_log WHERE league_id = ?').bind(gone).first();
    expect(log).toEqual({ deleted_via: 'billing_inactive_12_months', deleted_by_user_id: null });
    // The one Stripe kept paused for want of a card: cancelled, then deleted.
    expect(calls.filter(c => c.method === 'DELETE').map(c => c.path)).toEqual(['/subscriptions/sub_d4']);
    expect(await env.DB.prepare('SELECT id FROM leagues WHERE id = ?').bind(noCard).first()).toBe(null);
    // Saved and paused are still there.
    expect(await env.DB.prepare('SELECT id FROM leagues WHERE id = ?').bind(saved).first()).not.toBe(null);
    expect(await env.DB.prepare('SELECT id FROM leagues WHERE id = ?').bind(paused).first()).not.toBe(null);
    await run(400 * DAY);
    expect(await env.DB.prepare('SELECT id FROM leagues WHERE id = ?').bind(paused).first()).not.toBe(null);
  });
});

describe('the cron, and billing off', () => {
  it('the real cron entry point queues the notice in the outbox, once', async () => {
    const id = await mkLeague('dz-cron', { billing: NO_SUB(20, -3600000) });
    // The cron refreshes the count first: 20 regular players.
    for (let i = 0; i < 20; i++) await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, token_salt, league_id, is_active) VALUES (?, ?, ?, 'roster', 0, 's', ?, 1)`).bind(`${id}:r${i}`, `R${i}`, `r${i}.cron.p218@example.com`, id).run();
    const pass = async () => { const ctx = createExecutionContext(); await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, env, ctx); await waitOnExecutionContext(ctx); };
    await pass(); await pass();
    const rows = (await env.DB.prepare(`SELECT kind, league_id FROM outbox WHERE league_id = ?`).bind(id).all()).results;
    expect(rows).toEqual([{ kind: 'billing_notice', league_id: id }]);
  });

  it('billing off: nothing read, nothing written, nothing sent', async () => {
    delete env.BILLING_LAUNCH_AT;
    try {
      const id = await mkLeague('dz-off', { billing: NO_SUB(20, -400 * DAY) });
      const before = await row(id);
      queued = [];
      expect(await runBillingEnforcement(env, host, at(0))).toEqual({ checked: 0, notices: 0, deleted: 0 });
      expect(await row(id)).toEqual(before);
      expect(queued).toEqual([]);
      const ctx = createExecutionContext(); await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, env, ctx); await waitOnExecutionContext(ctx);
      expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE league_id = ?`).bind(id).first()).n).toBe(0);
      expect(await notices(id)).toEqual([]);
      expect(await env.DB.prepare(`SELECT 1 FROM league_billing WHERE league_id = 'smbhl'`).first()).toBe(null);
    } finally { env.BILLING_LAUNCH_AT = VARS.BILLING_LAUNCH_AT; }
  });

  it('who gets what: payment and card notices the owner, the rest every admin', () => {
    expect([...OWNER_NOTICES].sort()).toEqual(['grace_start', 'over_100', 'payment_failed', 'tier_change', 'trial_7d', 'trial_day']);
  });
});

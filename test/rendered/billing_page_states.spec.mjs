// Billing stage 1, item 1b: each message on the billing page shows only in
// its own state, in real Chromium. The cause of the bug: the browser's own
// [hidden] rule is weaker than any class that sets display (.nl-error and
// .nl-btn in the design system bundle, .bl-confirm on the page), so the
// error, the pause confirmation and a Pause button hidden by script all
// showed. HIDDEN_ATTR_CSS (src/design_system.js) makes hidden always hide.
//
// The league_billing row is written straight into the harness's local D1
// for each state; the page reads it and makes no Stripe call (no session_id,
// no Stripe key). The one failing action is answered by Playwright, never
// by the worker.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, launchChromium } from './support/public_page_harness.mjs';
import { formatPageDate } from '../../src/date_format.js';

let h, browser, owner, leagueId;
const ADMIN_KEY = 'billing-states-admin-key';
const DAY = 86400000;
const iso = ms => new Date(Date.now() + ms).toISOString();

beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { BILLING_LAUNCH_AT: '2026-10-01T00:00:00Z', ADMIN_KEY } });
  browser = await launchChromium();
  owner = await h.signup('rendered.billing.owner@example.com');
  leagueId = (await (await h.api('/leagues/create', { ...owner, body: { name: 'Billing States', teamNames: ['A', 'B'], tracksStats: false } })).json()).league.id;
  // 20 regular players: the Standard tier.
  for (let i = 0; i < 20; i++) {
    await h.db.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, token_salt, league_id, is_active) VALUES (?, ?, ?, 'roster', 0, 's', ?, 1)`)
      .bind(`${leagueId}:r${i}`, `R ${i}`, `r${i}.billing@example.com`, leagueId).run();
  }
}, 180000);
afterAll(async () => {
  await browser?.close();
  await h?.dispose();
});

// The row for each state. Past the trial unless the state says otherwise.
const LIVE = { stripe_customer_id: 'cus_rendered', stripe_subscription_id: 'sub_rendered', tier: 'standard', billing_interval: 'month', cancel_at_period_end: 0 };
const PAST_TRIAL = { trial_started_at: iso(-40 * DAY), trial_ends_at: iso(-10 * DAY) };
const IN_TRIAL = { trial_started_at: iso(-5 * DAY), trial_ends_at: iso(20 * DAY) };
const STATES = {
  none: { status: 'trial', stripe_status: null, stripe_customer_id: null, stripe_subscription_id: null, tier: 'free', billing_interval: null, cancel_at_period_end: 0, current_period_end: null, trial_started_at: null, trial_ends_at: null },
  active: { ...LIVE, ...PAST_TRIAL, status: 'active', stripe_status: 'active', current_period_end: iso(20 * DAY) },
  trialing: { ...LIVE, ...IN_TRIAL, status: 'active', stripe_status: 'trialing', current_period_end: iso(20 * DAY) },
  paused: { ...LIVE, ...PAST_TRIAL, status: 'paused', stripe_status: 'active', current_period_end: iso(20 * DAY) },
  pausedInTrial: { ...LIVE, ...IN_TRIAL, status: 'paused', stripe_status: 'trialing', current_period_end: iso(20 * DAY) },
  ending: { ...LIVE, ...PAST_TRIAL, status: 'active', stripe_status: 'active', cancel_at_period_end: 1, current_period_end: iso(12 * DAY) },
  pastDue: { ...LIVE, ...PAST_TRIAL, status: 'past_due', stripe_status: 'past_due', current_period_end: iso(-2 * DAY) },
  // Billing batch 3, decision 3: Stripe paused it at the trial's end, for
  // want of a card (Stripe's own status 'paused').
  stripePaused: { ...LIVE, ...PAST_TRIAL, status: 'paused', stripe_status: 'paused', current_period_end: iso(-10 * DAY) },
  // Billing batch 3: the trial ended without a subscription (read-only).
  readOnly: { status: 'trial', stripe_status: null, stripe_customer_id: null, stripe_subscription_id: null, tier: 'free', billing_interval: null, cancel_at_period_end: 0, current_period_end: null, ...PAST_TRIAL }
};
async function setState(name) {
  const s = STATES[name];
  const cols = Object.keys(s);
  // The page creates the row (the count) on its first load; make sure it is there.
  await h.db.prepare(`INSERT INTO league_billing (league_id, updated_at) VALUES (?, ?) ON CONFLICT(league_id) DO NOTHING`).bind(leagueId, new Date().toISOString()).run();
  await h.db.prepare(`UPDATE league_billing SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE league_id = ?`).bind(...cols.map(c => s[c]), leagueId).run();
}

// Every message the page can show: data-i18n keys, and the lines with a
// date, found by the start of their French text.
const KEYS = ['success', 'canceled', 'error', 'pause', 'pauseConfirm', 'pauseYes', 'cancelBtn', 'resume', 'resumeNote', 'paused', 'pastDue', 'subscribe', 'trialOver', 'manage', 'ownerOnly', 'addCard', 'trialEndedCard', 'readOnlyNote', 'secondLeague', 'emailsStopped'];
const DATED = { firstPayment: 'Premier paiement', nextPayment: 'Prochain paiement', ends: 'Ton abonnement prend fin', trialContinues: 'Ton essai continue' };
const ALL = [...KEYS, ...Object.keys(DATED)];

function visibleMessages({ keys, dated }) {
  const seen = el => el.checkVisibility();
  const out = [];
  for (const k of keys) if ([...document.querySelectorAll(`#bl-main [data-i18n="${k}"]`)].some(seen)) out.push(k);
  for (const [k, start] of Object.entries(dated)) if ([...document.querySelectorAll('#bl-main [data-date-fr]')].some(el => el.getAttribute('data-date-fr').startsWith(start) && seen(el))) out.push(k);
  return out.sort();
}

async function openPage(query = '', extraCookies = []) {
  const context = await browser.newContext({ locale: 'fr-CA', viewport: { width: 390, height: 900 } });
  await context.addCookies(owner.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
  if (extraCookies.length) await context.addCookies(extraCookies);
  const page = await context.newPage();
  const res = await page.goto(h.baseUrl + '/league/billing' + query);
  expect(res.status()).toBe(200);
  await page.waitForSelector('#bl-main');
  return { page, context, shown: () => page.evaluate(visibleMessages, { keys: KEYS, dated: DATED }) };
}

const EXPECTED = {
  none: ['subscribe'],
  active: ['manage', 'nextPayment', 'pause'],
  trialing: ['firstPayment', 'manage', 'pause'],
  paused: ['manage', 'paused', 'resume', 'resumeNote'],
  pausedInTrial: ['manage', 'paused', 'resume', 'trialContinues'],
  ending: ['ends', 'manage'],
  pastDue: ['manage', 'pastDue'],
  stripePaused: ['addCard', 'trialEndedCard'],
  readOnly: ['readOnlyNote', 'subscribe', 'trialOver']
};

describe('the billing page shows only the messages of its state', () => {
  for (const [state, expected] of Object.entries(EXPECTED)) {
    it(state, async () => {
      await setState(state);
      const { context, shown } = await openPage();
      try {
        expect(await shown()).toEqual([...expected].sort());
        expect(ALL).toEqual(expect.arrayContaining(expected));
      } finally {
        await context.close();
      }
    }, 60000);
  }

  it('paused in the trial: the first payment at the trial end, in words, FR and EN; never "Billing restarts today."', async () => {
    await setState('pausedInTrial');
    // The page shows the Montreal day: taking the UTC date failed every
    // evening from 20:00 Montreal, when the two differ.
    const end = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date(STATES.pausedInTrial.trial_ends_at));
    const { page, context } = await openPage();
    try {
      const fr = 'Ton essai continue : premier paiement le ' + formatPageDate(end, 'fr', 'long') + '.';
      const en = 'Your trial continues: first payment on ' + formatPageDate(end, 'en', 'long') + '.';
      const line = page.locator('#bl-main [data-date-fr^="Ton essai continue"]');
      expect(await line.textContent()).toBe(fr);
      expect(await line.getAttribute('data-date-en')).toBe(en);
      expect(fr).not.toMatch(/[0-9]{4}-[0-9]{2}/);
      const text = await page.innerText('#bl-main');
      expect(text).not.toContain('La facturation reprend');
      expect(text).not.toContain('Billing restarts today');
    } finally {
      await context.close();
    }
  }, 60000);

  it('back from Checkout: the thanks, without the error; a cancelled Checkout: its own line only', async () => {
    await setState('active');
    let p = await openPage('?status=success');
    try { expect(await p.shown()).toEqual(['manage', 'nextPayment', 'pause', 'success']); } finally { await p.context.close(); }
    await setState('none');
    p = await openPage('?status=cancel');
    try { expect(await p.shown()).toEqual(['canceled', 'subscribe']); } finally { await p.context.close(); }
  }, 60000);

  it('Pause opens the confirmation and hides itself; Cancel closes it', async () => {
    await setState('active');
    const { page, context, shown } = await openPage();
    try {
      await page.click('#bl-pause-ask');
      expect(await shown()).toEqual(['cancelBtn', 'manage', 'nextPayment', 'pauseConfirm', 'pauseYes']);
      await page.click('#bl-pause-no');
      expect(await shown()).toEqual(['manage', 'nextPayment', 'pause']);
    } finally {
      await context.close();
    }
  }, 60000);

  it('Stripe paused it for want of a card: « Ajouter une carte » asks for the portal, never Resume', async () => {
    await setState('stripePaused');
    const { page, context } = await openPage();
    try {
      expect(await page.locator('#bl-main [data-i18n="trialEndedCard"]').textContent()).toBe('Ton essai est terminé. Ajoute une carte pour réactiver ton abonnement.');
      const btn = page.locator('#bl-main [data-i18n="addCard"]');
      expect(await btn.textContent()).toBe('Ajouter une carte');
      expect(await btn.getAttribute('data-billing')).toBe('portal');
      expect(await page.locator('#bl-main [data-billing="resume"]').count()).toBe(0);
      let asked = null;
      await page.route('**/league/billing/portal', route => { asked = route.request().method(); return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ ok: false, errorKey: 'BILLING_STRIPE_ERROR' }) }); });
      await btn.click();
      await page.waitForFunction(() => document.getElementById('bl-err').checkVisibility());
      expect(asked).toBe('POST');
    } finally {
      await context.close();
    }
  }, 60000);

  // Item D (2026-10-02): in support mode every action shows disabled, like
  // every other change there (the server refuses them anyway).
  it('support mode: Subscribe, Manage, Pause, Resume and Add a card show disabled', async () => {
    const res = await fetch(h.baseUrl + '/super-admin/support/start', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin': ADMIN_KEY }, body: JSON.stringify({ leagueId }) });
    expect(res.status).toBe(200);
    const set = (res.headers.get('set-cookie') || '').split(';')[0];
    const i = set.indexOf('=');
    expect(set.slice(0, i)).toBe('nl_support');
    const support = [{ name: 'nl_support', value: set.slice(i + 1), url: h.baseUrl + '/' }];
    const buttons = page => page.evaluate(() => [...document.querySelectorAll('#bl-main [data-billing], #bl-main #bl-pause-ask')]
      .map(b => [b.getAttribute('data-billing') || b.id, b.disabled]));
    const cases = {
      none: [['checkout', true]],
      active: [['portal', true], ['bl-pause-ask', true], ['pause', true]],
      paused: [['portal', true], ['resume', true]],
      stripePaused: [['portal', true]]
    };
    try {
      for (const [state, want] of Object.entries(cases)) {
        await setState(state);
        const { page, context } = await openPage('', support);
        try {
          expect(await page.locator('#nl-support-banner').count()).toBe(1);
          expect(await buttons(page)).toEqual(want);
          if (state === 'none') expect(await page.locator('#bl-main fieldset.bl-choice').evaluate(f => f.disabled)).toBe(true);
          if (state === 'stripePaused') expect(await page.locator('#bl-main [data-i18n="addCard"]').isDisabled()).toBe(true);
        } finally {
          await context.close();
        }
      }
      // Outside support mode, the same page: every action enabled.
      await setState('active');
      const { page, context } = await openPage();
      try { expect(await buttons(page)).toEqual([['portal', false], ['bl-pause-ask', false], ['pause', false]]); }
      finally { await context.close(); }
    } finally {
      await fetch(h.baseUrl + '/super-admin/support/exit', { method: 'POST', headers: { cookie: set }, redirect: 'manual' });
    }
  }, 120000);

  it('a failed resume shows the error, once it has failed', async () => {
    await setState('paused');
    const { page, context, shown } = await openPage();
    try {
      await page.route('**/league/billing/resume', route => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ ok: false, errorKey: 'BILLING_STRIPE_ERROR' }) }));
      expect(await shown()).toEqual(['manage', 'paused', 'resume', 'resumeNote']);
      await page.click('[data-billing="resume"]');
      await page.waitForFunction(() => document.getElementById('bl-err').checkVisibility());
      expect(await shown()).toEqual(['error', 'manage', 'paused', 'resume', 'resumeNote']);
    } finally {
      await context.close();
    }
  }, 60000);
});

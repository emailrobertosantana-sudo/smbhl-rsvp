// Onboarding batch (2026-10-02), in a real Chromium: the finance step (yes,
// no, skip, a bad Interac email or number), and the two scenarios that
// were blocked -- an owner creating a second league (and getting back to
// the first), and a co-admin's invitation (it showed SMBHL's look).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, launchChromium } from './support/public_page_harness.mjs';
import { hmac } from '../../src/crypto_utils.js';

let h, browser;
beforeAll(async () => { h = await startPublicPageWorker({ extraVars: { BILLING_LAUNCH_AT: '2026-10-02' } }); browser = await launchChromium(); }, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

let ip = 0;
async function open(cookie) {
  const context = await browser.newContext({ locale: 'fr-CA', extraHTTPHeaders: { 'cf-connecting-ip': `192.0.2.${++ip}` } });
  if (cookie) await context.addCookies(cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
  return { context, page, errors };
}
// A fixed-teams league with its season: the finance step is step 6.
async function leagueAtFinance(email) {
  const s = await h.signup(email);
  const league = (await (await h.api('/leagues/create', { ...s, body: { name: `Ligue ${email}`, teamNames: ['A', 'B'] } })).json()).league;
  await h.api('/league/season/publish', { ...s, body: { season_name: 'Automne 2026' } });
  return { s, league };
}
const pricingRow = id => h.db.prepare('SELECT * FROM season_pricing WHERE league_id = ?').bind(id).first();
const setting = key => h.db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();

describe('the finance step', () => {
  it('yes: the season fees and the Interac details are saved, then the summary', async () => {
    const { s, league } = await leagueAtFinance('fin.yes@example.com');
    const { context, page, errors } = await open(s.cookie);
    await page.goto(h.baseUrl + '/onboarding/season?step=6');
    // Item 5: "Oui" is chosen from the start; "Non, pas pour l'instant" hides the parts.
    expect(await page.isChecked('#ob_finance_yes')).toBe(true);
    expect(await page.isVisible('#ob_finance_detail')).toBe(true);
    await page.check('#ob_finance_no');
    expect(await page.isVisible('#ob_finance_detail')).toBe(false);
    await page.check('#ob_finance_yes');
    expect(await page.isVisible('#ob_finance_detail')).toBe(true);
    // The main expenses: the gym rental, and one more row added.
    await page.selectOption('#ob_costs .ob-cost:nth-child(1) .ob-cost-cat', 'rental');
    await page.fill('#ob_costs .ob-cost:nth-child(1) .ob-cost-amount', '1800');
    await page.click('#ob_cost_add');
    expect(await page.textContent('#ob_costs .ob-cost:nth-child(2) .nl-label')).toBe('Catégorie');
    await page.selectOption('#ob_costs .ob-cost:nth-child(2) .ob-cost-cat', 'equipment');
    await page.fill('#ob_costs .ob-cost:nth-child(2) .ob-cost-desc', 'Balles et filets');
    await page.fill('#ob_costs .ob-cost:nth-child(2) .ob-cost-amount', '150');
    await page.fill('#ob_price_player', '120');
    await page.fill('#ob_price_goalie', '60');
    await page.fill('#ob_game_player', '15');
    await page.fill('#ob_pay_email', 'paiements@example.com');
    await page.fill('#ob_pay_phone', '514 555 1234');
    await Promise.all([page.waitForURL(/step=summary/), page.click('#ob_submit')]);
    const p = await pricingRow(league.id);
    expect(p.pricing_mode).toBe('season');
    expect([Number(p.price_player), Number(p.price_goalie), Number(p.price_sub_player), Number(p.price_sub_goalie)]).toEqual([120, 60, 15, 0]);
    const pay = await setting(`payment_info:${league.id}`);
    expect(pay.value).toContain('paiements@example.com');
    expect(pay.value).toContain('5145551234');
    const costs = (await h.db.prepare('SELECT category, description, amount FROM season_costs WHERE league_id = ? ORDER BY amount DESC').bind(league.id).all()).results;
    expect(costs.map(c => [c.category, c.description, Number(c.amount)])).toEqual([['rental', 'Location de glace ou de terrain', 1800], ['equipment', 'Balles et filets', 150]]);
    expect(errors).toEqual([]);
    await context.close();
  }, 60000);

  it('per game for everyone: the season fee fields are hidden and not saved', async () => {
    const { s, league } = await leagueAtFinance('fin.pergame@example.com');
    const { context, page } = await open(s.cookie);
    await page.goto(h.baseUrl + '/onboarding/season?step=6');
    await page.check('#ob_finance_yes');
    await page.check('input[name="ob_fin_mode"][value="per_game"]');
    expect(await page.isVisible('#ob_price_player')).toBe(false);
    await page.fill('#ob_game_player', '12');
    await Promise.all([page.waitForURL(/step=summary/), page.click('#ob_submit')]);
    const p = await pricingRow(league.id);
    expect(p.pricing_mode).toBe('per_game');
    expect(Number(p.price_player)).toBe(0);
    expect(Number(p.price_sub_player)).toBe(12);
    await context.close();
  }, 60000);

  it('no: nothing is saved, the step counts as answered', async () => {
    const { s, league } = await leagueAtFinance('fin.no@example.com');
    const { context, page } = await open(s.cookie);
    await page.goto(h.baseUrl + '/onboarding/season?step=6');
    await page.fill('#ob_costs .ob-cost-amount', '500');
    await page.check('#ob_finance_no');
    await Promise.all([page.waitForURL(/step=summary/), page.click('#ob_submit')]);
    expect(await pricingRow(league.id)).toBeNull();
    expect((await h.db.prepare('SELECT COUNT(*) AS c FROM season_costs WHERE league_id = ?').bind(league.id).first()).c).toBe(0);
    expect(await setting(`payment_info:${league.id}`)).toBeNull();
    expect(JSON.parse((await setting(`onboarding_done:${league.id}`)).value)).toContain('finance');
    await context.close();
  }, 60000);

  it('skip: nothing is saved, remembered as skipped, and it never nags on the dashboard', async () => {
    const { s, league } = await leagueAtFinance('fin.skip@example.com');
    const { context, page } = await open(s.cookie);
    await page.goto(h.baseUrl + '/onboarding/season?step=6');
    await page.check('#ob_finance_yes');
    await page.fill('#ob_price_player', '99');
    await Promise.all([page.waitForURL(/step=summary/), page.click('#ob_skip')]);
    expect(await pricingRow(league.id)).toBeNull();
    expect(JSON.parse((await setting(`onboarding_skipped:${league.id}`)).value)).toContain('finance');
    await page.goto(h.baseUrl + '/dashboard');
    expect(await page.content()).not.toContain('step=6');
    await context.close();
  }, 60000);

  it('a bad Interac email or number: the message, nothing saved, still on the step', async () => {
    const { s, league } = await leagueAtFinance('fin.bad@example.com');
    const { context, page } = await open(s.cookie);
    await page.goto(h.baseUrl + '/onboarding/season?step=6');
    await page.check('#ob_finance_yes');
    await page.fill('#ob_price_player', '120');
    await page.fill('#ob_pay_email', 'pas-un-courriel');
    await page.click('#ob_submit');
    await page.waitForSelector('#formErr', { state: 'visible' });
    expect(await page.textContent('#formErr')).toBe('Entre une adresse courriel valide.');
    expect(page.url()).toContain('step=6');
    await page.fill('#ob_pay_email', '');
    await page.fill('#ob_pay_phone', '123');
    await page.click('#ob_submit');
    await page.waitForFunction(() => document.getElementById('formErr').textContent.includes('10 chiffres'));
    expect(await page.textContent('#formErr')).toBe('Entre un numéro à 10 chiffres, par exemple 514-555-1234.');
    expect(await pricingRow(league.id)).toBeNull();
    expect(await setting(`payment_info:${league.id}`)).toBeNull();
    await context.close();
  }, 60000);
});

describe('S5: an owner creating a second league under 15 when the free slot is taken', () => {
  it('from the dashboard to the summary, then back to the first league', async () => {
    const s = await h.signup('s5.owner@example.com');
    const first = (await (await h.api('/leagues/create', { ...s, body: { name: 'Première ligue', teamNames: ['A', 'B'] } })).json()).league;
    await h.api('/league/season/publish', { ...s, body: { season_name: 'Automne 2026' } });
    await h.api('/league/contacts', { ...s, body: { name: 'Seul Joueur', role: 'roster' } });
    const { context, page, errors } = await open(s.cookie);
    await page.goto(h.baseUrl + '/dashboard');
    await Promise.all([page.waitForURL(/signup\?step=2/), page.click('#dash_new_league')]);
    await page.fill('#su_league_name', 'Deuxième ligue');
    await page.click('label[data-label="drop_in"]');
    await Promise.all([page.waitForURL(/step=done/), page.click('#su_submit')]);
    await Promise.all([page.waitForURL(/onboarding\/season/), page.click('[data-i18n="startMySeason"]')]);
    expect(await page.textContent('.overline')).toBe('Étape 3 sur 7');
    await page.fill('#ob_season_name', 'Automne 2026');
    await Promise.all([page.waitForURL(/step=1/), page.click('#ob_submit')]);
    for (let i = 0; i < 4; i++) { const u = page.url(); await Promise.all([page.waitForURL(x => x.toString() !== u), page.click('#ob_submit')]); }
    expect(page.url()).toContain('step=summary');
    const summary = await page.textContent('#ob_summary');
    expect(summary).toContain('Cette ligue demande un forfait.');
    expect(summary).toContain('Sans équipes : une seule liste de joueurs.');
    await Promise.all([page.waitForURL(/dashboard/), page.click('#ob_finish')]);
    expect(await page.textContent('h1')).toBe('Deuxième ligue');
    await Promise.all([page.waitForURL(/league_id=/), page.selectOption('#dash_league', first.id)]);
    expect(await page.textContent('h1')).toBe('Première ligue');
    expect(errors).toEqual([]);
    await context.close();
  }, 120000);
});

describe('S6: a co-admin who accepts an invitation', () => {
  it('in Notre Ligue\'s look, then the dashboard, never counted into the creator\'s steps', async () => {
    const s = await h.signup('s6.owner@example.com');
    const league = (await (await h.api('/leagues/create', { ...s, body: { name: 'Ligue des copains', teamNames: ['A', 'B'] } })).json()).league;
    await h.api('/league/season/publish', { ...s, body: { season_name: 'Automne 2026' } });
    const email = 's6.coadmin@example.com';
    const exp = Date.now() + 3600 * 1000;
    const enc = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const token = `${league.id}.${enc}.${exp}.${await hmac('rendered-public-page-secret', `invite:${league.id}:${email}:${exp}`)}`;
    const { context, page, errors } = await open(null);
    await page.goto(h.baseUrl + '/league/admins/accept?token=' + encodeURIComponent(token));
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toContain('SMBHL');
    expect(text).toContain('Rejoindre Ligue des copains');
    expect(await page.textContent('.nl-brand')).toContain('Notre Ligue');
    await page.fill('#accept_password', 'a-strong-password-2');
    await page.check('#accept_terms');
    await Promise.all([page.waitForURL(/dashboard/), page.click('#accept_submit')]);
    expect(await page.textContent('h1')).toBe('Ligue des copains');
    await page.goto(h.baseUrl + '/onboarding/season?step=1');
    expect(await page.$('.su-prog')).toBeNull();
    expect(errors).toEqual([]);
    await context.close();
  }, 120000);
});

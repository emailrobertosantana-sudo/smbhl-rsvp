// Stage 2 (items 2a, 2b, 2d, 2e), in a real Chromium on the Notre Ligue
// product: the super-admin's league list and league page carry Notre Ligue
// branding and nothing of SMBHL, render without a script error in French
// and English, filter and search; "View as admin" opens the league's admin
// pages with the support banner, and leaving comes back to the league page,
// where the visit is in the access log.
//
// Nothing here can send an email: the harness never sets RESEND_API_KEY,
// and every request that leaves the local worker is aborted.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, seedPopulatedLeague, seedBareLeague, launchChromium } from './support/public_page_harness.mjs';

const ADMIN_KEY = 'super-admin-nl-key';
let h, browser, populated, bare;

beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { ADMIN_KEY } });
  populated = await seedPopulatedLeague(h, { email: 'owner@sa-nl.example', name: 'Les Castors', teamNames: ['Loutres', 'Ours'], playerName: 'Lea Player', goalieName: 'Luc Goalie' });
  bare = await seedBareLeague(h, { email: 'bare@sa-nl.example', name: 'Ligue Aurore' });
  browser = await launchChromium();
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

async function open(path, { lang = 'fr' } = {}) {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'admin_key', value: ADMIN_KEY, url: h.baseUrl + '/' }]);
  await context.addInitScript(l => { try { localStorage.setItem('smbhl_admin_lang', l); } catch (e) {} }, lang);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss());
  await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
  await page.goto(h.baseUrl + path, { waitUntil: 'load' });
  return { context, page, errors };
}

describe('the super-admin on Notre Ligue', () => {
  it('the list: Notre Ligue branding, no SMBHL, one row per league, filter and search, FR and EN', async () => {
    const { context, page, errors } = await open('/super-admin/leagues');
    await page.waitForSelector('tr.sa-row');
    expect(await page.title()).toBe('Super-admin | Notre Ligue');
    expect(await page.textContent('.nl-brand')).toBe('Notre Ligue');
    const html = await page.content();
    expect(html.match(/.{0,80}(SMBHL|smbhl-horizontal|Barlow).{0,40}/g)).toBeNull();
    const names = await page.$$eval('tr.sa-row td:nth-child(2)', tds => tds.map(td => td.textContent));
    expect(names.sort()).toEqual(['Les Castors', 'Ligue Aurore']);
    expect(await page.$$eval('#sa-table th', ths => ths.map(t => t.textContent))).toEqual(['État', 'Ligue', 'Propriétaire', 'Inscription', 'Joueurs réguliers (palier)', 'Essai ou abonnement', 'Dernière connexion admin', 'Réponses (14 jours)', 'Prochain match']);
    // Search, then a filter no league matches.
    await page.fill('#sa-q', 'aurore');
    await page.waitForFunction(() => document.querySelectorAll('tr.sa-row').length === 1);
    expect(await page.textContent('tr.sa-row td:nth-child(2)')).toBe('Ligue Aurore');
    await page.selectOption('#sa-status', 'green');
    await page.waitForFunction(() => document.querySelectorAll('tr.sa-row').length === 0);
    expect(await page.isVisible('#sa-empty')).toBe(true);
    // English.
    await page.click('#btn-lang-en');
    expect(await page.textContent('h1')).toBe('Leagues');
    expect(await page.textContent('#sa-empty')).toBe('No league matches.');
    expect(errors).toEqual([]);
    await context.close();
  }, 120000);

  it('the league page, then "View as admin": the banner, read-only, and back', async () => {
    const id = populated.league.id;
    const { context, page, errors } = await open(`/super-admin/league?id=${encodeURIComponent(id)}`);
    await page.waitForSelector('#sa-signals tr');
    expect(await page.title()).toBe('Les Castors | Notre Ligue');
    expect(await page.$$eval('#sa-signals tr', trs => trs.length)).toBe(8);
    expect(await page.$$eval('#sa-timeline li', lis => lis.length)).toBe(6);
    expect(await page.textContent('#sa-timeline')).toContain('Inscription');
    expect(await page.textContent('#sa-log')).toContain('Aucun accès de soutien.');
    expect(await page.isVisible('#sa-free')).toBe(true);
    expect(await page.content()).not.toMatch(/SMBHL/);

    await page.click('#sa-view-as');
    await page.waitForURL(/\/dashboard/);
    await page.waitForSelector('#nl-support-banner');
    expect(await page.textContent('#nl-support-banner')).toContain('Mode soutien, lecture seule / Support mode, read-only · Les Castors');
    const box = await page.$eval('#nl-support-banner', el => { const r = el.getBoundingClientRect(); return { top: r.top, pos: getComputedStyle(el).position }; });
    expect(box).toEqual({ top: 0, pos: 'fixed' });
    // A write from the page's own context is refused by the server.
    const status = await page.evaluate(() => fetch('/league/contacts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"X"}' }).then(r => r.status));
    expect(status).toBe(403);

    await page.click('#nl-support-banner button[type="submit"]');
    await page.waitForURL(/\/super-admin\/league\?id=/);
    await page.waitForSelector('#sa-log table');
    expect(await page.$$eval('#sa-log tbody tr', trs => trs.length)).toBe(1);
    expect(await page.textContent('#sa-log tbody tr')).toContain('Super-admin');
    // Out of support mode: the dashboard has no banner (and no session).
    await page.goto(h.baseUrl + '/dashboard', { waitUntil: 'load' });
    expect(await page.$('#nl-support-banner')).toBeNull();
    expect(errors).toEqual([]);
    await context.close();
  }, 120000);

  it('the league page in English', async () => {
    const { context, page, errors } = await open(`/super-admin/league?id=${encodeURIComponent(bare.league.id)}`, { lang: 'en' });
    await page.waitForSelector('#sa-signals tr');
    expect(await page.textContent('#sa-view-as')).toBe('View as admin');
    expect(await page.textContent('#sa-signals')).toContain('An admin signed in within the last 7 days.');
    expect(errors).toEqual([]);
    await context.close();
  }, 120000);
});

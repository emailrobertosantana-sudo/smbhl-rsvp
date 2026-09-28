// SMBHL's player-facing pages (rsvp, team, sub availability, poll, their
// notices, the co-admin invitation) follow the FR/EN toggle: one language
// at a time, switched in place, and remembered on the next visit. They used
// to stack French over an English subtitle with a toggle that switched
// nothing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, launchChromium } from './support/public_page_harness.mjs';

let h, browser;
beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { RSVP_SECRET: 'rendered-player-lang' } });
  browser = await launchChromium();
}, 180000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

describe('Player-facing pages follow the language toggle', () => {
  it('a notice page: the toggle is visible, switches the text and title, and is remembered on reload', async () => {
    const ctx = await browser.newContext({ locale: 'fr-CA' });
    const page = await ctx.newPage();
    await page.goto(`${h.baseUrl}/rsvp`);
    const h1 = () => page.textContent('h1');
    expect((await h1()).trim()).toBe('Lien incomplet');
    expect(await page.isVisible('#btn-lang-en')).toBe(true);
    expect(await page.isVisible('#btn-lang-fr')).toBe(true);

    await page.click('#btn-lang-en');
    expect((await h1()).trim()).toBe('Incomplete link');
    expect(await page.title()).toMatch(/^Incomplete link — /);
    expect(await page.getAttribute('html', 'lang')).toBe('en-CA');

    // Remembered: a fresh load of another player page opens in English.
    await page.goto(`${h.baseUrl}/league/admins/accept?token=nope`);
    expect((await h1()).trim()).toBe('Invalid or expired invitation');
    expect((await page.textContent('p.state')).trim()).toBe('Ask the league admin to send you a new invitation.');
    expect(await page.title()).toMatch(/^Invalid invitation — /);

    await page.click('#btn-lang-fr');
    expect((await h1()).trim()).toBe('Invitation invalide ou expirée');
    await page.reload();
    expect((await h1()).trim()).toBe('Invitation invalide ou expirée');
    expect(await page.evaluate(() => localStorage.getItem('smbhl_admin_lang'))).toBe('fr');
    await ctx.close();
  });
});

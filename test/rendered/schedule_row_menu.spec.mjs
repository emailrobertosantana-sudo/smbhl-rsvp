// Onboarding review 3a, in a real Chromium at 390 and 1280 px: each game on
// the schedule has one main action and a « … » menu for the rest.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, launchChromium } from './support/public_page_harness.mjs';

let h, browser, s, gameNoMatchup, gameWithMatchup;
beforeAll(async () => {
  h = await startPublicPageWorker();
  browser = await launchChromium();
  s = await h.signup('menu.owner@example.com');
  await h.api('/leagues/create', { ...s, body: { name: 'Ligue du menu', teamNames: ['Rouges', 'Bleus'] } });
  await h.api('/league/season/publish', { ...s, body: { season_name: 'Automne 2026' } });
  gameNoMatchup = (await (await h.api('/league/events', { ...s, body: { date: '2099-03-03', start_time: '19:00', end_time: '20:00', venue: 'Aréna', season: 'Automne 2026' } })).json()).event.id;
  gameWithMatchup = (await (await h.api('/league/events', { ...s, body: { date: '2099-03-10', start_time: '19:00', end_time: '20:00', venue: 'Aréna', season: 'Automne 2026', home_team: 'Rouges', away_team: 'Bleus' } })).json()).event.id;
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

let ip = 0;
async function open(width) {
  const context = await browser.newContext({ locale: 'fr-CA', viewport: { width, height: 900 }, extraHTTPHeaders: { 'cf-connecting-ip': `192.0.2.${++ip}` } });
  await context.addCookies(s.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss());
  await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
  await page.goto(h.baseUrl + '/league/schedule');
  return { context, page, errors };
}
const sel = (prefix, id) => `[id="${prefix}${id}"]`;

describe('the « … » menu of each game', () => {
  for (const width of [390, 1280]) {
    it(`${width} px: one main action, the rest in a menu, by mouse and keyboard`, async () => {
      const { context, page, errors } = await open(width);
      // The main action: choose the matchup, or see the game.
      expect(await page.textContent(`.sc-game-row:has(${sel('more_', gameNoMatchup)}) .sc-main-act`)).toBe("Choisir l'affrontement");
      expect(await page.textContent(`.sc-game-row:has(${sel('more_', gameWithMatchup)}) .sc-main-act`)).toBe('Voir le match');
      // No other action button stands in the row.
      for (const k of ['duplicateBtn', 'cancelEventBtn', 'deleteEventBtn']) {
        expect(await page.isVisible(`.sc-game-row [data-i18n="${k}"]`)).toBe(false);
      }
      // Closed, then open by click: its items in order, « Supprimer » last.
      const more = sel('more_', gameWithMatchup);
      expect(await page.getAttribute(more, 'aria-expanded')).toBe('false');
      await page.click(more);
      expect(await page.getAttribute(more, 'aria-expanded')).toBe('true');
      const items = await page.$$eval(`${sel('menu_', gameWithMatchup)} [role="menuitem"]`, els => els.map(e => e.textContent));
      expect(items).toEqual(["Modifier l'affrontement", 'Dupliquer', 'Annuler le match', 'Supprimer']);
      expect(await page.evaluate(() => document.activeElement.getAttribute('data-act'))).toBe('matchup');
      // On screen at any width.
      const box = await page.$eval(sel('menu_', gameWithMatchup), m => { const r = m.getBoundingClientRect(); return { left: r.left, right: r.right }; });
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);
      // The arrows move, Escape closes it back on its button.
      await page.keyboard.press('ArrowDown');
      expect(await page.evaluate(() => document.activeElement.getAttribute('data-act'))).toBe('duplicate');
      await page.keyboard.press('End');
      expect(await page.evaluate(() => document.activeElement.getAttribute('data-act'))).toBe('delete');
      await page.keyboard.press('Escape');
      expect(await page.isVisible(sel('menu_', gameWithMatchup))).toBe(false);
      expect(await page.evaluate(() => document.activeElement.id)).toBe('more_' + gameWithMatchup);
      expect(await page.getAttribute(more, 'aria-expanded')).toBe('false');
      // From the keyboard: ArrowDown on the button opens it.
      await page.focus(more);
      await page.keyboard.press('ArrowDown');
      expect(await page.isVisible(sel('menu_', gameWithMatchup))).toBe(true);
      // « Supprimer » keeps its confirmation.
      await page.click(`${sel('menu_', gameWithMatchup)} [data-act="delete"]`);
      expect(await page.isVisible(sel('menu_', gameWithMatchup))).toBe(false);
      expect(await page.isVisible(`${sel('del_', gameWithMatchup)} [data-i18n="deleteConfirmBtn"]`)).toBe(true);
      // A click outside closes an open menu.
      await page.click(sel('more_', gameNoMatchup));
      expect(await page.isVisible(sel('menu_', gameNoMatchup))).toBe(true);
      await page.click('h1');
      expect(await page.isVisible(sel('menu_', gameNoMatchup))).toBe(false);
      expect(errors).toEqual([]);
      await context.close();
    }, 120000);
  }
});

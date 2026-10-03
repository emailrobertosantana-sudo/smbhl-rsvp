// Stage 2, item 2a: the league menu in the admin header, in Chromium. At 390
// and 1280 px, French and English: the menu opens inside the viewport, the
// page does not scroll sideways, and picking the other league makes it the
// current one on the next admin page.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, launchChromium } from './support/public_page_harness.mjs';

let h, browser, s;
beforeAll(async () => {
  h = await startPublicPageWorker();
  browser = await launchChromium();
  s = await h.signup('league.menu@example.com');
  const j = async (p, body) => (await h.api(p, { ...s, body })).json();
  await j('/leagues/create', { name: 'Ligue de hockey du dimanche matin de Saint-Maxime', teamNames: ['A', 'B'] });
  await j('/leagues/create', { name: 'Ligue Beta', teamStructure: 'headcount' });
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

describe('the league menu in the admin header', () => {
  for (const locale of ['fr-CA', 'en-CA']) for (const width of [390, 1280]) {
    it(`${locale}, ${width} px`, async () => {
      const context = await browser.newContext({ locale, viewport: { width, height: 800 } });
      await context.addCookies(s.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
      const page = await context.newPage();
      await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
      await page.goto(h.baseUrl + '/league/roster');
      await page.evaluate(() => document.fonts.ready);
      await page.click('#nl_league_menu > summary');
      const m = await page.evaluate(() => {
        const panel = document.querySelector('#nl_league_menu .nl-lm-panel').getBoundingClientRect();
        const lang = document.getElementById('btn-lang-fr').getBoundingClientRect();
        const summary = document.querySelector('#nl_league_menu > summary').getBoundingClientRect();
        return {
          left: panel.left, right: panel.right, vw: window.innerWidth,
          scrollW: document.documentElement.scrollWidth,
          summaryRight: summary.right, langLeft: lang.left,
          head: document.querySelector('.nl-lm-head').textContent,
          links: [...document.querySelectorAll('#nl_league_menu a')].map(a => a.textContent.trim())
        };
      });
      expect(m.left).toBeGreaterThanOrEqual(0);
      expect(m.right).toBeLessThanOrEqual(m.vw);
      expect(m.scrollW).toBeLessThanOrEqual(m.vw);
      expect(m.summaryRight).toBeLessThanOrEqual(m.langLeft);
      expect(m.head).toBe(locale === 'en-CA' ? 'Switch league' : 'Changer de ligue');
      expect(m.links).toEqual(['Ligue de hockey du dimanche matin de Saint-Maxime', 'Ligue Beta']);
      // Pick the league that is not current; the next admin page is its.
      const current = await page.textContent('#nl_league_menu .nl-lm-name');
      const other = current === 'Ligue Beta' ? 'Ligue de hockey du dimanche matin de Saint-Maxime' : 'Ligue Beta';
      await Promise.all([page.waitForNavigation(), page.click(`#nl_league_menu a:has-text("${other}")`)]);
      await page.goto(h.baseUrl + '/league/schedule');
      expect(await page.textContent('#nl_league_menu .nl-lm-name')).toBe(other);
      await context.close();
    }, 120000);
  }
});

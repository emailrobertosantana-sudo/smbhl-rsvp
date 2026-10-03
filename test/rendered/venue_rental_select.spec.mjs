// Stage 2, item 2c: the expense category dropdown fits a 390 px phone and
// still works, on the Finances page and in the onboarding's finance step,
// French and English. Its rental choice read « Location du lieu (glace,
// terrain ou gymnase) », cut off at that width; the dropdown now shows
// « Location du lieu » / "Venue rental", and the cost list and a cost saved
// with no description keep the full name.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, launchChromium } from './support/public_page_harness.mjs';

let h, browser, s;
beforeAll(async () => {
  h = await startPublicPageWorker();
  browser = await launchChromium();
  s = await h.signup('venue.rental@example.com');
  const j = async (p, body) => (await h.api(p, { ...s, body })).json();
  await j('/leagues/create', { name: 'Ligue des dépenses', teamStructure: 'headcount' });
  await j('/league/season/publish', { season_name: 'Automne 2099' });
  await j('/league/events', { date: '2099-10-11', season: 'Automne 2099', venue: 'Parc', start_time: '19:00', end_time: '20:30' });
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

// The select inside its card and the viewport, no sideways scroll, and the
// chosen option's text narrower than the select's text box (not cut off).
function measure(sel) {
  const el = document.querySelector(sel);
  const card = el.closest('.nl-card, .su-card, main');
  const r = el.getBoundingClientRect(), c = card.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = cs.font;
  const text = el.options[el.selectedIndex].text;
  const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 20;
  return { left: r.left, right: r.right, cardLeft: c.left, cardRight: c.right, vw: window.innerWidth, scrollW: document.documentElement.scrollWidth, text, textW: ctx.measureText(text).width, room };
}

const PAGES = [
  ['finances', '/league/finances', '#fin-cost-cat'],
  ['onboarding', '/onboarding/season?step=3', '.ob-cost-cat']
];

describe('the expense category dropdown at 390 px', () => {
  for (const locale of ['fr-CA', 'en-CA']) {
    it(locale, async () => {
      const context = await browser.newContext({ locale, viewport: { width: 390, height: 800 } });
      await context.addCookies(s.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
      const page = await context.newPage();
      await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
      for (const [name, path, sel] of PAGES) {
        await page.goto(h.baseUrl + path);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(q => { const el = document.querySelector(q); return el && el.options.length === 4; }, sel, { timeout: 10000 });
        await page.selectOption(sel, 'rental');
        const m = await page.evaluate(measure, sel);
        if (process.env.NL_SHOTS) await page.screenshot({ path: `${process.env.NL_SHOTS}/rental_${name}_${locale}.png`, fullPage: true });
        expect(m.left, name).toBeGreaterThanOrEqual(m.cardLeft);
        expect(m.right, name).toBeLessThanOrEqual(m.cardRight);
        expect(m.right, name).toBeLessThanOrEqual(m.vw);
        expect(m.scrollW, name).toBeLessThanOrEqual(m.vw);
        expect(m.text, name).toBe(locale === 'en-CA' ? 'Venue rental' : 'Location du lieu');
        expect(m.textW, name).toBeLessThanOrEqual(m.room);
      }
      // A rental saved from onboarding with no description keeps the full name.
      await page.fill('.ob-cost-amount', '1800');
      await Promise.all([page.waitForURL(/step=summary/), page.click('#ob_submit')]);
      const cost = await h.db.prepare("SELECT description FROM season_costs WHERE category = 'rental' ORDER BY rowid DESC LIMIT 1").first();
      expect(cost && cost.description).toBe(locale === 'en-CA' ? 'Venue rental (ice, field or gym)' : 'Location du lieu (glace, terrain ou gymnase)');
      await h.db.prepare('DELETE FROM season_costs').run();
      await context.close();
    }, 120000);
  }
});

// Stage 2, item 2c: the players import preview says how many will be
// imported and, for a fixed-teams league, how many of them without a team
// (« 3 seront importés, dont 2 sans équipe. »), singular for 1, and leaves
// the second part out when every player has a team. French and English.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, launchChromium } from './support/public_page_harness.mjs';

let h, browser, s;
beforeAll(async () => {
  h = await startPublicPageWorker();
  browser = await launchChromium();
  s = await h.signup('import.summary@example.com');
  const j = async (p, body) => (await h.api(p, { ...s, body })).json();
  await j('/leagues/create', { name: 'Ligue import', teamNames: ['Rouge', 'Bleu'] });
  await j('/league/season/publish', { season_name: 'Automne 2099' });
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

const CASES = [
  ['Ann One, a1@example.com, , Rouge\nBob Two, b2@example.com, , Vert\nCid Three, c3@example.com',
    '3 seront importés, dont 2 sans équipe.', '3 will be imported, 2 of them without a team.'],
  ['Ann One, a1@example.com, , Rouge\nBob Two, b2@example.com, , Bleu',
    '2 seront importés.', '2 will be imported.'],
  ['Ann One, a1@example.com, , Rouge', '1 sera importé.', '1 will be imported.'],
  ['Cid Three, c3@example.com', '1 sera importé, dont 1 sans équipe.', '1 will be imported, 1 of them without a team.'],
  ['Ann One, a1@example.com\nAnn One, a1@example.com\nBob Two, b2@example.com, , Bleu',
    '2 seront importés, dont 1 sans équipe.', '2 will be imported, 1 of them without a team.']
];

describe('the import preview summary', () => {
  for (const locale of ['fr-CA', 'en-CA']) {
    it(locale, async () => {
      const context = await browser.newContext({ locale });
      await context.addCookies(s.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
      await page.goto(h.baseUrl + '/league/roster');
      await page.click('#ro_toggle_bulk');
      for (const [text, fr, en] of CASES) {
        await page.fill('#ro_bulk_text', text);
        await page.click('[data-i18n="bulkPreviewBtn"]');
        expect(await page.textContent('#ro_bulk_summary')).toBe(locale === 'en-CA' ? en : fr);
      }
      expect(errors).toEqual([]);
      await context.close();
    }, 120000);
  }
});

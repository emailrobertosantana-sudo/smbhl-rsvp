// Item 6 (onboarding batch, 2026-10-02): in every list that shows a game's
// date, time and venue -- the admin's schedule, the dashboard's next game,
// the public page's upcoming games and results -- the venue is its own line
// under the time and never overlaps the date heading (« Centre sportif » ran
// over « dimanche 11 oct. » in the schedule). Measured in Chromium at 390
// and 1280 px, French and English, light and dark.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, launchChromium } from './support/public_page_harness.mjs';

let h, browser, s, slug;
beforeAll(async () => {
  h = await startPublicPageWorker();
  browser = await launchChromium();
  s = await h.signup('venue.layout@example.com');
  const j = async (p, body) => (await h.api(p, { ...s, body })).json();
  const league = (await j('/leagues/create', { name: 'Ligue des lieux', teamNames: ['Les Castors', 'Les Hiboux'] })).league;
  await j('/league/settings/identity', { tracksResults: true, publicPageEnabled: true });
  await j('/league/season/publish', { season_name: 'Automne 2099' });
  const venue = 'Centre sportif de la Polyvalente Saint-Maxime';
  for (const date of ['2099-10-11', '2099-11-01', '2099-12-31']) await j('/league/events', { date, season: 'Automne 2099', venue, start_time: '19:00', end_time: '20:30' });
  await j('/league/events', { date: '2020-01-05', season: 'Automne 2099', venue, start_time: '19:00', end_time: '20:30' });
  slug = (await h.db.prepare('SELECT slug FROM leagues WHERE id = ?').bind(league.id).first()).slug;
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

// Every row's date heading, time and venue boxes: the venue below both, no overlap.
function measure([rowSel, dateSel, timeSel, venueSel]) {
  const out = [];
  document.querySelectorAll(rowSel).forEach((row, i) => {
    const d = row.querySelector(dateSel), t = timeSel ? row.querySelector(timeSel) : null, v = row.querySelector(venueSel);
    if (!d || !v || !v.textContent.trim()) return;
    const rd = d.getBoundingClientRect(), rv = v.getBoundingClientRect(), rt = t ? t.getBoundingClientRect() : rd;
    const overlap = !(rv.right <= rd.left || rv.left >= rd.right || rv.bottom <= rd.top || rv.top >= rd.bottom);
    out.push({ i, overlap, below: rv.top >= Math.max(rd.bottom, rt.bottom) - 0.5, text: d.textContent + ' | ' + v.textContent });
  });
  return out;
}

const LISTS = [
  ['schedule', '/league/schedule', ['.sc-game', '.sc-when b', '.sc-when > span', '.sc-venue']],
  ['dashboard', '/dashboard', ['.dash-week-when', 'span[data-date-fr]', null, '.dash-week-venue']],
  ['public upcoming', null, ['.pb-g', '.pb-g-d b', '.pb-g-d span', '.pb-g-venue']]
];

describe('the venue sits under the time, never on the date heading', () => {
  for (const scheme of ['light', 'dark']) for (const locale of ['fr-CA', 'en-CA']) {
    it(`${scheme}, ${locale}`, async () => {
      const context = await browser.newContext({ locale, colorScheme: scheme });
      await context.addCookies(s.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
      const page = await context.newPage();
      await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        for (const [name, path, sels] of LISTS) {
          await page.goto(h.baseUrl + (path || `/${slug}?lang=${locale.slice(0, 2)}`));
          await page.evaluate(() => document.fonts.ready);
          const rows = await page.evaluate(measure, sels);
          expect(rows.length, `${name} ${width}`).toBeGreaterThan(0);
          for (const r of rows) {
            expect(r.overlap, `${name} ${width} ${scheme} ${locale}: ${r.text}`).toBe(false);
            expect(r.below, `${name} ${width} ${scheme} ${locale}: ${r.text}`).toBe(true);
          }
        }
      }
      await context.close();
    }, 120000);
  }
});

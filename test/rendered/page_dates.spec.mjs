// French Notre Ligue pages write dates in words and times in the Quebec
// 24-hour form (batch 4 item 4). The browser copy of the format
// (PAGE_DATE_JS, used by the pages' own scripts) gives exactly what the
// server gives (formatPageDate, formatEventTime) for every day of a year
// and every time of a day. On the schedule page, in Chromium: the dates in
// words, and the date and time inputs marked lang="fr-CA" (in English,
// en-CA).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import vm from 'node:vm';
import { PAGE_DATE_JS, formatPageDate, formatEventTime } from '../../src/date_format.js';
import { startPublicPageWorker, seedPopulatedLeague, launchChromium } from './support/public_page_harness.mjs';

describe('the browser copy matches the server', () => {
  it('every day of 2027, both styles, and every minute of a day', () => {
    const ctx = { window: {}, Date, Number, String, isNaN };
    vm.runInNewContext(PAGE_DATE_JS, ctx);
    const { __nlDate, __nlTime } = ctx.window;
    for (let t = Date.UTC(2027, 0, 1); t < Date.UTC(2028, 0, 1); t += 86400000) {
      const iso = new Date(t).toISOString().slice(0, 10);
      expect(__nlDate(iso, 'short')).toBe(formatPageDate(iso, 'fr', 'short'));
      expect(__nlDate(iso, 'long')).toBe(formatPageDate(iso, 'fr', 'long'));
    }
    for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m++) {
      const hhmm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      expect(__nlTime(hhmm)).toBe(formatEventTime(hhmm, 'fr'));
    }
  });
});

let h, browser, league;
beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { RSVP_SECRET: 'page-dates' } });
  league = await seedPopulatedLeague(h, { email: 'owner@page-dates.example', name: 'Ligue Dates', teamNames: ['Otters', 'Bears'], playerName: 'Lea Player', goalieName: 'Luc Goalie' });
  browser = await launchChromium();
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

async function open(path, lang) {
  const context = await browser.newContext();
  await context.addCookies(league.session.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
  await context.addInitScript(l => { try { localStorage.setItem('smbhl_admin_lang', l); } catch (e) {} }, lang);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
  await page.goto(h.baseUrl + path, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle').catch(() => {});
  return { page, errors, close: () => context.close() };
}

describe('the schedule page in Chromium', () => {
  it('French: dates in words, inputs marked fr-CA', async () => {
    const { page, errors, close } = await open('/league/schedule', 'fr');
    const text = await page.innerText('body');
    // The seeded upcoming game: 2099-01-05, a Monday, 20:30.
    expect(text).toContain('lundi 5 janv.');
    expect(text).toContain('20 h 30');
    expect(await page.getAttribute('html', 'lang')).toBe('fr-CA');
    expect(await page.$$eval('input[type="time"], input[type="date"]', els => els.map(e => e.getAttribute('lang')))).toEqual(expect.arrayContaining(['fr-CA']));
    expect(await page.$$eval('input[type="time"], input[type="date"]', els => els.every(e => e.getAttribute('lang') === 'fr-CA'))).toBe(true);
    expect(errors).toEqual([]);
    await close();
  }, 120000);

  it('English: unchanged ("Mon Jan 5", "8:30 PM"), inputs marked en-CA', async () => {
    const { page, errors, close } = await open('/league/schedule', 'en');
    const text = await page.innerText('body');
    expect(text).toContain('Mon Jan 5');
    expect(text).toContain('8:30 PM');
    expect(await page.$$eval('input[type="time"], input[type="date"]', els => els.every(e => e.getAttribute('lang') === 'en-CA'))).toBe(true);
    expect(errors).toEqual([]);
    await close();
  }, 120000);
});

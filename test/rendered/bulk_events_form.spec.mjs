// "Create multiple events" in a real browser: each problem the server
// names is shown under its field, the field is highlighted and marked
// invalid, the first one takes focus, in the page's language. A date the
// browser cannot read (typed 09/31/2026) is sent as invalid, not empty.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, seedPopulatedLeague, launchChromium } from './support/public_page_harness.mjs';

let h, browser, league;
const SHOTS = process.env.BULK_FORM_SHOTS || null; // a folder: screenshots for the report
beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { RSVP_SECRET: 'bulk-form' } });
  league = await seedPopulatedLeague(h, { email: 'owner@bulk-form.example', name: 'Bulk League', teamNames: ['Otters', 'Bears'], playerName: 'Lea Player', goalieName: 'Luc Goalie' });
  browser = await launchChromium();
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

async function openForm(lang, { offline = false } = {}) {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 1100 } });
  await context.addCookies(league.session.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
  await context.addInitScript(l => { try { localStorage.setItem('smbhl_admin_lang', l); } catch (e) {} }, lang);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.route('**/*', r => {
    const url = r.request().url();
    if (offline && url.includes('/league/events/bulk')) return r.abort('internetdisconnected');
    return url.startsWith(h.baseUrl) ? r.continue() : r.abort();
  });
  await page.goto(h.baseUrl + '/league/schedule', { waitUntil: 'load' });
  await page.evaluate(() => openBulkPanel());
  return { page, errors, close: () => context.close() };
}
const typeDate = async (page, sel, mmddyyyy) => { await page.click(sel); await page.keyboard.type(mmddyyyy); };
async function fieldState(page, field, input) {
  return page.evaluate(([f, i]) => {
    const line = document.getElementById('be_err_' + f); const el = document.getElementById(i);
    return { text: line.style.display === 'none' ? '' : line.textContent.trim(), invalid: el.getAttribute('aria-invalid'), highlighted: el.classList.contains('nl-input--error'), focused: document.activeElement === el };
  }, [field, input]);
}
async function submit(page) {
  await page.click('#be_submit');
  await page.waitForFunction(() => document.querySelector('[id^="be_err_"][style*="flex"]') || document.getElementById('bulkEventErr').style.display === 'block');
}

const COPY = {
  BULK_DATE_INVALID: { fr: "Cette date n'existe pas. Veuillez choisir une date valide.", en: 'This date does not exist. Please choose a valid date.' },
  BULK_TIMES_EQUAL: { fr: "L'heure de fin doit être différente de l'heure de début.", en: 'The end time must be different from the start time.' },
  BULK_COUNT_RANGE: { fr: "Le nombre d'événements doit être entre 1 et 52.", en: 'The number of events must be between 1 and 52.' },
  BULK_NETWORK_ERROR: { fr: 'La connexion a échoué. Vérifiez votre connexion Internet et réessayez.', en: 'The connection failed. Check your internet connection and try again.' }
};

describe('Create multiple events: the message beside the field', () => {
  for (const lang of ['fr', 'en']) {
    it(`${lang}: typed 09/31/2026 is "this date does not exist", beside the first date, highlighted, focused`, async () => {
      const { page, errors, close } = await openForm(lang);
      await typeDate(page, '#be_start_date', '09312026');
      await page.fill('#be_start', '19:00'); await page.fill('#be_end', '20:00');
      await submit(page);
      expect(await fieldState(page, 'startDate', 'be_start_date')).toEqual({ text: COPY.BULK_DATE_INVALID[lang], invalid: 'true', highlighted: true, focused: true });
      expect(await page.evaluate(() => document.getElementById('bulkEventErr').style.display)).toBe('none'); // not the generic box
      if (SHOTS) await page.locator('#sc_bulk_panel').screenshot({ path: `${SHOTS}/bulk_date_${lang}.png` });
      // Typing clears it.
      await page.fill('#be_start_date', '2027-01-05');
      expect((await fieldState(page, 'startDate', 'be_start_date')).text).toBe('');
      expect(errors).toEqual([]);
      await close();
    }, 120000);

    it(`${lang}: several at once, first one focused; an unreadable end date is invalid, not ignored`, async () => {
      const { page, errors, close } = await openForm(lang);
      await page.fill('#be_start_date', '2027-01-05');
      await page.fill('#be_occurrences', '60');
      await page.fill('#be_start', '19:00'); await page.fill('#be_end', '19:00');
      await submit(page);
      expect(await fieldState(page, 'occurrences', 'be_occurrences')).toMatchObject({ text: COPY.BULK_COUNT_RANGE[lang], highlighted: true, focused: true });
      expect(await fieldState(page, 'endTime', 'be_end')).toMatchObject({ text: COPY.BULK_TIMES_EQUAL[lang], highlighted: true, focused: false });
      // End date typed as 02/30/2027: the count is not used in its place.
      await page.fill('#be_end', '20:00');
      await typeDate(page, '#be_end_date', '02302027');
      await submit(page);
      expect(await fieldState(page, 'endDate', 'be_end_date')).toMatchObject({ text: COPY.BULK_DATE_INVALID[lang], highlighted: true, focused: true });
      expect(errors).toEqual([]);
      await close();
    }, 120000);

    it(`${lang}: a network failure has its own message, and is logged`, async () => {
      const { page, errors, close } = await openForm(lang, { offline: true });
      const logged = [];
      page.on('console', m => { if (m.type() === 'error') logged.push(m.text()); });
      await page.fill('#be_start_date', '2027-01-05');
      await page.fill('#be_start', '19:00'); await page.fill('#be_end', '20:00');
      await submit(page);
      expect((await page.textContent('#bulkEventErr')).trim()).toBe(COPY.BULK_NETWORK_ERROR[lang]);
      expect(logged.some(t => t.includes('[bulk-events] request failed'))).toBe(true);
      expect(errors).toEqual([]);
      await close();
    }, 120000);
  }
});

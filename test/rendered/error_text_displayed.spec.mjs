// The text an error puts ON SCREEN, in a real browser, in both languages.
// window.__errorText looked the dictionary up language-first while
// src/error_i18n.js is keyed error-first, so every key missed and the page
// showed "An error occurred." (or the server's raw English). Tests checked
// the error KEY a route returns, never the displayed text, which is how it
// survived. This checks the displayed text, for both copies of the shell:
//   - nlAuthScript (league pages, login, signup): /league/settings,
//     saving the season with no name;
//   - page() (the SMBHL shell): the co-admin invite page, a password that
//     is too short.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, seedPopulatedLeague, launchChromium } from './support/public_page_harness.mjs';
import { hmac } from '../../src/crypto_utils.js';

const SECRET = 'rendered-public-page-secret'; // the harness's AUTH_SECRET
let h, browser, league;
beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { RSVP_SECRET: 'error-text' } });
  league = await seedPopulatedLeague(h, { email: 'owner@error-text.example', name: 'Error League', teamNames: ['Otters', 'Bears'], playerName: 'Lea Player', goalieName: 'Luc Goalie' });
  browser = await launchChromium();
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

async function open(path, lang, { session = true } = {}) {
  const context = await browser.newContext();
  if (session) await context.addCookies(league.session.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
  await context.addInitScript(l => { try { localStorage.setItem('smbhl_admin_lang', l); } catch (e) {} }, lang);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
  await page.goto(h.baseUrl + path, { waitUntil: 'load' });
  return { page, errors, close: () => context.close() };
}

const b64url = s => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function inviteToken(email) {
  const exp = Date.now() + 7 * 86400000;
  const sig = await hmac(SECRET, `invite:${league.league.id}:${email}:${exp}`);
  return `${league.league.id}.${b64url(email)}.${exp}.${sig}`;
}

const expected = {
  SEASON_NAME_REQUIRED_CLIENT: { fr: 'Le nom de la saison est requis.', en: 'Season name is required.' },
  WEAK_PASSWORD: { fr: 'Ton mot de passe doit contenir au moins 8 caractères.', en: 'Password must be at least 8 characters.' }
};

describe('An error shows its own message, translated', () => {
  for (const lang of ['fr', 'en']) {
    it(`a league page (nlAuthScript), ${lang}: the season name left empty`, async () => {
      const { page, errors, close } = await open('/league/settings', lang);
      await page.fill('#season_mgmt_name', '');
      await page.evaluate(() => submitSeasonMgmt());
      const text = (await page.textContent('#seasonMgmtErr')).trim();
      expect(text).toBe(expected.SEASON_NAME_REQUIRED_CLIENT[lang]);
      expect(errors).toEqual([]);
      await close();
    }, 120000);

    it(`the SMBHL shell (page()), ${lang}: the co-admin invite page, a password too short`, async () => {
      const token = await inviteToken(`new.admin.${lang}@error-text.example`);
      const { page, errors, close } = await open(`/league/admins/accept?token=${encodeURIComponent(token)}`, lang, { session: false });
      await page.fill('#accept_password', 'short');
      await page.evaluate(() => submitAccept());
      const text = (await page.textContent('#formErr')).trim();
      expect(text).toBe(expected.WEAK_PASSWORD[lang]);
      expect(errors).toEqual([]);
      await close();
    }, 120000);
  }
});

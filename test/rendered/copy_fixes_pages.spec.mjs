// Copy fixes from the audit, as the pages show them in Chromium (item 5).
//  5a  SMBHL's people page: "{n} joueur{s} disponible{s}" showed its second
//      {s} unfilled. Now every {s} is filled: French plural from 2, English
//      for anything but 1.
//  5h  Notre Ligue's settings: no « un(e) co-administrateur(-trice) ».
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, seedBareLeague, launchChromium } from './support/public_page_harness.mjs';

const ADMIN_KEY = 'copy-fixes-admin-key';
let h, browser, league;

beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { ADMIN_KEY } });
  await h.kv.put('data_json', JSON.stringify({ current_season: 'Fall 2099', seasons: [{ name: 'Fall 2099', standings: [], fixtures: [] }], players: [] }));
  // SMBHL: three skater subs, one goalie sub (the schema's own sub goalies, from
  // migrate-002.sql, removed first).
  await h.db.prepare("DELETE FROM contacts WHERE COALESCE(league_id, 'smbhl') = 'smbhl'").run();
  for (const [id, role, g] of [['S1', 'sub_skater', 0], ['S2', 'sub_skater', 0], ['S3', 'sub_skater', 0], ['G1', 'sub_goalie', 1]]) {
    await h.db.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, ?, 1, ?, 's', 'smbhl')`).bind(id, `Sub ${id}`, `${id.toLowerCase()}@example.com`, role, g).run();
  }
  league = await seedBareLeague(h, { email: 'owner@copyfixes.example', name: 'Ligue du mercredi' });
  browser = await launchChromium();
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

async function open(path, lang, cookies) {
  const ctx = await browser.newContext({ locale: lang === 'fr' ? 'fr-CA' : 'en-US' });
  await ctx.addCookies(cookies);
  await ctx.addInitScript(l => { try { localStorage.setItem('admin_lang', l); localStorage.setItem('smbhl_admin_lang', l); } catch (e) {} }, lang);
  const page = await ctx.newPage();
  await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
  await page.goto(h.baseUrl + path, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  return { page, ctx };
}

describe('5a: SMBHL people page counts', () => {
  it('French and English, one and many: no unfilled placeholder', async () => {
    const admin = [{ name: 'admin_key', value: ADMIN_KEY, url: h.baseUrl + '/' }];
    for (const [lang, skaters, goalies] of [['fr', '3 joueurs disponibles', '1 gardien disponible'], ['en', '3 skaters available', '1 goalie available']]) {
      const { page, ctx } = await open('/admin/people', lang, admin);
      expect(await page.textContent('#sub-skater-desc')).toBe(skaters);
      expect(await page.textContent('#sub-goalie-desc')).toBe(goalies);
      expect(await page.evaluate(() => document.body.innerText)).not.toContain('{s}');
      await ctx.close();
    }
  }, 120000);
});

describe('5h: Notre Ligue settings, neutral wording', () => {
  it('the co-admin invite label', async () => {
    const cookies = league.session.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; });
    const { page, ctx } = await open('/league/settings', 'fr', cookies);
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).toContain("Inviter quelqu'un à coadministrer la ligue");
    expect(text).not.toMatch(/un\(e\)|\(-trice\)/);
    await ctx.close();
  }, 120000);
});

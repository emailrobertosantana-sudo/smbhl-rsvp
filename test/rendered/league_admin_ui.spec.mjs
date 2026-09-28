// League-product admin UI, in a real browser (real worker, local-only D1).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, seedPopulatedLeague, launchChromium } from './support/public_page_harness.mjs';

let h, browser, league;

beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { RSVP_SECRET: 'league-admin-ui' } });
  league = await seedPopulatedLeague(h, { email: 'owner@league-admin-ui.example', name: 'UI League', teamNames: ['Otters', 'Bears'], playerName: 'Lea Player', goalieName: 'Luc Goalie' });
  browser = await launchChromium();
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

async function open(path, { lang } = {}) {
  const context = await browser.newContext();
  await context.addCookies(league.session.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
  if (lang) await context.addInitScript(l => { try { localStorage.setItem('smbhl_admin_lang', l); } catch (e) {} }, lang);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
  await page.goto(h.baseUrl + path, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle').catch(() => {});
  return { page, errors, close: () => context.close() };
}

describe('Players table', () => {
  // Item 4: "can also play goalie" settable from the row itself.
  it('ticking "can also play goalie" in a row saves it, without opening Edit', async () => {
    const lea = await h.db.prepare(`SELECT player_id FROM contacts WHERE league_id = ? AND name = 'Lea Player'`).bind(league.league.id).first();
    const { page, errors, close } = await open('/league/roster');
    const box = `[data-toggle-backup="${lea.player_id}"]`;
    expect(await page.isVisible(box)).toBe(true);
    expect(await page.isVisible(`[id="edit_row_${lea.player_id}"]`)).toBe(false);
    await page.check(box);
    await page.waitForFunction(sel => !document.querySelector(sel).disabled, box);
    const row = await h.db.prepare('SELECT is_backup_goalie FROM contacts WHERE player_id = ?').bind(lea.player_id).first();
    expect(row.is_backup_goalie).toBe(1);
    // The Edit panel shows the same state.
    expect(await page.isChecked(`[id="edit_backup_${lea.player_id}"]`)).toBe(true);
    await page.uncheck(box);
    await page.waitForFunction(sel => !document.querySelector(sel).disabled, box);
    expect((await h.db.prepare('SELECT is_backup_goalie FROM contacts WHERE player_id = ?').bind(lea.player_id).first()).is_backup_goalie).toBe(0);
    expect(errors).toEqual([]);
    await close();
  }, 120000);
});

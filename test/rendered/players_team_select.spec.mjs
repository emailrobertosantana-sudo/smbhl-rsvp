// The Players table's Team dropdown, in a real browser: choosing a team in
// the row saves it and the filter tabs follow.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, launchChromium } from './support/public_page_harness.mjs';

let h, browser, s, leagueId;
beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { RSVP_SECRET: 'players-team-select' } });
  s = await h.signup('owner@players-team.example');
  const j = async (p, body) => (await h.api(p, { ...s, body })).json();
  leagueId = (await j('/leagues/create', { name: 'Team Select League', teamNames: ['Red', 'Blue', 'White'], tracksStats: false })).league.id;
  await j('/league/season/publish', { season_name: 'S1' });
  await j('/league/contacts/bulk', { contacts: [{ name: 'Gil Imported' }, { name: 'Hal Imported' }] });
  browser = await launchChromium();
}, 180000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

describe('Players table Team dropdown', () => {
  it('choosing a team in a row saves it, without opening Edit, and the tabs count it', async () => {
    const gil = await h.db.prepare(`SELECT player_id FROM contacts WHERE league_id = ? AND name = 'Gil Imported'`).bind(leagueId).first();
    const context = await browser.newContext();
    await context.addCookies(s.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
    await page.goto(h.baseUrl + '/league/roster', { waitUntil: 'load' });
    const sel = `[data-set-team="${gil.player_id}"]`;
    expect(await page.isVisible(sel)).toBe(true);
    expect(await page.inputValue(sel)).toBe('');
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.selectOption(sel, 'Blue')]);
    expect((await h.db.prepare('SELECT preferred_team FROM contacts WHERE player_id = ?').bind(gil.player_id).first()).preferred_team).toBe('Blue');
    expect(await page.inputValue(sel)).toBe('Blue');
    expect((await page.textContent('[data-filter="unassigned"]')).trim()).toMatch(/1$/);
    expect(errors).toEqual([]);
    await context.close();
  }, 120000);
});

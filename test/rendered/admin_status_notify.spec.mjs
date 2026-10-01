// "Notify the player" on the league game page, in a real browser: the box is
// there and checked for a game to come; OUT with it checked queues one email
// and, after the page reloads, says « 1 joueur avisé. »; unchecked, nothing
// is queued and nothing is said. No email leaves (the harness has no mail
// provider): the outbox row is what is checked.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, seedPopulatedLeague, launchChromium } from './support/public_page_harness.mjs';

let h, browser, league, ev, lea, luc;
beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { RSVP_SECRET: 'status-notify' } });
  league = await seedPopulatedLeague(h, { email: 'owner@status-notify.example', name: 'Ligue Avis', teamNames: ['Otters', 'Bears'], playerName: 'Lea Player', goalieName: 'Luc Goalie' });
  await h.db.prepare("UPDATE contacts SET email = lower(replace(name, ' ', '.')) || '@example.com' WHERE league_id = ?").bind(league.league.id).run();
  ev = await h.db.prepare("SELECT id FROM events WHERE league_id = ? AND date = '2099-01-05'").bind(league.league.id).first();
  lea = await h.db.prepare("SELECT player_id FROM contacts WHERE league_id = ? AND name = 'Lea Player'").bind(league.league.id).first();
  luc = await h.db.prepare("SELECT player_id FROM contacts WHERE league_id = ? AND name = 'Luc Goalie'").bind(league.league.id).first();
  browser = await launchChromium();
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

async function open(path) {
  const context = await browser.newContext();
  await context.addCookies(league.session.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
  await context.addInitScript(() => { try { localStorage.setItem('smbhl_admin_lang', 'fr'); } catch (e) {} });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
  await page.goto(h.baseUrl + path, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle').catch(() => {});
  return { page, errors, close: () => context.close() };
}
const mails = pid => h.db.prepare("SELECT count(*) n FROM outbox WHERE kind = 'admin_status' AND player_id = ?").bind(pid).first().then(r => r.n);

describe('the game page', () => {
  it('checked: OUT queues one email and says so after the reload', async () => {
    const { page, errors, close } = await open(`/league/events/detail?e=${encodeURIComponent(ev.id)}`);
    expect(await page.isChecked('#notify_player')).toBe(true);
    expect(await page.textContent('label:has(#notify_player)')).toContain('Aviser le joueur');
    await Promise.all([page.waitForEvent('load'), page.click(`button[onclick="setPlayerStatus('${lea.player_id}','out',this)"]`)]);
    await page.waitForFunction(() => (document.getElementById('notify_msg') || {}).textContent);
    expect(await page.textContent('#notify_msg')).toBe('1 joueur avisé.');
    expect(await mails(lea.player_id)).toBe(1);
    expect(errors).toEqual([]);
    await close();
  }, 120000);

  it('unchecked: nothing queued, nothing said', async () => {
    const { page, errors, close } = await open(`/league/events/detail?e=${encodeURIComponent(ev.id)}`);
    await page.uncheck('#notify_player');
    await Promise.all([page.waitForEvent('load'), page.click(`button[onclick="setPlayerStatus('${luc.player_id}','out',this)"]`)]);
    expect(await page.textContent('#notify_msg')).toBe('');
    expect(await mails(luc.player_id)).toBe(0);
    expect(errors).toEqual([]);
    await close();
  }, 120000);
});

// D1 (nights), in a real browser: a player with two games that night sees
// both on their page, and "I can't make this game" drops just that one --
// the page's own script, no error, both languages.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, launchChromium } from './support/public_page_harness.mjs';

let h, browser, url, ids;
const SECRET = 'rendered-night';
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { RSVP_SECRET: SECRET } });
  const s = await h.signup('owner@night.example');
  const j = async (p, body) => (await h.api(p, { ...s, body })).json();
  const league = (await j('/leagues/create', { name: 'Night League', teamNames: ['Bears', 'Otters', 'Wolves'] })).league;
  await j('/league/season/publish', { season_name: 'S1' });
  const p = (await j('/league/contacts', { name: 'Nina Night', email: 'nina@example.com', role: 'roster', team: 'Bears' })).contact;
  const A = (await j('/league/events', { date: '2099-03-03', season: 'S1', venue: 'Rink', start_time: '19:00', end_time: '20:00', home_team: 'Bears', away_team: 'Otters' })).event;
  const B = (await j('/league/events', { date: '2099-03-03', season: 'S1', venue: 'Rink', start_time: '20:00', end_time: '21:00', home_team: 'Bears', away_team: 'Wolves' })).event;
  ids = { A: A.id, B: B.id, p: p.player_id };
  const salt = (await h.db.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(p.player_id).first()).token_salt;
  const t = await hmac(SECRET, `lr:${league.id}:${A.id}:${p.player_id}:${salt}`);
  url = `${h.baseUrl}/league/rsvp?league=${encodeURIComponent(league.id)}&e=${encodeURIComponent(A.id)}&p=${encodeURIComponent(p.player_id)}&t=${t}`;
  browser = await launchChromium();
}, 180000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

const status = async id => ((await h.db.prepare('SELECT status FROM rsvp WHERE event_id = ? AND player_id = ?').bind(id, ids.p).first()) || {}).status || null;

describe('The night page, in a browser', () => {
  it('"I\'m in" answers both games; "I can\'t make this game" drops one; no script error', async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
    await page.goto(url, { waitUntil: 'load' });
    await page.click('#btn-lang-fr'); // the browser's own language would pick English
    expect(await page.$$eval('.rv-games li', lis => lis.length)).toBe(2);
    expect(await page.innerText('.rv-meta')).toContain('Ta réponse vaut pour la soirée : pour chaque match de ton équipe.');
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('.rv-answers [data-v="in"]')]);
    expect([await status(ids.A), await status(ids.B)]).toEqual(['in', 'in']);
    expect(await page.$$eval('#rv_games [data-gv="out"]', b => b.length)).toBe(2);
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click(`#rv_games [data-game="${ids.B}"][data-gv="out"]`)]);
    expect([await status(ids.A), await status(ids.B)]).toEqual(['in', 'out']);
    expect(await page.textContent(`#rv_games li[data-game-state="out"]`)).toContain('Tu ne joues pas ce match');
    // English.
    await page.click('#btn-lang-en');
    expect(await page.textContent('#rv_games li[data-game-state="out"]')).toContain("You're not playing this game");
    expect(await page.textContent('#rv_games li[data-game-state="in"]')).toContain("I can't make this game");
    expect(errors).toEqual([]);
    await page.close();
  }, 120000);
});

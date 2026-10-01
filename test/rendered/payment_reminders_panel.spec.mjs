// The "Send payment reminders" panel, in a real browser, on SMBHL's
// /admin/finances and Notre Ligue's Finances tab: who owes (checked by
// default), who has no email (cannot be checked), the send button's count
// in the singular and plural, the preview in the shared modal, the
// message after sending, and the notice when no e-Transfer detail is set.
// The send itself is answered by the test (page.route): nothing is queued
// or sent from here; the workers test part200 covers the real send.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, seedPopulatedLeague, launchChromium } from './support/public_page_harness.mjs';

const ADMIN_KEY = 'pay-panel-admin-key';
const SEASON = 'Fall 2099';
let h, browser, league;

beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { ADMIN_KEY, RSVP_SECRET: 'pay-panel-rsvp' } });
  await h.kv.put('data_json', JSON.stringify({ current_season: SEASON, seasons: [{ name: SEASON, config: { teams: [{ name: 'Red' }] }, standings: [], fixtures: [] }], players: [
    { id: 'P0001', name: 'Adam Albanese', seasons: { [SEASON]: { team: 'Red', gp: 0 } } },
    { id: 'P0002', name: 'Bruno Bédard', seasons: { [SEASON]: { team: 'Red', gp: 0 } } },
    { id: 'P0003', name: 'Carl Courriel', seasons: { [SEASON]: { team: 'Red', gp: 0 } } }
  ] }));
  for (const [id, name, email] of [['P0001', 'Adam Albanese', 'adam@example.com'], ['P0002', 'Bruno Bédard', 'bruno@example.com'], ['P0003', 'Carl Courriel', null]]) {
    await h.db.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, 'roster', 0, 0, 'salt', 'smbhl')`).bind(id, name, email).run();
  }
  // Bruno is off game emails: listed, unchecked by default (batch 4 item 2c).
  await h.db.prepare("UPDATE contacts SET opted_out = 1 WHERE player_id = 'P0002'").run();
  league = await seedPopulatedLeague(h, { email: 'owner@pay-panel.example', name: 'Ligue Paiement', teamNames: ['Otters', 'Bears'], playerName: 'Lea Player', goalieName: 'Luc Goalie' });
  await h.db.prepare("UPDATE contacts SET email = lower(replace(name, ' ', '.')) || '@example.com' WHERE league_id = ?").bind(league.league.id).run();
  await h.api('/league/finances/pricing', { ...league.session, body: { season: 'S1', mode: 'season', price_player: 85, price_goalie: 85, price_game_player: 5, price_game_goalie: 5 } });
  browser = await launchChromium();
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

async function open(path, cookies, { lang = 'fr' } = {}) {
  const context = await browser.newContext();
  await context.addCookies(cookies);
  if (lang) await context.addInitScript(l => { try { localStorage.setItem('smbhl_admin_lang', l); } catch (e) {} }, lang);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
  await page.goto(h.baseUrl + path, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle').catch(() => {});
  return { page, errors, close: () => context.close() };
}
const smbhlCookies = () => [{ name: 'admin_key', value: ADMIN_KEY, url: h.baseUrl + '/' }];
const leagueCookies = () => league.session.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; });
const outbox = async () => (await h.db.prepare('SELECT count(*) n FROM outbox').first()).n;
async function openPanel(page) {
  await page.click('#pay-open');
  await page.waitForSelector('#pay-table, #pay-noinfo, #pay-nobody');
}

describe('SMBHL /admin/finances', () => {
  it('no e-Transfer detail yet: the notice, and nothing can be sent', async () => {
    const { page, errors, close } = await open('/admin/finances', smbhlCookies());
    await openPanel(page);
    expect(await page.textContent('#pay-noinfo')).toContain('virement Interac');
    expect(await page.isDisabled('#pay-send')).toBe(true);
    expect(errors).toEqual([]);
    await close();
  }, 120000);

  it('the list, the count, the preview, the message after sending', async () => {
    await h.api('/admin/finances/payment-settings', { body: { email: 'paye@smbhl.com', phone: '5145551234' }, cookie: `admin_key=${ADMIN_KEY}` });
    const before = await outbox();
    const { page, errors, close } = await open('/admin/finances', smbhlCookies());
    await page.waitForFunction(() => document.getElementById('seasonSelect') && document.getElementById('seasonSelect').value);
    await openPanel(page);
    expect(await page.$$eval('#pay-table input[data-pay-player]', b => b.map(x => x.checked))).toEqual([true, false]);
    expect(await page.textContent('#pay-table')).toContain('Désabonné des courriels de match');
    expect(await page.textContent('#pay-table')).toContain('Adam Albanese');
    expect(await page.textContent('#pay-table')).toContain('170,00');
    expect(await page.textContent('#pay-table')).toContain('Jamais');
    expect(await page.textContent('#pay-noemail')).toContain('Carl Courriel');
    expect(await page.textContent('#pay-noemail')).toContain('Aucune adresse courriel');
    expect(await page.isDisabled('#pay-noemail input')).toBe(true);
    expect(await page.textContent('#pay-send')).toBe('Envoyer à 1 joueur');
    await page.check('#pay-table input[data-pay-player="P0002"]');
    expect(await page.textContent('#pay-send')).toBe('Envoyer à 2 joueurs');
    await page.uncheck('#pay-table input[data-pay-player="P0002"]');
    expect(await page.textContent('#pay-send')).toBe('Envoyer à 1 joueur');
    // The preview: the shared modal, the first checked player.
    await page.fill('#pay-note', 'Avant le 15.');
    await page.click('#pay-preview');
    await page.waitForSelector('.ep-overlay.on .ep-subject, .ep-overlay.on .ep-error');
    expect(await page.textContent('.ep-overlay .ep-subject .ep-v')).toBe('SMBHL : solde à payer / Balance owing');
    expect(await page.textContent('.ep-overlay .ep-meta')).toContain('adam@example.com');
    await page.click('.ep-overlay .ep-close');
    expect(await outbox()).toBe(before);
    // The send, answered here.
    let asked = null;
    await page.route('**/admin/finances/reminders/send', r => { asked = JSON.parse(r.request().postData()); r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sent: 1, skipped: [] }) }); });
    await page.click('#pay-send');
    await page.waitForFunction(() => /rappel envoyé/.test((document.getElementById('pay-msg') || {}).textContent || ''));
    expect(asked).toMatchObject({ season: SEASON, player_ids: ['P0001'], note: 'Avant le 15.' });
    expect(await page.textContent('#pay-msg')).toBe('1 rappel envoyé.');
    expect(errors).toEqual([]);
    await close();
  }, 120000);

  it('in English', async () => {
    const { page, errors, close } = await open('/admin/finances', smbhlCookies(), { lang: 'en' });
    await page.waitForFunction(() => document.getElementById('seasonSelect') && document.getElementById('seasonSelect').value);
    expect(await page.textContent('#pay-open')).toBe('Send payment reminders');
    await openPanel(page);
    expect(await page.textContent('#pay-send')).toBe('Send to 1 player');
    expect(await page.textContent('#pay-table')).toContain('Opted out of game emails');
    expect(await page.textContent('#pay-table')).toContain('$170.00');
    expect(await page.textContent('#pay-table')).toContain('Never');
    expect(await page.textContent('#pay-noemail')).toContain('No email address');
    expect(errors).toEqual([]);
    await close();
  }, 120000);
});

describe("Notre Ligue's Finances tab", () => {
  it('no e-Transfer detail yet: the notice, in "tu"', async () => {
    const { page, errors, close } = await open('/league/finances', leagueCookies());
    await page.waitForFunction(() => document.getElementById('fin-season') && document.getElementById('fin-season').value);
    await openPanel(page);
    expect(await page.textContent('#pay-noinfo')).toBe("Ajoute d'abord ton courriel ou ton cellulaire pour virement Interac dans les Paramètres.");
    expect(await page.isDisabled('#pay-send')).toBe(true);
    expect(errors).toEqual([]);
    await close();
  }, 120000);

  it('the list, the preview and the send', async () => {
    await h.api('/league/settings/payment', { ...league.session, body: { email: 'paye@ligue.example', phone: '' } });
    const before = await outbox();
    const { page, errors, close } = await open('/league/finances', leagueCookies());
    await page.waitForFunction(() => document.getElementById('fin-season') && document.getElementById('fin-season').value);
    await openPanel(page);
    expect(await page.textContent('#pay-table')).toContain('Lea Player');
    expect(await page.textContent('#pay-table')).toContain('85,00');
    expect(await page.textContent('#pay-send')).toBe('Envoyer à 2 joueurs');
    await page.click('#pay-preview');
    await page.waitForSelector('.ep-overlay.on .ep-subject, .ep-overlay.on .ep-error');
    expect(await page.textContent('.ep-overlay .ep-subject .ep-v')).toContain('Ligue Paiement : solde à payer');
    await page.click('.ep-overlay .ep-close');
    expect(await outbox()).toBe(before);
    await page.route('**/league/finances/reminders/send', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sent: 2, skipped: [] }) }));
    await page.click('#pay-send');
    await page.waitForFunction(() => /rappels envoyés/.test((document.getElementById('pay-msg') || {}).textContent || ''));
    expect(await page.textContent('#pay-msg')).toBe('2 rappels envoyés.');
    expect(errors).toEqual([]);
    await close();
  }, 120000);

  it('the Settings page: the two fields save, the number shown as 514-555-1234', async () => {
    const { page, errors, close } = await open('/league/settings', leagueCookies());
    await page.fill('#pay_phone', '(514) 555 1234');
    await page.click('#pay_save');
    await page.waitForSelector('#payOk', { state: 'visible' });
    expect(await page.inputValue('#pay_phone')).toBe('514-555-1234');
    await page.fill('#pay_phone', '123');
    await page.click('#pay_save');
    await page.waitForSelector('#payErr', { state: 'visible' });
    expect(await page.textContent('#payErr')).toContain('10 chiffres');
    expect(errors).toEqual([]);
    await close();
  }, 120000);
});

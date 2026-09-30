// The warning before players are emailed on an add or an import, in a real
// browser (the rules themselves: test/part184_add_emails.spec.js).
//
// It is its own step over the Players page, not a field of the form. It
// says how many players will be emailed, singular or plural, in the page's
// language. Closing it creates nothing and sends nothing. Answering it
// sends the same add again with the answer.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, launchChromium } from './support/public_page_harness.mjs';

let h, browser, league, session;
const SHOTS = process.env.ADD_EMAILS_SHOTS || null; // a folder: screenshots for the report
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { RSVP_SECRET: 'add-emails' } });
  session = await h.signup('owner@add-emails.example');
  const j = async (p, body) => (await h.api(p, { ...session, body })).json();
  league = (await j('/leagues/create', { name: 'Ligue du mercredi', teamNames: ['Bulls', 'Parade'], tracksStats: false })).league;
  await j('/league/season/publish', { season_name: 'S1' });
  await j('/league/contacts', { name: 'Bulls One', email: 'b1@add-emails.example', team: 'Bulls' });
  await j('/league/contacts', { name: 'Parade One', email: 'p1@add-emails.example', team: 'Parade' });
  // A game in two days, short on both teams: a sub added now would be called.
  await j('/league/events', { date: day(2), start_time: '19:00', end_time: '20:00', venue: 'Gym', home_team: 'Bulls', away_team: 'Parade' });
  browser = await launchChromium();
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

async function openPlayers(lang, who = session) {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1100, height: 900 } });
  await context.addCookies(who.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
  await context.addInitScript(l => { try { localStorage.setItem('smbhl_admin_lang', l); } catch (e) {} }, lang);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
  await page.goto(h.baseUrl + '/league/roster', { waitUntil: 'load' });
  return { page, errors, close: () => context.close() };
}
// Fills the add form for a substitute and submits it.
async function addSub(page, name, email) {
  await page.evaluate(() => { const p = document.getElementById('ro_panel'); if (!p.classList.contains('open')) p.classList.add('open'); });
  await page.fill('#r_name', name);
  await page.fill('#r_email', email);
  await page.click('#r_role_radio label[data-value="sub_skater"]');
  await page.click('#r_submit');
}
const subsInDb = async () => (await h.db.prepare(`SELECT name FROM contacts WHERE league_id = ? AND role = 'sub_skater' ORDER BY name`).bind(league.id).all()).results.map(r => r.name);
const subCallRows = async () => (await h.db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE league_id = ? AND kind = 'sub_call'`).bind(league.id).first()).n;
const dialog = page => page.evaluate(() => {
  const d = document.getElementById('add_emails_dialog');
  const t = id => document.getElementById(id).textContent.trim();
  return { shown: d.style.display === 'flex', title: t('add_emails_title'), text: t('add_emails_text'), send: t('add_emails_send'), skip: t('add_emails_skip'), checkbox: document.querySelector('#add_emails_dialog label span').textContent.trim(), checked: document.getElementById('add_emails_off').checked, focused: document.activeElement.id };
});

const COPY = {
  fr: {
    title: "Courriels d'invitation", one: 'Ajouter ce joueur lui enverra un courriel tout de suite.',
    many: "Ajouter ces 20 joueurs enverra un courriel à chacun d'eux tout de suite.",
    some: '3 des joueurs que tu ajoutes recevront un courriel tout de suite.', someOne: '1 des joueurs que tu ajoutes recevra un courriel tout de suite.',
    send: 'Ajouter et envoyer les courriels', skip: 'Ajouter sans envoyer de courriel', checkbox: 'Désactiver les courriels automatiques pour cette ligue à partir de maintenant'
  },
  en: {
    title: 'Invitation emails', one: 'Adding this player will email them right away.',
    many: 'Adding these 20 players will email each of them right away.',
    some: '3 of the players you are adding will be emailed right away.', someOne: '1 of the players you are adding will be emailed right away.',
    send: 'Add and send emails', skip: 'Add without emailing', checkbox: 'Turn off automatic emails for this league from now on'
  }
};

describe('The warning before players are emailed', () => {
  for (const lang of ['fr', 'en']) {
    it(`${lang}: adding one substitute opens it, in the singular; closing it creates nothing and sends nothing`, async () => {
      const { page, errors, close } = await openPlayers(lang);
      await addSub(page, 'Sam Sub', `sam.${lang}@add-emails.example`);
      await page.waitForFunction(() => document.getElementById('add_emails_dialog').style.display === 'flex');
      const c = COPY[lang];
      expect(await dialog(page)).toEqual({ shown: true, title: c.title, text: c.one, send: c.send, skip: c.skip, checkbox: c.checkbox, checked: false, focused: 'add_emails_send' });
      // Its own step: over the page, the form still behind it.
      const covers = await page.evaluate(() => { const r = document.getElementById('add_emails_dialog').getBoundingClientRect(); return r.width >= window.innerWidth && r.height >= window.innerHeight && getComputedStyle(document.getElementById('add_emails_dialog')).position === 'fixed'; });
      expect(covers).toBe(true);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/warning_singular_${lang}.png` });
      expect(await subsInDb()).toEqual([]);
      // Closed three ways: nothing exists afterwards.
      await page.click('#add_emails_close');
      expect((await dialog(page)).shown).toBe(false);
      await page.click('#r_submit');
      await page.waitForFunction(() => document.getElementById('add_emails_dialog').style.display === 'flex');
      await page.keyboard.press('Escape');
      expect((await dialog(page)).shown).toBe(false);
      await page.click('#r_submit');
      await page.waitForFunction(() => document.getElementById('add_emails_dialog').style.display === 'flex');
      await page.mouse.click(5, 5); // the backdrop
      expect((await dialog(page)).shown).toBe(false);
      expect(await subsInDb()).toEqual([]);
      expect(await subCallRows()).toBe(0);
      expect(errors).toEqual([]);
      await close();
    }, 120000);

    it(`${lang}: the plural, and the case where only some of the players are emailed`, async () => {
      const { page, errors, close } = await openPlayers(lang);
      const c = COPY[lang];
      const show = async data => { await page.evaluate(d => openAddEmailsDialog(d, function() { return Promise.resolve({ ok: false, message: '' }); }), data); return (await dialog(page)).text; };
      expect(await show({ emailCount: 20, addCount: 20 })).toBe(c.many);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/warning_plural_${lang}.png` });
      expect(await show({ emailCount: 3, addCount: 10 })).toBe(c.some);
      expect(await show({ emailCount: 1, addCount: 10 })).toBe(c.someOne);
      expect(await show({ emailCount: 1, addCount: 1 })).toBe(c.one);
      expect(await page.locator('#add_emails_dialog').innerText()).not.toMatch(/\((s|es|e)\)|—/);
      expect(errors).toEqual([]);
      await close();
    }, 120000);
  }

  it('"Add without emailing" with the box ticked: the player is added, no sub call exists, the league is off, and the next add does not ask', async () => {
    const { page, errors, close } = await openPlayers('en');
    await addSub(page, 'Sam Sub', 'sam@add-emails.example');
    await page.waitForFunction(() => document.getElementById('add_emails_dialog').style.display === 'flex');
    await page.check('#add_emails_off');
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#add_emails_skip')]);
    expect(await subsInDb()).toEqual(['Sam Sub']);
    expect(await subCallRows()).toBe(0);
    const saved = JSON.parse((await h.db.prepare('SELECT value FROM settings WHERE key = ?').bind(`league_add_emails:${league.id}`).first()).value);
    expect(saved.mode).toBe('off');
    expect(saved.held).toHaveLength(1);
    // The next substitute: no dialog, added straight away, still no email.
    await addSub(page, 'Second Sub', 'second@add-emails.example');
    await page.waitForLoadState('load');
    await page.waitForFunction(() => document.getElementById('r_name') && document.getElementById('r_name').value === '');
    expect(await subsInDb()).toEqual(['Sam Sub', 'Second Sub']);
    expect(await subCallRows()).toBe(0);
    // The Settings page shows it off, and turns it back on.
    await page.goto(h.baseUrl + '/league/settings', { waitUntil: 'load' });
    expect(await page.getAttribute('#add_emails_switch', 'aria-checked')).toBe('false');
    if (SHOTS) await page.locator('#add_emails_switch').locator('xpath=..').screenshot({ path: `${SHOTS}/setting_off_en.png` });
    await page.click('#add_emails_switch');
    await page.waitForFunction(() => document.getElementById('add_emails_switch').getAttribute('aria-checked') === 'true');
    const after = JSON.parse((await h.db.prepare('SELECT value FROM settings WHERE key = ?').bind(`league_add_emails:${league.id}`).first()).value);
    expect(after).toEqual({ mode: 'on', held: [], regularNotice: false });
    expect(errors).toEqual([]);
    await close();
  }, 120000);
});

// The notice for regular players: shown the first time regular players are
// added in a league (test/part185 for the rules). Nothing to choose: one
// button adds them, closing adds nothing.
const NOTICE = {
  fr: {
    one: 'Ajouter ce joueur ne lui enverra pas de courriel maintenant. Son premier courriel sera le rappel envoyé 72 heures avant le prochain match (',
    many: 'Ajouter ces 20 joueurs ne leur enverra pas de courriel maintenant. Leur premier courriel sera le rappel envoyé 72 heures avant le prochain match (',
    noGame: 'Ajouter ces 3 joueurs ne leur enverra pas de courriel maintenant. Leur premier courriel sera le rappel avant leur premier match.',
    off: 'Ajouter ce joueur ne lui enverra pas de courriel maintenant. Les rappels automatiques sont désactivés pour cette ligue : il ne recevra aucun courriel tant que tu ne les actives pas dans les Paramètres.',
    teamlessOne: "Ce joueur n'a pas d'équipe : il ne recevra aucun rappel tant que tu ne lui en donnes pas une.",
    teamless: "20 de ces joueurs n'ont pas d'équipe : ils ne recevront aucun rappel tant que tu ne leur en donnes pas une.",
    btnOne: 'Ajouter le joueur', btnMany: 'Ajouter les joueurs',
    date: 'jeudi 15 oct · 19 h'
  },
  en: {
    one: "Adding this player won't email them now. Their first email will be the reminder 72 hours before the next game (",
    many: "Adding these 20 players won't email them now. Their first email will be the reminder 72 hours before the next game (",
    noGame: "Adding these 3 players won't email them now. Their first email will be the reminder before their first game.",
    off: "Adding this player won't email them now. The automatic reminders are off for this league, so they will get no email until you turn them on in Settings.",
    teamlessOne: 'This player has no team: they get no reminder until you give them one.',
    teamless: '20 of these players have no team: they get no reminder until you give them one.',
    btnOne: 'Add the player', btnMany: 'Add the players',
    date: 'Thursday Oct 15 · 7 PM'
  }
};
const noticeState = page => page.evaluate(() => ({
  shown: document.getElementById('add_emails_dialog').style.display === 'flex',
  text: document.getElementById('add_notice_text').textContent.trim(),
  teamless: document.getElementById('add_notice_teamless').style.display === 'none' ? '' : document.getElementById('add_notice_teamless').textContent.trim(),
  button: document.getElementById('add_notice_ok').textContent.trim(),
  subPart: document.getElementById('add_emails_part').style.display
}));
const FORBIDDEN = /\((s|es|e)\)|—|(^|[^a-zà-ÿ])(vous|votre|vos|veuillez)(?![a-zà-ÿ])|substituts?(?![a-zà-ÿ])/i;

describe('The notice before regular players are added, once per league', () => {
  for (const lang of ['fr', 'en']) {
    it(`${lang}: one regular player, a game in 10 days: the notice, one button; closing adds nothing; the button adds the player and it never shows again`, async () => {
      const s = await h.signup(`notice.${lang}@add-emails.example`);
      const j = async (p, body) => (await h.api(p, { ...s, body })).json();
      const lg = (await j('/leagues/create', { name: 'Ligue du jeudi', teamNames: ['Bulls', 'Parade'], tracksStats: false })).league;
      await j('/league/season/publish', { season_name: 'S1' });
      await j('/league/events', { date: day(10), start_time: '19:00', end_time: '20:00', venue: 'Gym', home_team: 'Bulls', away_team: 'Parade' });
      const { page, errors, close } = await openPlayers(lang, s);
      const openForm = () => page.evaluate(() => { const p = document.getElementById('ro_panel'); if (!p.classList.contains('open')) p.classList.add('open'); });
      await openForm();
      await page.fill('#r_name', 'Rita Regular');
      await page.fill('#r_email', `rita.${lang}@add-emails.example`);
      await page.click('#r_submit');
      await page.waitForFunction(() => document.getElementById('add_emails_dialog').style.display === 'flex');
      let st = await noticeState(page);
      expect(st.text.startsWith(NOTICE[lang].one), st.text).toBe(true);
      expect(st).toMatchObject({ button: NOTICE[lang].btnOne, subPart: 'none', teamless: NOTICE[lang].teamlessOne });
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/notice_singular_${lang}.png` });
      const count = async () => (await h.db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE league_id = ? AND role = 'roster'`).bind(lg.id).first()).n;
      await page.click('#add_emails_close');
      expect(await count()).toBe(0);
      await page.click('#r_submit');
      await page.waitForFunction(() => document.getElementById('add_emails_dialog').style.display === 'flex');
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#add_notice_ok')]);
      expect(await count()).toBe(1);
      expect((await h.db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE league_id = ? AND kind != 'short_alert'`).bind(lg.id).first()).n).toBe(0);
      // Never again in this league.
      await openForm();
      await page.fill('#r_name', 'Rob Regular');
      await page.fill('#r_email', `rob.${lang}@add-emails.example`);
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#r_submit')]);
      expect(await count()).toBe(2);
      // The plural and the other cases, drawn by the same dialog.
      const show = async data => { await page.evaluate(d => openAddEmailsDialog(d, function() { return Promise.resolve({ ok: false, message: '' }); }), data); return noticeState(page); };
      st = await show({ needsRegularNotice: true, regularCount: 20, teamlessCount: 20, addCount: 20, firstEmail: { kind: 'reminder', hours: 72, soon: false, date: { fr: NOTICE.fr.date, en: NOTICE.en.date } } });
      expect(st.text).toBe(NOTICE[lang].many + NOTICE[lang].date + ').');
      expect(st).toMatchObject({ teamless: NOTICE[lang].teamless, button: NOTICE[lang].btnMany });
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/notice_plural_${lang}.png` });
      expect((await show({ needsRegularNotice: true, regularCount: 3, teamlessCount: 0, addCount: 3, firstEmail: { kind: 'none_scheduled' } })).text).toBe(NOTICE[lang].noGame);
      expect((await show({ needsRegularNotice: true, regularCount: 1, teamlessCount: 0, addCount: 1, firstEmail: { kind: 'reminders_off' } })).text).toBe(NOTICE[lang].off);
      // Regular players and a substitute: one step, both parts, the sub's buttons.
      st = await show({ needsRegularNotice: true, regularCount: 2, teamlessCount: 0, addCount: 3, needsEmailChoice: true, emailCount: 1, firstEmail: { kind: 'none_scheduled' } });
      expect(st.subPart).toBe('flex');
      expect(await page.evaluate(() => [document.getElementById('add_notice_ok').style.display, document.getElementById('add_emails_send').style.display])).toEqual(['none', '']);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/notice_combined_${lang}.png` });
      expect(await page.locator('#add_emails_dialog').innerText()).not.toMatch(FORBIDDEN);
      expect(errors).toEqual([]);
      await close();
    }, 180000);
  }
});

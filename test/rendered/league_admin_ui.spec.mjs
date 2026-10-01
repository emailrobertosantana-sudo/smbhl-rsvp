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
  // Item 6a: a row's choice of three (Joueur / Gardien / Les deux) saves at once.
  it('choosing "Les deux" in a row saves it, without opening Edit', async () => {
    const lea = await h.db.prepare(`SELECT player_id FROM contacts WHERE league_id = ? AND name = 'Lea Player'`).bind(league.league.id).first();
    const { page, errors, close } = await open('/league/roster');
    const sel = `[data-play-role="${lea.player_id}"]`;
    expect(await page.isVisible(sel)).toBe(true);
    expect(await page.isVisible(`[id="edit_row_${lea.player_id}"]`)).toBe(false);
    const flags = () => h.db.prepare('SELECT is_goalie, is_backup_goalie FROM contacts WHERE player_id = ?').bind(lea.player_id).first();
    await page.selectOption(sel, 'both');
    await page.waitForFunction(s => !document.querySelector(s).disabled, sel);
    expect(await flags()).toMatchObject({ is_goalie: 0, is_backup_goalie: 1 });
    await page.selectOption(sel, 'skater');
    await page.waitForFunction(s => !document.querySelector(s).disabled, sel);
    expect(await flags()).toMatchObject({ is_goalie: 0, is_backup_goalie: 0 });
    expect(errors).toEqual([]);
    await close();
  }, 120000);
});

describe('Comms', () => {
  // Item 11a: each automation is switched on or off right in Comms.
  it('an automation row\'s switch turns the reminder on and off', async () => {
    const lid = league.league.id;
    const get = async () => (await h.db.prepare('SELECT reminder_72h_enabled v FROM leagues WHERE id = ?').bind(lid).first()).v;
    const before = await get();
    const { page, errors, close } = await open('/league/comms');
    const sw = '[data-cadence-key="reminder72h"]';
    await page.waitForSelector(sw);
    expect(await page.getAttribute(sw, 'aria-checked')).toBe(before ? 'true' : 'false');
    await page.click(sw);
    await page.waitForFunction(([sel, want]) => document.querySelector(sel) && document.querySelector(sel).getAttribute('aria-checked') === want, [sw, before ? 'false' : 'true']);
    expect(await get()).toBe(before ? 0 : 1);
    await page.click(sw);
    await page.waitForFunction(([sel, want]) => document.querySelector(sel) && document.querySelector(sel).getAttribute('aria-checked') === want, [sw, before ? 'true' : 'false']);
    expect(await get()).toBe(before ? 1 : 0);
    expect(errors).toEqual([]);
    await close();
  }, 120000);

  // Item 11b: switched to EN after loading in FR, nothing French is left.
  it('toggled to EN, the whole page is English', async () => {
    const { page, errors, close } = await open('/league/comms');
    await page.waitForSelector('[data-cadence-key]');
    await page.evaluate(() => window.__setLang('en'));
    const text = await page.evaluate(() => document.body.innerText);
    for (const fr of ['Rappel 72 h (sans réponse)', 'Rappel 24 h (sans réponse)', 'Détails 12 h (confirmés)', 'Appel aux remplaçants', 'Alerte de désistement tardif', 'Aperçu', 'Activé', 'Désactivé', 'Aucune activité', 'Tout le monde (réguliers et substituts)']) {
      expect(text, fr).not.toContain(fr);
    }
    expect(text).toContain('72h reminder (no reply)');
    expect(text).toContain('Late dropout alert (admin)');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en-CA');
    expect(errors).toEqual([]);
    await close();
  }, 120000);
});

// Item 11b, the whole admin surface: every league admin page, loaded in FR
// and toggled to EN, reads exactly like the same page loaded in EN.
describe('Every league admin page follows the EN toggle', () => {
  const pagesToCheck = () => [
    '/dashboard', '/league/roster', '/league/schedule', '/league/settings', '/league/comms',
    ...(league.eventId ? [`/league/events/detail?e=${encodeURIComponent(league.eventId)}`] : [])
  ];
  beforeAll(async () => {
    league.eventId = (await h.db.prepare('SELECT id FROM events WHERE league_id = ? ORDER BY date DESC LIMIT 1').bind(league.league.id).first()).id;
  });
  const visibleText = page => page.evaluate(() => ({ text: document.body.innerText.replace(/\s+/g, ' ').trim(), title: document.title, lang: document.documentElement.lang }));
  it('toggled = loaded in EN, text, tab title and lang, on every page', async () => {
    const mismatches = [];
    for (const path of pagesToCheck()) {
      const en = await open(path, { lang: 'en' });
      await en.page.waitForTimeout(300);
      const a = await visibleText(en.page);
      await en.close();
      const fr = await open(path, { lang: 'fr' });
      await fr.page.waitForTimeout(300);
      await fr.page.evaluate(() => window.__setLang('en'));
      await fr.page.waitForTimeout(100);
      const b = await visibleText(fr.page);
      expect(fr.errors, path).toEqual([]);
      await fr.close();
      if (a.title !== b.title) mismatches.push(`${path} title: "${b.title}" vs "${a.title}"`);
      if (a.lang !== b.lang) mismatches.push(`${path} lang: ${b.lang} vs ${a.lang}`);
      if (a.text !== b.text) {
        const wa = a.text.split(' '), wb = b.text.split(' ');
        let i = 0; while (i < wa.length && wa[i] === wb[i]) i++;
        mismatches.push(`${path} text differs at: "${wb.slice(i, i + 12).join(' ')}" (EN load: "${wa.slice(i, i + 12).join(' ')}")`);
      }
    }
    expect(mismatches).toEqual([]);
  }, 300000);
});

// Item 10: the reminder notice on game creation.
describe('Create-game reminder notice', () => {
  const isoOf = days => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() + days * 86400000)); const g = t => p.find(x => x.type === t).value; return `${g('year')}-${g('month')}-${g('day')}`; };
  beforeAll(async () => {
    const lid = league.league.id;
    await h.db.prepare('UPDATE leagues SET reminder_72h_enabled = 1, reminder_24h_enabled = 1, reminder_12h_enabled = 1 WHERE id = ?').bind(lid).run();
    await h.db.prepare("UPDATE contacts SET email = lower(replace(name, ' ', '.')) || '@example.com' WHERE league_id = ?").bind(lid).run();
  });

  it('hidden for a game months away; for a game in 2 days it lists what goes out and what is too late', async () => {
    const { page, errors, close } = await open('/league/schedule', { lang: 'fr' });
    await page.evaluate(() => toggleSchedulePanel());
    await page.fill('#e_start', '19:00');
    await page.fill('#e_date', isoOf(90));
    expect(await page.isVisible('#e_reminder_notice')).toBe(false);
    await page.fill('#e_date', isoOf(2));
    expect(await page.isVisible('#e_reminder_notice')).toBe(true);
    const text = await page.textContent('#e_reminder_notice_body');
    expect(text).toContain('Rappel 72 h avant · trop tard, ne sera pas envoyé');
    // Under 48 h the page says hours, beyond it days: which one depends on the time of day the test runs.
    expect(text).toMatch(/Rappel 24 h avant · part dans environ (\d+ h|\d+ jours?)/);
    expect(text).toMatch(/Détails 12 h avant · part dans environ (\d+ h|\d+ jours?)/);
    expect(text).toContain("Jusqu'à 2 joueurs avec un courriel enregistré les recevront.");
    // No start time: no reminders at all, no notice.
    await page.fill('#e_start', '');
    expect(await page.isVisible('#e_reminder_notice')).toBe(false);
    expect(errors).toEqual([]);
    await close();
  }, 120000);

  it('bulk create names the games that send within 7 days, and suppresses reminders for only those', async () => {
    const lid = league.league.id;
    const { page, errors, close } = await open('/league/schedule', { lang: 'fr' });
    await page.evaluate(() => toggleBulkPanel());
    await page.fill('#be_start', '19:00');
    await page.fill('#be_end', '20:00');
    await page.fill('#be_occurrences', '4');
    await page.fill('#be_start_date', isoOf(2));
    expect(await page.isVisible('#be_reminder_notice')).toBe(true);
    const items = await page.$$eval('#be_reminder_notice_body li', lis => lis.length);
    expect(items).toBe(2); // +2 days (24 h / 12 h soon) and +9 days (its 72 h reminder in 6 days)
    expect(await page.textContent('#be_suppress_soon_label')).toBe('Ne pas envoyer de rappels automatiques pour ces 2 matchs seulement (les autres gardent les leurs)');
    await page.check('#be_suppress_soon');
    await Promise.all([page.waitForNavigation().catch(() => {}), page.evaluate(() => submitBulkEvents())]);
    const rows = (await h.db.prepare('SELECT date, auto_reminders_enabled a FROM events WHERE league_id = ? AND date IN (?, ?, ?, ?) ORDER BY date')
      .bind(lid, isoOf(2), isoOf(9), isoOf(16), isoOf(23)).all()).results;
    expect(rows.map(r => [r.date, r.a])).toEqual([[isoOf(2), 0], [isoOf(9), 0], [isoOf(16), 1], [isoOf(23), 1]]);
    expect(errors).toEqual([]);
    await close();
  }, 120000);
});

// Item 9: the create-game forms are narrow but centred, and wide enough that
// labels and placeholders fit (at 1450px the map-link label wrapped and the
// address placeholder was cut at "123 rue Principale, Vill").
describe('Create-game form layout at 1450px', () => {
  for (const [label, panelFn, panelSel, prefix] of [['single', 'toggleSchedulePanel', '#sc_panel', 'e'], ['bulk', 'toggleBulkPanel', '#sc_bulk_panel', 'be']]) {
    it(`${label}: centred, no wrapped label, no cut-off placeholder`, async () => {
      const { page, errors, close } = await open('/league/schedule', { lang: 'fr' });
      await page.setViewportSize({ width: 1450, height: 1000 });
      await page.evaluate(fn => window[fn](), panelFn);
      const m = await page.evaluate(([sel, pre]) => {
        const panel = document.querySelector(sel).getBoundingClientRect();
        const main = document.querySelector('.sc-main').getBoundingClientRect();
        const lbl = document.querySelector(`label[for="${pre}_venue_map_link"]`);
        const lh = parseFloat(getComputedStyle(lbl).lineHeight) || 20;
        const addr = document.getElementById(`${pre}_venue_address`);
        const cs = getComputedStyle(addr);
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const room = addr.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        return { left: panel.left - main.left, right: main.right - panel.right, width: panel.width, labelLines: Math.round(lbl.getBoundingClientRect().height / lh), placeholderFits: ctx.measureText(addr.placeholder).width <= room };
      }, [panelSel, prefix]);
      expect(Math.abs(m.left - m.right)).toBeLessThan(40); // centred (scrollbar tolerance)
      expect(m.width).toBeLessThanOrEqual(640);
      expect(m.labelLines).toBe(1);
      expect(m.placeholderFits).toBe(true);
      expect(errors).toEqual([]);
      await close();
    }, 120000);
  }
});

describe('Schedule', () => {
  // Follow-up batch, item 3e: the Assign matchups panel sits below the
  // whole event list; opening it now scrolls it into view, like the
  // create panels.
  // Item 4: what a real time picker sends for 10:30 in the morning is
  // what gets stored -- the browser's 24-hour value, no conversion.
  // Item 2 (follow-up): 23:30 to 00:30 is a one-hour game -- no warning,
  // and it is stored as ending at 00:30. More than 6 hours still asks.
  it('bulk create 11:30 PM to 12:30 AM: no warning, end stored as 00:30', async () => {
    const { page, errors, close } = await open('/league/schedule');
    const dialogs = [];
    page.on('dialog', d => dialogs.push(d.message()));
    await page.click('.sc-top [onclick="openBulkPanel()"]');
    await page.fill('#be_start_date', '2099-10-04');
    await page.fill('#be_occurrences', '1');
    await page.fill('#be_start', '23:30');
    await page.fill('#be_end', '00:30');
    const answered = page.waitForResponse(r => r.url().endsWith('/league/events/bulk'));
    await page.click('#be_submit');
    expect((await answered).status()).toBe(200);
    await page.waitForLoadState('load');
    expect(dialogs).toEqual([]);
    const row = await h.db.prepare("SELECT start_time, end_time FROM events WHERE league_id = ? AND date = '2099-10-04'").bind(league.league.id).first();
    expect([row.start_time, row.end_time]).toEqual(['23:30', '00:30']);
    expect(errors).toEqual([]);
    await close();
  }, 120000);

  for (const [lang, want] of [['fr', 'Ce match durerait 7 h (18:00 à 01:00). Continuer quand même?'], ['en', 'This game would last 7h (18:00 to 01:00). Continue anyway?']]) it(`an implausible length still warns, with the length (${lang}): 18:00 to 01:00 is 7 h`, async () => {
    const { page, close } = await open('/league/schedule', { lang });
    const dialogs = [];
    page.on('dialog', d => dialogs.push(d.message()));
    await page.click('.sc-top [onclick="openSchedulePanel()"]');
    await page.fill('#e_date', lang === 'fr' ? '2099-10-11' : '2099-10-18');
    await page.fill('#e_start', '18:00');
    await page.fill('#e_end', '01:00');
    await page.click('#e_submit');
    await page.waitForFunction(() => true);
    await page.waitForTimeout(300);
    expect(dialogs).toEqual([want]);
    await close();
  }, 120000);

  it('bulk create: 10:30 AM typed in the picker is sent and stored as 10:30', async () => {
    const { page, errors, close } = await open('/league/schedule');
    await page.click('.sc-top [onclick="openBulkPanel()"]');
    await page.fill('#be_start_date', '2099-09-06');
    await page.fill('#be_occurrences', '2');
    await page.click('#be_start'); await page.keyboard.type('1030A');
    await page.click('#be_end'); await page.keyboard.type('1130A');
    const answered = page.waitForResponse(r => r.url().endsWith('/league/events/bulk'));
    await page.click('#be_submit');
    const res = await answered;
    const body = JSON.parse(res.request().postData());
    expect([body.start_time, body.end_time]).toEqual(['10:30', '11:30']);
    expect(res.status()).toBe(200);
    await page.waitForLoadState('load');
    const rows = (await h.db.prepare("SELECT start_time, end_time FROM events WHERE league_id = ? AND date IN ('2099-09-06', '2099-09-13')").bind(league.league.id).all()).results;
    expect(rows.map(r => r.start_time + '-' + r.end_time)).toEqual(['10:30-11:30', '10:30-11:30']);
    expect(errors).toEqual([]);
    await close();
  }, 120000);

  // Item 4 (follow-up): the matchup is the row's headline, not small grey
  // text weighted like the venue; the row's cells stay on one line.
  for (const width of [1200, 400]) it(`the matchup leads the Schedule row at ${width}px`, async () => {
    const { page, errors, close } = await open('/league/schedule');
    await page.setViewportSize({ width, height: 900 });
    const row = page.locator('.sc-game-row', { has: page.locator('.sc-matchup') }).first();
    const m = await row.locator('.sc-matchup').evaluate(el => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return { size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight), color: cs.color, top: r.top, left: r.left }; });
    const v = await row.locator('.sc-venue').evaluate(el => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return { size: parseFloat(cs.fontSize), color: cs.color, top: r.top }; });
    const when = await row.locator('.sc-when').evaluate(el => { const r = el.getBoundingClientRect(); return { right: r.right, top: r.top, bottom: r.bottom }; });
    expect(m.size).toBeGreaterThanOrEqual(18);
    expect(m.weight).toBeGreaterThanOrEqual(700);
    expect(m.size).toBeGreaterThan(v.size);
    expect(m.color).not.toBe(v.color);
    expect(v.top).toBeGreaterThan(m.top);             // the venue under it, not beside it
    expect(m.left).toBeGreaterThanOrEqual(when.right); // beside the date, in the same line
    expect(m.top).toBeLessThan(when.bottom);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await close();
  }, 120000);

  // Item 3a (follow-up): one game's matchup, changed from its row.
  it('Edit matchup changes that one game from the Schedule row, nothing else', async () => {
    const ev = await h.db.prepare("SELECT id FROM events WHERE league_id = ? AND date = '2099-01-05'").bind(league.league.id).first();
    const { page, errors, close } = await open('/league/schedule');
    await page.click(`[onclick="toggleMatchupEdit('${ev.id}')"]`);
    expect(await page.isVisible(`[id="mx_edit_${ev.id}"]`)).toBe(true);
    await page.selectOption(`[id="mx_home_${ev.id}"]`, 'Bears');
    await page.selectOption(`[id="mx_away_${ev.id}"]`, 'Otters');
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click(`[id="mx_edit_${ev.id}"] [data-i18n="matchupSaveBtn"]`)]);
    const row = await h.db.prepare('SELECT home_team, away_team, start_time FROM events WHERE id = ?').bind(ev.id).first();
    expect(row).toEqual({ home_team: 'Bears', away_team: 'Otters', start_time: '20:30' });
    expect(errors).toEqual([]);
    await close();
  }, 120000);

  // Item 4 (follow-up): the same scroll-into-view as Assign matchups, for
  // the other panels -- bulk create, and a row's Duplicate.
  it('Create multiple games and Duplicate open IN VIEW too, focused', async () => {
    const { page, errors, close } = await open('/league/schedule');
    await page.setViewportSize({ width: 1200, height: 700 });
    const inView = sel => page.waitForFunction(q => { const el = document.querySelector(q); if (!el) return false; const r = el.getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 1; }, sel, { timeout: 5000 });
    await page.click('.sc-top [onclick="openBulkPanel()"]');
    await inView('#be_start_date');
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('be_start_date');
    // The last row's Duplicate, from the top of the page.
    await page.evaluate(() => window.scrollTo(0, 0));
    const last = await page.$$eval('[id^="dup_date_"]', els => els[els.length - 1].id);
    const evId = last.slice('dup_date_'.length);
    await page.evaluate(id => window.toggleDuplicateRow(id), evId);
    await inView('[id="' + last + '"]');
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe(last);
    expect(errors).toEqual([]);
    await close();
  }, 120000);

  it('Assign matchups opens its panel IN VIEW, even below a long list', async () => {
    for (let i = 0; i < 16; i++) {
      const d = new Date(Date.UTC(2099, 1, 1 + i * 7)).toISOString().slice(0, 10);
      await h.api('/league/events', { ...league.session, body: { date: d, season: 'S1', start_time: '19:00', end_time: '20:00' } });
    }
    const { page, errors, close } = await open('/league/schedule');
    const panel = '#sc_matchups_panel';
    expect(await page.isVisible(panel)).toBe(false);
    await page.click('.sc-top [onclick="toggleMatchupsPanel()"]');
    await page.waitForFunction(sel => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return r.height > 0 && r.top >= 0 && r.top < window.innerHeight;
    }, panel, { timeout: 5000 });
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('mx_preview_btn');
    expect(errors).toEqual([]);
    await close();
  }, 120000);
});

describe('Event page result', () => {
  // Follow-up batch, item 5: the form is closed until its button opens it
  // (never both at once), and the result reads as one scoreline --
  // Otters [5] — [3] Bears, Save beside it -- at desktop and phone width.
  for (const width of [1200, 400]) {
    it(`the result form swaps with its button, and is one line at ${width}px`, async () => {
      const past = await h.db.prepare("SELECT id FROM events WHERE league_id = ? AND date = '2020-01-05'").bind(league.league.id).first();
      const { page, errors, close } = await open('/league/events/detail?e=' + encodeURIComponent(past.id));
      await page.setViewportSize({ width, height: 900 });
      expect(await page.isVisible('#score_form')).toBe(false);
      expect(await page.isVisible('#score_toggle_wrap button')).toBe(true);
      await page.click('#score_toggle_wrap button');
      expect(await page.isVisible('#score_form')).toBe(true);
      expect(await page.isVisible('#score_toggle_wrap button')).toBe(false);
      const mid = sel => page.$eval(sel, el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; });
      const home = await mid('#score_home');
      for (const sel of ['#score_home_label', '#score_away', '#score_away_label']) expect(Math.abs((await mid(sel)) - home)).toBeLessThan(6);
      if (width >= 1200) expect(Math.abs((await mid('[data-i18n="scoreSaveBtn"]')) - home)).toBeLessThan(6);
      const w = await page.$eval('#score_home', el => el.getBoundingClientRect().width);
      expect(w).toBeLessThan(90);
      await page.click('[data-i18n="scoreCancelBtn"]');
      expect(await page.isVisible('#score_form')).toBe(false);
      expect(await page.isVisible('#score_toggle_wrap button')).toBe(true);
      expect(errors).toEqual([]);
      await close();
    }, 120000);
  }
});

describe('Import, with reminders on (D6)', () => {
  // Reminders are on for a new league: an import days before a game would
  // email the whole list at the next pass. The import preview names the
  // games that would, and can hold their reminders first.
  it('the preview names a game about to send, and holding it pauses that game before importing', async () => {
    const lid = league.league.id;
    const at = new Date(Date.now() + 30 * 3600000);
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(at);
    const g = t => p.find(x => x.type === t).value;
    const date = `${g('year')}-${g('month')}-${g('day')}`, time = `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
    const evId = `${lid}:imp:${date}`;
    await h.db.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, auto_reminders_enabled) VALUES (?, 'S1', 9, ?, 'Gym', 'open', ?, ?, 1)`).bind(evId, date, time, lid).run();
    const { page, errors, close } = await open('/league/roster');
    await page.click('#ro_toggle_bulk');
    await page.fill('#ro_bulk_text', 'Imp One, imp.one@example.com\nImp Two, imp.two@example.com');
    await page.click('[data-i18n="bulkPreviewBtn"]');
    await page.waitForSelector('#ro_bulk_rem_notice', { state: 'visible' });
    const notice = await page.textContent('#ro_bulk_rem_notice');
    // In the admin's language (an earlier test may have switched it to English).
    expect(notice).toMatch(/Ces matchs enverront des rappels aux joueurs importés dans les 7 prochains jours :|These games will send reminders to the imported players within the next 7 days:/);
    expect(notice).toContain(time);
    expect(notice).toMatch(/rappel 24 h|24h reminder/);
    expect(notice).toMatch(/Ne pas envoyer de rappels automatiques pour ce match|Don't send automatic reminders for this game/);
    await page.check('#ro_bulk_rem_suppress');
    // The league's first add of regular players from the page: the notice
    // of when they get their first email comes first (test/part185).
    await page.click('#ro_bulk_confirm');
    await page.waitForFunction(() => document.getElementById('add_emails_dialog').style.display === 'flex');
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#add_notice_ok')]);
    expect((await h.db.prepare('SELECT auto_reminders_enabled v FROM events WHERE id = ?').bind(evId).first()).v).toBe(0);
    expect((await h.db.prepare(`SELECT count(*) n FROM contacts WHERE league_id = ? AND email IN ('imp.one@example.com', 'imp.two@example.com')`).bind(lid).first()).n).toBe(2);
    expect(errors).toEqual([]);
    await close();
  }, 120000);
});

describe('Finances', () => {
  // Six tabs now (Finances added): at phone width the tab bar and the page
  // fit, in both languages, and pricing saves from the page itself.
  for (const lang of ['fr', 'en']) {
    it(`at 390 px (${lang}): no sideways scroll, every tab and its label inside the screen; the pricing form saves`, async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.addCookies(league.session.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
      await context.addInitScript(l => { try { localStorage.setItem('smbhl_admin_lang', l); } catch (e) {} }, lang);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
      await page.goto(h.baseUrl + '/league/finances', { waitUntil: 'load' });
      await page.waitForSelector('#fin-tiles .fin-tile');
      const m = await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('.nl-tabbar a')].map(a => {
          const r = a.getBoundingClientRect(); const span = a.querySelector('span');
          return { left: r.left, right: r.right, label: span.textContent, clipped: span.scrollWidth > span.clientWidth + 1 };
        });
        return { scrollW: document.documentElement.scrollWidth, tabs };
      });
      expect(m.scrollW).toBeLessThanOrEqual(390);
      expect(m.tabs.length).toBe(6);
      for (const t of m.tabs) {
        expect(t.left, t.label).toBeGreaterThanOrEqual(0);
        expect(t.right, t.label).toBeLessThanOrEqual(390);
        expect(t.clipped, t.label).toBe(false);
      }
      await page.check('input[name="fin-mode"][value="per_game"]');
      expect(await page.isVisible('#fin-price-player')).toBe(false); // season fee only in the season mode
      await page.fill('#fin-game-player', '12');
      await page.click('#fin-save-pricing');
      await page.waitForFunction(() => document.getElementById('fin-pricing-msg').textContent.length > 0);
      const row = await h.db.prepare(`SELECT pricing_mode, price_sub_player FROM season_pricing WHERE league_id = ?`).bind(league.league.id).first();
      expect(row).toEqual({ pricing_mode: 'per_game', price_sub_player: 12 });
      expect(errors).toEqual([]);
      await context.close();
    }, 120000);
  }
});

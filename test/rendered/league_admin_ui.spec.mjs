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
    expect(text).toContain('Rappel 72 h avant — trop tard, ne sera pas envoyé');
    expect(text).toMatch(/Rappel 24 h avant — part dans environ \d+ h/);
    expect(text).toMatch(/Détails 12 h avant — part dans environ \d+ h/);
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

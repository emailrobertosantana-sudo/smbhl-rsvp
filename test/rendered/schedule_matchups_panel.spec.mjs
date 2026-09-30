// The Schedule page's "Assign matchups" panel in a real browser.
//
// Where it is: at the top of the page, under the header buttons and the
// "Next step" card, above the game list (it used to be after the whole
// list). Opening it from the header button or from the "Next step" card
// scrolls it into view and puts the focus inside it. A game's own "Set
// matchup" button does not open the panel: it opens that one game's
// editor on its row, in view, with the focus in it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, launchChromium } from './support/public_page_harness.mjs';

let h, browser, single, double;
const SHOTS = process.env.MATCHUPS_PANEL_SHOTS || null; // a folder: screenshots and panel HTML for the report

// Four fixed teams and a season; `slots` are [start, end] pairs, each one
// a weekly series of `weeks` games from the same first date.
async function seedLeague(email, name, slots, weeks) {
  const s = await h.signup(email);
  const j = async (p, body) => (await h.api(p, { ...s, body })).json();
  const league = (await j('/leagues/create', { name, teamNames: ['Red', 'Blue', 'White', 'Black'], tracksStats: false })).league;
  await j('/league/season/publish', { season_name: 'S1' });
  for (const [start, end] of slots) {
    const r = await j('/league/events/bulk', { startDate: '2099-01-05', occurrences: weeks, start_time: start, end_time: end, venue: 'Gym' });
    if (!r.ok) throw new Error('seed: ' + JSON.stringify(r));
  }
  return { league, session: s };
}

beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { RSVP_SECRET: 'matchups-panel' } });
  single = await seedLeague('owner@one-game.example', 'One Game A Night', [['19:00', '20:00']], 12);
  double = await seedLeague('owner@two-games.example', 'Two Games A Night', [['19:00', '20:00'], ['20:00', '21:00']], 6);
  browser = await launchChromium();
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

async function openSchedule(league, lang) {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await context.addCookies(league.session.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
  await context.addInitScript(l => { try { localStorage.setItem('smbhl_admin_lang', l); } catch (e) {} }, lang);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
  await page.goto(h.baseUrl + '/league/schedule', { waitUntil: 'load' });
  return { page, errors, close: () => context.close() };
}

// Where the panel is, and whether it is on screen with the focus in it.
const panelState = page => page.evaluate(() => {
  const panel = document.getElementById('sc_matchups_panel');
  const list = document.getElementById('scheduleList');
  const top = document.querySelector('.sc-top');
  const next = document.getElementById('sc_next_step');
  const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const r = panel.getBoundingClientRect();
  return {
    open: panel.classList.contains('open'),
    afterHeader: before(top, panel),
    afterNextStep: next ? before(next, panel) : null,
    beforeList: before(panel, list),
    aboveList: r.bottom <= list.getBoundingClientRect().top,
    onScreen: r.top >= 0 && r.top < window.innerHeight,
    focusInside: panel.contains(document.activeElement),
    focused: document.activeElement ? document.activeElement.id : ''
  };
});
// The scroll is smooth: wait until the page has stopped moving.
const settled = async page => {
  await page.waitForTimeout(150);
  await page.waitForFunction(() => {
    const y = window.scrollY; return new Promise(res => setTimeout(() => res(window.scrollY === y), 300));
  });
};

describe('Assign matchups: the panel is at the top, in view, with the focus', () => {
  for (const lang of ['fr', 'en']) {
    it(`${lang}: the header button opens it above the game list, on screen, focus inside`, async () => {
      const { page, errors, close } = await openSchedule(single, lang);
      // From the bottom of a long list: the page has to come back up to it.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.evaluate(() => document.querySelector('.sc-top button[onclick="toggleMatchupsPanel()"]').click());
      await settled(page);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/panel_header_${lang}.png` });
      expect(await panelState(page)).toEqual({ open: true, afterHeader: true, afterNextStep: true, beforeList: true, aboveList: true, onScreen: true, focusInside: true, focused: 'mx_preview_btn' });
      expect(errors).toEqual([]);
      await close();
    }, 120000);

    it(`${lang}: the "Next step" card's button opens the same panel, right under the card`, async () => {
      const { page, errors, close } = await openSchedule(single, lang);
      await page.click('#sc_next_step button');
      await settled(page);
      const st = await panelState(page);
      expect(st).toMatchObject({ open: true, afterNextStep: true, beforeList: true, aboveList: true, onScreen: true, focusInside: true });
      // Directly under the card: nothing but the page's gap between them.
      const gap = await page.evaluate(() => document.getElementById('sc_matchups_panel').getBoundingClientRect().top - document.getElementById('sc_next_step').getBoundingClientRect().bottom);
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(32);
      expect(errors).toEqual([]);
      await close();
    }, 120000);

    it(`${lang}: a game's "Set matchup" opens that game's editor on its row, on screen, focus in it; the panel stays closed`, async () => {
      const { page, errors, close } = await openSchedule(single, lang);
      const id = await page.evaluate(() => {
        const rows = document.querySelectorAll('.sc-game-row button[onclick^="toggleMatchupEdit"]');
        const btn = rows[rows.length - 1]; // the last game: far down the list
        btn.scrollIntoView(); btn.click();
        return btn.getAttribute('onclick').match(/'([^']+)'/)[1];
      });
      await settled(page);
      const st = await page.evaluate(i => {
        const ed = document.getElementById('mx_edit_' + i); const r = ed.getBoundingClientRect();
        return { shown: ed.style.display !== 'none', onScreen: r.top >= 0 && r.bottom <= window.innerHeight, focused: document.activeElement.id, panelOpen: document.getElementById('sc_matchups_panel').classList.contains('open') };
      }, id);
      expect(st).toEqual({ shown: true, onScreen: true, focused: 'mx_home_' + id, panelOpen: false });
      expect(errors).toEqual([]);
      await close();
    }, 120000);
  }
});

// A schedule of one game a night says nothing about playing twice in a
// night: no sentence, and the table has the team and its games only. With
// two games a night the sentence and the "nights with two or more games"
// column are there, in the preview and on the Schedule page's card.
const DOUBLES = { fr: 'Soirs à deux matchs ou plus', en: 'Nights with two or more games' };
const NOBODY = { fr: "Personne n'a besoin de jouer deux fois le même soir. Personne ne le fait.", en: 'Nobody needs to play twice in a night. Nobody does.' };
const HEADS = { fr: ['Équipe', 'Matchs'], en: ['Team', 'Games'] };

async function previewState(page) {
  await page.evaluate(() => toggleMatchupsPanel());
  await page.click('#mx_preview_btn');
  await page.waitForSelector('#mx_dist_table');
  return page.evaluate(() => ({
    heads: [...document.querySelectorAll('#mx_dist_table th')].map(th => th.textContent),
    cells: document.querySelectorAll('#mx_dist_table tr')[1].children.length,
    summary: document.getElementById('mx_dist_summary') ? document.getElementById('mx_dist_summary').textContent : null,
    text: document.getElementById('sc_matchups_panel').innerText
  }));
}
const cardState = page => page.evaluate(() => {
  const card = document.getElementById('sc_distribution');
  const p = card.querySelector('p.nl-help');
  return { heads: [...card.querySelectorAll('th')].map(th => th.textContent), cells: card.querySelector('tbody tr').children.length, summary: p ? p.textContent : null, text: card.innerText };
});
async function saveProof(page, selector, name, lang) {
  if (!SHOTS) return;
  const fs = await import('node:fs');
  await page.locator(selector).screenshot({ path: `${SHOTS}/${name}_${lang}.png` });
  fs.writeFileSync(`${SHOTS}/${name}_${lang}.html`, await page.locator(selector).evaluate(el => el.outerHTML));
}

describe('Game distribution: playing twice in a night is only mentioned when a night has two games', () => {
  for (const lang of ['fr', 'en']) {
    it(`${lang}: preview, one game a night: Team and Games only, no sentence`, async () => {
      const { page, errors, close } = await openSchedule(single, lang);
      const st = await previewState(page);
      await saveProof(page, '#sc_matchups_panel', 'preview_one_game', lang);
      expect(st.heads).toEqual(HEADS[lang]);
      expect(st.cells).toBe(2);
      expect(st.summary).toBe(null);
      expect(st.text).not.toContain(DOUBLES[lang]);
      expect(st.text).not.toContain(NOBODY[lang].split('.')[0]);
      expect(errors).toEqual([]);
      await close();
    }, 120000);

    it(`${lang}: preview, two games a night: the sentence and the third column`, async () => {
      const { page, errors, close } = await openSchedule(double, lang);
      const st = await previewState(page);
      await saveProof(page, '#sc_matchups_panel', 'preview_two_games', lang);
      expect(st.heads).toEqual([...HEADS[lang], DOUBLES[lang]]);
      expect(st.cells).toBe(3);
      expect(st.summary).toBe(NOBODY[lang]);
      expect(errors).toEqual([]);
      await close();
    }, 120000);
  }

  it('after assigning: the Schedule page card follows the same rule, FR and EN', async () => {
    for (const league of [single, double]) {
      const res = await (await h.api('/league/season/matchups-confirm', { ...league.session, body: { mode: 'fill_blanks' } })).json();
      expect(res.ok).toBe(true);
    }
    for (const lang of ['fr', 'en']) {
      let { page, errors, close } = await openSchedule(single, lang);
      let st = await cardState(page);
      await saveProof(page, '#sc_distribution', 'card_one_game', lang);
      expect(st).toMatchObject({ heads: HEADS[lang], cells: 2, summary: null });
      expect(st.text).not.toContain(DOUBLES[lang]);
      expect(errors).toEqual([]);
      await close();
      ({ page, errors, close } = await openSchedule(double, lang));
      st = await cardState(page);
      await saveProof(page, '#sc_distribution', 'card_two_games', lang);
      expect(st).toMatchObject({ heads: [...HEADS[lang], DOUBLES[lang]], cells: 3, summary: NOBODY[lang] });
      expect(errors).toEqual([]);
      await close();
    }
  }, 240000);
});

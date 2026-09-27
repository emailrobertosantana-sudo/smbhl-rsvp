// Public page QA batch, Groups B and C2 -- locked from a RENDERED page.
//
//  B1: the header reaches both window edges (nlDocument never reset the
//      browser's 8px body margin).
//  B3/C2: tables at phone width. The original proof data only had
//      short names, so nothing had ever checked what a realistic long
//      team or player name does at 390px. Every table must stay inside
//      the viewport (its own scroll wrapper may scroll; the PAGE never
//      scrolls sideways), name cells are left-aligned and never
//      clipped, and a league with ordinary names fits a phone outright:
//      one line per name, every column visible.
//  C2: every other place a long name lands (team tiles, leaders, the
//      next-game card, recent results) never pushes the page wider than
//      the phone or spills out of its own box.
//  B4: History's "All time" row leads somewhere that actually shows
//      all-time numbers.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, seedPopulatedLeague, launchChromium } from './support/public_page_harness.mjs';
import { showSection } from './support/measure.mjs';

const THEMES = ['arene', 'clean', 'classique', 'quartier'];
const LONG_TEAMS = ['Les Castors de Saint-Michel-des-Saints', 'Les Harfangs de Notre-Dame-de-Grâce'];
const LONG_PLAYER = 'Jean-François Tremblay-Desrosiers';
const LONG_GOALIE = 'Marie-Ève Bouchard-Lefebvre';

let h, browser, longLeague, shortLeague;

beforeAll(async () => {
  h = await startPublicPageWorker();
  longLeague = await seedPopulatedLeague(h, { email: 'layout.long@example.com', name: 'Ligue de hockey récréatif du Plateau-Mont-Royal', teamNames: LONG_TEAMS, playerName: LONG_PLAYER, goalieName: LONG_GOALIE });
  shortLeague = await seedPopulatedLeague(h, { email: 'layout.short@example.com', name: 'Layout Short League', teamNames: ['Rouge', 'Bleu'], playerName: 'Populated Top Player', goalieName: 'Populated Goalie Player' });
  browser = await launchChromium();
}, 180000);

afterAll(async () => {
  await browser?.close();
  await h?.dispose();
});

function measureLayout() {
  const vw = document.documentElement.clientWidth;
  const out = { vw, pageScrollWidth: document.documentElement.scrollWidth, header: null, tables: [], spills: [] };
  const hdr = document.querySelector('.nl-header').getBoundingClientRect();
  out.header = { left: hdr.left, right: hdr.right };
  for (const wrap of document.querySelectorAll('.pb-table-wrap')) {
    if (!wrap.getClientRects().length) continue;
    const w = wrap.getBoundingClientRect(); const t = wrap.querySelector('table').getBoundingClientRect();
    const names = [...wrap.querySelectorAll('td.pb-nm')].map(td => {
      const span = td.querySelector('.pb-nm-t') || td;
      const lh = parseFloat(getComputedStyle(span).lineHeight) || 20;
      return { text: td.textContent.trim(), align: getComputedStyle(td).textAlign, lines: Math.round(span.getBoundingClientRect().height / lh), clipped: span.scrollWidth > span.clientWidth + 1 || td.scrollWidth > td.clientWidth + 1 };
    });
    out.tables.push({ id: wrap.closest('section').id, wrapLeft: w.left, wrapRight: w.right, tableRight: t.right, names });
  }
  // Anything with a long name in it must stay inside its own box.
  for (const el of document.querySelectorAll('.pb-tg div, .pb-lead-name, .pb-hero-matchup, .pb-g-score, .pb-g-matchup, .pb-draw-team-name')) {
    if (!el.getClientRects().length) continue;
    const r = el.getBoundingClientRect();
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 || r.right > vw + 0.5) out.spills.push(el.className + ': ' + el.textContent.trim().slice(0, 40));
  }
  return out;
}

async function sweep(league, theme, width) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${h.baseUrl}/${league.slug}?theme=${theme}`);
  const sections = await page.$$eval('.pb-nav-link', ls => ls.map(l => l.getAttribute('data-section')));
  const results = [];
  for (const s of sections) { await showSection(page, s); results.push({ section: s, ...(await page.evaluate(measureLayout)) }); }
  await page.close();
  return results;
}

describe('Public page layout, measured from the rendered page', () => {
  for (const theme of THEMES) {
    it(`${theme}: header is edge to edge and long team/player names never break the page at 390px or 1440px`, async () => {
      const problems = [];
      let tablesSeen = 0;
      for (const width of [1440, 390]) {
        for (const r of await sweep(longLeague, theme, width)) {
          const where = `${theme} ${width}px #${r.section}`;
          if (r.header.left !== 0 || Math.round(r.header.right) !== r.vw) problems.push(`${where}: header spans ${r.header.left}..${r.header.right} of ${r.vw}`);
          if (r.pageScrollWidth > r.vw) problems.push(`${where}: page scrolls sideways (${r.pageScrollWidth} > ${r.vw})`);
          for (const t of r.tables) {
            tablesSeen++;
            if (t.wrapLeft < 0 || t.wrapRight > r.vw + 0.5) problems.push(`${where}: table wrapper ${t.wrapLeft}..${t.wrapRight} leaves the viewport`);
            for (const n of t.names) {
              if (n.align !== 'left' && n.align !== 'start') problems.push(`${where}: name "${n.text}" is ${n.align}-aligned`);
              if (n.clipped) problems.push(`${where}: name "${n.text}" is clipped`);
              if (n.lines > 2) problems.push(`${where}: name "${n.text}" wraps to ${n.lines} lines`);
            }
          }
          for (const s of r.spills) problems.push(`${where}: overflows its box -- ${s}`);
        }
      }
      expect(problems).toEqual([]);
      expect(tablesSeen).toBeGreaterThan(0);
    }, 300000);

    it(`${theme}: a league with ordinary names fits a 390px phone outright -- one line per name, every column visible`, async () => {
      const problems = [];
      let tablesSeen = 0;
      for (const r of await sweep(shortLeague, theme, 390)) {
        for (const t of r.tables) {
          tablesSeen++;
          if (t.tableRight > t.wrapRight + 0.5) problems.push(`#${r.section}: table is ${Math.round(t.tableRight - t.wrapRight)}px wider than the phone`);
          for (const n of t.names) if (n.lines !== 1) problems.push(`#${r.section}: "${n.text}" wraps to ${n.lines} lines`);
        }
      }
      expect(problems).toEqual([]);
      expect(tablesSeen).toBe(3); // standings, players, goalies -- guards against a vacuous pass
    }, 300000);
  }

  it('History: the All time row opens a section that shows all-time numbers, not the History list again', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${h.baseUrl}/${shortLeague.slug}#history`);
    await showSection(page, 'history');
    await page.click('a.pb-g-link[href*="season=all"]');
    await page.waitForURL(/season=all/);
    await page.waitForFunction(() => document.getElementById('standings').style.display !== 'none');
    const visible = await page.evaluate(() => ({
      standingsRows: document.querySelectorAll('#standings tbody tr').length,
      banner: document.querySelector('.pb-season-banner')?.textContent.trim()
    }));
    expect(visible.standingsRows).toBeGreaterThan(0);
    expect(visible.banner).toBeTruthy();
    await page.close();
  });
});

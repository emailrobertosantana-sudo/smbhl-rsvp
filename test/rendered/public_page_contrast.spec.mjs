// Public page QA batch, Group A -- locked from a RENDERED page.
//
// A previous pass "verified" every theme's contrast from token values
// and shipped two themes with invisible text: the ratios had been
// computed against the wrong backgrounds. Arène's nav rendered
// near-black on near-black (the base stylesheet's `.nl a` rule,
// specificity 0,1,1, silently beat `.pb-nav-link`, 0,1,0), Épuré/
// Quartier put dark text on the league-coloured next-game card (1.06:1
// / 1.31:1 -- the card's fill is an inline style no theme rule can
// override), and several labels read the OS-reactive --ink-muted token
// on a fixed dark card. Every assertion here is measured in Chromium,
// under BOTH OS colour-scheme preferences (the a236130 bug class only
// shows up under one of them), at desktop and phone widths, in every
// nav section, for all four themes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, seedPopulatedLeague, seedBareLeague, saveTheme, launchChromium } from './support/public_page_harness.mjs';
import { domContrast, pixelContrast, showSection } from './support/measure.mjs';

const THEMES = ['arene', 'clean', 'classique', 'quartier'];
const SCHEMES = ['light', 'dark'];
const WIDTHS = [1440, 390];

// The elements this batch was about, each checked BOTH ways (computed
// colour vs composited real background, and painted pixels).
const TARGETS = [
  ['nav link', '.pb-nav-link'],
  ['next-game card text', '.pb-hero .overline, .pb-hero-when, .pb-hero-matchup, .pb-hero-venue'],
  ['language toggle', '.nl-lang button'],
  ['leaders label', '.pb-lead-card .overline'],
  ['empty-state message', '.nl-help, .pb-empty'],
];

let h, browser, populated, bare;

beforeAll(async () => {
  h = await startPublicPageWorker();
  populated = await seedPopulatedLeague(h, { email: 'contrast.pop@example.com', name: 'Contrast Populated League', teamNames: ['Rouge', 'Bleu'], playerName: 'Populated Top Player', goalieName: 'Populated Goalie Player' });
  bare = await seedBareLeague(h, { email: 'contrast.bare@example.com', name: 'Contrast Bare League' });
  browser = await launchChromium();
}, 180000);

afterAll(async () => {
  await browser?.close();
  await h?.dispose();
});

async function auditLeague(league, theme) {
  const failures = [];
  const seen = { nav: 0, hero: 0, lang: 0, leaders: 0 };
  for (const scheme of SCHEMES) for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme });
    const page = await ctx.newPage();
    await page.goto(`${h.baseUrl}/${league.slug}`);
    const sections = await page.$$eval('.pb-nav-link', ls => ls.map(l => l.getAttribute('data-section')));
    for (const section of sections) {
      await showSection(page, section);
      const where = `${theme} / ${scheme} OS / ${width}px / #${section}`;
      // 1) Every visible text element on the page, not just the targets.
      for (const d of await domContrast(page)) {
        if (d.ratio < d.need) failures.push(`${where}: ${d.sel} "${d.text}" ${d.ratio}:1 < ${d.need}:1 (fg ${d.fg} on ${d.bg})`);
      }
      // 2) The named targets, by painted pixels.
      for (const [label, sel] of TARGETS) {
        for (const el of await page.$$(sel)) {
          if (!(await el.isVisible())) continue;
          const text = (await el.textContent()).trim();
          if (!text) continue;
          if (label === 'nav link') seen.nav++;
          if (label === 'next-game card text') seen.hero++;
          if (label === 'language toggle') seen.lang++;
          if (label === 'leaders label') seen.leaders++;
          const px = await pixelContrast(page, el);
          if (px && px.ratio < 4.5) failures.push(`${where}: ${label} "${text}" painted at ${px.ratio}:1 (${px.fg} on ${px.bg})`);
        }
      }
    }
    // B2: nav links are styled on purpose -- no browser-default
    // underline (the active link's own bar/pill is the only marker).
    const decorations = await page.$$eval('.pb-nav-link', ls => ls.map(l => [l.textContent, getComputedStyle(l).textDecorationLine]));
    for (const [text, deco] of decorations) if (deco !== 'none') failures.push(`${theme} / ${scheme} / ${width}px: nav "${text}" has text-decoration ${deco}`);
    await ctx.close();
  }
  return { failures, seen };
}

describe('Public page contrast, measured from the rendered page', () => {
  for (const theme of THEMES) {
    it(`${theme}: nav, next-game card, language toggle, leaders labels and all other text clear WCAG AA in both OS colour schemes`, async () => {
      await saveTheme(h, populated.session, theme);
      await saveTheme(h, bare.session, theme);
      const pop = await auditLeague(populated, theme);
      const b = await auditLeague(bare, theme);
      expect([...pop.failures, ...b.failures]).toEqual([]);
      // Guard against a vacuous pass: every target class really rendered.
      expect(pop.seen.nav).toBeGreaterThan(0);
      expect(pop.seen.hero).toBeGreaterThan(0);
      expect(pop.seen.lang).toBeGreaterThan(0);
      expect(pop.seen.leaders).toBeGreaterThan(0);
    }, 300000);
  }
});

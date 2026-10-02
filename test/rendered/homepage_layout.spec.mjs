// Homepage review batch, item 4: the mobile pass, in real Chromium.
// At 360, 390, 768 and 1280 px, in French and in English:
//   - the page never scrolls sideways;
//   - below 640 px the nav keeps only Log in and the FR/EN toggle;
//   - the hero mockup never shows below 900 px (it cannot clip or overlap);
//   - cards, tiers and steps are one column below 640 px;
//   - below 480 px the call-to-action buttons are full width, 44 px or taller.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, launchChromium } from './support/public_page_harness.mjs';

let h, browser;
beforeAll(async () => {
  h = await startPublicPageWorker();
  browser = await launchChromium();
}, 180000);
afterAll(async () => {
  await browser?.close();
  await h?.dispose();
});

function measure() {
  const vis = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const cols = sel => { const el = document.querySelector(sel); return el ? getComputedStyle(el).gridTemplateColumns.split(' ').length : 0; };
  const box = el => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, left: r.left, right: r.right }; };
  const ctas = [...document.querySelectorAll('.home-cta .nl-btn, .home-final-cta .nl-btn')].map(box);
  const header = document.querySelector('.nl-hero .nl-header');
  return {
    vw: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    navVisible: vis(document.querySelector('.nl-hero .nl-nav')),
    loginVisible: vis(document.querySelector('.nl-hero a[href="/login"]')),
    loginH: box(document.querySelector('.nl-hero a[href="/login"]')).h,
    toggleVisible: vis(document.getElementById('btn-lang-fr')) && vis(document.getElementById('btn-lang-en')),
    toggleH: box(document.getElementById('btn-lang-en')).h,
    headerRight: box(header).right,
    mockVisible: vis(document.querySelector('.home-mock')),
    feats: cols('.home-feats'), tiers: cols('.home-tiers'), steps: cols('.home-steps'),
    ctas,
    lang: document.documentElement.lang
  };
}

describe('the homepage at phone, tablet and desktop widths', () => {
  for (const lang of ['fr', 'en']) {
    for (const width of [360, 390, 768, 1280]) {
      it(`${lang} at ${width} px`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        try {
          await page.goto(h.baseUrl + '/?lang=' + lang);
          const m = await page.evaluate(measure);
          expect(m.lang).toBe(lang === 'en' ? 'en-CA' : 'fr-CA');
          expect(m.scrollWidth).toBeLessThanOrEqual(m.vw);
          expect(m.headerRight).toBeLessThanOrEqual(m.vw + 0.5);
          expect(m.loginVisible).toBe(true);
          expect(m.toggleVisible).toBe(true);
          expect(m.loginH).toBeGreaterThanOrEqual(40);
          expect(m.toggleH).toBeGreaterThanOrEqual(28);
          if (width < 640) {
            expect(m.navVisible).toBe(false);
            expect([m.feats, m.tiers, m.steps]).toEqual([1, 1, 1]);
          } else {
            expect(m.navVisible).toBe(true);
          }
          if (width < 900) expect(m.mockVisible).toBe(false);
          if (width === 768) expect([m.feats, m.tiers]).toEqual([2, 2]);
          if (width >= 1280) expect([m.feats, m.tiers, m.steps]).toEqual([3, 4, 3]);
          for (const c of m.ctas) {
            expect(c.h).toBeGreaterThanOrEqual(44);
            if (width < 480) expect(c.w, JSON.stringify(m.ctas)).toBeGreaterThanOrEqual(m.vw - 2 * 16 - 1);
          }
        } finally {
          await page.close();
        }
      }, 60000);
    }
  }
});

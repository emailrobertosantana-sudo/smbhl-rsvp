// The public page's matchup line ("Rouge contre Bleu" / "Rouge vs Bleu")
// switches with the FR/EN toggle. The joining word used to be baked in
// server-side, in whichever language the page was first rendered in, so
// English readers saw "contre".
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, seedPopulatedLeague, launchChromium } from './support/public_page_harness.mjs';

let h, browser, league;
beforeAll(async () => {
  h = await startPublicPageWorker();
  league = await seedPopulatedLeague(h, { email: 'matchup.lang@example.com', name: 'Matchup Language League', teamNames: ['Rouge', 'Bleu'], playerName: 'Lang Player', goalieName: 'Lang Goalie' });
  browser = await launchChromium();
}, 180000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

describe('Public page matchup word follows the language toggle', () => {
  it('"contre" in French, "vs" in English, and back', async () => {
    const page = await browser.newPage();
    await page.goto(`${h.baseUrl}/${league.slug}`);
    const hero = () => page.textContent('.pb-hero-matchup');
    const list = () => page.$$eval('.pb-g-matchup', els => els.map(e => e.textContent.trim()));
    await page.evaluate(() => window.__setLang('fr'));
    expect((await hero()).trim()).toBe('Rouge contre Bleu');
    await page.evaluate(() => window.__setLang('en'));
    expect((await hero()).trim()).toBe('Rouge vs Bleu');
    expect(await list()).toContain('Rouge vs Bleu');
    await page.evaluate(() => window.__setLang('fr'));
    expect((await hero()).trim()).toBe('Rouge contre Bleu');
    await page.close();
  });
});

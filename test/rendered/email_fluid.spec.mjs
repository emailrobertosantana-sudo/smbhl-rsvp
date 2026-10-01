// Notre Ligue emails are fluid: the card is width 100% with max-width 560px
// (src/design_system.js nlEmailWrap), so it fits a phone. Every league email
// the preview renders, in Chromium at 390 px and at 600 px: nothing wider
// than the screen, the card fills the phone (less its 12 px margins) and
// stops at 560 px on a wider screen. SMBHL's emails keep their own template.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, seedPopulatedLeague, launchChromium } from './support/public_page_harness.mjs';
import { PREVIEW_KINDS } from '../../src/email_preview.js';

let h, browser, league;

beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { RSVP_SECRET: 'fluid-secret' } });
  league = await seedPopulatedLeague(h, { email: 'owner@fluid.example', name: 'Ligue du mercredi', teamNames: ['Loutres', 'Ours'], playerName: 'Léa Joueuse', goalieName: 'Luc Gardien' });
  await h.api('/league/contacts', { ...league.session, body: { name: 'Sam Remplaçant', role: 'sub_skater', emailChoice: 'skip' } });
  await h.db.prepare(`UPDATE contacts SET email = lower(replace(name, ' ', '.')) || '@fluid.example' WHERE league_id = ?`).bind(league.league.id).run();
  browser = await launchChromium();
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

async function measure(html, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  await page.route('**/*', r => r.abort());
  await page.setContent(html, { waitUntil: 'load' });
  const m = await page.evaluate(() => {
    const card = [...document.querySelectorAll('table')].find(t => /max-width:\s*560px/.test(t.getAttribute('style') || ''));
    return { scroll: document.documentElement.scrollWidth, card: card ? Math.round(card.getBoundingClientRect().width) : null };
  });
  await ctx.close();
  return m;
}

describe('Notre Ligue emails fit the screen', () => {
  it('every league email, in each language mode, at 390 px and 600 px', async () => {
    const problems = [];
    let measured = 0;
    for (const mode of ['fr', 'en', 'both']) {
      await h.db.prepare('UPDATE leagues SET language_mode = ? WHERE id = ?').bind(mode, league.league.id).run();
      for (const kind of Object.keys(PREVIEW_KINDS.league)) {
        const body = kind === 'broadcast' ? { kind, subject: 'Avis', message: 'Bonjour.' } : { kind };
        const r = await (await h.api('/league/comms/preview', { ...league.session, body })).json();
        if (!r.ok || !r.html) continue;
        for (const width of [390, 600]) {
          const m = await measure(r.html, width);
          measured++;
          if (m.scroll > width) problems.push(`${kind} ${mode} ${width}px: page ${m.scroll}px wide`);
          // The sub call is SMBHL's shared template (its own 540 px fluid table).
          if (kind === 'sub_call') continue;
          if (m.card === null) { problems.push(`${kind} ${mode}: no fluid card`); continue; }
          const expected = width === 390 ? 390 - 24 : 560;
          if (Math.abs(m.card - expected) > 1) problems.push(`${kind} ${mode} ${width}px: card ${m.card}px, expected ${expected}px`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(measured).toBeGreaterThanOrEqual(36);
  }, 300000);
});

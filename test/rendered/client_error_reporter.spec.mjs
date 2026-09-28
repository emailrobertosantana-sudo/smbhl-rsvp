// A page's own script error reaches the server (src/health.js), in a real
// browser: the reporter is first in <head>, so it is listening before any
// page script runs -- a syntax error that kills a whole admin page is
// reported, not found days later.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, launchChromium } from './support/public_page_harness.mjs';

let h, browser;
beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { RSVP_SECRET: 'client-error-reporter' } });
  browser = await launchChromium();
}, 180000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

describe('Client error reporter', () => {
  it('a script that throws on the page is recorded for the operator, with its path and message', async () => {
    const page = await browser.newPage();
    await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
    await page.goto(h.baseUrl + '/login', { waitUntil: 'load' });
    const reported = page.waitForRequest(r => r.url().endsWith('/health/client-error'));
    await page.addScriptTag({ content: 'var broken = ;' }).catch(() => {});
    await reported;
    await page.waitForTimeout(300);
    const row = await h.db.prepare("SELECT value FROM settings WHERE key >= 'health:clienterr:' AND key < 'health:clienterr:￿'").first();
    const v = JSON.parse(row.value);
    expect(v.path).toBe('/login');
    expect(v.msg).toMatch(/SyntaxError/);
    await page.close();
  });
});

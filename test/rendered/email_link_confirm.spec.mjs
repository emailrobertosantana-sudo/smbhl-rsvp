// An email answer link in a real browser: opening it records nothing, and
// pressing the confirmation page's button (a plain form POST, no JavaScript
// needed) records it and lands on the recorded page.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, launchChromium } from './support/public_page_harness.mjs';

let h, browser;
const SECRET = 'rendered-email-link';
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { RSVP_SECRET: SECRET } });
  await h.db.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES ('smbhl:2099-10-04', 'Fall 2099', 4, '2099-10-04', 'Letendre', 'open', '10:30', 'smbhl')`).run();
  await h.db.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, token_salt, league_id) VALUES ('RND1', 'Rena Rendered', 'rena@example.com', 'roster', 0, 's', 'smbhl')`).run();
  await h.db.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES ('smbhl:2099-10-04', 'RND1', 'Blue', 'pending', 'roster', 'auto', '2099-01-01', 'smbhl')`).run();
  browser = await launchChromium();
}, 180000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

describe('Email answer link, in a browser', () => {
  it('opens the confirmation (nothing recorded); the big button records it', async () => {
    const t = await hmac(SECRET, 'p:smbhl:2099-10-04:RND1:s');
    const page = await browser.newPage();
    await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
    await page.goto(`${h.baseUrl}/rsvp?e=${encodeURIComponent('smbhl:2099-10-04')}&p=RND1&t=${t}&v=in`, { waitUntil: 'load' });
    expect(await page.textContent('h1')).toContain('Encore un clic pour confirmer');
    const status = async () => (await h.db.prepare("SELECT status FROM rsvp WHERE event_id = 'smbhl:2099-10-04' AND player_id = 'RND1'").first()).status;
    expect(await status()).toBe('pending');
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#rsvp_confirm button[type="submit"]')]);
    expect(await status()).toBe('in');
    expect(await page.textContent('body')).toContain('Réponse enregistrée avec succès!');
    await page.close();
  });
});

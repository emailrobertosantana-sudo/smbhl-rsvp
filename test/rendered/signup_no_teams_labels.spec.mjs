// D5 (decided 2026-09-29): a single squad playing in someone else's
// league describes itself with the no-teams structure. Signup offers it
// under two labels -- "Just my team" and "Drop-in, no fixed teams" -- and
// both create exactly the same league underneath.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, launchChromium } from './support/public_page_harness.mjs';

let h, browser;
beforeAll(async () => { h = await startPublicPageWorker(); browser = await launchChromium(); }, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

async function signupWith(label, email, name) {
  const s = await h.signup(email);
  const context = await browser.newContext();
  await context.addCookies(s.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
  await page.goto(h.baseUrl + '/signup?step=2', { waitUntil: 'load' });
  const labelText = await page.textContent(`label[data-label="${label}"] .t`);
  await page.fill('#su_league_name', name);
  await page.click(`label[data-label="${label}"]`);
  await Promise.all([page.waitForURL(/step=done/), page.click('#su_submit')]);
  const user = await h.db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  const row = await h.db.prepare('SELECT team_structure, team_names, team_count, min_players, max_players, min_goalies, tracks_results, reminder_72h_enabled FROM leagues WHERE created_by = ?').bind(user.id).first();
  await context.close();
  return { labelText, row, errors };
}

describe('Two labels, one no-teams structure', () => {
  it('"Just my team" and "Drop-in, no fixed teams" create the same league', async () => {
    const mine = await signupWith('my_team', 'd5.mine@example.com', 'Les Castors');
    const drop = await signupWith('drop_in', 'd5.drop@example.com', 'Drop-in du jeudi');
    // Signup follows the browser's language.
    expect(['Juste mon équipe', 'Just my team']).toContain(mine.labelText);
    expect(['Liste des présents seulement (drop-in)', 'Attendance list only (drop-in)']).toContain(drop.labelText); // onboarding review item 2
    expect(mine.row.team_structure).toBe('headcount');
    expect(mine.row).toEqual(drop.row);
    expect(mine.errors).toEqual([]);
    expect(drop.errors).toEqual([]);
  }, 120000);
});

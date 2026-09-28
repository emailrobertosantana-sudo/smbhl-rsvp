// Group A, in a real browser: the preview button beside an email opens the
// email as a mail client would show it (subject + the HTML part, rendered),
// for SMBHL's Comms and the league product's Comms and Settings -- and
// nothing is queued or sent.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, seedPopulatedLeague, launchChromium } from './support/public_page_harness.mjs';

const ADMIN_KEY = 'preview-ui-admin-key';
const SEASON = 'Fall 2099';
let h, browser, league;

beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { ADMIN_KEY, RSVP_SECRET: 'preview-ui-rsvp' } });
  await h.kv.put('data_json', JSON.stringify({ current_season: SEASON, seasons: [
    { name: SEASON, standings: [], fixtures: [{ week: 2, date: 'Sunday January 11 2099', time: '10:30 AM', home: 'Red', away: 'Blue', venue: 'Aréna' }] },
    { name: 'Spring 2098', champion: 'Blue', standings: [], fixtures: [] }
  ], players: [] }));
  await h.db.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES ('smbhl:2099-01-11', ?, 2, 'Sunday January 11 2099', 'Aréna', 'open', '10:30', 'smbhl')`).bind(SEASON).run();
  await h.db.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES ('P0001', 'Adam Albanese', 'adam@example.com', 'roster', 0, 0, 'salt', 'smbhl')`).run();
  await h.db.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES ('smbhl:2099-01-11', 'P0001', 'Red', 'pending', 'roster', '2099-01-01T00:00:00Z', 'smbhl')`).run();
  league = await seedPopulatedLeague(h, { email: 'owner@preview-ui.example', name: 'Preview League', teamNames: ['Otters', 'Bears'], playerName: 'Lea Player', goalieName: 'Luc Goalie' });
  // The seeded league's players get addresses, and one has not answered yet.
  await h.db.prepare("UPDATE contacts SET email = lower(replace(name, ' ', '.')) || '@example.com' WHERE league_id = ?").bind(league.league.id).run();
  await h.db.prepare("UPDATE rsvp SET status = 'pending' WHERE player_id = (SELECT player_id FROM contacts WHERE league_id = ? AND name = 'Lea Player') AND event_id = (SELECT id FROM events WHERE league_id = ? ORDER BY date DESC LIMIT 1)").bind(league.league.id, league.league.id).run();
  browser = await launchChromium();
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

async function openPreview(path, cookies, selector) {
  const context = await browser.newContext();
  await context.addCookies(cookies);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
  await page.goto(h.baseUrl + path, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.click(selector);
  await page.waitForSelector('.ep-overlay.on .ep-subject, .ep-overlay.on .ep-error');
  const error = await page.$('.ep-overlay .ep-error') ? await page.textContent('.ep-overlay .ep-error') : null;
  if (error) { await context.close(); return { error, errors }; }
  const subject = await page.textContent('.ep-overlay .ep-subject .ep-v');
  const meta = await page.textContent('.ep-overlay .ep-meta');
  // The HTML part, rendered in the sandboxed frame as a mail client shows it.
  const frame = page.frames().find(f => f !== page.mainFrame());
  const shown = frame ? await frame.evaluate(() => document.body ? document.body.innerText : '') : '';
  await context.close();
  return { subject, meta, shown, errors };
}

const outbox = async () => (await h.db.prepare('SELECT count(*) n FROM outbox').first()).n;

describe('Email preview in the browser', () => {
  it('SMBHL Comms: the weekly invite, beside its cadence card', async () => {
    const before = await outbox();
    const r = await openPreview('/admin/comms', [{ name: 'admin_key', value: ADMIN_KEY, url: h.baseUrl + '/' }], '[data-email-preview="invite"]');
    expect(r.error || null).toBe(null);
    expect(r.errors).toEqual([]);
    expect(r.subject).toMatch(/^Présence : dimanche 11 janvier \/ RSVP: Sunday January 11 2099$/);
    expect(r.meta).toContain('adam@example.com');
    expect(r.shown).toContain('Salut Adam / Hi Adam');
    expect(r.shown).toContain('Oui / Yes');
    expect(await outbox()).toBe(before);
  }, 120000);

  it('SMBHL Comms: the season recap uses the most recent completed season and says so', async () => {
    const r = await openPreview('/admin/comms', [{ name: 'admin_key', value: ADMIN_KEY, url: h.baseUrl + '/' }], '[data-email-preview="season_recap_prompt"]');
    expect(r.error || null).toBe(null);
    expect(r.errors).toEqual([]);
    expect(r.meta).toContain('Spring 2098');
    expect(r.subject).toContain('(Spring 2098)');
  }, 120000);

  const sessionCookies = () => league.session.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; });

  it('league Comms: the 72 h reminder row', async () => {
    const before = await outbox();
    const r = await openPreview('/league/comms', sessionCookies(), '[data-email-preview="reminder_72h"]');
    expect(r.error || null).toBe(null);
    expect(r.errors).toEqual([]);
    expect(r.subject).toMatch(/as-tu décidé pour .* \/ .*have you decided for /);
    expect(r.shown).toContain('Preview League');
    expect(await outbox()).toBe(before);
  }, 120000);

  it('league Settings: the co-admin invitation beside the invite button', async () => {
    const r = await openPreview('/league/settings', sessionCookies(), '[data-email-preview="coadmin_invite"]');
    expect(r.error || null).toBe(null);
    expect(r.errors).toEqual([]);
    expect(r.subject).toContain('Preview League');
  }, 120000);
});

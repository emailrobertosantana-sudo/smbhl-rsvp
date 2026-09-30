// Group C: every server-rendered page's inline script, run in Chromium.
//
// Two bugs came from server templates generating browser code whose
// escaping was lost: the review page's script failed to parse entirely,
// and a \s regex became an s regex. test/rendered/review_page_scripts.spec
// .mjs caught that class for the review page; this covers every HTML page
// the worker serves -- the real worker (wrangler's test harness, local-only
// D1/KV), seeded with enough data that each page renders its real content,
// loaded in a real Chromium, failing on ANY script error (a parse error,
// or an exception thrown while the page's script runs, including while it
// renders the data it fetches).
//
// Nothing here can send an email: the harness never sets RESEND_API_KEY,
// and every request that leaves the local worker is aborted.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, seedPopulatedLeague, launchChromium } from './support/public_page_harness.mjs';
import { hmac } from '../../src/crypto_utils.js';

const ADMIN_KEY = 'every-page-admin-key';
const RSVP_SECRET = 'every-page-rsvp-secret';
const SEASON = 'Fall 2099';

let h, browser, league, eventId, leagueEventId, pollId, reviewId, pages;

const DATA = {
  current_season: SEASON,
  updated: '2099-01-01',
  seasons: [{
    name: SEASON,
    standings: [
      { team: 'Red', gp: 1, w: 1, l: 0, t: 0, pts: 2, gf: 5, ga: 3 },
      { team: 'Blue', gp: 1, w: 0, l: 1, t: 0, pts: 0, gf: 3, ga: 5 },
      { team: 'White', gp: 0, w: 0, l: 0, t: 0, pts: 0, gf: 0, ga: 0 },
      { team: 'Black', gp: 0, w: 0, l: 0, t: 0, pts: 0, gf: 0, ga: 0 }
    ],
    fixtures: [
      { week: 1, date: 'Sunday January 4 2099', time: '10:30 AM', home: 'Red', away: 'Blue', venue: 'Aréna', hs: 5, as: 3 },
      { week: 2, date: 'Sunday January 11 2099', time: '10:30 AM', home: 'Red', away: 'Blue', venue: 'Aréna' },
      { week: 2, date: 'Sunday January 11 2099', time: '11:30 AM', home: 'White', away: 'Black', venue: 'Aréna' }
    ]
  }],
  players: [
    { id: 'P0001', name: 'Adam Albanese', seasons: { [SEASON]: { team: 'Red', gp: 1, g: 2, a: 1, pts: 3 } }, career: { gp: 1, g: 2, a: 1, pts: 3 } },
    { id: 'P0002', name: 'Gus Goalie', seasons: {}, gseasons: { [SEASON]: { team: 'Red', gp: 1, w: 1, l: 0, ga: 3 } }, gcareer: { gp: 1, w: 1, ga: 3 } },
    { id: 'P0003', name: 'Sam Sub', seasons: { [SEASON]: { team: null, gp: 1, g: 0, a: 1, pts: 1 } } }
  ]
};

beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { ADMIN_KEY, RSVP_SECRET } });
  await h.kv.put('data_json', JSON.stringify(DATA));
  const db = h.db;

  // SMBHL: the next game, a roster player, a goalie, a sub, a poll.
  eventId = 'smbhl:2099-01-11';
  await db.prepare("INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES ('smbhl:2099-01-04', ?, 1, 'Sunday January 4 2099', 'Aréna', 'cancelled', '10:30', 'smbhl')").bind(SEASON).run();
  await db.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, ?, 2, 'Sunday January 11 2099', 'Aréna', 'open', '10:30', 'smbhl')`).bind(eventId, SEASON).run();
  for (const [id, name, role, isSub, isGoalie] of [['P0001', 'Adam Albanese', 'roster', 0, 0], ['P0002', 'Gus Goalie', 'roster', 0, 1], ['P0003', 'Sam Sub', 'sub_skater', 1, 0]]) {
    await db.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, ?, ?, ?, 'salt', 'smbhl')`).bind(id, name, `${id.toLowerCase()}@example.com`, role, isSub, isGoalie).run();
  }
  await db.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, 'P0001', 'Red', 'pending', 'roster', '2099-01-01T00:00:00Z', 'smbhl'), (?, 'P0002', 'Red', 'in', 'roster', '2099-01-01T00:00:00Z', 'smbhl')`).bind(eventId, eventId).run();
  await db.prepare(`INSERT INTO settings (key, value) VALUES (?, 'tsalt')`).bind(`teamsalt:${SEASON}:Red`).run();
  await db.prepare(`INSERT INTO team_messages (event_id, team, player_name, player_id, message, created_at) VALUES (?, 'Red', 'Adam Albanese', 'P0001', 'On se voit dimanche', '2099-01-08T20:00:00Z')`).bind(eventId).run();
  await db.prepare(`INSERT INTO polls (season, title, description, created_at) VALUES (?, 'Meilleur gardien', 'Vote !', '2099-01-01T00:00:00Z')`).bind(SEASON).run();
  pollId = (await db.prepare('SELECT id FROM polls LIMIT 1').first()).id;
  const rev = await h.api('/admin/review/manual-start', { body: { season: SEASON, week: 1 } }).then(async r => {
    // manual-start is admin-only: retry with the admin header if the helper's
    // plain POST was refused.
    if (r.status === 200) return r.json();
    const res = await fetch(h.baseUrl + '/admin/review/manual-start', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin': ADMIN_KEY }, body: JSON.stringify({ season: SEASON, week: 1 }) });
    return res.json();
  });
  reviewId = rev.id;

  // League product: a populated league with an upcoming game.
  const seeded = await seedPopulatedLeague(h, { email: 'owner@every-page.example', name: 'Every Page League', teamNames: ['Otters', 'Bears'], playerName: 'Lea Player', goalieName: 'Luc Goalie' });
  league = seeded;
  leagueEventId = (await db.prepare(`SELECT id FROM events WHERE league_id = ? ORDER BY date DESC LIMIT 1`).bind(seeded.league.id).first()).id;
  const lc = await db.prepare(`SELECT player_id, token_salt FROM contacts WHERE league_id = ? LIMIT 1`).bind(seeded.league.id).first();

  const rsvpT = await hmac(RSVP_SECRET, `p:${eventId}:P0001:salt`);
  const teamT = await hmac(RSVP_SECRET, `t:${SEASON}:Red:tsalt`);
  const pollT = await hmac(RSVP_SECRET, `poll:${pollId}:P0001:salt`);
  const leagueRsvpT = await hmac(RSVP_SECRET, `lr:${seeded.league.id}:${leagueEventId}:${lc.player_id}:${lc.token_salt}`);
  const q = encodeURIComponent;

  // [label, path, auth] -- auth: 'none' | 'admin' | 'session'
  pages = [
    ['marketing home', '/', 'none'],
    ['login', '/login', 'none'],
    ['signup', '/signup', 'none'],
    ['forgot password', '/forgot-password', 'none'],
    ['reset password', '/reset-password?token=x.y.z', 'none'],
    ['verify email (bad token)', '/auth/verify?token=bad', 'none'],
    ['co-admin accept (bad token)', '/league/admins/accept?token=bad', 'none'],
    ['league public page (slug)', `/${seeded.slug}`, 'none'],
    ['league public page (id)', `/league/public?league=${q(seeded.league.id)}`, 'none'],
    ['league public page (missing)', '/league/public?league=nope', 'none'],
    ['rsvp: incomplete link notice', '/rsvp', 'none'],
    ['rsvp (signed)', `/rsvp?e=${q(eventId)}&p=P0001&t=${rsvpT}`, 'none'],
    ['team page (signed)', `/team-rsvp?s=${q(SEASON)}&team=Red&t=${teamT}`, 'none'],
    ['poll (signed)', `/poll?id=${pollId}&p=P0001&t=${pollT}`, 'none'],
    ['league rsvp (signed)', `/league/rsvp?league=${q(seeded.league.id)}&e=${q(leagueEventId)}&p=${q(lc.player_id)}&t=${leagueRsvpT}`, 'none'],
    ['dashboard', '/dashboard', 'session'],
    ['onboarding season', '/onboarding/season', 'session'],
    ['signup done', '/signup?step=done', 'session'],
    ['league roster', '/league/roster', 'session'],
    ['league schedule', '/league/schedule', 'session'],
    ['league event detail', `/league/events/detail?e=${q(leagueEventId)}`, 'session'],
    ['league settings', '/league/settings', 'session'],
    ['league comms', '/league/comms', 'session'],
    ['league finances', '/league/finances', 'session'],
    ['super admin', '/super-admin/leagues', 'admin'],
    ['admin board', '/admin/board', 'admin'],
    ['admin subs', '/admin/subs', 'admin'],
    ['admin review list', '/admin/review', 'admin'],
    ['admin review', `/admin/review?id=${q(reviewId)}`, 'admin'],
    ['admin schedule', '/admin/schedule', 'admin'],
    ['admin teams', '/admin/teams', 'admin'],
    ['admin comms', '/admin/comms', 'admin'],
    ['admin people', '/admin/people', 'admin'],
    ['admin finances', '/admin/finances', 'admin'],
    ['admin season', '/admin/season', 'admin'],
    ['admin polls', '/admin/polls', 'admin'],
    ['admin season recap', `/admin/season-recap?s=${q(SEASON)}`, 'admin']
  ];
  browser = await launchChromium();
}, 240000);

afterAll(async () => {
  await browser?.close();
  await h?.dispose();
});

function cookiesFor(auth) {
  const url = h.baseUrl + '/';
  if (auth === 'admin') return [{ name: 'admin_key', value: ADMIN_KEY, url }];
  if (auth === 'session') return league.session.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url }; });
  return [];
}

// Loads one page and returns every script error it raised.
async function scriptErrors(path, auth) {
  const context = await browser.newContext();
  await context.addCookies(cookiesFor(auth));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss());
  await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
  const res = await page.goto(h.baseUrl + path, { waitUntil: 'load' });
  // Let each page's own data fetches come back and render.
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(250);
  const status = res ? res.status() : 0;
  const scripts = await page.evaluate(() => document.querySelectorAll('script:not([src])').length);
  await context.close();
  return { errors, status, scripts };
}

describe('Every server-rendered page: its inline script runs without error', () => {
  it('loads every page in Chromium and none raises a script error', async () => {
    const report = [];
    for (const [label, path, auth] of pages) {
      const r = await scriptErrors(path, auth);
      report.push({ label, path, status: r.status, scripts: r.scripts, errors: r.errors });
    }
    // Every page really rendered with its scripts (a login redirect or an
    // error page would not prove anything about the page's own script).
    const notRendered = report.filter(r => r.scripts === 0 || (r.status >= 500));
    expect(notRendered.map(r => `${r.label} ${r.path}: status ${r.status}, ${r.scripts} inline scripts`)).toEqual([]);
    const broken = report.filter(r => r.errors.length);
    expect(broken.map(r => `${r.label} ${r.path}: ${r.errors.join(' | ')}`)).toEqual([]);
  }, 600000);

  // Found while building this test: the Schedule page's "notify players"
  // button on a cancelled game threw (its modal's ids did not match its
  // script), so the cancellation notice could not be sent from the page.
  it('Schedule: a cancelled game’s "notify players" opens its modal, and the notice previews', async () => {
    const context = await browser.newContext();
    await context.addCookies(cookiesFor('admin'));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.dismiss());
    await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
    await page.goto(h.baseUrl + '/admin/schedule', { waitUntil: 'load' });
    await page.waitForSelector('[data-notify-cancelled="smbhl:2099-01-04"]');
    await page.click('[data-notify-cancelled="smbhl:2099-01-04"]');
    await page.waitForSelector('#cancel-email-modal', { state: 'visible' });
    expect(await page.textContent('#cancel-event-info')).toContain('Sunday January 4 2099');
    await page.click('#cancel-preview-btn');
    await page.waitForSelector('.ep-overlay.on .ep-subject');
    expect(await page.textContent('.ep-overlay .ep-subject .ep-v')).toBe('Match annulé : dimanche 4 janvier / Game Cancelled: Sunday January 4 2099');
    expect(errors).toEqual([]);
    await context.close();
  }, 120000);
});

// The em dash guard for SMBHL, in a real browser.
//
// The league product's guard is test/rendered/copy_guard.spec.mjs. This is
// the same check for SMBHL: no user-facing string may contain U+2014. Every
// SMBHL page (the admin pages, the player pages a signed link opens) is
// loaded in Chromium in French and in English; for each, the visible text,
// the title, the attributes people read and every value of the page's
// dictionary. Then every SMBHL email the preview renders (the real
// renderer, the cron's shared template included): subject, HTML and text.
//
// SMBHL shows French and English together; this guard checks only the
// dash, not the voice (SMBHL's French says "vous").
//
// Nothing here can send an email: the harness never sets RESEND_API_KEY,
// and every request that leaves the local worker is aborted.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, launchChromium } from './support/public_page_harness.mjs';
import { hmac } from '../../src/crypto_utils.js';
import { PREVIEW_KINDS } from '../../src/email_preview.js';

const EM_DASH = '—';
const ADMIN_KEY = 'smbhl-em-dash-admin-key';
const RSVP_SECRET = 'smbhl-em-dash-rsvp-secret';
const SEASON = 'Fall 2099';

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

let h, browser, pages;
const admin = (path, body) => fetch(h.baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin': ADMIN_KEY }, body: JSON.stringify(body) });

beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { ADMIN_KEY, RSVP_SECRET } });
  await h.kv.put('data_json', JSON.stringify(DATA));
  const db = h.db;
  const eventId = 'smbhl:2099-01-11';
  await db.prepare("INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES ('smbhl:2099-01-04', ?, 1, 'Sunday January 4 2099', 'Aréna', 'cancelled', '10:30', 'smbhl')").bind(SEASON).run();
  await db.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, ?, 2, 'Sunday January 11 2099', 'Aréna', 'open', '10:30', 'smbhl')`).bind(eventId, SEASON).run();
  for (const [id, name, role, isSub, isGoalie] of [['P0001', 'Adam Albanese', 'roster', 0, 0], ['P0002', 'Gus Goalie', 'roster', 0, 1], ['P0003', 'Sam Sub', 'sub_skater', 1, 0]]) {
    await db.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, ?, ?, ?, 'salt', 'smbhl')`).bind(id, name, `${id.toLowerCase()}@example.com`, role, isSub, isGoalie).run();
  }
  await db.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, 'P0001', 'Red', 'pending', 'roster', '2099-01-01T00:00:00Z', 'smbhl'), (?, 'P0002', 'Red', 'in', 'roster', '2099-01-01T00:00:00Z', 'smbhl')`).bind(eventId, eventId).run();
  await db.prepare(`INSERT INTO settings (key, value) VALUES (?, 'tsalt')`).bind(`teamsalt:${SEASON}:Red`).run();
  await db.prepare(`INSERT INTO polls (season, title, description, created_at) VALUES (?, 'Meilleur gardien', 'Vote !', '2099-01-01T00:00:00Z')`).bind(SEASON).run();
  const pollId = (await db.prepare('SELECT id FROM polls LIMIT 1').first()).id;
  const reviewId = (await (await admin('/admin/review/manual-start', { season: SEASON, week: 1 })).json()).id;
  const q = encodeURIComponent;
  const rsvpT = await hmac(RSVP_SECRET, `p:${eventId}:P0001:salt`);
  const teamT = await hmac(RSVP_SECRET, `t:${SEASON}:Red:tsalt`);
  const pollT = await hmac(RSVP_SECRET, `poll:${pollId}:P0001:salt`);
  // [label, path, signed in with the admin key]
  pages = [
    ['rsvp: incomplete link notice', '/rsvp', false],
    ['rsvp (signed)', `/rsvp?e=${q(eventId)}&p=P0001&t=${rsvpT}`, false],
    ['team page (signed)', `/team-rsvp?s=${q(SEASON)}&team=Red&t=${teamT}`, false],
    ['poll (signed)', `/poll?id=${pollId}&p=P0001&t=${pollT}`, false],
    ['super admin', '/super-admin/leagues', true],
    ['admin board', '/admin/board', true],
    ['admin subs', '/admin/subs', true],
    ['admin review list', '/admin/review', true],
    ['admin review', `/admin/review?id=${q(reviewId)}`, true],
    ['admin schedule', '/admin/schedule', true],
    ['admin teams', '/admin/teams', true],
    ['admin comms', '/admin/comms', true],
    ['admin people', '/admin/people', true],
    ['admin finances', '/admin/finances', true],
    ['admin season', '/admin/season', true],
    ['admin polls', '/admin/polls', true],
    ['admin season recap', `/admin/season-recap?s=${q(SEASON)}`, true]
  ];
  browser = await launchChromium();
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

// Every string a person can meet on the page, with where it came from.
const collect = () => {
  const out = [];
  const add = (where, v) => { if (typeof v === 'string' && v) out.push([where, v]); };
  add('title', document.title);
  add('visible text', document.body.innerText);
  for (const el of document.querySelectorAll('[placeholder],[aria-label],[title],[alt]')) {
    for (const a of ['placeholder', 'aria-label', 'title', 'alt']) add(a, el.getAttribute(a));
  }
  for (const el of document.querySelectorAll('option')) add('option', el.textContent);
  const walk = (where, v) => {
    if (typeof v === 'string') add(where, v);
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(where + '.' + k, v[k]);
  };
  try { if (typeof __I18N !== 'undefined') walk('page dictionary', __I18N); } catch (e) {}
  try { if (typeof I18N !== 'undefined') walk('page dictionary', I18N); } catch (e) {}
  return out;
};

describe('The copy of SMBHL: no em dash', () => {
  it('every SMBHL page, French and English: text, title, labels, options and its dictionary', async () => {
    const hits = [];
    let checked = 0;
    for (const lang of ['fr', 'en']) {
      for (const [label, path, signedIn] of pages) {
        const context = await browser.newContext({ locale: lang === 'fr' ? 'fr-CA' : 'en-US', viewport: { width: 1280, height: 900 } });
        if (signedIn) await context.addCookies([{ name: 'admin_key', value: ADMIN_KEY, url: h.baseUrl + '/' }]);
        await context.addInitScript(l => { try { localStorage.setItem('smbhl_admin_lang', l); localStorage.setItem('smbhl_lang', l); } catch (e) {} }, lang);
        const page = await context.newPage();
        await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
        const res = await page.goto(h.baseUrl + path, { waitUntil: 'load' });
        expect(res.status(), `${label} answers`).toBeLessThan(500);
        await page.waitForTimeout(250); // pages that fetch their data render it
        const strings = await page.evaluate(collect);
        checked += strings.length;
        for (const [where, v] of strings) {
          if (v.includes(EM_DASH)) { const i = v.indexOf(EM_DASH); hits.push(`${label} | ${where} | ${v.slice(Math.max(0, i - 60), i + 60).replace(/\s+/g, ' ')}`); }
        }
        await context.close();
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect([...new Set(hits)]).toEqual([]);
  }, 600000);

  it('every SMBHL email the preview renders: subject, HTML and text', async () => {
    const hits = [];
    const rendered = [];
    for (const kind of Object.keys(PREVIEW_KINDS.smbhl)) {
      const label = PREVIEW_KINDS.smbhl[kind];
      for (const v of [label.fr, label.en]) if (v.includes(EM_DASH)) hits.push(`${kind} | label | ${v}`);
      const body = kind === 'broadcast' ? { kind, subject: 'Avis', message: 'Bonjour à tous.' } : { kind };
      const r = await (await admin('/admin/comms/preview', body)).json();
      if (!r.ok) { rendered.push(`${kind}: not rendered (${r.error && (r.error.en || r.error)})`); continue; }
      rendered.push(`${kind}: rendered`);
      for (const [part, v] of [['subject', r.subject || ''], ['html', r.html || ''], ['text', r.text || '']]) {
        if (v.includes(EM_DASH)) { const i = v.indexOf(EM_DASH); hits.push(`${kind} | ${part} | ${v.slice(Math.max(0, i - 60), i + 60).replace(/\s+/g, ' ')}`); }
      }
    }
    expect(hits, rendered.join('; ')).toEqual([]);
    expect(rendered.filter(x => x.endsWith(': rendered')).length, rendered.join('; ')).toBeGreaterThanOrEqual(10);
  }, 240000);
});

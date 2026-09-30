// The copy guard, in a real browser.
//
// French voice: Notre Ligue says "tu" everywhere and calls a substitute
// "remplaçant". No French string of a league page (its dictionary, the
// error dictionary, the text on screen in French) and no league email the
// preview renders may contain "vous", "votre", "vos", "veuillez" or
// "substitut". (The emails a league really sends are checked the same way
// in test/part182_email_links.spec.js.)
//
// The em dash guard. No user-facing string of the league product, in
// either language, may contain U+2014: not the text on screen, not the tab
// title, not a placeholder or a label read by a screen reader, and not a
// string waiting in a page's dictionary or in the shared error dictionary
// for a state this test does not reach.
//
// Every league-product page is loaded in Chromium in French and in
// English. For each: the visible text, the title, the attributes people
// read (placeholder, aria-label, title, alt), every value of the page's
// own dictionary in BOTH languages (window.__pageDict's source, __I18N),
// and every value of the error dictionary.
//
// Emails: every league email the preview can render (the real renderer,
// see src/email_preview.js), the cron's shared template included (its
// separators became "---" when the golden recordings were re-recorded).
// SMBHL's pages and emails have the same guard in
// test/rendered/smbhl_em_dash.spec.mjs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, seedPopulatedLeague, launchChromium } from './support/public_page_harness.mjs';
import { hmac } from '../../src/crypto_utils.js';
import { PREVIEW_KINDS } from '../../src/email_preview.js';

const EM_DASH = '—';
const RSVP_SECRET = 'em-dash-guard-secret';
// "vous", "votre", "vos", "veuillez" and "substitut(s)" as whole words (a bilingual email also says "substitutes", which is English).
const FORMAL_FR = /(^|[^a-zà-ÿ])(vous|votre|vos|veuillez)(?![a-zà-ÿ])|substituts?(?![a-zà-ÿ])/i;
const formalHit = v => { const m = FORMAL_FR.exec(v); return m ? v.slice(Math.max(0, m.index - 50), m.index + 60).replace(/\s+/g, ' ') : null; };

let h, browser, league, pages;

beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { RSVP_SECRET } });
  league = await seedPopulatedLeague(h, { email: 'owner@em-dash.example', name: 'Dash League', teamNames: ['Otters', 'Bears', 'Hawks'], playerName: 'Lea Player', goalieName: 'Luc Goalie' });
  const j = async (p, body) => (await h.api(p, { ...league.session, body })).json();
  // People an email preview can address, a sub, and a saved venue (the
  // schedule form's venue select only exists with one).
  await h.db.prepare(`UPDATE contacts SET email = lower(replace(name, ' ', '.')) || '@em-dash.example' WHERE league_id = ?`).bind(league.league.id).run();
  await j('/league/contacts', { name: 'Sam Sub', role: 'sub', email: 'sam.sub@em-dash.example' });
  await j('/league/venues', { name: 'Gym A', address: '1 rue Principale', map_link: 'https://maps.example/a' });
  const ev = await h.db.prepare(`SELECT id FROM events WHERE league_id = ? ORDER BY date DESC LIMIT 1`).bind(league.league.id).first();
  const lc = await h.db.prepare(`SELECT player_id, token_salt FROM contacts WHERE league_id = ? LIMIT 1`).bind(league.league.id).first();
  const t = await hmac(RSVP_SECRET, `lr:${league.league.id}:${ev.id}:${lc.player_id}:${lc.token_salt}`);
  const q = encodeURIComponent;
  // [label, path, signed in]
  pages = [
    ['marketing home', '/', false],
    ['login', '/login', false],
    ['signup', '/signup', false],
    ['forgot password', '/forgot-password', false],
    ['reset password', '/reset-password?token=x.y.z', false],
    ['verify email (bad token)', '/auth/verify?token=bad', false],
    ['co-admin accept (bad token)', '/league/admins/accept?token=bad', false],
    ['public page', `/${league.slug}`, false],
    ['public page (missing league)', '/league/public?league=nope', false],
    ['player answer page', `/league/rsvp?league=${q(league.league.id)}&e=${q(ev.id)}&p=${q(lc.player_id)}&t=${t}`, false],
    ['dashboard', '/dashboard', true],
    ['onboarding', '/onboarding/season', true],
    ['signup done', '/signup?step=done', true],
    ['players', '/league/roster', true],
    ['schedule', '/league/schedule', true],
    ['game page', `/league/events/detail?e=${q(ev.id)}`, true],
    ['game page (missing game)', '/league/events/detail?e=nope', true],
    ['settings', '/league/settings', true],
    ['communications', '/league/comms', true],
    ['finances', '/league/finances', true]
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
  for (const el of document.querySelectorAll('[data-date-fr],[data-date-en],[data-title-fr],[data-title-en]')) {
    for (const a of ['data-date-fr', 'data-date-en', 'data-title-fr', 'data-title-en']) add(a, el.getAttribute(a));
  }
  const walk = (where, v) => {
    if (typeof v === 'string') add(where, v);
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(where + '.' + k, v[k]);
  };
  try { if (typeof __I18N !== 'undefined') walk('page dictionary', __I18N); } catch (e) {}
  walk('error dictionary', window.__ERROR_I18N || {});
  return out;
};

describe('The copy of the league product: no em dash, and French that says tu and remplaçant', () => {
  it('every page, French and English: text, title, labels, and both languages of its dictionaries', async () => {
    const hits = [];
    const voice = [];
    let checked = 0;
    for (const lang of ['fr', 'en']) {
      for (const [label, path, signedIn] of pages) {
        const context = await browser.newContext({ locale: lang === 'fr' ? 'fr-CA' : 'en-US', viewport: { width: 1280, height: 900 } });
        if (signedIn) await context.addCookies(league.session.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
        await context.addInitScript(l => { try { localStorage.setItem('smbhl_admin_lang', l); } catch (e) {} }, lang);
        const page = await context.newPage();
        await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
        const res = await page.goto(h.baseUrl + path, { waitUntil: 'load' });
        expect(res.status(), `${label} answers`).toBeLessThan(500);
        await page.waitForTimeout(250); // pages that fetch their data render it
        const strings = await page.evaluate(collect);
        checked += strings.length;
        for (const [where, v] of strings) {
          if (v.includes(EM_DASH)) { const i = v.indexOf(EM_DASH); hits.push(`${lang} | ${label} | ${where} | ${v.slice(Math.max(0, i - 60), i + 60).replace(/\s+/g, ' ')}`); }
          // French only: a dictionary's fr side, and what a French page shows.
          const french = /^page dictionary\.fr\./.test(where) || /^error dictionary\..*\.fr$/.test(where) || (lang === 'fr' && !/dictionary/.test(where));
          if (french && formalHit(v)) voice.push(`${label} | ${where} | ${formalHit(v)}`);
        }
        await context.close();
      }
    }
    expect(checked).toBeGreaterThan(5000); // the dictionaries were really read
    expect([...new Set(hits)]).toEqual([]);
    expect([...new Set(voice)]).toEqual([]);
  }, 600000);

  it('every league email the preview renders: subject, HTML and text', async () => {
    const hits = [];
    const rendered = [];
    for (const kind of Object.keys(PREVIEW_KINDS.league)) {
      const label = PREVIEW_KINDS.league[kind];
      for (const v of [label.fr, label.en]) if (v.includes(EM_DASH)) hits.push(`${kind} | label | ${v}`);
      const body = kind === 'broadcast' ? { kind, subject: 'Avis', message: 'Bonjour à tous.' } : { kind };
      const r = await (await h.api('/league/comms/preview', { ...league.session, body })).json();
      if (!r.ok) { rendered.push(`${kind}: not rendered (${r.error && r.error.en})`); continue; }
      rendered.push(`${kind}: rendered`);
      for (const [part, v] of [['subject', r.subject], ['html', r.html || ''], ['text', r.text || '']]) {
        if (v.includes(EM_DASH)) { const i = v.indexOf(EM_DASH); hits.push(`${kind} | ${part} | ${v.slice(Math.max(0, i - 60), i + 60).replace(/\s+/g, ' ')}`); }
        const shown = part === 'html' ? v.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ') : v;
        if (formalHit(shown)) hits.push(`${kind} | ${part} | French voice: ${formalHit(shown)}`);
      }
    }
    expect(hits, rendered.join('; ')).toEqual([]);
    expect(rendered.filter(x => x.endsWith(': rendered')).length, rendered.join('; ')).toBeGreaterThanOrEqual(6);
  }, 240000);
});

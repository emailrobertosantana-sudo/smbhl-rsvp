// Live-testing task (batch 5), Part 3: "Nom de la saison" and the
// placeholder "Ex. Saison Hiver 2026" were confirmed rendering in
// French on English pages (dashboard season prompt and settings).
// Root cause (same bug class as Part 1): the season-name input's
// PLACEHOLDER had no i18n wiring at all -- fixed the same way Part 1
// fixed the hard-delete confirm placeholder, via nlAuthScript's new
// [data-i18n-ph] support.
//
// The sweep also found two bugs beyond the one confirmed report:
//  1. buildDashI18n's non-needsSeason ("Saisons" management / create
//     an additional season) branch never defined seasonNameLabel at
//     all -- only the needsSeason (first season) branch did. On a
//     league that already has a season, the "Nom de la saison" label
//     there NEVER translated on a language switch, regardless of the
//     placeholder fix. Both branches now define the same keys.
//  2. Two other bare, server-rendered-literal placeholders with no
//     i18n wiring existed on in-scope bilingual pages: the co-admin
//     invite email field ("courriel@exemple.com", dashboard) and the
//     roster bulk-import textarea's example rows ("Marie Tremblay,
//     marie@example.com..." -- French-Canadian example names, never
//     swapped to English ones). Both fixed the same way.
//
// A systematic sweep (every data-i18n/data-i18n-ph reference on every
// in-scope bilingual league-product page -- dashboard, comms,
// settings, roster, schedule, event-detail, signup -- checked against
// real fr+en dict definitions in the same scope) found no further
// orphan keys after these fixes. SMBHL's own legacy admin pages use a
// different, older both-languages-shown convention (.fr/.en CSS
// classes, not a single-active-language dict swap) and were out of
// scope -- they were never "French on an English page" in the same
// sense, since there is no single active language there to begin with.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { buildDashI18n } from '../src';

const AUTH_SECRET = 'test-part67-untranslated-strings-secret';

function extractCookie(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(', ');
  const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
  return csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
}
async function signup(email, ip) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  return { cookie: extractCookie(res), csrfToken: extractCsrfToken(res) };
}
async function createLeague(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).league;
}

describe('Part 3 (live-testing task, batch 5): hardcoded untranslated strings sweep', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('buildDashI18n (needsSeason=true, first-season prompt): seasonNameLabel and the new seasonNamePh both translate correctly', () => {
    const { fr, en } = buildDashI18n({ state: 'active', needsSeason: true, leagueName: 'Sweep League' });
    expect(fr.seasonNameLabel).toBe('Nom de la saison');
    expect(fr.seasonNamePh).toBe('Ex. Saison Hiver 2026');
    expect(en.seasonNameLabel).toBe('Season name');
    expect(en.seasonNamePh).not.toContain('Saison');
    expect(en.seasonNamePh.toLowerCase()).toContain('winter');
  });

  it('buildDashI18n (needsSeason=false, "Saisons" management section): seasonNameLabel used to be completely undefined here -- now translates too', () => {
    const { fr, en } = buildDashI18n({ state: 'active', needsSeason: false, leagueName: 'Sweep League' });
    expect(fr.seasonNameLabel).toBe('Nom de la saison');
    expect(fr.seasonNamePh).toBe('Ex. Saison Hiver 2026');
    expect(en.seasonNameLabel).toBe('Season name');
    expect(en.seasonNamePh).not.toContain('Saison');
  });

  it('the co-admin invite email placeholder translates on the Settings page (was a bare French literal, never wired; moved off the dashboard in batch 5 Part 7)', async () => {
    const { cookie, csrfToken } = await signup('sweep.inviteph@example.com', '203.0.182.004');
    await createLeague(cookie, csrfToken, { name: 'Sweep Invite League', teamNames: ['X', 'Y'] });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toContain('id="invite_email" type="email" data-i18n-ph="inviteEmailPh"');
    expect(html).toContain('placeholder="courriel@exemple.com"');
  });

  it('the served dashboard HTML wires data-i18n-ph on the season-name input (needsSeason state)', async () => {
    const { cookie, csrfToken } = await signup('sweep.needsseason@example.com', '203.0.182.001');
    await createLeague(cookie, csrfToken, { name: 'Sweep NeedsSeason League', teamNames: ['X', 'Y'] });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('id="season_name" type="text" data-i18n-ph="seasonNamePh"');
  });

  it('the served dashboard HTML wires data-i18n-ph on the season-mgmt-name input once a season already exists', async () => {
    const { cookie, csrfToken } = await signup('sweep.hasseason@example.com', '203.0.182.002');
    await createLeague(cookie, csrfToken, { name: 'Sweep Has Season League', teamNames: ['X', 'Y'] });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'S1' })
    });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('id="season_mgmt_name" type="text" data-i18n-ph="seasonNamePh"');
  });

  it('the roster page wires data-i18n-ph on the bulk-import textarea (was hardcoded French example names)', async () => {
    const { cookie, csrfToken } = await signup('sweep.roster@example.com', '203.0.182.003');
    await createLeague(cookie, csrfToken, { name: 'Sweep Roster League', teamNames: ['X', 'Y'] });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    expect(html).toContain('id="ro_bulk_text" data-i18n-ph="bulkTextPh"');
  });

  // A systematic sweep (script, run once outside this suite -- the
  // Workers test sandbox's virtualized filesystem can't read the real
  // source tree via fs.readFileSync, so this can't run as a live
  // vitest case here) checked every data-i18n/data-i18n-ph reference
  // on every in-scope bilingual page -- dashboard, comms, settings,
  // roster, schedule, event-detail, signup -- against real fr+en dict
  // definitions in the same scope. After the fixes above, it found no
  // further orphan keys (a key referenced in HTML but never defined
  // in that page's own dict, the same bug class as the two found
  // here). The individual known-bad cases this sweep surfaced are
  // each covered by their own test above instead.
});

// Live-testing task (batch 5), Part 1: the settings/dashboard delete
// confirmation contradicted itself -- the label (via data-i18n) DID
// switch language correctly ("Type DELETE..." on the English page),
// but the input's placeholder hint was a server-rendered literal
// string ("SUPPRIMER {name}") with no i18n wiring at all, so it never
// changed regardless of displayed language. A user reading the
// English label, then typing what the placeholder showed them, would
// be typing the FRENCH keyword and have it silently rejected (or,
// worse, successfully match if they happened to type the French one
// shown, on a page whose label told them to type an English one --
// either way, the on-screen instruction contradicted itself).
//
// Root cause: nlAuthScript's applyLanguage() (shared by dashboard,
// settings, signup, and more) only ever swapped [data-i18n] elements'
// innerHTML -- there was no placeholder-attribute equivalent, unlike
// the league-comms/board pages' own applyLanguage(), which already
// had a [data-i18n-ph] convention. Fix: bring that same convention
// into nlAuthScript's applyLanguage(), add data-i18n-ph="hardDeleteConfirmPh"
// to both hard-delete inputs (the dashboard's 'deactivated'-state
// card, and the still-active dashboard's advance-notice card -- see
// Part 7, which will later move both into Settings), and add real
// fr/en values for that key to BOTH of buildDashI18n's state branches
// ('active' and 'deactivated' had two independent dicts; only 'active'
// had hardDelete* keys at all before this fix -- 'deactivated' state
// silently never translated the whole hard-delete section, a second
// instance of the same underlying bug class Part 3 asks to sweep for).
//
// Also verifies Part 1.2: the deactivate confirmation does NOT have
// this bug -- its label says "type your league's name" (no baked-in
// keyword) and its placeholder is just the league's own name, which
// is identical in both languages by construction. No fix needed there.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { buildDashI18n } from '../src';

const AUTH_SECRET = 'test-part65-delete-confirm-i18n-secret';

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
async function deactivate(cookie, csrfToken, confirmName) {
  return SELF.fetch('http://example.com/league/deactivate', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ confirmName })
  });
}

describe('Part 1 (live-testing task, batch 5): delete confirmation keyword matches the displayed instruction', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  // buildDashI18n('active') no longer defines hardDeleteConfirmLabel/Ph
  // at all -- batch 5 Part 7 moved the active-state "advance notice"
  // hard-delete card to Settings (no confirm field there, since it's
  // never actionable while still active) and left the real, actionable
  // version only on the 'deactivated' state below, which is the one
  // this fix actually needed to be correct in the first place.
  it("buildDashI18n('deactivated') has the correct hardDelete* keys -- SUPPRIMER for fr, DELETE for en, matching each language's own label", () => {
    const { fr, en } = buildDashI18n({ state: 'deactivated', leagueName: 'Ligue Test 65' });
    expect(fr.hardDeleteConfirmLabel).toContain('SUPPRIMER');
    expect(fr.hardDeleteConfirmPh).toBe('SUPPRIMER Ligue Test 65');
    expect(en.hardDeleteConfirmLabel).toContain('DELETE');
    expect(en.hardDeleteConfirmPh).toBe('DELETE Ligue Test 65');
    // Sanity: this used to be the ONLY key 'deactivated' defined.
    expect(fr.deactivatedOn).toBeTruthy();
    expect(en.deactivatedOn).toBeTruthy();
  });

  // deactivateConfirmLabel now lives in I18N_SETTINGS, not
  // buildDashI18n (batch 5 Part 7 moved the deactivate section to
  // Settings) -- verified directly via HTTP against the real page.
  it('the deactivate confirmation on Settings has NO keyword baked into its label or placeholder (Part 1.2: verified clean, no fix needed)', async () => {
    const { cookie, csrfToken } = await signup('delconfirm.deactivatelabel@example.com', '203.0.180.004');
    const league = await createLeague(cookie, csrfToken, { name: 'Delete Confirm League D', teamNames: ['X', 'Y'] });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="deactivateConfirmLabel">Tape le nom de ta ligue pour confirmer<');
    expect(html).toContain(`id="deactivate_confirm" type="text" placeholder="${league.name}"`);
  });

  it('the served dashboard HTML (deactivated-league state) wires the hard-delete input to data-i18n-ph="hardDeleteConfirmPh", not a static placeholder alone', async () => {
    const { cookie, csrfToken } = await signup('delconfirm.deactivated@example.com', '203.0.180.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Delete Confirm League A', teamNames: ['X', 'Y'], tracksStats: true });
    const deactRes = await deactivate(cookie, csrfToken, league.name);
    expect(deactRes.status).toBe(200);

    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n-ph="hardDeleteConfirmPh"');
    // The initial SSR placeholder (before any client-side language
    // swap) is the French default -- unchanged behavior, still correct
    // on its own since the label right above it is French too by
    // default.
    expect(html).toContain(`placeholder="SUPPRIMER ${league.name}"`);
  });

  it('a still-active league sees only the advance-notice hard-delete card on Settings (no confirm field -- it is not actionable yet); the real one stays on the dashboard\'s deactivated state (live-testing task, batch 5, Part 7)', async () => {
    const { cookie, csrfToken } = await signup('delconfirm.active@example.com', '203.0.180.002');
    await createLeague(cookie, csrfToken, { name: 'Delete Confirm League B', teamNames: ['X', 'Y'], tracksStats: true });

    const settingsHtml = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(settingsHtml).toContain('data-i18n="hardDeleteNotDeactivated"');
    expect(settingsHtml).not.toContain('id="hard_delete_confirm"');

    const dashHtml = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(dashHtml).not.toContain('id="hard_delete_confirm"'); // not reachable while still active
  });

  it("the shared applyLanguage() embedded in the page's own script now includes the [data-i18n-ph] swap block", async () => {
    const { cookie, csrfToken } = await signup('delconfirm.script@example.com', '203.0.180.003');
    await createLeague(cookie, csrfToken, { name: 'Delete Confirm League C', teamNames: ['X', 'Y'], tracksStats: true });

    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain("data-i18n-ph");
    expect(html).toContain("el.placeholder = dict[k]");
  });
});

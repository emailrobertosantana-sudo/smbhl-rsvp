// Group D (smaller UI fixes polish task).
//
// D1: a long league name ("Sunday Morning Hockey League") truncated
// in the nav with no way to see it in full. Added title= (native
// tooltip + accessible name for assistive tech) to both the admin
// nav's .nl-brand and the public page's own -- same truncation CSS,
// same fix. Decided against a separate short-name field.
//
// D2: Settings' league-colour field was an unrestricted native colour
// picker driving the public page -- nothing prevented an illegible
// choice. Replaced with LEAGUE_COLOR_PRESETS, the SAME already-
// shipped, already-verified 8-colour palette ROSTER_TEAM_DOTS uses
// for team dots (test/part51 proves each clears >=3:1 against both
// #ffffff, the Épuré public theme, and #16181d, the Arène theme's
// surface-hero) -- reused rather than a second invented palette. An
// existing league whose stored colour isn't one of the 8 keeps
// rendering exactly as before (leagueFillColor()/the public page are
// completely untouched); the picker shows it as an extra "current"
// swatch so the admin isn't left looking at nothing selected.
//
// D3: covered in its own describe block below.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part90-group-d-ui-fixes-secret';

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
async function publishSeason(cookie, csrfToken, body) {
  return SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
}
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex).trim());
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}
function relLuminance({ r, g, b }) {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const [R, G, B] = [f(r), f(g), f(b)];
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
function contrastRatio(h1, h2) {
  const L1 = relLuminance(hexToRgb(h1));
  const L2 = relLuminance(hexToRgb(h2));
  const [lighter, darker] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (lighter + 0.05) / (darker + 0.05);
}

describe('D1: a long league name gets a tooltip + title attribute where it truncates', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the admin nav (.nl-brand) carries title= with the real full name', async () => {
    const { cookie, csrfToken } = await signup('d1.nav@example.com', '203.0.213.001');
    await createLeague(cookie, csrfToken, { name: 'Sunday Morning Hockey League', teamNames: ['A', 'B'] });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('<span class="nl-brand" style="max-width:280px" title="Sunday Morning Hockey League">Sunday Morning Hockey League</span>');
  });

  it('the public page header also carries title=', async () => {
    const { cookie, csrfToken } = await signup('d1.public@example.com', '203.0.213.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Sunday Morning Hockey League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const html = await (await SELF.fetch(`http://example.com/league/public?league=${league.id}`)).text();
    expect(html).toContain('title="Sunday Morning Hockey League"');
  });

  it('no separate short-name field was added -- leagues.name stays the single source of the league\'s name', async () => {
    const { cookie, csrfToken } = await signup('d1.nofield@example.com', '203.0.213.003');
    await createLeague(cookie, csrfToken, { name: 'Sunday Morning Hockey League', teamNames: ['A', 'B'] });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).not.toContain('short_name');
    expect(html).not.toContain('shortName');
  });
});

describe('D2: league colour is a curated, verified-legible preset palette', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the 8 presets rendered on Settings are exactly ROSTER_TEAM_DOTS -- same palette, one source of truth', async () => {
    const { cookie, csrfToken } = await signup('d2.presets@example.com', '203.0.213.004');
    await createLeague(cookie, csrfToken, { name: 'D2 Presets League', teamNames: ['A', 'B'] });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();

    const expectedHexes = ['#c0392b', '#2980b9', '#16a085', '#8e44ad', '#d35400', '#c2185b', '#4a5fc1', '#b7791f'];
    for (const hex of expectedHexes) {
      expect(html).toContain(`data-hex="${hex}"`);
    }
    // Exactly 8 -- roughly the low end of "8 to 12", not padded with
    // invented colours to hit a higher number. A brand-new league gets
    // an explicit preset at creation (see handleLeagueCreate's own
    // comment) rather than the old schema-default #b3122e (which
    // fails the >=3:1 bar), so there's no stray "current" 9th swatch.
    const matches = html.match(/class="se-color-swatch[^"]*" style="background:#[0-9a-f]{6}" data-hex=/g) || [];
    expect(matches.length).toBe(8);
    // The CSS rule for .se-color-swatch--current is always present in
    // the <style> block regardless of whether any element uses it --
    // the real check is no button ELEMENT carrying that class, which
    // the exact-8-matches count above already confirms (an extra
    // "current" swatch would make it 9).
    expect(html).not.toMatch(/class="se-color-swatch se-color-swatch--current/);
  });

  it('every preset independently clears >=3:1 against BOTH public themes\' real backgrounds (WCAG non-text minimum)', () => {
    const presets = ['#c0392b', '#2980b9', '#16a085', '#8e44ad', '#d35400', '#c2185b', '#4a5fc1', '#b7791f'];
    for (const hex of presets) {
      const vsArene = contrastRatio(hex, '#16181d');
      const vsEpure = contrastRatio(hex, '#ffffff');
      expect(vsArene).toBeGreaterThanOrEqual(3.0);
      expect(vsEpure).toBeGreaterThanOrEqual(3.0);
    }
  });

  it('the swatch names are real dict keys, both languages, kept in sync with a client-side toggle', async () => {
    const { cookie, csrfToken } = await signup('d2.names@example.com', '203.0.213.005');
    await createLeague(cookie, csrfToken, { name: 'D2 Names League', teamNames: ['A', 'B'] });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/);
    const dict = JSON.parse(m[1]);
    expect(dict.fr.colorPresetRed).toBe('Rouge');
    expect(dict.en.colorPresetRed).toBe('Red');
    expect(dict.fr.colorPresetTeal).toBe('Sarcelle');
    expect(dict.en.colorPresetTeal).toBe('Teal');
    expect(html).toContain('data-i18n-title="colorPresetRed"');
    expect(html).toContain("document.querySelectorAll('[data-i18n-title]')");
  });

  it('selecting a swatch updates the hidden #se_color input the existing save logic reads -- no backend change needed', async () => {
    const { cookie, csrfToken } = await signup('d2.hidden@example.com', '203.0.213.006');
    await createLeague(cookie, csrfToken, { name: 'D2 Hidden League', teamNames: ['A', 'B'] });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toContain('<input type="hidden" id="se_color"');
    expect(html).toContain('function selectLeagueColor(hex, btn)');
    expect(html).toContain("document.getElementById('se_color').value = hex");
    expect(html).toContain("color: document.getElementById('se_color').value");
  });

  it('a league with an existing custom colour outside the preset set keeps it rendering unchanged, shown as an extra "current" swatch', async () => {
    const { cookie, csrfToken } = await signup('d2.legacy@example.com', '203.0.213.007');
    const league = await createLeague(cookie, csrfToken, { name: 'D2 Legacy League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    // A colour outside the 8-preset set, set directly (as an existing
    // pre-D2 league might have via the old free picker).
    await SELF.fetch('http://example.com/league/settings/identity', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ color: '#3498db' })
    });

    const settingsHtml = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(settingsHtml).toMatch(/class="se-color-swatch se-color-swatch--current on" style="background:#3498db" data-hex="#3498db"/);

    // The stored value and the public page's own rendering are
    // completely untouched by D2 -- still leagueFillColor(leagueRow.color)
    // exactly as before (that function may legitimately darken a
    // color for contrast, same as it always has; D2 only changed the
    // SETTINGS PICKER, never storage or the public page).
    const row = await env.DB.prepare('SELECT color FROM leagues WHERE id = ?').bind(league.id).first();
    expect(row.color).toBe('#3498db');
    const publicRes = await SELF.fetch(`http://example.com/league/public?league=${league.id}`);
    expect(publicRes.status).toBe(200);
  });

  it('a league whose colour IS a preset shows no extra "current" swatch -- only the matching preset is marked selected', async () => {
    const { cookie, csrfToken } = await signup('d2.matched@example.com', '203.0.213.008');
    await createLeague(cookie, csrfToken, { name: 'D2 Matched League', teamNames: ['A', 'B'] });
    await SELF.fetch('http://example.com/league/settings/identity', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ color: '#2980b9' })
    });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).not.toMatch(/class="se-color-swatch se-color-swatch--current/);
    expect(html).toMatch(/class="se-color-swatch on" style="background:#2980b9"/);
  });

  it('per-team dot colours are unaffected -- still a free native colour input, a different field entirely', async () => {
    const { cookie, csrfToken } = await signup('d2.teamdots@example.com', '203.0.213.009');
    await createLeague(cookie, csrfToken, { name: 'D2 Team Dots League', teamNames: ['A', 'B'] });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toContain('data-team-color');
    expect(html).toMatch(/<input type="color" class="se-color"[^>]*data-team-color/);
  });
});

// Live-testing task (batch 2), Part 7: league colour contrast
// failures. On the public page's "next match" banner, the eyebrow
// text and venue name were unreadable against the league's colour.
//
// ROOT CAUSE: leagueFillColor() only guarantees >=4.5:1 contrast for
// SOLID #ffffff against its own darkened output -- a league colour
// that just clears that bar leaves no headroom for a REDUCED-opacity
// white layered on top of it. .pb-hero-venue (rgba(255,255,255,.75)),
// .pb-hero-pool (rgba(255,255,255,.9)), and the eyebrow's inline
// rgba(255,255,255,.65) all sit directly on the hero's DYNAMIC,
// per-league background (style="background:${fillColor}"), unlike
// .pb-foot/.rv-* elsewhere in this app, which sit on the page's own
// FIXED, always-near-black surface-hero background (safe at any
// opacity) -- an established pattern that doesn't transfer safely to a
// per-league colour. Fixed by using solid, full-opacity white for all
// three (de-emphasis now comes from size/weight alone, already true).
//
// Also: the team-colour default palette (ROSTER_TEAM_DOTS) "appeared
// randomly assigned, producing poor combinations" -- not literally
// random, but several existing entries failed a reasonable 3:1
// non-text-contrast minimum against one of the two real surfaces a
// team dot renders on (white, and the Arène theme's near-black
// surface-hero). Replaced with a curated 8-colour palette, each
// verified to clear >=3:1 against both.
import { env, SELF } from 'cloudflare:test';
import { leagueFillColor } from '../src/design_system.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part7-batch2-league-colour-contrast-secret';

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

// Real WCAG relative-luminance contrast math, independent of the
// app's own implementation (so this test can't pass merely by
// agreeing with a bug in the app's own contrastRatio).
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}
function relLuminance({ r, g, b }) {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const [R, G, B] = [f(r), f(g), f(b)];
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
function contrastRatio(h1, h2) {
  const L1 = relLuminance(hexToRgb(h1)), L2 = relLuminance(hexToRgb(h2));
  const [l, d] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (l + 0.05) / (d + 0.05);
}

describe('Part 7 (live-testing task, batch 2): league colour contrast', () => {
  describe('leagueFillColor is applied and text against it uses solid, full-opacity colours', () => {
    it('darkens a low-contrast league colour until solid white reaches 4.5:1 (existing guarantee, re-confirmed)', () => {
      // A bright, light colour that fails 4.5:1 for white as-is.
      const fixed = leagueFillColor('#ffd23f');
      expect(contrastRatio(fixed, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    });

    it('a colour that already passes is returned unchanged (byte-for-byte, case-insensitive)', () => {
      expect(leagueFillColor('#16181d').toLowerCase()).toBe('#16181d');
    });

    beforeAll(async () => {
      env.AUTH_SECRET = AUTH_SECRET;
      await applyRealSchema(env);
    });

    it('the public page hero banner: eyebrow, venue, and pool text are all solid white, not reduced opacity', async () => {
      const { cookie, csrfToken } = await signup('colourcontrast.hero@example.com', '203.0.167.001');
      // A colour specifically chosen to be right at the edge of
      // leagueFillColor's own 4.5:1-for-solid-white guarantee, so a
      // reduced-opacity overlay on top of it would visibly fail if the
      // bug were still present.
      const league = await createLeague(cookie, csrfToken, { name: 'Colour Contrast League', teamNames: ['A', 'B'], tracksStats: true });
      await SELF.fetch('http://example.com/league/settings/identity', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ color: '#b8860b' })
      });
      await SELF.fetch('http://example.com/league/season/publish', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ season_name: 'S1' })
      });
      await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ date: '2099-05-05', venue: 'Contrast Test Arena' })
      });
      const html = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
      // Eyebrow (inline style).
      expect(html).toContain('style="color:#fff"');
      expect(html).not.toContain('rgba(255,255,255,.65)');
      // Venue and pool text (CSS rules).
      expect(html).toMatch(/\.pb-hero-venue\s*\{[^}]*color:\s*#fff/);
      expect(html).toMatch(/\.pb-hero-pool\s*\{[^}]*color:\s*#fff/);
      expect(html).not.toContain('rgba(255,255,255,.75)');
      expect(html).not.toContain('rgba(255,255,255,.9)');
      expect(html).toContain('Contrast Test Arena');
    });

    it('an already-safe league colour still fills the hero unchanged (no unnecessary darkening)', async () => {
      const { cookie, csrfToken } = await signup('colourcontrast.safe@example.com', '203.0.167.002');
      const league = await createLeague(cookie, csrfToken, { name: 'Colour Contrast Safe League', teamNames: ['A', 'B'], tracksStats: true });
      await SELF.fetch('http://example.com/league/settings/identity', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ color: '#16181d' })
      });
      await SELF.fetch('http://example.com/league/season/publish', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ season_name: 'S1' })
      });
      await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ date: '2099-05-06' })
      });
      const html = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
      expect(html).toContain('style="background:#16181d"');
    });
  });

  describe('curated team-colour palette: every colour clears >=3:1 against both surfaces', () => {
    it('every default team-dot colour passes >=3:1 against #ffffff AND #16181d', async () => {
      const { cookie, csrfToken } = await signup('colourcontrast.dots@example.com', '203.0.167.003');
      // 8 teams, no explicit team_colors -- exercises every entry of
      // the default palette via resolveTeamColor's own fallback.
      await createLeague(cookie, csrfToken, {
        name: 'Colour Contrast Dots League',
        teamNames: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'],
        tracksStats: true
      });
      const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
      const dotColors = [...html.matchAll(/class="nl-dot" style="background:(#[0-9a-fA-F]{6})"/g)].map(m => m[1]);
      expect(dotColors.length).toBe(8);
      expect(new Set(dotColors).size).toBe(8); // all distinct
      for (const c of dotColors) {
        expect(contrastRatio(c, '#ffffff')).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(c, '#16181d')).toBeGreaterThanOrEqual(3);
      }
    });

    it('the old, poorly-contrasted palette entries are gone', async () => {
      const { cookie, csrfToken } = await signup('colourcontrast.oldpalette@example.com', '203.0.167.004');
      await createLeague(cookie, csrfToken, {
        name: 'Colour Contrast Old Palette League',
        teamNames: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'],
        tracksStats: true
      });
      const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
      for (const bad of ['#a3123a', '#6d3fae', '#8b4a1c']) {
        expect(html.toLowerCase()).not.toContain(bad.toLowerCase());
      }
    });

    it('a league\'s own explicit team_colors still override the default palette (unaffected by this change)', async () => {
      const { cookie, csrfToken } = await signup('colourcontrast.custom@example.com', '203.0.167.005');
      await createLeague(cookie, csrfToken, { name: 'Colour Contrast Custom League', teamNames: ['A', 'B'], tracksStats: true });
      await SELF.fetch('http://example.com/league/settings/teams', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ teamNames: ['A', 'B'], teamColors: ['#123456', '#654321'] })
      });
      const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
      expect(html).toContain('#123456');
      expect(html).toContain('#654321');
    });
  });
});

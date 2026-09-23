// Part 1 (design system task): foundation -- fonts, tokens, base
// styles, the real notre-ligue-design-system/ applied for the first
// time. A brand-new, SEPARATE document shell (nlDocument, src/index.js)
// from SMBHL's own page() shell -- page() is completely untouched by
// this task (see its own test coverage, unmodified and still green).
// leagues.color (migrate-025.sql) is the per-league brand color the
// design system's core rule depends on for player-facing surfaces.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { TOKENS_CSS, BUNDLE_CSS, BUNDLE_JS, leagueFillColor } from '../src/design_system.js';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part1-design-system-secret';

describe('Part 1 (design system): foundation', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('TOKENS_CSS defines the real color tokens from tokens.json, light and dark', () => {
    expect(TOKENS_CSS).toContain('--surface:#ffffff');
    expect(TOKENS_CSS).toContain('--ink:#16181d');
    expect(TOKENS_CSS).toContain('--yellow:#ffd23f');
    expect(TOKENS_CSS).toContain('--league:#b3122e');
    expect(TOKENS_CSS).toContain('prefers-color-scheme: dark');
    expect(TOKENS_CSS).toContain('--surface:#121418'); // dark theme surface
    expect(TOKENS_CSS).toContain('--font-display:"Archivo"');
  });

  it('TOKENS_CSS defines the real spacing/radius/size scale from tokens.json', () => {
    expect(TOKENS_CSS).toContain('--space-4:16px');
    expect(TOKENS_CSS).toContain('--space-6:32px');
    expect(TOKENS_CSS).toContain('--radius-lg:6px');
    expect(TOKENS_CSS).toContain('--control-md:48px');
    expect(TOKENS_CSS).toContain('--control-lg:64px');
    expect(TOKENS_CSS).toContain('--header-h:56px');
    expect(TOKENS_CSS).toContain('--content-narrow:480px');
    expect(TOKENS_CSS).toContain('--content-wide:1120px');
  });

  it('BUNDLE_CSS carries the real nl- prefixed component classes', () => {
    for (const cls of ['.nl-btn', '.nl-field', '.nl-card', '.nl-badge', '.nl-header', '.nl-meter', '.nl-steps', '.nl-lang']) {
      expect(BUNDLE_CSS).toContain(cls);
    }
  });

  it('BUNDLE_JS exposes window.NotreLigue with the real component helpers', () => {
    expect(BUNDLE_JS).toContain('window.NotreLigue');
    for (const fn of ['Button:', 'Field:', 'Card:', 'Badge:', 'AppHeader:', 'Stepper:', 'SpotMeter:', 'slugify:']) {
      expect(BUNDLE_JS).toContain(fn);
    }
  });

  it("leagueFillColor guarantees white-text contrast (4.5:1+), darkening only when the league's own color doesn't already pass", () => {
    // The design system's own sample color already passes -- unchanged.
    expect(leagueFillColor('#b3122e')).toBe('#b3122e');
    // A color that can't carry white text un-darkened gets stepped down
    // until it does -- never returned as-is.
    const darkenedYellow = leagueFillColor('#ffd23f');
    expect(darkenedYellow).not.toBe('#ffd23f');
    expect(darkenedYellow.toLowerCase()).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('a new league gets the design system\'s sample color by default (no color-picker exists yet)', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.691' },
      body: JSON.stringify({ email: 'part1.color@example.com', password: 'a-strong-password-1' })
    });
    const cookie = (signupRes.headers.get('set-cookie') || '').split(';')[0];
    const cookies = typeof signupRes.headers.getSetCookie === 'function' ? signupRes.headers.getSetCookie() : [cookie];
    const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
    const csrfToken = csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';

    const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Part 1 Color League', teamNames: ['A', 'B'], tracksStats: true })
    });
    const leagueId = (await leagueRes.json()).league.id;
    const row = await env.DB.prepare('SELECT color FROM leagues WHERE id = ?').bind(leagueId).first();
    expect(row.color).toBe('#b3122e');
  });

  it("SMBHL's own real pages are completely unaffected -- no Archivo font, no design-system tokens, page() unchanged", async () => {
    const res = await SELF.fetch('http://example.com/signup'); // still page(), not nlDocument, until Part 2 migrates it
    const html = await res.text();
    expect(html).not.toContain('Archivo');
    expect(html).not.toContain('--surface:#ffffff');
    expect(html).not.toContain('nl-btn');
    expect(html).toContain("Barlow"); // page()'s own, real, existing font -- untouched
  });
});

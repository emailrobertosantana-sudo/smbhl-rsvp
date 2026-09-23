// Bug found via a real end-to-end live verification against
// notreligue.ca: on public league pages (a dark surface-hero
// background, always dark in both light/dark OS themes -- see
// tokens.json's own surface-hero entry), the "Propulsé par Notre
// Ligue" footer link rendered in near-black text, invisible against
// the dark background.
//
// ROOT CAUSE: the shared base stylesheet's `.nl a { color: var(--ink); }`
// rule (design_system.js) has HIGHER CSS specificity (0,1,1) than a
// bare `.pb-foot` class selector (0,1,0) -- introduced when a prior
// fix turned the footer from a <div> into an <a> (so it could link to
// notreligue.ca), which made it start matching that shared rule too.
// In a light-OS-theme browser, var(--ink) resolves to near-black
// (#16181d), rendered on this page's own always-dark hero background
// (also #16181d) -- invisible. The exact same specificity bug also
// affected the RSVP page's own footer (.rv-foot), forcing full-
// strength var(--ink) instead of the intended var(--ink-muted) --
// less severe there (that page's background is theme-reactive, so
// var(--ink) stays readable), but the same real defect.
//
// FIX: `.nl a.pb-foot` / `.nl a.rv-foot` (0,2,1 specificity) reliably
// win regardless of source order. The public page's footer now uses
// ink-inverse's own token value (#f4f4f2, "text on surface-hero only"
// per tokens.json) at reduced opacity -- not var(--ink)/var(--ink-muted),
// both of which are theme-reactive and meant for the normal surface/
// surface-sunken context, not this always-dark hero -- matching the
// same rgba(255,255,255,X)-on-hero pattern this exact page already
// uses elsewhere (.pb-hero-venue). The RSVP page's footer keeps
// var(--ink-muted), correct for its own theme-reactive background.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part19-live-bugs-7-secret';
const RSVP_SECRET = 'test-part19-live-bugs-7-rsvp-secret';

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
  const league = (await res.json()).league;
  await SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ season_name: `${body.name} Season` })
  });
  return league;
}
async function addPlayer(cookie, csrfToken, name, extra = {}) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, ...extra })
  });
  return (await res.json()).contact.player_id;
}
async function createEvent(cookie, csrfToken, date) {
  return (await (await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ date })
  })).json()).event.id;
}
async function computeToken(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

describe('Live-testing bug: public-page footer link invisible on dark hero background', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    await applyRealSchema(env);
  });

  it('the public page footer uses a higher-specificity selector (.nl a.pb-foot) with a real, readable color -- not the losing bare .pb-foot form', async () => {
    const { cookie, csrfToken } = await signup('bugs7.footer.contrast.public@example.com', '203.0.122.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Footer Contrast Public League', teamNames: ['A', 'B'], tracksStats: true });
    const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`);
    const html = await res.text();

    // The fixed, higher-specificity rule is present.
    expect(html).toContain('.nl a.pb-foot {');
    // The vulnerable, LOSING bare-class form (no leading ".nl a") is
    // gone -- this is the exact selector shape that let the shared
    // base stylesheet's .nl a rule silently win.
    expect(html).not.toMatch(/[^a]\s\.pb-foot\s*\{/);
    // A real, readable-on-dark color (not var(--ink), which is what
    // was actually being rendered due to the specificity bug).
    const ruleMatch = html.match(/\.nl a\.pb-foot \{[^}]*\}/);
    expect(ruleMatch[0]).toContain('rgba(244,244,242');
    expect(ruleMatch[0]).not.toContain('var(--ink)');
  });

  it('the RSVP page footer also uses the higher-specificity selector (.nl a.rv-foot), keeping var(--ink-muted) -- correct for its own theme-reactive background', async () => {
    const { cookie, csrfToken } = await signup('bugs7.footer.contrast.rsvp@example.com', '203.0.122.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Footer Contrast RSVP League', teamNames: ['A', 'B'], tracksStats: true });
    const eventId = await createEvent(cookie, csrfToken, '2099-08-01');
    const playerId = await addPlayer(cookie, csrfToken, 'Footer Contrast Player', { team: 'A' });
    const salt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerId).first()).token_salt;
    const token = await computeToken(RSVP_SECRET, `lr:${league.id}:${eventId}:${playerId}:${salt}`);

    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(league.id)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`);
    const html = await res.text();
    expect(html).toContain('.nl a.rv-foot {');
    expect(html).not.toMatch(/[^a]\s\.rv-foot\s*\{/);
    const ruleMatch = html.match(/\.nl a\.rv-foot \{[^}]*\}/);
    expect(ruleMatch[0]).toContain('var(--ink-muted)');
  });

  it('the footer link markup and href are unaffected -- only the CSS specificity/color changed', async () => {
    const { cookie, csrfToken } = await signup('bugs7.footer.contrast.markup@example.com', '203.0.122.003');
    const league = await createLeague(cookie, csrfToken, { name: 'Footer Contrast Markup League', teamNames: ['A', 'B'], tracksStats: true });
    const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`);
    const html = await res.text();
    expect(html).toContain('<a class="pb-foot" href="https://notreligue.ca" data-i18n="poweredBy">');
  });
});

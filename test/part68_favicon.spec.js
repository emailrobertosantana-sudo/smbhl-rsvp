// Live-testing task (batch 5), Part 4: no favicon was served on any
// league-product page. Root cause: nlDocument() -- the shared page
// wrapper behind every league-product page (dashboard, settings,
// signup, roster, schedule, comms, event detail, the public page) --
// never had a <link rel="icon"> at all.
//
// The design system itself has no literal favicon spec (no favicon
// file, no pixel dimensions anywhere in notre-ligue-design-system/),
// but its own README is explicit about the ONE brand mark that
// exists: a 10px yellow square preceding the "NOTRE LIGUE" wordmark
// ("There is no Notre Ligue logo yet ... Leagues never get a
// generated logo"), and separately specs a plain solid yellow square
// as its own generic decorative shape ("solid rectangles in primary
// and yellow with radius-sm"). Implemented as an inline SVG data URI
// matching that exact shape -- no new asset needed, no logo invented
// that the design system doesn't have.
//
// SMBHL's own, separate page() wrapper already had a real (and still
// live) favicon reference of its own (https://smbhl.com/img/favicon-32.svg)
// before this task -- untouched by this change, since nlDocument() and
// page() are two completely independent functions.
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part68-favicon-secret';

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

describe('Part 4 (live-testing task, batch 5): a favicon is now served on every league-product page', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the signup page (nlDocument, no session needed) serves a real <link rel="icon"> pointing at the yellow-square brand mark', async () => {
    const html = await (await SELF.fetch('http://example.com/signup')).text();
    expect(html).toContain('<link rel="icon" href="data:image/svg+xml');
    expect(html).toContain('%23ffd23f');
  });

  it('the dashboard (a real authenticated league-product page) serves the same favicon', async () => {
    const { cookie } = await signup('favicon.dashboard@example.com', '203.0.183.001');
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('<link rel="icon" href="data:image/svg+xml');
  });

  it('the public league page (a player-facing, non-admin surface) also serves the favicon -- proving it is not admin-only', async () => {
    const { cookie, csrfToken } = await signup('favicon.public@example.com', '203.0.183.002');
    const created = await (await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Favicon Public League', teamNames: ['X', 'Y'] })
    })).json();
    const html = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(created.league.id)}`)).text();
    expect(html).toContain('<link rel="icon" href="data:image/svg+xml');
  });
});

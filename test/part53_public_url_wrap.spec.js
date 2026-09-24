// Live-testing task (batch 2), Part 9: the dashboard's public-page
// card wrapped the league's URL mid-word ("tesee11 / 6").
//
// ROOT CAUSE: word-break: break-all forces a line break at literally
// any character, with no regard for natural break points (a slash, a
// hyphen) -- exactly what produces a mangled mid-word wrap. Fixed with
// word-break: normal + overflow-wrap: anywhere, which restores the
// browser's normal preference for breaking at an existing boundary
// first, only falling back to a mid-word break when a single unbroken
// run of characters genuinely can't fit otherwise.
//
// The identical bug existed on two other URL/slug displays (the
// signup completion screen's own public-URL card, and the settings
// page's read-only slug display) -- fixed the same way for
// consistency, per this task's own "check whether this affects other
// surfaces too" instruction elsewhere in the same batch.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part9-batch2-url-wrap-secret';

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

describe('Part 9 (live-testing task, batch 2): public-page URL wraps sensibly, not mid-word', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('dashboard public-page card: no more word-break: break-all, uses overflow-wrap: anywhere instead', async () => {
    const { cookie, csrfToken } = await signup('urlwrap.dashboard@example.com', '203.0.169.001');
    await createLeague(cookie, csrfToken, { name: 'URL Wrap Dashboard League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toMatch(/\.dash-share code\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(html).toMatch(/\.dash-share code\s*\{[^}]*word-break:\s*normal/);
    expect(html).not.toMatch(/\.dash-share code\s*\{[^}]*word-break:\s*break-all/);
  });

  it('signup completion screen: same fix applied to its own public-URL card', async () => {
    const { cookie, csrfToken } = await signup('urlwrap.signup@example.com', '203.0.169.002');
    await createLeague(cookie, csrfToken, { name: 'URL Wrap Signup League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/signup?step=done', { headers: { cookie } })).text();
    expect(html).toMatch(/\.su-url\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(html).not.toMatch(/\.su-url\s*\{[^}]*word-break:\s*break-all/);
  });

  it('settings page: same fix applied to the read-only slug display', async () => {
    const { cookie, csrfToken } = await signup('urlwrap.settings@example.com', '203.0.169.003');
    await createLeague(cookie, csrfToken, { name: 'URL Wrap Settings League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toMatch(/\.se-slug-display\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(html).not.toMatch(/\.se-slug-display\s*\{[^}]*word-break:\s*break-all/);
  });
});

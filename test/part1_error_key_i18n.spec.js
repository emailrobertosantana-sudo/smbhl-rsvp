// Part 1 (overnight follow-up task): server-returned error/validation
// messages previously bypassed the FR/EN toggle entirely -- every
// error string was shown verbatim in whatever language the server
// happened to write it in. Fixed with a key-based design: every route
// that returns a user-facing error now ALSO returns `errorKey`
// alongside the existing `error` field (which stays byte-for-byte
// unchanged, English, for logs/API consumers). Every page's error-
// display code resolves errorKey through a shared dictionary
// (src/error_i18n.js) via window.__errorText(), the same data-i18n-
// dictionary PATTERN already used for static content -- one system,
// not two. Also: forgot-password and reset-password never got a real
// toggle at all in the earlier work; both get one here, consistent
// with every other public page.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part1-error-key-secret';

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(', ');
  const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
  return csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
}

describe('Part 1: server error responses carry a translation key, resolved client-side through the shared toggle system', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('signup: a duplicate-email failure returns both the unchanged English error text AND a matching errorKey', async () => {
    await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.641' },
      body: JSON.stringify({ email: 'part1.dupe@example.com', password: 'a-strong-password-1' })
    });
    const res = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.642' },
      body: JSON.stringify({ email: 'part1.dupe@example.com', password: 'a-strong-password-1' })
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('An account with this email already exists.'); // byte-identical to before
    expect(json.errorKey).toBe('EMAIL_EXISTS');
  });

  it('login: an invalid-credentials failure carries errorKey, and the signup page ships the matching French translation in its dictionary', async () => {
    const res = await SELF.fetch('http://example.com/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password' })
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.errorKey).toBe('INVALID_CREDENTIALS');

    const loginHtml = await (await SELF.fetch('http://example.com/login')).text();
    expect(loginHtml).toContain('window.__ERROR_I18N');
    expect(loginHtml).toContain('"INVALID_CREDENTIALS"');
    expect(loginHtml).toContain('Courriel ou mot de passe invalide.'); // the real French translation is present
    expect(loginHtml).toContain('window.__errorText');
  });

  it('dashboard: a deactivate-confirmation mismatch carries errorKey, and the dashboard ships the matching translation', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.643' },
      body: JSON.stringify({ email: 'part1.dash@example.com', password: 'a-strong-password-1' })
    });
    const cookie = extractCookie(signupRes);
    const csrfToken = extractCsrfToken(signupRes);
    await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Part 1 Dash League', teamNames: ['A', 'B'], tracksStats: true })
    });

    const res = await SELF.fetch('http://example.com/league/deactivate', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ confirmName: 'Wrong Name' })
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errorKey).toBe('CONFIRM_NAME_MISMATCH');

    const dashHtml = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(dashHtml).toContain('"CONFIRM_NAME_MISMATCH"');
    expect(dashHtml).toContain('window.__errorText(data.errorKey, data.error)');
  });

  it('the forgot-password page now has a real, working toggle (design system, migrated in Part 2)', async () => {
    const res = await SELF.fetch('http://example.com/forgot-password');
    const html = await res.text();
    expect(html).toContain('nl-lang');
    expect(html).toContain('id="btn-lang-en"');
    expect(html).toContain('data-i18n');
    expect(html).toContain('Forgot password'); // real English translation present
    expect(html).toContain('window.__ERROR_I18N');
  });

  it('the reset-password page now has a real, working toggle (design system, migrated in Part 2)', async () => {
    const res = await SELF.fetch('http://example.com/reset-password?token=whatever');
    const html = await res.text();
    expect(html).toContain('nl-lang');
    expect(html).toContain('id="btn-lang-en"');
    expect(html).toContain('data-i18n');
    expect(html).toContain('New password');
    expect(html).toContain('window.__ERROR_I18N');
  });

  it("SMBHL's own real /rsvp page is completely unaffected -- never given its own error dictionary, no errorKey data embedded", async () => {
    const res = await SELF.fetch('http://example.com/rsvp?e=2026-09-20&p=P0001&t=bad-token');
    const html = await res.text();
    expect(html).not.toContain('window.__ERROR_I18N = {'); // no dictionary DATA embedded (the shared comment mentioning the name is fine)
    expect(html).not.toContain('"errorKey"');
  });
});

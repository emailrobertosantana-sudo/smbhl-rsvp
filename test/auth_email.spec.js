import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { handleSignup, handleResendVerification } from '../src/auth.js';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-auth-email-secret';

function mockSendMail() {
  const sent = [];
  const fn = async (env2, to, subject, text, html) => {
    sent.push({ to, subject, text, html });
  };
  return { fn, sent };
}

describe('Part E: verification email sending', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('handleSignup calls sendMailFunc with the new user\'s own email and a working verification link', async () => {
    const { fn, sent } = mockSendMail();
    const req = new Request('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.90' },
      body: JSON.stringify({ email: 'verify.me@example.com', password: 'a-strong-password-1' })
    });

    const res = await handleSignup(req, env, fn);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe('verify.me@example.com');
    expect(sent[0].subject.toLowerCase()).toContain('confirm');
    expect(sent[0].text).toContain(encodeURIComponent(json.verification.token));
    expect(sent[0].html).toContain(encodeURIComponent(json.verification.token));
  });

  it('handleSignup does not send to any address other than the one the user just signed up with', async () => {
    const { fn, sent } = mockSendMail();
    const req = new Request('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.91' },
      body: JSON.stringify({ email: 'only.this.address@example.com', password: 'a-strong-password-1' })
    });

    await handleSignup(req, env, fn);
    expect(sent.every(m => m.to === 'only.this.address@example.com')).toBe(true);
  });

  it('handleSignup still succeeds and returns a working session even when sendMailFunc throws (e.g. no RESEND_API_KEY on this environment)', async () => {
    const throwingSendMail = async () => { throw new Error('RESEND_API_KEY not set'); };
    const req = new Request('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.92' },
      body: JSON.stringify({ email: 'send.fails@example.com', password: 'a-strong-password-1' })
    });

    const res = await handleSignup(req, env, throwingSendMail);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(res.headers.get('set-cookie') || '').toContain('user_session=');
  });

  it('handleSignup succeeds with no sendMailFunc at all (route not wired, or called directly)', async () => {
    const req = new Request('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.93' },
      body: JSON.stringify({ email: 'no.sendmail.arg@example.com', password: 'a-strong-password-1' })
    });

    const res = await handleSignup(req, env, null);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  describe('POST /auth/resend-verification (handleResendVerification)', () => {
    async function signupDirect(email, ip) {
      const req = new Request('http://example.com/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify({ email, password: 'a-strong-password-1' })
      });
      const res = await handleSignup(req, env, null); // no send on signup itself, for a clean slate
      const json = await res.json();
      const cookieHeader = (res.headers.get('set-cookie') || '').split(';')[0];
      const cookies = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : (res.headers.get('set-cookie') || '').split(', ');
      const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
      const csrfToken = csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
      return { json, cookieHeader, csrfToken };
    }

    it('requires an authenticated session', async () => {
      const req = new Request('http://example.com/auth/resend-verification', { method: 'POST' });
      const res = await handleResendVerification(req, env, mockSendMail().fn);
      expect(res.status).toBe(401);
    });

    it('sends a fresh verification email to the logged-in user\'s own address', async () => {
      const { cookieHeader, csrfToken } = await signupDirect('resend.me@example.com', '203.0.113.94');
      const { fn, sent } = mockSendMail();

      const req = new Request('http://example.com/auth/resend-verification', {
        method: 'POST',
        headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken }
      });
      const res = await handleResendVerification(req, env, fn);
      expect(res.status).toBe(200);
      const resendJson = await res.json();
      expect(resendJson.ok).toBe(true);
      expect(resendJson.alreadyVerified).toBe(false);

      expect(sent.length).toBe(1);
      expect(sent[0].to).toBe('resend.me@example.com');
    });

    it('reports alreadyVerified and does not send again once the address is verified', async () => {
      const { cookieHeader, csrfToken } = await signupDirect('already.verified@example.com', '203.0.113.95');
      await env.DB.prepare('UPDATE users SET email_verified_at = ? WHERE email = ?')
        .bind(new Date().toISOString(), 'already.verified@example.com').run();

      const { fn, sent } = mockSendMail();
      const req = new Request('http://example.com/auth/resend-verification', {
        method: 'POST',
        headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken }
      });
      const res = await handleResendVerification(req, env, fn);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.alreadyVerified).toBe(true);
      expect(sent.length).toBe(0);
    });
  });
});

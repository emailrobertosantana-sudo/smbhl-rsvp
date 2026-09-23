import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { handleSignup, handleResendVerification } from '../src/auth.js';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-verify-lang-secret';

function mockSendMail() {
  const sent = [];
  const fn = async (env2, to, subject, text, html) => {
    sent.push({ to, subject, text, html });
  };
  return { fn, sent };
}

describe('Part 1 (live-testing task): verification email sends in one language only', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a FR signup gets a FR-only email (no English content mixed in)', async () => {
    const { fn, sent } = mockSendMail();
    const req = new Request('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.100' },
      body: JSON.stringify({ email: 'fr.signup@example.com', password: 'a-strong-password-1', lang: 'fr' })
    });
    const res = await handleSignup(req, env, fn);
    expect(res.status).toBe(200);
    expect(sent.length).toBe(1);
    expect(sent[0].subject).toBe('Confirme ton courriel');
    expect(sent[0].text).toContain('Bienvenue');
    expect(sent[0].html).toContain('Confirme ton courriel');
    expect(sent[0].text).not.toContain('Welcome');
    expect(sent[0].html).not.toContain('Confirm your email');
    expect(sent[0].html).not.toContain('Welcome!');
  });

  it('an EN signup gets an EN-only email (no French content mixed in)', async () => {
    const { fn, sent } = mockSendMail();
    const req = new Request('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.101' },
      body: JSON.stringify({ email: 'en.signup@example.com', password: 'a-strong-password-1', lang: 'en' })
    });
    const res = await handleSignup(req, env, fn);
    expect(res.status).toBe(200);
    expect(sent.length).toBe(1);
    expect(sent[0].subject).toBe('Confirm your email');
    expect(sent[0].text).toContain('Welcome');
    expect(sent[0].html).toContain('Confirm your email');
    expect(sent[0].text).not.toContain('Bienvenue');
    expect(sent[0].html).not.toContain('Confirme ton courriel');
  });

  it('omitting lang defaults to French, matching every other lang fallback in this app', async () => {
    const { fn, sent } = mockSendMail();
    const req = new Request('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.102' },
      body: JSON.stringify({ email: 'no.lang.signup@example.com', password: 'a-strong-password-1' })
    });
    const res = await handleSignup(req, env, fn);
    expect(res.status).toBe(200);
    expect(sent[0].subject).toBe('Confirme ton courriel');
  });

  it('an invalid lang value falls back to French rather than erroring', async () => {
    const { fn, sent } = mockSendMail();
    const req = new Request('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.103' },
      body: JSON.stringify({ email: 'bad.lang.signup@example.com', password: 'a-strong-password-1', lang: 'xx' })
    });
    const res = await handleSignup(req, env, fn);
    expect(res.status).toBe(200);
    expect(sent[0].subject).toBe('Confirme ton courriel');
  });

  it('the chosen signup language is persisted, and a resend uses that same language later', async () => {
    const { fn: signupFn } = mockSendMail();
    const req = new Request('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.104' },
      body: JSON.stringify({ email: 'resend.lang@example.com', password: 'a-strong-password-1', lang: 'en' })
    });
    const signupRes = await handleSignup(req, env, signupFn);
    const cookieHeader = (signupRes.headers.get('set-cookie') || '').split(';')[0];
    const cookies = typeof signupRes.headers.getSetCookie === 'function'
      ? signupRes.headers.getSetCookie()
      : (signupRes.headers.get('set-cookie') || '').split(', ');
    const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
    const csrfToken = csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';

    const { fn: resendFn, sent: resendSent } = mockSendMail();
    const resendReq = new Request('http://example.com/auth/resend-verification', {
      method: 'POST',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken }
    });
    const resendRes = await handleResendVerification(resendReq, env, resendFn);
    expect(resendRes.status).toBe(200);
    expect(resendSent.length).toBe(1);
    expect(resendSent[0].subject).toBe('Confirm your email');
  });
});

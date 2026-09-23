// Part 6: password reset. Request reset (email + form) -> a signed,
// time-limited HMAC token (same shape as email verification, its own
// message prefix so the two token kinds can never be confused/replayed
// as each other) -> emailed link -> set new password. Reuses the real
// email-sending infrastructure (the injected sendMailFunc, exactly like
// signup/resend-verification), and invalidates every existing session
// on a successful reset via the existing invalidateAllSessions
// (session_epoch bump) -- reused, not reimplemented.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part6-password-reset-secret';

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

async function withMailMock(fn) {
  const originalFetch = globalThis.fetch;
  const sentMails = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      sentMails.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ id: 'mock_resend_id' }), { status: 200 });
    }
    return originalFetch(url, opts);
  };
  try {
    return { sentMails, result: await fn(sentMails) };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function extractResetToken(sentMail) {
  const raw = JSON.stringify(sentMail);
  const m = /\/reset-password\?token=([^\s"'<\\]+)/.exec(raw);
  if (!m) throw new Error('No reset link found in mail body: ' + raw);
  return decodeURIComponent(m[1]);
}

describe('Part 6: password reset flow', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RESEND_API_KEY = 're_test_key_part6';
    await applyRealSchema(env);

    await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.451' },
      body: JSON.stringify({ email: 'part6.reset@example.com', password: 'original-password-1' })
    });
  });

  it('GET /forgot-password and GET /reset-password render real forms', async () => {
    const fp = await SELF.fetch('http://example.com/forgot-password');
    expect(fp.status).toBe(200);
    expect(await fp.text()).toContain('id="fp_email"');

    const rp = await SELF.fetch('http://example.com/reset-password?token=whatever');
    expect(rp.status).toBe(200);
    expect(await rp.text()).toContain('id="rp_password"');
  });

  it('the full real round trip: request sends a real email with a working link, and the new password actually works to log in', async () => {
    const { sentMails, result: reqRes } = await withMailMock(async () =>
      SELF.fetch('http://example.com/auth/request-password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.452' },
        body: JSON.stringify({ email: 'part6.reset@example.com' })
      })
    );
    expect(reqRes.status).toBe(200);
    expect((await reqRes.json()).ok).toBe(true);
    expect(sentMails.length).toBe(1);
    expect(sentMails[0].to).toEqual(['part6.reset@example.com']);

    const token = extractResetToken(sentMails[0]);

    const resetRes = await SELF.fetch('http://example.com/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password: 'brand-new-password-2' })
    });
    expect(resetRes.status).toBe(200);
    const resetJson = await resetRes.json();
    expect(resetJson.ok).toBe(true);
    // A fresh session cookie is issued immediately, same convention as signup.
    expect(resetRes.headers.get('set-cookie') || '').toContain('user_session=');

    // The OLD password no longer works.
    const oldLoginRes = await SELF.fetch('http://example.com/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'part6.reset@example.com', password: 'original-password-1' })
    });
    expect(oldLoginRes.status).toBe(401);

    // The NEW password works.
    const newLoginRes = await SELF.fetch('http://example.com/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'part6.reset@example.com', password: 'brand-new-password-2' })
    });
    expect(newLoginRes.status).toBe(200);
  });

  it('resetting invalidates every prior session (session_epoch bump), not just the one that requested it', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.453' },
      body: JSON.stringify({ email: 'part6.multisession@example.com', password: 'session-one-password' })
    });
    const oldSessionCookie = extractCookie(signupRes);

    // Confirm the old session genuinely works before reset.
    const preCheck = await SELF.fetch('http://example.com/dashboard', { headers: { cookie: oldSessionCookie }, redirect: 'manual' });
    expect(preCheck.status).toBe(200);

    const { sentMails } = await withMailMock(async () =>
      SELF.fetch('http://example.com/auth/request-password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.454' },
        body: JSON.stringify({ email: 'part6.multisession@example.com' })
      })
    );
    const token = extractResetToken(sentMails[0]);
    await SELF.fetch('http://example.com/auth/reset-password', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password: 'session-two-password' })
    });

    // The pre-reset session cookie is now dead.
    const postCheck = await SELF.fetch('http://example.com/dashboard', { headers: { cookie: oldSessionCookie }, redirect: 'manual' });
    expect(postCheck.status).toBe(302);
    expect(postCheck.headers.get('location') || '').toContain('/login');
  });

  it('does not reveal whether an email has an account (always { ok: true }, real or not)', async () => {
    const { sentMails, result: res } = await withMailMock(async () =>
      SELF.fetch('http://example.com/auth/request-password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.455' },
        body: JSON.stringify({ email: 'no.such.account@example.com' })
      })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(sentMails.length).toBe(0); // nothing sent, but the response doesn't say so
  });

  it('a garbage or expired token is rejected cleanly, not a crash', async () => {
    const res = await SELF.fetch('http://example.com/auth/reset-password', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-token', password: 'whatever-password-1' })
    });
    expect([400, 410]).toContain(res.status);
    expect((await res.json()).ok).toBe(false);
  });

  it('rejects a new password under 8 characters', async () => {
    const res = await SELF.fetch('http://example.com/auth/reset-password', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'irrelevant', password: 'short' })
    });
    expect(res.status).toBe(400);
  });

  it('rate-limits repeated reset requests from the same IP, independent of the signup rate limit', async () => {
    const ip = '203.0.113.456';
    for (let i = 0; i < 5; i++) {
      await SELF.fetch('http://example.com/auth/request-password-reset', {
        method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify({ email: `rate.limit.${i}@example.com` })
      });
    }
    const res = await SELF.fetch('http://example.com/auth/request-password-reset', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ email: 'rate.limit.overflow@example.com' })
    });
    expect(res.status).toBe(429);

    // A signup from the SAME IP is unaffected -- separate counters.
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ email: 'not.rate.limited@example.com', password: 'a-strong-password-1' })
    });
    expect(signupRes.status).toBe(200);
  });
});

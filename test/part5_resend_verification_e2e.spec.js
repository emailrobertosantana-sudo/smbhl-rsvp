// Part 5: confirm the resend-verification-email flow is genuinely wired
// correctly end to end -- not just handleResendVerification in isolation
// (already covered by test/auth_email.spec.js), but the real thing a
// user actually experiences: dashboard shows the "email not verified"
// banner, clicking resend calls the real HTTP route with the real
// sendMail function, a real email is attempted with a real, working
// verification link, and following that link actually verifies the
// account and makes the dashboard banner disappear.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part5-resend-verify-secret';

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

describe('Part 5: resend-verification-email flow, real end to end', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RESEND_API_KEY = 're_test_key_part5';
    await applyRealSchema(env);
  });

  it('a newly signed-up, unverified admin sees the resend banner on /dashboard', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.441' },
      body: JSON.stringify({ email: 'part5.unverified@example.com', password: 'a-strong-password-1' })
    });
    const cookie = extractCookie(signupRes);
    await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Part 5 League', teamNames: ['Red', 'Blue'], tracksStats: true })
    });

    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain('id="resendBtn"');
    expect(html).toContain("Votre courriel n'est pas encore vérifié");
  });

  it('the full real round trip: resend sends a real, working link that actually verifies the account, and the dashboard banner then disappears', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.442' },
      body: JSON.stringify({ email: 'part5.fullflow@example.com', password: 'a-strong-password-1' })
    });
    const cookie = extractCookie(signupRes);

    // A real, working session hitting the real HTTP route (not calling
    // handleResendVerification directly), with the real sendMail wiring.
    const { sentMails, result: resendRes } = await withMailMock(async () =>
      SELF.fetch('http://example.com/auth/resend-verification', { method: 'POST', headers: { cookie } })
    );
    expect(resendRes.status).toBe(200);
    const resendJson = await resendRes.json();
    expect(resendJson.ok).toBe(true);
    expect(resendJson.alreadyVerified).toBe(false);

    expect(sentMails.length).toBe(1);
    expect(sentMails[0].to).toEqual(['part5.fullflow@example.com']);
    const raw = JSON.stringify(sentMails[0]);
    const linkMatch = /\\\/auth\\\/verify\?token=([^\s"'<\\]+)/.exec(raw) || /\/auth\/verify\?token=([^\s"'<\\]+)/.exec(raw);
    if (!linkMatch) throw new Error('No verify link found in mail body: ' + raw);
    const token = decodeURIComponent(linkMatch[1]);

    // Following the real link from the real email.
    const verifyRes = await SELF.fetch(`http://example.com/auth/verify?token=${encodeURIComponent(token)}`);
    expect(verifyRes.status).toBe(200);
    const verifyJson = await verifyRes.json();
    expect(verifyJson.ok).toBe(true);

    const dashRes = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const dashHtml = await dashRes.text();
    expect(dashHtml).not.toContain('id="resendBtn"');
    expect(dashHtml).not.toContain('Votre courriel n’est pas encore vérifié');
  });

  it('resending after already verified does not send another email (alreadyVerified: true)', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.443' },
      body: JSON.stringify({ email: 'part5.alreadyverified@example.com', password: 'a-strong-password-1' })
    });
    const cookie = extractCookie(signupRes);

    await env.DB.prepare('UPDATE users SET email_verified_at = ? WHERE email = ?')
      .bind(new Date().toISOString(), 'part5.alreadyverified@example.com').run();

    const { sentMails, result: res } = await withMailMock(async () =>
      SELF.fetch('http://example.com/auth/resend-verification', { method: 'POST', headers: { cookie } })
    );
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.alreadyVerified).toBe(true);
    expect(sentMails.length).toBe(0);
  });

  it('an expired or garbage token is rejected cleanly, not a crash', async () => {
    const res = await SELF.fetch('http://example.com/auth/verify?token=not-a-real-token');
    expect([400, 410]).toContain(res.status);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it('resend requires an authenticated session', async () => {
    const res = await SELF.fetch('http://example.com/auth/resend-verification', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

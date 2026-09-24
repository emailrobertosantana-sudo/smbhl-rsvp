// Live-testing task, Part 7: the email-verification landing page
// (GET /auth/verify?token=...) used to render BOTH French and English
// stacked vertically, each with its own button, and had no FR/EN toggle
// at all -- unlike every other page in this app. Fixed to render ONE
// language (the account's own stored users.signup_lang, from the prior
// task's signup work), with a real, working toggle using the same
// localStorage key/technique every other page already uses.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part7-verify-email-lang-secret';

async function signup(email, ip, lang) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1', ...(lang ? { lang } : {}) })
  });
  return res.json();
}
async function fetchVerifyPage(token) {
  return SELF.fetch(`http://example.com/auth/verify?token=${encodeURIComponent(token)}`, {
    headers: { accept: 'text/html' }
  });
}

describe('Part 7 (live-testing task): email-verification page renders one language with a real toggle', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('an English signup renders the success page in English only, not stacked with French', async () => {
    const { verification } = await signup('verify.lang.en@example.com', '203.0.152.001', 'en');
    const res = await fetchVerifyPage(verification.token);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Exactly one confirmation heading -- not two stacked, one per
    // language -- and its VISIBLE text is English. Both languages'
    // strings legitimately also appear inside the inline VE_I18N data
    // island (needed for the client-side toggle), so the assertion
    // targets the rendered heading specifically, not a raw substring
    // search across the whole page.
    const headings = [...html.matchAll(/<h1[^>]*>([^<]*)<\/h1>/g)].map(m => m[1]);
    expect(headings).toEqual(['Email confirmed']);
  });

  it('a French signup (the default) renders the success page in French only', async () => {
    const { verification } = await signup('verify.lang.fr@example.com', '203.0.152.002');
    const res = await fetchVerifyPage(verification.token);
    expect(res.status).toBe(200);
    const html = await res.text();
    const headings = [...html.matchAll(/<h1[^>]*>([^<]*)<\/h1>/g)].map(m => m[1]);
    expect(headings).toEqual(['Courriel confirmé']);
  });

  it('a real, working FR/EN toggle is present (not the old stacked-with-no-toggle layout)', async () => {
    const { verification } = await signup('verify.lang.toggle@example.com', '203.0.152.003', 'en');
    const html = await (await fetchVerifyPage(verification.token)).text();
    expect(html).toContain('id="btn-lang-fr"');
    expect(html).toContain('id="btn-lang-en"');
    expect(html).toContain('window.__setLang');
    // Same persistence key every other page uses (nlAuthScript, leagueRsvpNotice).
    expect(html).toContain('smbhl_admin_lang');
    // The toggle actually carries BOTH languages' text for client-side switching.
    expect(html).toContain('Email confirmed');
    expect(html).toContain('Courriel confirmé');
  });

  it('an expired-link error page also resolves the language from the account, not always French', async () => {
    const before = await signup('verify.lang.expired@example.com', '203.0.152.004', 'en');
    // Forge an already-expired token for the same user (same shape verifyEmailToken parses: userId.exp.sig).
    const { hmac } = await import('../src/crypto_utils.js');
    const expiredExp = Date.now() - 1000;
    const sig = await hmac(AUTH_SECRET, `verify:${before.userId}:${expiredExp}`);
    const expiredToken = `${before.userId}.${expiredExp}.${sig}`;
    const res = await fetchVerifyPage(expiredToken);
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html).not.toContain('Ce lien est invalide.');
    // English error copy should appear since this account signed up in English.
    const errBody = await (async () => html)();
    expect(errBody.toLowerCase()).toContain('log in');
  });

  it('a genuinely malformed token (no resolvable account) still renders, defaulting to French', async () => {
    const res = await fetchVerifyPage('not-a-real-token');
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Ce lien est invalide.');
  });

  it('the page\'s inline script is syntactically valid', async () => {
    const { verification } = await signup('verify.lang.jssyntax@example.com', '203.0.152.005', 'en');
    const html = await (await fetchVerifyPage(verification.token)).text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
  });

  it('the non-HTML (JSON API) path is completely unaffected', async () => {
    const { verification } = await signup('verify.lang.jsonpath@example.com', '203.0.152.006', 'en');
    const res = await SELF.fetch(`http://example.com/auth/verify?token=${encodeURIComponent(verification.token)}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });
});

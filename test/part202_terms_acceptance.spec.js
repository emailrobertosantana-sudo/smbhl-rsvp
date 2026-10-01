// The terms of service and the privacy policy (src/terms.js): no Notre
// Ligue admin account without accepting them; the acceptance and its
// version are kept; an account with none on record is asked once, at its
// next sign-in (/accept-terms), then goes on. SMBHL's admin key is not an
// account and is never asked.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { hashPassword } from '../src/auth.js';
import { LEGAL_UPDATED } from '../src/legal.js';

let ip = 0;
const post = (path, body, headers = {}) => SELF.fetch('http://example.com' + path, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.202.${++ip}`, ...headers }, body: JSON.stringify(body)
});
const session = res => {
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
};
const acceptance = async email => {
  const u = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (!u) return undefined;
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(`terms_acceptance:${u.id}`).first();
  return row ? JSON.parse(row.value) : null;
};

beforeAll(async () => {
  env.AUTH_SECRET = 'p202-auth'; env.LEAGUE_PRODUCT = 'true';
  await applyRealSchema(env);
});

describe('sign-up', () => {
  it('refused without the box checked: the message, and no account', async () => {
    const res = await post('/auth/signup', { email: 'no.terms@p202.example', password: 'a-strong-password-1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, errorKey: 'TERMS_NOT_ACCEPTED', error: 'Check the box to accept the terms and the privacy policy.' });
    expect(await acceptance('no.terms@p202.example')).toBeUndefined();
    const { ERROR_I18N } = await import('../src/error_i18n.js');
    expect(ERROR_I18N.TERMS_NOT_ACCEPTED.fr).toBe('Coche la case pour accepter les conditions et la politique de confidentialité.');
  });

  it('with it: the account, the date and the version kept', async () => {
    const res = await post('/auth/signup', { email: 'yes.terms@p202.example', password: 'a-strong-password-1', accept_terms: true });
    expect(res.status).toBe(200);
    const a = await acceptance('yes.terms@p202.example');
    expect(a.version).toBe(LEGAL_UPDATED);
    expect(Date.parse(a.at)).toBeGreaterThan(Date.now() - 60000);
  });

  it('the sign-up page: the box, both documents linked', async () => {
    const html = await (await SELF.fetch('http://example.com/signup')).text();
    expect(html).toContain('id="su_terms"');
    expect(html).toContain("J'accepte les <a href=\"/conditions\" target=\"_blank\" rel=\"noopener\">conditions d'utilisation</a> et la <a href=\"/confidentialite\" target=\"_blank\" rel=\"noopener\">politique de confidentialité</a>");
    expect(html).toContain('I accept the <a href=\\"/conditions#en\\"');
  });
});

describe('an existing account with no acceptance on record', () => {
  const email = 'old.admin@p202.example';
  beforeAll(async () => {
    await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at, email_verified_at, last_login_at, session_epoch) VALUES ('u-p202-old', ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL, 0)`)
      .bind(email, await hashPassword('old-admin-password')).run();
  });

  it('sign-in says so; the screen asks once, then goes on', async () => {
    const login = await post('/auth/login', { email, password: 'old-admin-password' });
    expect(await login.clone().json()).toMatchObject({ ok: true, termsNeeded: true });
    const s = session(login);
    // The screen.
    const page = await SELF.fetch('http://example.com/accept-terms?next=%2Fleague%2Froster', { headers: { cookie: s.cookie }, redirect: 'manual' });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('id="at_terms"');
    expect(html).toContain('href="/confidentialite"');
    expect(html).toContain('Avant de continuer');
    // Not checked: refused. No CSRF token: refused.
    expect((await post('/auth/accept-terms', {}, { cookie: s.cookie, 'x-csrf-token': s.csrf })).status).toBe(400);
    expect((await post('/auth/accept-terms', { accept_terms: true }, { cookie: s.cookie })).status).toBe(403);
    // Accepted.
    expect((await post('/auth/accept-terms', { accept_terms: true }, { cookie: s.cookie, 'x-csrf-token': s.csrf })).status).toBe(200);
    expect((await acceptance(email)).version).toBe(LEGAL_UPDATED);
    // Once: the screen now sends straight on, and sign-in no longer asks.
    const again = await SELF.fetch('http://example.com/accept-terms?next=%2Fleague%2Froster', { headers: { cookie: s.cookie }, redirect: 'manual' });
    expect(again.status).toBe(302);
    expect(new URL(again.headers.get('location')).pathname).toBe('/league/roster');
    expect(await (await post('/auth/login', { email, password: 'old-admin-password' })).json()).toMatchObject({ termsNeeded: false });
  });

  it('the screen without a session: to sign-in', async () => {
    const res = await SELF.fetch('http://example.com/accept-terms', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')).pathname).toBe('/login');
  });

  it('the sign-in page sends to the screen when asked', async () => {
    const html = await (await SELF.fetch('http://example.com/login')).text();
    expect(html).toContain("data.termsNeeded ? '/accept-terms?next=' + encodeURIComponent(dest) : dest");
  });
});

describe('SMBHL', () => {
  it("its admin pages use the admin key, never the acceptance screen", async () => {
    delete env.LEAGUE_PRODUCT;
    env.ADMIN_KEY = 'p202-admin';
    const res = await SELF.fetch('http://example.com/admin/people', { headers: { 'x-admin': 'p202-admin' }, redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('accept-terms');
    env.LEAGUE_PRODUCT = 'true';
  });
});

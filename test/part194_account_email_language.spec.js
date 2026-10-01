// Account emails follow the language of the page the person was on (item
// 5n): a password reset asked from a French page arrives in French only,
// from an English page in English only; both languages only when the
// request does not say. The same for the sign-up verification and its
// resend. A co-admin invitation (sent by someone else) follows the
// inviting league's language setting.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

let originalFetch;
const sent = [];
let ip = 10;
const post = (path, body, headers = {}) => SELF.fetch('http://example.com' + path, {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${++ip}`, ...headers }, body: JSON.stringify(body)
});
const FR = /Réinitialise ton mot de passe|Confirme ton courriel|On t'invite/;
const EN = /Reset your password|Confirm your email|You've been invited/;

async function signup(email, lang) {
  const res = await post('/auth/signup', { accept_terms: true, email, password: 'a-strong-password-1', ...(lang ? { lang } : {}) });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}

beforeAll(async () => {
  env.AUTH_SECRET = 'p194-auth'; env.RESEND_API_KEY = 'p194'; env.PUBLIC_URL = 'https://rsvp.notreligue.ca'; env.MAIL_DAILY_CAP = '';
  await applyRealSchema(env);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) { sent.push(JSON.parse(opts.body)); return new Response('{"id":"x"}', { status: 200 }); }
    return new Response('{}', { status: 404 });
  };
});
afterAll(() => { globalThis.fetch = originalFetch; });
beforeEach(() => { sent.length = 0; });

describe('the sign-up verification', () => {
  for (const [lang, want, not] of [['fr', FR, EN], ['en', EN, FR]]) {
    it(`from a page in ${lang}: ${lang} only, subject included`, async () => {
      await signup(`verify.${lang}@example.com`, lang);
      expect(sent).toHaveLength(1);
      expect(sent[0].subject + sent[0].text + sent[0].html).toMatch(want);
      expect(sent[0].subject + sent[0].text + sent[0].html).not.toMatch(not);
    });
  }
  it('with no language in the request: both', async () => {
    await signup('verify.none@example.com', null);
    expect(sent[0].subject).toBe('Confirme ton courriel / Confirm your email');
  });
});

describe('the password reset', () => {
  beforeAll(async () => { await signup('reset.me@example.com', 'fr'); });
  for (const [lang, want, not, subject] of [['fr', FR, EN, 'Réinitialise ton mot de passe'], ['en', EN, FR, 'Reset your password']]) {
    it(`asked from a page in ${lang}: ${lang} only`, async () => {
      await post('/auth/request-password-reset', { email: 'reset.me@example.com', lang });
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toBe(subject);
      expect(sent[0].text + sent[0].html).toMatch(want);
      expect(sent[0].text + sent[0].html).not.toMatch(not);
    });
  }
  it('with no language in the request: both', async () => {
    await post('/auth/request-password-reset', { email: 'reset.me@example.com' });
    expect(sent[0].subject).toBe('Réinitialise ton mot de passe / Reset your password');
  });
});

describe('the verification resend', () => {
  it('follows the page it is asked from', async () => {
    const s = await signup('resend.me@example.com', 'fr');
    sent.length = 0;
    await post('/auth/resend-verification', { lang: 'en' }, { cookie: s.cookie, 'x-csrf-token': s.csrf });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Confirm your email');
  });
});

describe('the co-admin invitation follows the league', () => {
  for (const [mode, check] of [['fr', m => { expect(m.subject).toMatch(/^Invitation à co-administrer/); expect(m.text).not.toMatch(EN); }], ['both', m => { expect(m.text).toMatch(FR); expect(m.text).toMatch(EN); }]]) {
    it(`a league set to ${mode}`, async () => {
      const s = await signup(`owner.${mode}@example.com`, 'en');
      const lg = (await (await post('/leagues/create', { name: `Ligue ${mode}`, teamNames: ['A', 'B'], tracksStats: false }, { cookie: s.cookie, 'x-csrf-token': s.csrf })).json()).league;
      await env.DB.prepare('UPDATE leagues SET language_mode = ? WHERE id = ?').bind(mode, lg.id).run();
      sent.length = 0;
      const r = await post('/league/admins/invite', { email: `coadmin.${mode}@example.com` }, { cookie: s.cookie, 'x-csrf-token': s.csrf });
      expect(r.status).toBe(200);
      expect(sent).toHaveLength(1);
      check(sent[0]);
    });
  }
});

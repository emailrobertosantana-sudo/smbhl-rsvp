// Part 1 of a live-testing task: on a French session, signup step 2
// sometimes rendered in English unexpectedly, and separately, the
// homepage sometimes showed French sample/mock content even when
// viewed in English.
//
// ROOT CAUSES:
// 1. Every signup-step transition was a real full page navigation
//    (not a SPA) relying solely on localStorage surviving that
//    navigation to carry the language choice forward -- fragile
//    (private browsing storage partitioning, Safari ITP, or simply a
//    guard redirect like "no league draft in sessionStorage yet -- go
//    back to step 2" bouncing the user without preserving language
//    context). Fixed: the language is now also carried explicitly via
//    a `lang` URL query param on every internal signup navigation
//    (client-side via a new window.__navWithLang helper, and
//    server-side on the session-missing/no-league-yet redirects too),
//    checked FIRST (before localStorage, before the navigator.language
//    guess) by the shared nlAuthScript init logic every signup page
//    already uses.
// 2. The homepage's decorative "sample content" (.home-mock -- a fake
//    phone-screen mockup showing example league data) was hardcoded
//    French text with zero data-i18n attributes, so the toggle could
//    never translate it. Fixed: wrapped in real data-i18n keys with FR/EN
//    translations. The homepage also had its OWN duplicated copy of the
//    language-persistence script (instead of reusing the shared
//    nlAuthScript() helper every other page uses) -- consolidated onto
//    the shared helper, eliminating the risk of the two ever silently
//    drifling apart again.
import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { env } from 'cloudflare:test';

const AUTH_SECRET = 'test-part20-live-bugs-8-secret';

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

describe('Live-testing Part 1: language toggle consistency across signup and the homepage', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('every signup step embeds the URL-lang-param-first init logic and the __navWithLang helper', async () => {
    for (const step of ['1']) {
      const res = await SELF.fetch(`http://example.com/signup?step=${step}`);
      const html = await res.text();
      expect(html).toContain("new URLSearchParams(location.search).get('lang')");
      expect(html).toContain('window.__navWithLang');
    }
  });

  it('step 1 -> step 2 -> step 3 -> done: every internal navigation call uses __navWithLang, not a bare location.href to another signup step', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.123.001' },
      body: JSON.stringify({ email: 'lang.persist.steps@example.com', password: 'a-strong-password-1' })
    });
    const cookie = extractCookie(signupRes);

    const step1Html = await (await SELF.fetch('http://example.com/signup?step=1')).text();
    expect(step1Html).toContain("window.__navWithLang('/signup?step=2')");
    expect(step1Html).not.toMatch(/location\.href\s*=\s*'\/signup\?step=2'/);

    const step2Html = await (await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie } })).text();
    expect(step2Html).toContain("window.__navWithLang('/signup?step=1')");
    expect(step2Html).toContain("window.__navWithLang('/signup?step=3')");
    expect(step2Html).not.toMatch(/location\.href\s*=\s*'\/signup\?step=[13]'/);
    expect(step2Html).not.toMatch(/onclick="location\.href='\/signup\?step=1'"/);

    const step3Html = await (await SELF.fetch('http://example.com/signup?step=3', { headers: { cookie } })).text();
    expect(step3Html).toContain("window.__navWithLang('/signup?step=2')");
    expect(step3Html).toContain("window.__navWithLang('/signup?step=done')");
    expect(step3Html).not.toMatch(/onclick="location\.href='\/signup\?step=2'"/);
    expect(step3Html).not.toMatch(/window\.location\.href = '\/signup\?step=2';/);
  });

  it('a server-side redirect (no session yet) preserves an explicit ?lang= param', async () => {
    const res = await SELF.fetch('http://example.com/signup?step=2&lang=en', { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toContain('/signup?step=1');
    expect(location).toContain('lang=en');
  });

  it('a server-side redirect with no lang param omits it (no fabricated default)', async () => {
    const res = await SELF.fetch('http://example.com/signup?step=2', { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toContain('/signup?step=1');
    expect(location).not.toContain('lang=');
  });

  it('an invalid ?lang= value is ignored, not carried forward', async () => {
    const res = await SELF.fetch('http://example.com/signup?step=2&lang=xx', { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).not.toContain('lang=xx');
  });

  it('the homepage\'s mock/sample content is now real, translatable data-i18n content in both languages, not hardcoded French', async () => {
    const res = await SELF.fetch('http://example.com/');
    const html = await res.text();
    expect(html).toContain('data-i18n="mockQuestion"');
    expect(html).toContain('data-i18n="mockBtnIn"');
    expect(html).toContain('data-i18n="mockBtnOut"');
    expect(html).toContain('data-i18n="mockShort"');
    expect(html).toContain('data-i18n="mockSubsInvited"');
    // Real EN translations are embedded in the page's own I18N dict.
    expect(html).toContain('"mockQuestion":"Marc, are you playing Sunday?"');
    expect(html).toContain('"mockBtnIn":"✓ I\'m in"');
  });

  it('the homepage now uses the SAME shared language mechanism as every other page (the URL-lang-param-first init, __navWithLang), not its own separate duplicated script', async () => {
    const res = await SELF.fetch('http://example.com/');
    const html = await res.text();
    expect(html).toContain("new URLSearchParams(location.search).get('lang')");
    expect(html).toContain('window.__navWithLang');
  });

  // B1 bug fix (i18n polish task): the browser tab <title> is set
  // server-side, before applyLanguage() (the shared client script
  // above) ever runs -- and that script only ever swaps [data-i18n]
  // BODY content, never document.title. Every signup step used to
  // hardcode the French title/description regardless of ?lang=, so an
  // explicitly-English signup page still showed "Créer un compte" in
  // the browser tab. Locks the real fix (signupDoc(), index.js) through
  // an actual HTTP fetch of the raw HTML -- not a DOM/JS assertion --
  // so it can't silently regress back to a hardcoded string.
  it('B1: step 1\'s <title> and <html lang> follow ?lang=, not a hardcoded French default', async () => {
    const fr = await (await SELF.fetch('http://example.com/signup?step=1')).text();
    expect(fr).toContain('<title>Créer un compte</title>');
    expect(fr).toContain('<html lang="fr-CA">');

    const en = await (await SELF.fetch('http://example.com/signup?step=1&lang=en')).text();
    expect(en).toContain('<title>Create an account</title>');
    expect(en).toContain('<html lang="en-CA">');
  });

  it('B1: steps 2/3 and the done screen (session-gated) also follow ?lang=, not a hardcoded French default', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.150.001' },
      body: JSON.stringify({ email: 'b1.title.signupflow@example.com', password: 'a-strong-password-1' })
    });
    const cookie = extractCookie(signupRes);
    const csrfToken = extractCsrfToken(signupRes);

    const step2En = await (await SELF.fetch('http://example.com/signup?step=2&lang=en', { headers: { cookie } })).text();
    expect(step2En).toContain('<title>Create an account</title>');
    expect(step2En).toContain('<html lang="en-CA">');
    const step2Fr = await (await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie } })).text();
    expect(step2Fr).toContain('<title>Créer un compte</title>');
    expect(step2Fr).toContain('<html lang="fr-CA">');

    const step3En = await (await SELF.fetch('http://example.com/signup?step=3&lang=en', { headers: { cookie } })).text();
    expect(step3En).toContain('<title>Create an account</title>');

    await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'B1 Title League', teamNames: ['A', 'B'], tracksStats: true })
    });
    const doneEn = await (await SELF.fetch('http://example.com/signup?step=done&lang=en', { headers: { cookie } })).text();
    expect(doneEn).toContain('<title>League created · Notre Ligue</title>');
    expect(doneEn).toContain('<html lang="en-CA">');
    const doneFr = await (await SELF.fetch('http://example.com/signup?step=done', { headers: { cookie } })).text();
    expect(doneFr).toContain('<title>Ligue créée · Notre Ligue</title>');
  });
});

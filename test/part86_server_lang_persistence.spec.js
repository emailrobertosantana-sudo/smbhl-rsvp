// Server-side language persistence task (Part 1 of a 3-part batch;
// Parts 2/3 were investigate-only, no code). The admin FR/EN toggle
// was client-side only (localStorage), so nlDocument() (design_system.js)
// never had a language signal at RENDER time and every hardcoded
// <title>/<meta description> came out French regardless of what the
// admin had actually chosen.
//
// Fix: resolveServerLang(req) (src/index.js), priority order:
// (1) the nl_lang cookie -- not HttpOnly, written by window.__setLang
// the moment the toggle is used, and ALSO synced from an already-
// resolved localStorage/navigator-language preference on ordinary page
// load (nlAuthScript), so a returning admin who chose English before
// this cookie existed doesn't get a flash of French chrome on their
// next visit; (2) the Accept-Language header's highest-quality fr/en
// tag; (3) French, the safe default when the header is absent,
// ambiguous, or names neither language.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part86-server-lang-persistence-secret';

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
async function publishSeason(cookie, csrfToken, body) {
  return SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
}
function extractTitle(html) {
  const m = html.match(/<title>([^<]*)<\/title>/);
  return m ? m[1] : null;
}

describe('Server-side language persistence: resolveServerLang + translated <title>/<meta description>', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  describe('cookie drives the rendered <title>, both languages, on a page with no session required', () => {
    it('nl_lang=fr -> French title', async () => {
      const html = await (await SELF.fetch('http://example.com/login', { headers: { cookie: 'nl_lang=fr' } })).text();
      expect(extractTitle(html)).toBe('Se connecter');
    });
    it('nl_lang=en -> English title', async () => {
      const html = await (await SELF.fetch('http://example.com/login', { headers: { cookie: 'nl_lang=en' } })).text();
      expect(extractTitle(html)).toBe('Log in');
    });
    it('the meta description also follows the cookie, both languages', async () => {
      const htmlFr = await (await SELF.fetch('http://example.com/login', { headers: { cookie: 'nl_lang=fr' } })).text();
      const htmlEn = await (await SELF.fetch('http://example.com/login', { headers: { cookie: 'nl_lang=en' } })).text();
      expect(htmlFr).toContain('<meta name="description" content="Connecte-toi pour gérer ta ligue.">');
      expect(htmlEn).toContain('<meta name="description" content="Log in to manage your league.">');
    });
    it('the cookie also drives the <html lang> attribute', async () => {
      const htmlFr = await (await SELF.fetch('http://example.com/login', { headers: { cookie: 'nl_lang=fr' } })).text();
      const htmlEn = await (await SELF.fetch('http://example.com/login', { headers: { cookie: 'nl_lang=en' } })).text();
      expect(htmlFr).toContain('<html lang="fr-CA">');
      expect(htmlEn).toContain('<html lang="en-CA">');
    });
  });

  describe('Accept-Language fallback for a cookie-less visitor', () => {
    it('an English-preferring header with no cookie resolves to English', async () => {
      const html = await (await SELF.fetch('http://example.com/login', { headers: { 'accept-language': 'en-US,en;q=0.9,fr;q=0.5' } })).text();
      expect(extractTitle(html)).toBe('Log in');
    });
    it('a French-preferring header with no cookie resolves to French', async () => {
      const html = await (await SELF.fetch('http://example.com/login', { headers: { 'accept-language': 'fr-CA,fr;q=0.9,en;q=0.5' } })).text();
      expect(extractTitle(html)).toBe('Se connecter');
    });
    it('a header naming English at lower quality than French still resolves by quality, not order', async () => {
      // English listed first in the raw string but at a LOWER q than
      // French -- the highest-quality tag must win, not first-in-string.
      const html = await (await SELF.fetch('http://example.com/login', { headers: { 'accept-language': 'en;q=0.4,fr;q=0.9' } })).text();
      expect(extractTitle(html)).toBe('Se connecter');
    });
    it('the cookie wins over a conflicting Accept-Language header', async () => {
      const html = await (await SELF.fetch('http://example.com/login', { headers: { cookie: 'nl_lang=en', 'accept-language': 'fr-CA,fr;q=0.9' } })).text();
      expect(extractTitle(html)).toBe('Log in');
    });
  });

  describe('French default when the header gives no useful signal', () => {
    it('no cookie, no Accept-Language header at all -> French', async () => {
      const html = await (await SELF.fetch('http://example.com/login')).text();
      expect(extractTitle(html)).toBe('Se connecter');
    });
    it('an Accept-Language header naming neither fr nor en -> French', async () => {
      const html = await (await SELF.fetch('http://example.com/login', { headers: { 'accept-language': 'de-DE,de;q=0.9,es;q=0.8' } })).text();
      expect(extractTitle(html)).toBe('Se connecter');
    });
    it('a malformed/empty Accept-Language header -> French, no crash', async () => {
      const res = await SELF.fetch('http://example.com/login', { headers: { 'accept-language': ';;;garbage,,,' } });
      expect(res.status).toBe(200);
      expect(extractTitle(await res.text())).toBe('Se connecter');
    });
    it('a bogus nl_lang cookie value -> falls through to Accept-Language, not left broken', async () => {
      const html = await (await SELF.fetch('http://example.com/login', { headers: { cookie: 'nl_lang=xx', 'accept-language': 'en-US,en;q=0.9' } })).text();
      expect(extractTitle(html)).toBe('Log in');
    });
  });

  describe('the rest of the ~14 known pages, both languages, session-backed', () => {
    it('dashboard, settings, roster, schedule all translate their <title> per the cookie', async () => {
      const { cookie: sessionCookie, csrfToken } = await signup('lang.pages@example.com', '203.0.202.001');
      const league = await createLeague(sessionCookie, csrfToken, { name: 'Lang Pages League', teamNames: ['A', 'B'] });

      const withLang = (l) => `${sessionCookie}; nl_lang=${l}`;

      const dashFr = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie: withLang('fr') } })).text();
      const dashEn = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie: withLang('en') } })).text();
      expect(extractTitle(dashFr)).toBe(`Tableau de bord — ${league.name}`);
      expect(extractTitle(dashEn)).toBe(`Dashboard — ${league.name}`);

      const settingsFr = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie: withLang('fr') } })).text();
      const settingsEn = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie: withLang('en') } })).text();
      expect(extractTitle(settingsFr)).toBe(`Paramètres — ${league.name}`);
      expect(extractTitle(settingsEn)).toBe(`Settings — ${league.name}`);

      const rosterFr = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie: withLang('fr') } })).text();
      const rosterEn = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie: withLang('en') } })).text();
      expect(extractTitle(rosterFr)).toBe(`Joueurs — ${league.name}`);
      expect(extractTitle(rosterEn)).toBe(`Players — ${league.name}`);

      const schedFr = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: withLang('fr') } })).text();
      const schedEn = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: withLang('en') } })).text();
      expect(extractTitle(schedFr)).toBe(`Horaire — ${league.name}`);
      expect(extractTitle(schedEn)).toBe(`Schedule — ${league.name}`);
    });

    it('onboarding, comms and the event-not-found 404 also translate', async () => {
      const { cookie: sessionCookie, csrfToken } = await signup('lang.pages2@example.com', '203.0.202.002');
      const league = await createLeague(sessionCookie, csrfToken, { name: 'Lang Pages League 2', teamNames: ['A', 'B'] });
      await publishSeason(sessionCookie, csrfToken, { season_name: 'Lang Pages Season' });
      const withLang = (l) => `${sessionCookie}; nl_lang=${l}`;

      const obEn = await (await SELF.fetch('http://example.com/onboarding/season', { headers: { cookie: withLang('en') } })).text();
      expect(extractTitle(obEn)).toBe(`Welcome — ${league.name}`);
      const obFr = await (await SELF.fetch('http://example.com/onboarding/season', { headers: { cookie: withLang('fr') } })).text();
      expect(extractTitle(obFr)).toBe(`Bienvenue — ${league.name}`);

      const commsEn = await (await SELF.fetch('http://example.com/league/comms', { headers: { cookie: withLang('en') } })).text();
      expect(commsEn).toContain('<html lang="en-CA">');
      expect(extractTitle(commsEn)).toBe(`Communications — ${league.name}`);

      const notFoundRes = await SELF.fetch('http://example.com/league/events/detail?e=nonexistent', { headers: { cookie: withLang('en') } });
      expect(notFoundRes.status).toBe(404);
      expect(extractTitle(await notFoundRes.text())).toBe(`Event not found — ${league.name}`);
    });
  });

  describe('the cookie mechanism itself is wired into the shared toggle script', () => {
    it('window.__setLang writes the nl_lang cookie, and the initial resolution IIFE syncs it too (no flash for a returning admin)', async () => {
      const html = await (await SELF.fetch('http://example.com/login')).text();
      expect(html).toContain("document.cookie = 'nl_lang=' + l + '; path=/; max-age=31536000; samesite=lax'");
      expect(html).toContain("document.cookie = 'nl_lang=' + lang + '; path=/; max-age=31536000; samesite=lax'");
    });
  });

  describe('signup wizard ?lang= threading is unbroken by the new cookie mechanism', () => {
    it('signup step 1 still honours ?lang=en directly, independent of any cookie', async () => {
      const html = await (await SELF.fetch('http://example.com/signup?step=1&lang=en', { headers: { cookie: 'nl_lang=fr' } })).text();
      expect(extractTitle(html)).toBe('Create an account');
    });
  });

  describe('data-i18n-aria: the new small mechanism for aria-label translation', () => {
    it('signup step 3\'s team-count stepper aria-labels are server-rendered in the requested language and carry data-i18n-aria for the client-side toggle', async () => {
      // Steps 2/3 require a real in-progress signup session (redirect
      // back to step 1 otherwise) -- see renderSignupPage's own comment.
      const { cookie: cookieFr } = await signup('aria.step3.fr@example.com', '203.0.202.004');
      const { cookie: cookieEn } = await signup('aria.step3.en@example.com', '203.0.202.005');
      const htmlFr = await (await SELF.fetch('http://example.com/signup?step=3&lang=fr', { headers: { cookie: cookieFr } })).text();
      const htmlEn = await (await SELF.fetch('http://example.com/signup?step=3&lang=en', { headers: { cookie: cookieEn } })).text();
      // esc() HTML-entity-escapes apostrophes (&#39;) -- the real,
      // correct rendered attribute value, not a raw apostrophe.
      expect(htmlFr).toContain('data-i18n-aria="teamCountGroupAria" aria-label="Nombre d&#39;équipes"');
      expect(htmlFr).toContain('data-i18n-aria="decreaseTeamsAria" aria-label="Moins"');
      expect(htmlFr).toContain('data-i18n-aria="increaseTeamsAria" aria-label="Plus"');
      expect(htmlEn).toContain('data-i18n-aria="teamCountGroupAria" aria-label="Number of teams"');
      expect(htmlEn).toContain('data-i18n-aria="decreaseTeamsAria" aria-label="Decrease"');
      expect(htmlEn).toContain('data-i18n-aria="increaseTeamsAria" aria-label="Increase"');
      // The shared client-side mechanism that keeps it in sync on a
      // later toggle (no full reload).
      expect(htmlFr).toContain("document.querySelectorAll('[data-i18n-aria]')");
      expect(htmlFr).toContain("el.setAttribute('aria-label', dict[k])");
    });

    it('the roster and schedule panels\' own aria-labels reuse their real i18n dict keys (never drift from the visible heading)', async () => {
      const { cookie: sessionCookie, csrfToken } = await signup('aria.panels@example.com', '203.0.202.003');
      await createLeague(sessionCookie, csrfToken, { name: 'Aria Panels League', teamNames: ['A', 'B'] });
      // The schedule page's create-event panel only renders once a
      // season exists -- otherwise it shows a "start your season
      // first" empty state instead (needsSeasonTitle/needsSeasonBody).
      await publishSeason(sessionCookie, csrfToken, { season_name: 'Aria Panels Season' });

      const rosterHtml = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie: sessionCookie } })).text();
      expect(rosterHtml).toContain('data-i18n-aria="addPlayer" aria-label="Ajouter un joueur"');

      const schedHtml = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: sessionCookie } })).text();
      expect(schedHtml).toContain('data-i18n-aria="createEvent" aria-label="Créer un match"');
      expect(schedHtml).toContain('data-i18n-aria="bulkCreateTitle" aria-label="Créer plusieurs matchs"');
    });
  });
});

describe('SMBHL unaffected: page() (SMBHL\'s own shell) ignores the new nl_lang cookie/Accept-Language signal entirely', () => {
  it('/admin/board (SMBHL, no session/ADMIN_KEY required to reach the page shell) renders the same fr-CA shell and French content regardless of nl_lang or Accept-Language', async () => {
    // page() (SMBHL's own document shell, distinct from nlDocument()
    // which every league-product page above goes through) always
    // renders <html lang="fr-CA"> unconditionally and has no call to
    // resolveServerLang anywhere in it -- this proves that behaviorally
    // against a real SMBHL page, not by inspecting source text: even
    // with an EN cookie AND an English-preferring Accept-Language
    // header (either one alone is enough to flip every league-product
    // page above to English), SMBHL's board page still renders its
    // unconditional French shell.
    const baseline = await (await SELF.fetch('http://example.com/admin/board')).text();
    const withEnSignals = await (await SELF.fetch('http://example.com/admin/board', {
      headers: { cookie: 'nl_lang=en', 'accept-language': 'en-US,en;q=0.9' }
    })).text();
    for (const html of [baseline, withEnSignals]) {
      expect(html).toContain('<html lang="fr-CA">');
      expect(html).toContain('Tableau');
    }
    expect(withEnSignals).toBe(baseline);
  });
});

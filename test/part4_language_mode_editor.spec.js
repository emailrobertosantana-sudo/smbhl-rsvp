// Part 4 (overnight follow-up task): the language_mode field (added
// as a foundation earlier tonight) previously had no way for an admin
// to see or change it at all. Adds a real display + working editor on
// the dashboard, writing back via a new session-gated route,
// POST /league/language-mode.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part4-lang-editor-secret';

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

async function signupAndCreateLeague(email, ip) {
  const signupRes = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookie = extractCookie(signupRes);
  const csrfToken = extractCsrfToken(signupRes);
  const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name: 'Part 4 Editor League', teamNames: ['A', 'B'], tracksStats: true })
  });
  const leagueId = (await leagueRes.json()).league.id;
  return { cookie, csrfToken, leagueId };
}

describe('Part 4: language exposure display + working editor on the dashboard', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it("the dashboard shows the league's current language exposure, defaulting to 'both' selected", async () => {
    const a = await signupAndCreateLeague('part4.display@example.com', '203.0.113.681');
    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie: a.cookie } });
    const html = await res.text();
    expect(html).toContain('id="lang_mode_select"');
    expect(html).toContain('<option value="both" data-i18n="langBoth" selected>');
  });

  it('an admin can change language exposure to French only, and it persists in the database', async () => {
    const a = await signupAndCreateLeague('part4.setfr@example.com', '203.0.113.682');
    const res = await SELF.fetch('http://example.com/league/language-mode', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ languageMode: 'fr' })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.languageMode).toBe('fr');

    const row = await env.DB.prepare('SELECT language_mode FROM leagues WHERE id = ?').bind(a.leagueId).first();
    expect(row.language_mode).toBe('fr');

    // The dashboard itself now reflects the change on next load.
    const dashHtml = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie: a.cookie } })).text();
    expect(dashHtml).toContain('<option value="fr" data-i18n="langFrOnly" selected>');

    // And Part 4's original foundation behavior (public page toggle
    // hidden when not 'both') still takes effect immediately.
    const publicHtml = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(a.leagueId)}`)).text();
    expect(publicHtml).not.toContain('id="btn-lang-en"');
  });

  it('an invalid language value is rejected with a translatable error key', async () => {
    const a = await signupAndCreateLeague('part4.invalid@example.com', '203.0.113.683');
    const res = await SELF.fetch('http://example.com/league/language-mode', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ languageMode: 'de' })
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errorKey).toBe('INVALID_LANGUAGE_MODE');

    const row = await env.DB.prepare('SELECT language_mode FROM leagues WHERE id = ?').bind(a.leagueId).first();
    expect(row.language_mode).toBe('both'); // unchanged
  });

  it('the route requires a valid session and CSRF token, matching every other league-admin write route', async () => {
    const unauthRes = await SELF.fetch('http://example.com/league/language-mode', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ languageMode: 'en' })
    });
    expect(unauthRes.status).toBe(401);

    const a = await signupAndCreateLeague('part4.csrf@example.com', '203.0.113.684');
    const noCsrfRes = await SELF.fetch('http://example.com/league/language-mode', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ languageMode: 'en' })
    });
    expect(noCsrfRes.status).toBe(403);
  });

  it("a second league's language_mode is completely independent, and SMBHL's own default ('both') is untouched", async () => {
    const a = await signupAndCreateLeague('part4.indepA@example.com', '203.0.113.685');
    const b = await signupAndCreateLeague('part4.indepB@example.com', '203.0.113.686');
    await SELF.fetch('http://example.com/league/language-mode', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ languageMode: 'en' })
    });
    const rowB = await env.DB.prepare('SELECT language_mode FROM leagues WHERE id = ?').bind(b.leagueId).first();
    expect(rowB.language_mode).toBe('both');
    const smbhlRow = await env.DB.prepare("SELECT language_mode FROM leagues WHERE id = 'smbhl'").first();
    expect(smbhlRow.language_mode).toBe('both');
  });
});

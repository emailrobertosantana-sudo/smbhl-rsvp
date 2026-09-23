// Design system Part 3: the dashboard's admin desktop/phone chrome
// (notre-ligue-design-system/components/ScreenDashboard/preview.html)
// -- real header nav on desktop, a bottom nl-tabbar on phones, and an
// onboarding checklist driven by real signals (not just static markup).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part3-dashboard-ds-secret';

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
async function signupAndCreateLeague(email, ip, name, teamNames) {
  const signupRes = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookie = extractCookie(signupRes);
  const csrfToken = extractCsrfToken(signupRes);
  const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, teamNames, tracksStats: true })
  });
  const leagueId = (await leagueRes.json()).league.id;
  return { cookie, csrfToken, leagueId };
}

describe('Part 3: dashboard admin chrome (design system)', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('has the real header nav (desktop) and a matching bottom tab bar (phone), both pointing at roster/schedule', async () => {
    const { cookie } = await signupAndCreateLeague('ds.dash.chrome@example.com', '203.0.113.811', 'Chrome League', ['A', 'B']);
    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain('class="nl-nav"');
    expect(html).toContain('class="nl-tabbar"');
    expect(html).toContain('href="/league/roster"');
    expect(html).toContain('href="/league/schedule"');
    // Accueil (home) is the current tab on both.
    expect((html.match(/aria-current="page"/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('the onboarding checklist reflects real signals: player-added checkmark flips once a real player exists', async () => {
    const { cookie, csrfToken } = await signupAndCreateLeague('ds.dash.checklist@example.com', '203.0.113.812', 'Checklist League', ['A', 'B']);

    const playersRowRe = /^.*class="dash-ck( done)?">.*ckPlayers.*$/m;

    const beforeRes = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const beforeHtml = await beforeRes.text();
    expect(beforeHtml).toContain('Pour bien partir');
    // No players yet -- the "add players" checklist item is NOT marked done.
    expect(playersRowRe.exec(beforeHtml)[1]).toBeUndefined();

    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'A Real Player', team: 'A' })
    });

    const afterRes = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const afterHtml = await afterRes.text();
    expect(playersRowRe.exec(afterHtml)[1]).toBe(' done');
  });

  it('the "no active season" state uses a real Badge component, not ad hoc text', async () => {
    const { cookie } = await signupAndCreateLeague('ds.dash.badge@example.com', '203.0.113.813', 'Badge League', ['A', 'B']);
    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain('nl-badge nl-badge--pending');
  });
});

// Live-testing task, Part 2: "hide the division/age-group field at
// signup." Investigation found this was already true -- the signup
// wizard's real markup (renderSignupStep2/renderSignupStep3 in
// index.js) has never rendered a division/age-group field (see
// auth_pages.spec.js's own comment on this), and submitStep3()'s
// payload never sends divisionLabel. The underlying capability
// (leagues.division_label column, handleLeagueCreate's optional
// body.divisionLabel, and the dashboard's display of it once set) is
// fully intact -- just never asked during signup. No code change
// needed; this test makes that confirmation explicit and regression-
// tested rather than just a comment.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part2-division-hidden-secret';

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

describe('Part 2 (live-testing task): division/age-group field is not shown or required at signup', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('signup step 2 and step 3 never render a division/age-group field', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.110' },
      body: JSON.stringify({ email: 'no.division.field@example.com', password: 'a-strong-password-1' })
    });
    const cookieHeader = extractCookie(signupRes);

    const step2Html = await (await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie: cookieHeader } })).text();
    const step3Html = await (await SELF.fetch('http://example.com/signup?step=3', { headers: { cookie: cookieHeader } })).text();

    for (const html of [step2Html, step3Html]) {
      expect(html.toLowerCase()).not.toContain('division');
      expect(html.toLowerCase()).not.toContain('age group');
      expect(html.toLowerCase()).not.toContain("groupe d'âge");
    }
  });

  it('a signup-wizard league creation (no divisionLabel in the payload, matching submitStep3()) still succeeds', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.111' },
      body: JSON.stringify({ email: 'signup.no.division@example.com', password: 'a-strong-password-1' })
    });
    const cookieHeader = extractCookie(signupRes);
    const csrfToken = extractCsrfToken(signupRes);

    const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'No Division League', tracksStats: true, teamStructure: 'fixed', teamNames: ['A', 'B'] })
    });
    expect(leagueRes.status).toBe(200);
    const json = await leagueRes.json();
    expect(json.ok).toBe(true);
    expect(json.league.divisionLabel == null).toBe(true);
  });

  it('the division_label capability itself still exists and works when set through another surface (not signup)', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.112' },
      body: JSON.stringify({ email: 'division.still.works@example.com', password: 'a-strong-password-1' })
    });
    const cookieHeader = extractCookie(signupRes);
    const csrfToken = extractCsrfToken(signupRes);

    const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Division Still Works League', tracksStats: true, teamStructure: 'fixed', teamNames: ['A', 'B'], divisionLabel: 'U14 AA' })
    });
    expect(leagueRes.status).toBe(200);
    const json = await leagueRes.json();
    expect(json.ok).toBe(true);
    expect(json.league.divisionLabel).toBe('U14 AA');

    const dashboardHtml = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie: cookieHeader } })).text();
    expect(dashboardHtml).toContain('U14 AA');
  });
});

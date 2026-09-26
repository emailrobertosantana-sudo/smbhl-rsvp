// Signup/recovery task (Group A, urgent): a real person got stuck --
// an authenticated account with no league, and no way back in. Three
// sub-items: A1 (dashboard dead end), A2 (back navigation during
// onboarding/signup abandons league creation), A3 (Gmail-variant
// emails wrongly treated as duplicates -- investigated, NOT
// reproduced with current code; locked in as a regression test
// regardless), A4 (generic "An error occurred" swallowing specific
// messages on unexpected failures).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part96-signup-recovery-secret';

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
  return { cookie: extractCookie(res), csrfToken: extractCsrfToken(res), status: res.status, json: await res.json() };
}
async function createLeague(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).league;
}

describe('Signup/recovery, A1: an authenticated user with no league can reach league creation from the dashboard', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the dashboard\'s empty state offers a real, working link to create a league -- not just Log out', async () => {
    const { cookie } = await signup('a1.stuck@example.com', '203.0.220.001');
    const dashRes = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const html = await dashRes.text();
    expect(dashRes.status).toBe(200);
    expect(html).toContain('data-i18n="noLeagueYet"');
    // The old dead end: only a logout button, no create action.
    expect(html).toContain('id="createLeagueBtn"');
    expect(html).toContain('href="/signup?step=2"');
    expect(html).toContain('data-i18n="createLeagueCta"');
    expect(html).toContain('Créer ma ligue');
    expect(html).toContain('Create my league');

    // The link actually works -- a real, rendering league-creation form.
    const step2Res = await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie } });
    expect(step2Res.status).toBe(200);
    const step2Html = await step2Res.text();
    expect(step2Html).toContain('id="su_league_name"');
  });

  it('a session with a real league never sees the empty state at all (regression lock)', async () => {
    const { cookie, csrfToken } = await signup('a1.hasleague@example.com', '203.0.220.002');
    await createLeague(cookie, csrfToken, { name: 'A1 Has League', teamNames: ['A', 'B'] });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).not.toContain('data-i18n="noLeagueYet"');
  });
});

describe('Signup/recovery, A2: back navigation cannot strand a user out of their own league', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a session that already has a league is redirected away from the pre-league wizard (step 2) to real onboarding, not shown a blank form again', async () => {
    const { cookie, csrfToken } = await signup('a2.step2@example.com', '203.0.220.010');
    await createLeague(cookie, csrfToken, { name: 'A2 Step2 League', teamNames: ['A', 'B'] });
    const res = await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/onboarding/season');
  });

  it('same redirect for step 3', async () => {
    const { cookie, csrfToken } = await signup('a2.step3@example.com', '203.0.220.011');
    await createLeague(cookie, csrfToken, { name: 'A2 Step3 League', teamNames: ['A', 'B'] });
    const res = await SELF.fetch('http://example.com/signup?step=3', { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/onboarding/season');
  });

  it('a session with NO league yet still sees the real wizard at step 2/3 (unaffected)', async () => {
    const { cookie } = await signup('a2.noleague@example.com', '203.0.220.012');
    const res2 = await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie } });
    expect(res2.status).toBe(200);
    expect(await res2.text()).toContain('id="su_league_name"');
  });

  it('the redirected onboarding/season page itself resolves sensibly for a league with no season yet (redirects to dashboard, not a broken shell)', async () => {
    const { cookie, csrfToken } = await signup('a2.noseasonyet@example.com', '203.0.220.013');
    await createLeague(cookie, csrfToken, { name: 'A2 No Season League', teamNames: ['A', 'B'] });
    const res = await SELF.fetch('http://example.com/onboarding/season', { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/dashboard');
  });
});

describe('Signup/recovery, A3: every distinct email string is its own account -- no Gmail dot/plus normalization', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('three Gmail-style variants of the same inbox each create a separate, real account', async () => {
    const base = await signup('a3.investigate@example.com', '203.0.220.020');
    const plus = await signup('a3.investigate+test2@example.com', '203.0.220.021');
    const dots = await signup('a3investigate@example.com', '203.0.220.022');
    expect(base.status).toBe(200); expect(base.json.ok).toBe(true);
    expect(plus.status).toBe(200); expect(plus.json.ok).toBe(true);
    expect(dots.status).toBe(200); expect(dots.json.ok).toBe(true);
    expect(new Set([base.json.userId, plus.json.userId, dots.json.userId]).size).toBe(3);

    const rows = (await env.DB.prepare(
      "SELECT email FROM users WHERE email IN (?, ?, ?)"
    ).bind('a3.investigate@example.com', 'a3.investigate+test2@example.com', 'a3investigate@example.com').all()).results;
    expect(rows.length).toBe(3);
  });

  it('a genuine duplicate -- the SAME literal email string twice -- is still correctly rejected', async () => {
    const first = await signup('a3.dupe@example.com', '203.0.220.023');
    expect(first.status).toBe(200);
    const second = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.220.024' },
      body: JSON.stringify({ email: 'a3.dupe@example.com', password: 'a-strong-password-1' })
    });
    expect(second.status).toBe(409);
    const secondJson = await second.json();
    expect(secondJson.errorKey).toBe('EMAIL_EXISTS');
  });
});

describe('Signup/recovery, A4: every signup-path rejection shows a specific message, from the rendered page, not "An error occurred"', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a genuine duplicate email shows its own specific message text on the rendered step-1 page (not a generic fallback)', async () => {
    await signup('a4.dupe@example.com', '203.0.220.030');
    const step1Html = await (await SELF.fetch('http://example.com/signup?step=1')).text();
    // The embedded client-side dict (both languages, for the toggle)
    // must carry the real, specific EMAIL_EXISTS text, not a generic one.
    expect(step1Html).toContain('An account with this email already exists.');
    expect(step1Html).toContain('Un compte avec ce courriel existe déjà.');
  });

  it('every rejection handleSignup can produce has a specific, non-generic ERROR_I18N entry (server-side inventory)', async () => {
    const { ERROR_I18N } = await import('../src/error_i18n.js');
    for (const key of ['INVALID_EMAIL', 'WEAK_PASSWORD', 'RATE_LIMITED_SIGNUP', 'EMAIL_EXISTS', 'SIGNUP_FAILED']) {
      expect(ERROR_I18N[key], `missing ERROR_I18N entry for ${key}`).toBeTruthy();
      expect(ERROR_I18N[key].fr).toBeTruthy();
      expect(ERROR_I18N[key].en).toBeTruthy();
    }
    // The catch-all's own new key -- previously had none at all.
    expect(ERROR_I18N.SIGNUP_FAILED.en).not.toBe('An error occurred.');
    expect(ERROR_I18N.LOGIN_FAILED).toBeTruthy();
    expect(ERROR_I18N.LEAGUE_CREATE_FAILED).toBeTruthy();
  });

  it('league creation\'s own rejections (step 2/3) all have specific messages too, including the new catch-all key', async () => {
    const { cookie, csrfToken } = await signup('a4.leaguereject@example.com', '203.0.220.031');
    const res = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: '', teamNames: ['A', 'B'] })
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errorKey).toBe('LEAGUE_NAME_REQUIRED');
  });
});

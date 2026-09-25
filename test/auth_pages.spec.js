import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-auth-pages-secret';

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  return setCookie.split(';')[0]; // "user_session=<value>"
}

function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(', ');
  const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
  return csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
}

async function signup(email, password, ip) {
  return SELF.fetch('http://example.com/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password })
  });
}

describe('Frontend pages: /signup, /login, /dashboard', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  describe('GET /signup and GET /login render', () => {
    // Design system Part 2: signup is now a real 3-step wizard (one
    // subject per step -- account, league, teams -- matching
    // notre-ligue-design-system/components/ScreenSignup/preview.html),
    // not a single long form. Step 1 needs no session; steps 2/3 do
    // (created by step 1's own POST /auth/signup), so they're exercised
    // via the full flow, same as the dashboard-flow test below. The
    // wizard's real reference markup has no division/age-group field --
    // dropped from signup (still settable elsewhere; just never part of
    // ScreenSignup's real 3 steps) rather than invented.
    it('GET /signup?step=1 returns the account step with the expected fields', async () => {
      const res = await SELF.fetch('http://example.com/signup');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="su_email"');
      expect(html).toContain('id="su_password"');
    });

    it('GET /signup?step=2 and ?step=3 render the league and team steps once a session exists', async () => {
      const signupRes = await signup('wizard.steps@example.com', 'a-strong-password-1', '203.0.113.45');
      const cookieHeader = extractCookie(signupRes);

      const step2Res = await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie: cookieHeader } });
      expect(step2Res.status).toBe(200);
      const step2Html = await step2Res.text();
      expect(step2Html).toContain('id="su_league_name"');
      expect(step2Html).toContain('id="su_slug"');

      const step3Res = await SELF.fetch('http://example.com/signup?step=3', { headers: { cookie: cookieHeader } });
      expect(step3Res.status).toBe(200);
      const step3Html = await step3Res.text();
      expect(step3Html).toContain('id="su_team_count_out"');
      expect(step3Html).toContain('id="su_teams"');
    });

    it('GET /signup?step=2 without a session redirects back to step 1, not a broken form', async () => {
      const res = await SELF.fetch('http://example.com/signup?step=2', { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location') || '').toContain('/signup?step=1');
    });

    it('GET /login returns the login form with the expected fields', async () => {
      const res = await SELF.fetch('http://example.com/login');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="li_email"');
      expect(html).toContain('id="li_password"');
    });
  });

  describe('GET /dashboard without a session', () => {
    it('redirects to /login instead of erroring or crashing', async () => {
      const res = await SELF.fetch('http://example.com/dashboard', { redirect: 'manual' });
      expect(res.status).toBe(302);
      const location = res.headers.get('location') || '';
      expect(location).toContain('/login');
    });

    it('a tampered session cookie is also redirected to /login, not an error', async () => {
      const res = await SELF.fetch('http://example.com/dashboard', {
        redirect: 'manual',
        headers: { cookie: 'user_session=garbage.not.a.real.token' }
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location') || '').toContain('/login');
    });
  });

  describe('Simulated signup form submission (the two-step sequence the page\'s JS performs)', () => {
    it('creates the user and league end-to-end, and the resulting dashboard reflects both', async () => {
      const signupRes = await signup('dashboard.flow@example.com', 'a-strong-password-1', '203.0.113.40');
      expect(signupRes.status).toBe(200);
      const signupJson = await signupRes.json();
      expect(signupJson.ok).toBe(true);
      const cookieHeader = extractCookie(signupRes);
      const csrfToken = extractCsrfToken(signupRes);

      const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
        body: JSON.stringify({
          name: 'Sunday Ball Hockey Dashboard League',
          teamNames: ['Falcons', 'Otters', 'Comets'],
          tracksStats: true,
          divisionLabel: 'Adult Rec'
        })
      });
      expect(leagueRes.status).toBe(200);
      expect((await leagueRes.json()).ok).toBe(true);

      const dashboardRes = await SELF.fetch('http://example.com/dashboard', {
        headers: { cookie: cookieHeader }
      });
      expect(dashboardRes.status).toBe(200);
      const html = await dashboardRes.text();
      expect(html).toContain('Sunday Ball Hockey Dashboard League');
      expect(html).toContain('Adult Rec');
      expect(html).toContain('Falcons');
      expect(html).toContain('Otters');
      expect(html).toContain('Comets');
      // UI task Part R: nav to the roster/schedule pages.
      expect(html).toContain('href="/league/roster"');
      expect(html).toContain('href="/league/schedule"');
    });

    it('a freshly-signed-up (unverified) user sees the unverified-email notice on the dashboard', async () => {
      const signupRes = await signup('unverified.dashboard@example.com', 'a-strong-password-1', '203.0.113.41');
      const cookieHeader = extractCookie(signupRes);
      const csrfToken = extractCsrfToken(signupRes);

      await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Unverified League', teamNames: ['A', 'B'], tracksStats: true })
      });

      const dashboardRes = await SELF.fetch('http://example.com/dashboard', {
        headers: { cookie: cookieHeader }
      });
      const html = await dashboardRes.text();
      expect(html).toContain('not yet verified');
      expect(html).toContain('id="resendBtn"');
      expect(html).toContain('/auth/resend-verification');
    });

    it('a verified user does NOT see the unverified-email notice', async () => {
      const signupRes = await signup('verified.dashboard@example.com', 'a-strong-password-1', '203.0.113.42');
      const { verification } = await signupRes.json();
      const cookieHeader = extractCookie(signupRes);
      const csrfToken = extractCsrfToken(signupRes);

      await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Verified League', teamNames: ['A', 'B'], tracksStats: true })
      });
      await SELF.fetch(`http://example.com/auth/verify?token=${encodeURIComponent(verification.token)}`);

      const dashboardRes = await SELF.fetch('http://example.com/dashboard', {
        headers: { cookie: cookieHeader }
      });
      const html = await dashboardRes.text();
      expect(html).not.toContain('not yet verified');
      expect(html).not.toContain('id="resendBtn"');
    });
  });

  describe('Simulated login form submission', () => {
    it('valid credentials (the same POST /auth/login the page\'s JS calls) succeed and the resulting session opens the dashboard', async () => {
      await signup('login.page.flow@example.com', 'the-real-password-1', '203.0.113.43');

      const loginRes = await SELF.fetch('http://example.com/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'login.page.flow@example.com', password: 'the-real-password-1' })
      });
      expect(loginRes.status).toBe(200);
      const cookieHeader = extractCookie(loginRes);

      const dashboardRes = await SELF.fetch('http://example.com/dashboard', { headers: { cookie: cookieHeader } });
      expect(dashboardRes.status).toBe(200);
    });

    it('invalid credentials fail with the exact generic error the login page displays verbatim', async () => {
      await signup('login.page.wrong@example.com', 'the-real-password-1', '203.0.113.44');

      const res = await SELF.fetch('http://example.com/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'login.page.wrong@example.com', password: 'not-it' })
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe('Invalid email or password.');
    });
  });
});

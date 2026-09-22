import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

const AUTH_SECRET = 'test-auth-pages-secret';

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  return setCookie.split(';')[0]; // "user_session=<value>"
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
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      email_verified_at TEXT,
      last_login_at TEXT,
      session_epoch INTEGER NOT NULL DEFAULT 0
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS signup_attempts (
      ip TEXT PRIMARY KEY,
      window_start TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leagues (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      division_label TEXT,
      tracks_stats INTEGER NOT NULL DEFAULT 1,
      team_count INTEGER NOT NULL,
      team_names TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS league_admins (
      user_id TEXT NOT NULL,
      league_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, league_id)
    )`).run();
  });

  describe('GET /signup and GET /login render', () => {
    it('GET /signup returns the signup form with the expected fields', async () => {
      const res = await SELF.fetch('http://example.com/signup');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="su_email"');
      expect(html).toContain('id="su_password"');
      expect(html).toContain('id="su_league_name"');
      expect(html).toContain('id="su_team_count"');
      expect(html).toContain('id="su_tracks_stats"');
      expect(html).toContain('id="su_division"');
      expect(html).toContain('optional');
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

      const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieHeader },
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
    });

    it('a freshly-signed-up (unverified) user sees the unverified-email notice on the dashboard', async () => {
      const signupRes = await signup('unverified.dashboard@example.com', 'a-strong-password-1', '203.0.113.41');
      const cookieHeader = extractCookie(signupRes);

      await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieHeader },
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

      await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieHeader },
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

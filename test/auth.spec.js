import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  checkUserSession,
  isUserEmailVerified,
  isLeagueEmailVerified
} from '../src/auth.js';
import { hmac } from '../src/crypto_utils.js';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-auth-secret-for-sessions-and-verification';

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

async function signup(email, password, ip = '203.0.113.10') {
  return SELF.fetch('http://example.com/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password })
  });
}

describe('Part A/B/C: user accounts, sessions, leagues, and email verification', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  describe('Password hashing', () => {
    it('hashPassword never stores the plaintext password, and the stored format is self-describing', async () => {
      const hash = await hashPassword('correct horse battery staple');
      expect(hash).not.toContain('correct horse battery staple');
      const parts = hash.split('$');
      expect(parts[0]).toBe('pbkdf2');
      expect(Number(parts[1])).toBeGreaterThanOrEqual(100000);
      expect(parts.length).toBe(4);
    });

    it('verifyPassword accepts the correct password and rejects a wrong one', async () => {
      const hash = await hashPassword('my-real-password-1');
      expect(await verifyPassword('my-real-password-1', hash)).toBe(true);
      expect(await verifyPassword('wrong-password', hash)).toBe(false);
    });

    it('two hashes of the same password are different (random salt per hash)', async () => {
      const h1 = await hashPassword('same-password-both-times');
      const h2 = await hashPassword('same-password-both-times');
      expect(h1).not.toBe(h2);
      expect(await verifyPassword('same-password-both-times', h1)).toBe(true);
      expect(await verifyPassword('same-password-both-times', h2)).toBe(true);
    });
  });

  describe('POST /auth/signup and POST /auth/login', () => {
    it('signup creates a user with a properly-hashed password, not plaintext, and logs them in immediately', async () => {
      const res = await signup('coach.signup@example.com', 'a-strong-password-1');
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.userId).toBeTruthy();
      expect(res.headers.get('set-cookie') || '').toContain('user_session=');
      expect(res.headers.get('set-cookie') || '').toContain('HttpOnly');

      const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(json.userId).first();
      expect(row.password_hash).not.toContain('a-strong-password-1');
      expect(row.password_hash.startsWith('pbkdf2$')).toBe(true);
    });

    it('signup rejects a duplicate email', async () => {
      await signup('dupe@example.com', 'a-strong-password-1', '203.0.113.11');
      const res = await signup('dupe@example.com', 'a-different-password', '203.0.113.12');
      expect(res.status).toBe(409);
      expect((await res.json()).ok).toBe(false);
    });

    it('login succeeds with the correct password and sets a session cookie', async () => {
      await signup('login.ok@example.com', 'correct-password-1', '203.0.113.13');
      const res = await SELF.fetch('http://example.com/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'login.ok@example.com', password: 'correct-password-1' })
      });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
      expect(res.headers.get('set-cookie') || '').toContain('user_session=');
    });

    it('login fails with a wrong password, and with a nonexistent email, using the exact same generic error', async () => {
      await signup('login.wrongpw@example.com', 'the-real-password', '203.0.113.14');

      const wrongPwRes = await SELF.fetch('http://example.com/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'login.wrongpw@example.com', password: 'not-the-password' })
      });
      const nonexistentRes = await SELF.fetch('http://example.com/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody-signed-up-with-this@example.com', password: 'whatever' })
      });

      expect(wrongPwRes.status).toBe(401);
      expect(nonexistentRes.status).toBe(401);
      const wrongPwBody = await wrongPwRes.json();
      const nonexistentBody = await nonexistentRes.json();
      // Identical error, so a caller can't distinguish "wrong password" from
      // "no such account" — the whole point of not revealing which it was.
      expect(wrongPwBody).toEqual(nonexistentBody);
    });
  });

  describe('Session cookie validation', () => {
    it('checkUserSession accepts a freshly-issued signup session cookie', async () => {
      const res = await signup('session.valid@example.com', 'a-strong-password-1', '203.0.113.15');
      const cookieHeader = extractCookie(res);
      const fakeReq = new Request('http://example.com/whatever', { headers: { cookie: cookieHeader } });
      const session = await checkUserSession(fakeReq, env);
      expect(session).toBeTruthy();
      expect(session.userId).toBe((await res.json()).userId);
    });

    it('checkUserSession rejects a cookie with a tampered signature', async () => {
      const res = await signup('session.tampered@example.com', 'a-strong-password-1', '203.0.113.16');
      const cookieHeader = extractCookie(res);
      // Flip the last character of the signature to corrupt it.
      const tampered = cookieHeader.slice(0, -1) + (cookieHeader.slice(-1) === 'a' ? 'b' : 'a');
      const fakeReq = new Request('http://example.com/whatever', { headers: { cookie: tampered } });
      expect(await checkUserSession(fakeReq, env)).toBeNull();
    });

    it('checkUserSession rejects an expired session token', async () => {
      const userId = 'expired-test-user';
      await env.DB.prepare(
        `INSERT OR REPLACE INTO users (id, email, password_hash, created_at, session_epoch) VALUES (?, ?, 'x', ?, 0)`
      ).bind(userId, 'expired-user@example.com', new Date().toISOString()).run();

      const epoch = 0;
      const expiredExp = Date.now() - 1000; // already expired
      const sig = await hmac(AUTH_SECRET, `session:${userId}:${epoch}:${expiredExp}`);
      const cookieHeader = `user_session=${encodeURIComponent(`${userId}.${epoch}.${expiredExp}.${sig}`)}`;
      const fakeReq = new Request('http://example.com/whatever', { headers: { cookie: cookieHeader } });
      expect(await checkUserSession(fakeReq, env)).toBeNull();
    });

    it('checkUserSession rejects a request with no cookie header at all', async () => {
      const fakeReq = new Request('http://example.com/whatever');
      expect(await checkUserSession(fakeReq, env)).toBeNull();
    });

    it('POST /auth/logout destroys the session — the same cookie no longer authenticates afterward', async () => {
      const signupRes = await signup('session.logout@example.com', 'a-strong-password-1', '203.0.113.17');
      const cookieHeader = extractCookie(signupRes);

      const beforeLogout = await checkUserSession(new Request('http://example.com/x', { headers: { cookie: cookieHeader } }), env);
      expect(beforeLogout).toBeTruthy();

      const logoutRes = await SELF.fetch('http://example.com/auth/logout', {
        method: 'POST',
        headers: { cookie: cookieHeader }
      });
      expect(logoutRes.status).toBe(200);

      const afterLogout = await checkUserSession(new Request('http://example.com/x', { headers: { cookie: cookieHeader } }), env);
      expect(afterLogout).toBeNull();
    });
  });

  describe('Signup rate limiting', () => {
    it('blocks a burst of signups from the same IP past the limit, while a different IP is unaffected', async () => {
      const burstIp = '198.51.100.50';
      for (let i = 0; i < 5; i++) {
        const res = await signup(`burst${i}@example.com`, 'a-strong-password-1', burstIp);
        expect(res.status).toBe(200);
      }
      const sixthRes = await signup('burst5@example.com', 'a-strong-password-1', burstIp);
      expect(sixthRes.status).toBe(429);
      expect((await sixthRes.json()).ok).toBe(false);

      // A normal single signup from an unrelated IP is unaffected by the burst.
      const otherIpRes = await signup('normal.signup@example.com', 'a-strong-password-1', '198.51.100.99');
      expect(otherIpRes.status).toBe(200);
    });
  });

  describe('POST /leagues/create', () => {
    it('creates the league row and links the creating user as admin, given a valid session', async () => {
      const signupRes = await signup('league.creator@example.com', 'a-strong-password-1', '203.0.113.20');
      const { userId } = await signupRes.json();
      const cookieHeader = extractCookie(signupRes);
      const csrfToken = extractCsrfToken(signupRes);

      const res = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
        body: JSON.stringify({
          name: 'Tuesday Night Beer League',
          teamNames: ['Ice Wolves', 'Rink Rats', 'Puck Hogs', 'Slap Shots'],
          tracksStats: true
        })
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.league.id).toBeTruthy();
      expect(json.league.teamCount).toBe(4);

      const leagueRow = await env.DB.prepare('SELECT * FROM leagues WHERE id = ?').bind(json.league.id).first();
      expect(leagueRow.name).toBe('Tuesday Night Beer League');
      expect(leagueRow.created_by).toBe(userId);
      expect(JSON.parse(leagueRow.team_names)).toEqual(['Ice Wolves', 'Rink Rats', 'Puck Hogs', 'Slap Shots']);

      const adminRow = await env.DB.prepare(
        'SELECT * FROM league_admins WHERE league_id = ? AND user_id = ?'
      ).bind(json.league.id, userId).first();
      expect(adminRow).toBeTruthy();
      expect(adminRow.role).toBe('admin');
    });

    it('rejects league creation with no session at all', async () => {
      const res = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'No Session League', teamNames: ['A', 'B'], tracksStats: true })
      });
      expect(res.status).toBe(401);
      expect((await res.json()).ok).toBe(false);

      const row = await env.DB.prepare('SELECT id FROM leagues WHERE name = ?').bind('No Session League').first();
      expect(row).toBeNull();
    });

    it('rejects league creation with a tampered session cookie', async () => {
      const signupRes = await signup('league.tampered@example.com', 'a-strong-password-1', '203.0.113.21');
      const cookieHeader = extractCookie(signupRes);
      const tampered = cookieHeader.slice(0, -1) + (cookieHeader.slice(-1) === '9' ? '8' : '9');

      const res = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: tampered },
        body: JSON.stringify({ name: 'Tampered Cookie League', teamNames: ['A', 'B'], tracksStats: true })
      });
      expect(res.status).toBe(401);
    });
  });

  describe('Email verification', () => {
    it('the token from signup verifies the account, and isUserEmailVerified reflects it correctly before and after', async () => {
      const res = await signup('verify.me@example.com', 'a-strong-password-1', '203.0.113.30');
      const { userId, verification } = await res.json();
      expect(verification.token).toBeTruthy();
      expect(verification.link).toContain('/auth/verify?token=');

      expect(await isUserEmailVerified(env, userId)).toBe(false);

      const verifyRes = await SELF.fetch(`http://example.com/auth/verify?token=${encodeURIComponent(verification.token)}`);
      expect(verifyRes.status).toBe(200);
      expect((await verifyRes.json()).ok).toBe(true);

      expect(await isUserEmailVerified(env, userId)).toBe(true);
    });

    it('using the same valid token a second time is idempotent (still succeeds, does not error)', async () => {
      const res = await signup('verify.twice@example.com', 'a-strong-password-1', '203.0.113.31');
      const { verification } = await res.json();

      const firstRes = await SELF.fetch(`http://example.com/auth/verify?token=${encodeURIComponent(verification.token)}`);
      const secondRes = await SELF.fetch(`http://example.com/auth/verify?token=${encodeURIComponent(verification.token)}`);
      expect(firstRes.status).toBe(200);
      expect(secondRes.status).toBe(200);
      expect((await firstRes.json()).ok).toBe(true);
      expect((await secondRes.json()).ok).toBe(true);
    });

    it('rejects a malformed or garbage token', async () => {
      const res = await SELF.fetch('http://example.com/auth/verify?token=not-a-real-token');
      expect(res.status).toBe(400);
      expect((await res.json()).ok).toBe(false);
    });

    it('isLeagueEmailVerified is false until an admin of that league verifies, then true afterward', async () => {
      const signupRes = await signup('league.email.verify@example.com', 'a-strong-password-1', '203.0.113.32');
      const { userId, verification } = await signupRes.json();
      const cookieHeader = extractCookie(signupRes);
      const csrfToken = extractCsrfToken(signupRes);

      const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Email Gate League', teamNames: ['A', 'B'], tracksStats: true })
      });
      const { league } = await leagueRes.json();

      expect(await isLeagueEmailVerified(env, league.id)).toBe(false);

      await SELF.fetch(`http://example.com/auth/verify?token=${encodeURIComponent(verification.token)}`);

      expect(await isLeagueEmailVerified(env, league.id)).toBe(true);
      // And the user-level check agrees.
      expect(await isUserEmailVerified(env, userId)).toBe(true);
    });
  });
});

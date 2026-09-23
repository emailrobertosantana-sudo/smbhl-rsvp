// Part 7: IP-based rate limiting on POST /auth/login, matching the class
// of protection signup already has (checkSignupRateLimit) -- its own
// checkLoginRateLimit, reusing the same signup_attempts table under a
// 'login:' key prefix so it can never cross-throttle against the real
// signup or password-reset-request counters.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part7-login-rate-limit-secret';

describe('Part 7: login rate limiting', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);

    await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.461' },
      body: JSON.stringify({ email: 'part7.ratelimit@example.com', password: 'a-strong-password-1' })
    });
  });

  it('allows normal login attempts under the limit', async () => {
    const ip = '203.0.113.462';
    for (let i = 0; i < 5; i++) {
      const res = await SELF.fetch('http://example.com/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify({ email: 'part7.ratelimit@example.com', password: 'wrong-password' })
      });
      expect(res.status).toBe(401); // wrong password, but not rate-limited yet
    }
  });

  it('blocks further login attempts from the same IP once the limit is exceeded (429)', async () => {
    const ip = '203.0.113.463';
    for (let i = 0; i < 10; i++) {
      await SELF.fetch('http://example.com/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify({ email: 'part7.ratelimit@example.com', password: 'wrong-password' })
      });
    }
    const res = await SELF.fetch('http://example.com/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ email: 'part7.ratelimit@example.com', password: 'a-strong-password-1' }) // even the RIGHT password
    });
    expect(res.status).toBe(429);
  });

  it("a different IP is completely unaffected by another IP's rate limit", async () => {
    const res = await SELF.fetch('http://example.com/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.464' },
      body: JSON.stringify({ email: 'part7.ratelimit@example.com', password: 'a-strong-password-1' })
    });
    expect(res.status).toBe(200);
  });

  it("the login rate limit is a genuinely separate counter from signup's -- hitting one doesn't affect the other", async () => {
    const ip = '203.0.113.465';
    for (let i = 0; i < 10; i++) {
      await SELF.fetch('http://example.com/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify({ email: 'part7.ratelimit@example.com', password: 'wrong-password' })
      });
    }
    // Login from this IP is now blocked...
    const loginRes = await SELF.fetch('http://example.com/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ email: 'part7.ratelimit@example.com', password: 'a-strong-password-1' })
    });
    expect(loginRes.status).toBe(429);

    // ...but a signup from the SAME IP is completely unaffected.
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ email: 'part7.separate.counter@example.com', password: 'a-strong-password-1' })
    });
    expect(signupRes.status).toBe(200);
  });
});

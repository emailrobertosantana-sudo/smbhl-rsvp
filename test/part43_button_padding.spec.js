// Live-testing task, Part 8: buttons lacked horizontal padding so
// label text touched the edges -- confirmed in real testing on two
// separate surfaces: the verification email's primary button
// (nlEmailButton, design_system.js -- was `padding:16px 0`, vertical
// only) and the roster form's role/goalie-axis buttons (.ro-radio
// label, index.js -- was `padding: 0 4px`). Fixed independently since
// they're two different rendering contexts (email HTML vs in-app CSS).
import { env, SELF } from 'cloudflare:test';
import { nlEmailButton } from '../src/design_system.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part8-button-padding-secret';

describe('Part 8 (live-testing task): buttons have real horizontal padding', () => {
  it('nlEmailButton (every transactional email\'s primary button) has non-zero horizontal padding', () => {
    const html = nlEmailButton('https://notreligue.ca/x', 'Confirmer mon courriel');
    const match = html.match(/padding:\s*([\d.]+)px\s+([\d.]+)px/);
    expect(match).not.toBeNull();
    const [, vertical, horizontal] = match;
    expect(Number(horizontal)).toBeGreaterThan(0);
    // Matches the app's own .nl-btn horizontal padding (--space-5, 24px)
    // for visual consistency between the email and in-app buttons.
    expect(Number(horizontal)).toBe(24);
    expect(Number(vertical)).toBe(16);
  });

  it('every email template using nlEmailButton inherits the fix (verification, password reset, co-admin invite)', async () => {
    // A direct regression against the exact old buggy pattern, so a
    // future edit to nlEmailButton can't silently reintroduce it.
    const html = nlEmailButton('https://notreligue.ca/x', 'Go');
    expect(html).not.toMatch(/padding:\s*16px\s+0(?:px)?[;"]/);
  });

  describe('roster page role/goalie-axis buttons (.ro-radio)', () => {
    beforeAll(async () => {
      env.AUTH_SECRET = AUTH_SECRET;
      await applyRealSchema(env);
    });

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
    async function createLeague(cookie, csrfToken, body) {
      const res = await SELF.fetch('http://example.com/leagues/create', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify(body)
      });
      return (await res.json()).league;
    }

    it('the rendered .ro-radio label CSS no longer uses the tight 4px horizontal padding', async () => {
      const signupRes = await SELF.fetch('http://example.com/auth/signup', {
        method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.153.001' },
        body: JSON.stringify({ email: 'roster.padding@example.com', password: 'a-strong-password-1' })
      });
      const cookie = extractCookie(signupRes);
      const csrfToken = extractCsrfToken(signupRes);
      await createLeague(cookie, csrfToken, { name: 'Padding Check League', teamNames: ['A', 'B'], tracksStats: true });
      const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
      expect(html).toContain('.ro-radio label');
      expect(html).not.toMatch(/\.ro-radio label \{[^}]*padding:\s*0\s+4px/);
      expect(html).toMatch(/\.ro-radio label \{[^}]*padding:\s*0\s+var\(--space-3\)/);
    });
  });
});

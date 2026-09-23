// Part 3 (overnight follow-up task): a simple "copy link" button next
// to the dashboard's public page URL (made actually presentable by
// Part 2's short slugs), so an admin doesn't have to select/copy the
// text by hand.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part3-copy-link-secret';

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

describe('Part 3: copy-link button on the dashboard', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the dashboard has a real copy-link button wired to the actual public URL', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.671' },
      body: JSON.stringify({ email: 'part3.copylink@example.com', password: 'a-strong-password-1' })
    });
    const cookie = extractCookie(signupRes);
    const csrfToken = extractCsrfToken(signupRes);
    await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Copy Link League', teamNames: ['A', 'B'], tracksStats: true, slug: 'copy-link-league' })
    });

    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain('id="copyPublicUrlBtn"');
    expect(html).toContain('onclick="copyPublicUrl()"');
    expect(html).toContain('id="publicUrlLink"');
    expect(html).toContain('/copy-link-league"'); // the button targets the real, current public URL
    expect(html).toContain('navigator.clipboard.writeText(url)');
    // Bilingual (Part 2/3 toggle system), not a one-off hardcoded string.
    expect(html).toContain('"copyLink"');
    expect(html).toContain('"Copy"'); // real EN translation, design system voice (verb button, not ALL CAPS)
  });
});

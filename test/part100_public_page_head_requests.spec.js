// Public page QA batch, C1: a HEAD request to a league's public page
// returned 404 while GET returned 200. Link-preview crawlers (iMessage,
// Slack, WhatsApp, Facebook) commonly issue HEAD first, so a shared
// league page could preview as broken -- on a page whose whole purpose
// is being shared. HEAD must now answer exactly like GET, minus the
// body, in every case: a real page, a hidden one, a nonexistent one.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part100-head-secret';

function extractCookie(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.get('set-cookie') || '').split(', ');
  const c = cookies.find(x => x.startsWith('csrf_token='));
  return c ? c.split(';')[0].split('=')[1] : '';
}
async function signupAndCreate(email, ip, name) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookie = extractCookie(res), csrfToken = extractCsrfToken(res);
  const league = (await (await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, teamNames: ['A', 'B'], tracksStats: false })
  })).json()).league;
  const slug = (await env.DB.prepare('SELECT slug FROM leagues WHERE id = ?').bind(league.id).first()).slug;
  return { league, slug };
}

async function both(url) {
  const get = await SELF.fetch(url);
  const getBody = await get.text();
  const head = await SELF.fetch(url, { method: 'HEAD' });
  const headBody = await head.text();
  return { get, getBody, head, headBody };
}

describe('Public page answers HEAD exactly like GET, without a body', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('short slug URL: HEAD is 200 with the same content-type as GET, and no body', async () => {
    const { slug } = await signupAndCreate('head.slug@example.com', '203.0.220.001', 'Head Slug League');
    const r = await both(`http://example.com/${slug}`);
    expect(r.get.status).toBe(200);
    expect(r.head.status).toBe(r.get.status);
    expect(r.head.headers.get('content-type')).toBe(r.get.headers.get('content-type'));
    expect(r.getBody).toContain('pb-main');
    expect(r.headBody).toBe('');
  });

  it('/league/public?league=<id>: HEAD matches GET too', async () => {
    const { league } = await signupAndCreate('head.id@example.com', '203.0.220.002', 'Head Id League');
    const r = await both(`http://example.com/league/public?league=${league.id}`);
    expect(r.get.status).toBe(200);
    expect(r.head.status).toBe(200);
    expect(r.headBody).toBe('');
  });

  it('a hidden public page: HEAD gives the same 404 GET does -- never a different answer about whether the page exists', async () => {
    const { league, slug } = await signupAndCreate('head.hidden@example.com', '203.0.220.003', 'Head Hidden League');
    await env.DB.prepare('UPDATE leagues SET public_page_enabled = 0 WHERE id = ?').bind(league.id).run();
    const r = await both(`http://example.com/${slug}`);
    expect(r.get.status).toBe(404);
    expect(r.head.status).toBe(404);
  });

  it('an unknown slug still 404s on both', async () => {
    const r = await both('http://example.com/no-such-league-anywhere');
    expect(r.get.status).toBe(404);
    expect(r.head.status).toBe(404);
  });
});

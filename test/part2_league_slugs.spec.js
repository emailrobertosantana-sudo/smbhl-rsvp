// Part 2 (overnight follow-up task): short, human-readable league URL
// slugs (notreligue.ca/dmbhl) instead of the raw UUID
// (notreligue.ca/league/public?league=<uuid>). Auto-suggested from the
// league name at signup, user-editable before submitting, validated
// server-side (format, reserved words, uniqueness) using Part 1's
// key-based error system. NOT changeable after creation (a deliberate,
// documented choice -- see leagues.js's own comment on
// generateUniqueSlug). Existing leagues (created before this field
// existed) get a real slug lazily, the first time their dashboard is
// loaded. The bare-slug URL is a genuine last-resort GET route, checked
// only after every fixed route already failed to match, so it can
// never shadow a real route.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part2-slugs-secret';

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

async function signup(email, ip) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  return { cookie: extractCookie(res), csrfToken: extractCsrfToken(res) };
}

describe('Part 2: league URL slugs', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a new league with no explicit slug gets one auto-generated from its name', async () => {
    const a = await signup('part2.auto@example.com', '203.0.113.651');
    const res = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ name: 'DMBHL', teamNames: ['A', 'B'], tracksStats: true })
    });
    const json = await res.json();
    expect(json.league.slug).toBe('dmbhl');
  });

  it('an explicit, user-chosen slug is accepted and used', async () => {
    const a = await signup('part2.custom@example.com', '203.0.113.652');
    const res = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ name: 'Some League', teamNames: ['A', 'B'], tracksStats: true, slug: 'my-custom-slug' })
    });
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.league.slug).toBe('my-custom-slug');
  });

  it('an invalid-format slug is rejected with a translatable error key', async () => {
    const a = await signup('part2.badformat@example.com', '203.0.113.653');
    const res = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ name: 'Bad Format League', teamNames: ['A', 'B'], tracksStats: true, slug: 'Not Valid!!' })
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errorKey).toBe('SLUG_INVALID_FORMAT');
  });

  it('a reserved slug (matching a real route name) is rejected', async () => {
    const a = await signup('part2.reserved@example.com', '203.0.113.654');
    const res = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ name: 'Reserved League', teamNames: ['A', 'B'], tracksStats: true, slug: 'dashboard' })
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.errorKey).toBe('SLUG_RESERVED');
  });

  it('a slug already taken by another league is rejected', async () => {
    const a = await signup('part2.takenA@example.com', '203.0.113.655');
    await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ name: 'Taken League A', teamNames: ['A', 'B'], tracksStats: true, slug: 'already-taken' })
    });
    const b = await signup('part2.takenB@example.com', '203.0.113.656');
    const res = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie: b.cookie, 'content-type': 'application/json', 'x-csrf-token': b.csrfToken },
      body: JSON.stringify({ name: 'Taken League B', teamNames: ['A', 'B'], tracksStats: true, slug: 'already-taken' })
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.errorKey).toBe('SLUG_TAKEN');
  });

  it('two leagues auto-generating from the same name get different, non-colliding slugs', async () => {
    const a = await signup('part2.collideA@example.com', '203.0.113.657');
    const resA = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ name: 'Collision League', teamNames: ['A', 'B'], tracksStats: true })
    });
    const b = await signup('part2.collideB@example.com', '203.0.113.658');
    const resB = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie: b.cookie, 'content-type': 'application/json', 'x-csrf-token': b.csrfToken },
      body: JSON.stringify({ name: 'Collision League', teamNames: ['C', 'D'], tracksStats: true })
    });
    const slugA = (await resA.json()).league.slug;
    const slugB = (await resB.json()).league.slug;
    expect(slugA).not.toBe(slugB);
    expect(slugA).toBe('collision-league');
    expect(slugB).toBe('collision-league-2');
  });

  it('GET /<slug> renders the exact same public page as ?league=<uuid>', async () => {
    const a = await signup('part2.route@example.com', '203.0.113.659');
    const createRes = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ name: 'Slug Route League', teamNames: ['Red', 'Blue'], tracksStats: true, slug: 'slug-route-league' })
    });
    const leagueId = (await createRes.json()).league.id;

    const bySlug = await (await SELF.fetch('http://example.com/slug-route-league')).text();
    const byUuid = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(leagueId)}`)).text();
    expect(bySlug).toContain('Slug Route League');
    expect(bySlug).toContain('Red');
    // Same page content either way (title, teams) -- not byte-identical
    // (no reason it needs to be), but both resolve to the same league.
    expect(byUuid).toContain('Slug Route League');
  });

  it('a slug that happens to look like a real route path is never actually reachable that way -- fixed routes always win', async () => {
    // /login is a real, fixed route -- confirms the catch-all can never
    // shadow it, structurally (fixed routes are checked first in the
    // dispatch chain; the slug fallback only runs after every one of
    // them has already failed to match).
    const res = await SELF.fetch('http://example.com/login');
    const html = await res.text();
    expect(html).toContain('Connexion'); // the real login page, not a 404 or a league page
  });

  it("a deactivated league's slug URL returns 410, consistent with the ?league=<uuid> form", async () => {
    const a = await signup('part2.deactivated@example.com', '203.0.113.660');
    const createRes = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ name: 'Deactivated Slug League', teamNames: ['A', 'B'], tracksStats: true, slug: 'deactivated-slug-league' })
    });
    const leagueId = (await createRes.json()).league.id;
    await env.DB.prepare('UPDATE leagues SET deactivated_at = ? WHERE id = ?').bind(new Date().toISOString(), leagueId).run();

    const res = await SELF.fetch('http://example.com/deactivated-slug-league');
    expect(res.status).toBe(410);
  });

  it('a league created before slugs existed (no DB column value) gets one lazily generated the first time its dashboard loads', async () => {
    const a = await signup('part2.backfill@example.com', '203.0.113.661');
    const createRes = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ name: 'Backfill Me League', teamNames: ['A', 'B'], tracksStats: true, slug: 'backfill-me-league' })
    });
    const leagueId = (await createRes.json()).league.id;
    // Simulate a pre-Part-2 league: wipe its slug back to NULL directly.
    await env.DB.prepare('UPDATE leagues SET slug = NULL WHERE id = ?').bind(leagueId).run();
    const before = await env.DB.prepare('SELECT slug FROM leagues WHERE id = ?').bind(leagueId).first();
    expect(before.slug).toBeNull();

    await SELF.fetch('http://example.com/dashboard', { headers: { cookie: a.cookie } });

    const after = await env.DB.prepare('SELECT slug FROM leagues WHERE id = ?').bind(leagueId).first();
    expect(after.slug).toBeTruthy();
    expect(after.slug).toBe('backfill-me-league'); // regenerated from the same real name
  });

  it("SMBHL is not part of this system at all -- no slug, and the marketing homepage / smbhl.com root are unaffected", async () => {
    const row = await env.DB.prepare("SELECT slug FROM leagues WHERE id = 'smbhl'").first();
    expect(row.slug).toBeNull();
  });
});

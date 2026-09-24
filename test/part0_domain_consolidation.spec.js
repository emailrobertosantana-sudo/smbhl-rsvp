// Part 0: this Worker now also serves other leagues' own domains
// (e.g. notreligue.ca) directly, not just SMBHL's -- the standalone
// marketing Worker for notreligue.ca is being retired. This does NOT
// touch Cloudflare routing/domain configuration (a real remote change,
// done separately) -- it only proves the app code itself is
// domain-aware and ready: GET / behaves correctly depending on which
// HOSTNAME the request actually arrived on, and nothing hardcodes
// rsvp.notreligue.ca or any other non-SMBHL domain.
//
// Post-deploy fix #1 (091bf2e): the original implementation branched on
// env.PUBLIC_URL (a single fixed value for the whole Worker
// deployment) instead of the request's own hostname. Fixed to decide
// based on url.hostname (the real incoming request), never PUBLIC_URL.
//
// Post-deploy fix #2 (this commit): a direct redirect straight to
// /signup for every non-SMBHL hostname skipped introducing the product
// at all -- a prospect landed on a bare signup form with zero context.
// Root / for a non-SMBHL hostname now serves a real marketing homepage
// (ported from the standalone notreligue-marketing Worker) with its
// own "Get Started" button leading to /signup, instead of an immediate
// redirect.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

describe('Part 0: domain-aware GET /', () => {
  // Schema-drift guard task: every real request now passes through a
  // schema check before routing (src/schema_guard.js) -- this file
  // never needed real data before (it only tests hostname-based
  // routing, not DB content), but the guard still requires a real
  // migrated schema to exist, same as any other real deployment would
  // always have. Matches the convention 130+ other test files already
  // use.
  beforeAll(async () => {
    await applyRealSchema(env);
  });
  it("SMBHL's own hostname (smbhl.com, or any subdomain of it like rsvp.smbhl.com) keeps its exact original redirect to https://smbhl.com", async () => {
    const res = await SELF.fetch('https://rsvp.smbhl.com/', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://smbhl.com/');
  });

  it("a bare smbhl.com hostname also redirects to https://smbhl.com", async () => {
    const res = await SELF.fetch('https://smbhl.com/', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://smbhl.com/');
  });

  it("any other hostname (e.g. notreligue.ca) shows the marketing homepage, not an immediate redirect", async () => {
    const res = await SELF.fetch('http://notreligue.ca/', { redirect: 'manual' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Notre Ligue');
    expect(html).not.toContain('smbhl.com');
  });

  it("the homepage's primary CTA links to /signup (design system: ScreenHomepage's real copy, \"Créer ma ligue\")", async () => {
    const res = await SELF.fetch('http://notreligue.ca/');
    const html = await res.text();
    expect(html).toContain('href="/signup"');
    expect(html).toContain('Create my league'); // real EN translation, shipped in the toggle dict
    expect(html).toContain('Créer ma ligue'); // French-default copy
  });

  it("rsvp.notreligue.ca hitting root also shows the marketing homepage, not smbhl.com", async () => {
    const res = await SELF.fetch('https://rsvp.notreligue.ca/', { redirect: 'manual' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Notre Ligue');
  });

  it("a brand-new, never-configured league domain works correctly out of the box, with zero PUBLIC_URL reconfiguration needed", async () => {
    const res = await SELF.fetch('https://some-future-league.example/', { redirect: 'manual' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/signup"');
  });

  it("REGRESSION (the live bug): notreligue.ca still shows its own homepage, not a redirect to smbhl.com, even when env.PUBLIC_URL is fixed to SMBHL's own value", async () => {
    const originalPublicUrl = env.PUBLIC_URL;
    env.PUBLIC_URL = 'https://rsvp.smbhl.com'; // the real, fixed, per-deployment value that caused the original bug
    try {
      const res = await SELF.fetch('https://notreligue.ca/', { redirect: 'manual' });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain('smbhl.com');
    } finally {
      env.PUBLIC_URL = originalPublicUrl;
    }
  });

  it("SMBHL's own root redirect is unaffected by the marketing homepage change", async () => {
    const res = await SELF.fetch('https://rsvp.smbhl.com/', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://smbhl.com/');
  });

  it('GET /signup (still reachable directly, e.g. from the homepage\'s Get Started button) is French by default, not a bare form', async () => {
    const res = await SELF.fetch('http://example.com/signup');
    expect(res.status).toBe(200);
    const html = await res.text();
    // Design system Part 2: signup is now the real 3-step wizard
    // (ScreenSignup's own copy), starting at step 1 -- account.
    expect(html).toContain('Créons ton compte');
    expect(html).toContain('Créer un compte');
  });
});

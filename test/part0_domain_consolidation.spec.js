// Part 0: this Worker now also serves other leagues' own domains
// (e.g. notreligue.ca) directly, not just SMBHL's -- the standalone
// marketing Worker for notreligue.ca is being retired. This does NOT
// touch Cloudflare routing/domain configuration (a real remote change,
// done separately) -- it only proves the app code itself is
// domain-aware and ready: GET / behaves correctly depending on which
// HOSTNAME the request actually arrived on, and nothing hardcodes
// rsvp.notreligue.ca or any other non-SMBHL domain.
//
// Post-deploy bug fix: the original implementation branched on
// env.PUBLIC_URL (a single fixed value for the whole Worker
// deployment) instead of the request's own hostname. Since multiple
// custom domains (smbhl.com's production deployment AND notreligue.ca,
// once consolidated onto the same Worker) can be routed to the same
// deployment, this meant EVERY request -- regardless of which domain it
// actually arrived on -- redirected to smbhl.com, because PUBLIC_URL is
// fixed to https://rsvp.smbhl.com for that deployment. Fixed to decide
// based on url.hostname (the real incoming request), never PUBLIC_URL.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Part 0: domain-aware GET /', () => {
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

  it("any other hostname (e.g. notreligue.ca) redirects GET / to ITS OWN /signup, not to smbhl.com", async () => {
    const res = await SELF.fetch('http://notreligue.ca/', { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toContain('/signup');
    expect(location).not.toContain('smbhl.com');
    // Relative to the request's own origin -- never a hardcoded domain.
    expect(location.startsWith('http://notreligue.ca')).toBe(true);
  });

  it("rsvp.notreligue.ca hitting root also lands on its own /signup, not smbhl.com", async () => {
    const res = await SELF.fetch('https://rsvp.notreligue.ca/', { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toBe('https://rsvp.notreligue.ca/signup');
  });

  it("a brand-new, never-configured league domain works correctly out of the box, with zero PUBLIC_URL reconfiguration needed", async () => {
    const res = await SELF.fetch('https://some-future-league.example/', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://some-future-league.example/signup');
  });

  it("REGRESSION (the live bug): notreligue.ca still lands on its own /signup even when env.PUBLIC_URL is fixed to SMBHL's own value -- the decision must never depend on PUBLIC_URL", async () => {
    const originalPublicUrl = env.PUBLIC_URL;
    env.PUBLIC_URL = 'https://rsvp.smbhl.com'; // the real, fixed, per-deployment value that caused the bug
    try {
      const res = await SELF.fetch('https://notreligue.ca/', { redirect: 'manual' });
      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).toBe('https://notreligue.ca/signup');
      expect(location).not.toContain('smbhl.com');
    } finally {
      env.PUBLIC_URL = originalPublicUrl;
    }
  });

  it("GET /signup (the effective root landing page for a non-SMBHL deployment) is French by default, not a bare form", async () => {
    const res = await SELF.fetch('http://example.com/signup');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Créer votre ligue');
    expect(html).toContain('Créer un compte');
  });
});

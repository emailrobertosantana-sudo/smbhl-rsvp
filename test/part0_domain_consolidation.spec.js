// Part 0: this Worker now also serves other leagues' own domains
// (e.g. notreligue.ca) directly, not just SMBHL's -- the standalone
// marketing Worker for notreligue.ca is being retired. This does NOT
// touch Cloudflare routing/domain configuration (a real remote change,
// done separately) -- it only proves the app code itself is
// domain-aware and ready: GET / behaves correctly depending on which
// deployment's PUBLIC_URL it's running under, and nothing hardcodes
// rsvp.notreligue.ca or any other non-SMBHL domain.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Part 0: domain-aware GET /', () => {
  it("SMBHL's own deployment (PUBLIC_URL contains smbhl.com) keeps its exact original root redirect to https://smbhl.com", async () => {
    const originalPublicUrl = env.PUBLIC_URL;
    env.PUBLIC_URL = 'https://rsvp.smbhl.com';
    try {
      const res = await SELF.fetch('http://example.com/', { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://smbhl.com/');
    } finally {
      env.PUBLIC_URL = originalPublicUrl;
    }
  });

  it("any other deployment (e.g. notreligue.ca's PUBLIC_URL) redirects GET / to its own /signup, not to smbhl.com", async () => {
    const originalPublicUrl = env.PUBLIC_URL;
    env.PUBLIC_URL = 'https://notreligue.ca';
    try {
      const res = await SELF.fetch('http://notreligue.ca/', { redirect: 'manual' });
      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).toContain('/signup');
      expect(location).not.toContain('smbhl.com');
      // Relative to the request's own origin -- never a hardcoded domain.
      expect(location.startsWith('http://notreligue.ca')).toBe(true);
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

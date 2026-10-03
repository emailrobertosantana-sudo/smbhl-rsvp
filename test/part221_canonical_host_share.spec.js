// Notre Ligue: one canonical address and a share image.
//   A. rsvp.notreligue.ca sends its public pages (/, /fr, /en, the legal
//      pages and their English aliases, the sitemap) to the same path on
//      https://notreligue.ca with a 301; every app path stays where it is.
//      www.notreligue.ca still sends everything there.
//   B. The share image (1200 by 630 PNG) is served at /share/notre-ligue.png
//      and named in og:image and twitter:image on /, /fr and /en.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

beforeAll(async () => { await applyRealSchema(env); env.LEAGUE_PRODUCT = 'true'; });
afterAll(() => { delete env.LEAGUE_PRODUCT; });

const get = (url, init = {}) => SELF.fetch(url, { redirect: 'manual', ...init });

describe('A. the public pages live on notreligue.ca', () => {
  for (const path of ['/', '/fr', '/en', '/confidentialite', '/conditions', '/privacy', '/terms', '/sitemap.xml']) {
    it(`rsvp.notreligue.ca${path} answers 301 to notreligue.ca`, async () => {
      const res = await get(`https://rsvp.notreligue.ca${path}?lang=en`);
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe(`https://notreligue.ca${path}?lang=en`);
    });
  }

  it('every other path on rsvp.notreligue.ca is unchanged', async () => {
    for (const path of ['/rsvp', '/login', '/signup', '/dashboard', '/league/billing', '/avail', '/admin/board', '/super-admin/leagues', '/auth/verify', '/share/notre-ligue.png', '/some-league']) {
      const res = await get(`https://rsvp.notreligue.ca${path}`);
      const loc = res.headers.get('location') || '';
      expect(loc.startsWith('https://notreligue.ca'), path).toBe(false);
    }
    const hook = await get('https://rsvp.notreligue.ca/billing/stripe-webhook', { method: 'POST', body: '{}' });
    expect(hook.status).not.toBe(301);
  });

  it('notreligue.ca serves the public pages itself; www still redirects everything', async () => {
    for (const path of ['/', '/fr', '/en', '/confidentialite', '/conditions']) {
      expect((await get(`https://notreligue.ca${path}`)).status, path).toBe(200);
    }
    const w = await get('https://www.notreligue.ca/rsvp?x=1');
    expect(w.status).toBe(301);
    expect(w.headers.get('location')).toBe('https://notreligue.ca/rsvp?x=1');
  });
});

describe('B. the share image', () => {
  it('is a 1200 by 630 PNG', async () => {
    const res = await get('https://notreligue.ca/share/notre-ligue.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const b = new Uint8Array(await res.arrayBuffer());
    expect([...b.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(b.buffer);
    expect(dv.getUint32(16)).toBe(1200);
    expect(dv.getUint32(20)).toBe(630);
  });

  // Since the homepage polish batch (item 1), /en names its own English
  // image (test/part230); / and /fr keep the French one.
  it('/, /fr and /en name their image, with its size, and a large Twitter card', async () => {
    for (const [path, file] of [['/', 'notre-ligue.png'], ['/fr', 'notre-ligue.png'], ['/en', 'notre-ligue-en.png']]) {
      const html = await (await get(`https://notreligue.ca${path}`)).text();
      expect(html, path).toContain(`<meta property="og:image" content="https://notreligue.ca/share/${file}">`);
      expect(html).toContain('<meta property="og:image:width" content="1200">');
      expect(html).toContain('<meta property="og:image:height" content="630">');
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
      expect(html).toContain(`<meta name="twitter:image" content="https://notreligue.ca/share/${file}">`);
    }
  });

  it('SMBHL does not serve it', async () => {
    delete env.LEAGUE_PRODUCT;
    expect((await get('https://rsvp.smbhl.com/share/notre-ligue.png')).status).not.toBe(200);
    env.LEAGUE_PRODUCT = 'true';
  });
});

// Homepage batch 3, item 3: SEO and language URLs.
//   /, /fr and /en: html lang, title, description, canonical, hreflang,
//   Open Graph, one H1, JSON-LD; /fr and /en ignore the browser and the
//   cookie; sitemap.xml and robots.txt for Notre Ligue; X-Robots-Tag on the
//   demo deployment (only the public pages on notreligue.ca are indexable).
import { env, SELF, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index.js';
import { applyRealSchema } from './support/real_schema.js';

beforeAll(async () => { await applyRealSchema(env); });

const ORIGIN = 'https://notreligue.ca';
const home = (path, headers = {}) => SELF.fetch(ORIGIN + path, { headers });
// The Worker with extra vars (the demo deployment's), without touching the
// shared env.
async function fetchWith(vars, u, headers = {}) {
  const e = new Proxy(env, { get: (t, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : Reflect.get(t, k)) });
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(u, { headers, redirect: 'manual' }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const DEMO = { DEMO_ENV: 'true', LEAGUE_PRODUCT: 'true', PUBLIC_URL: 'https://rsvp.notreligue.ca' };
const PRODUCT = { LEAGUE_PRODUCT: 'true', PUBLIC_URL: 'https://rsvp.notreligue.ca' };

const attr = (html, re) => (re.exec(html) || [])[1];
const TITLE = { fr: 'Notre Ligue : présences, remplaçants et calendrier de ligue', en: 'Notre Ligue: attendance, subs and schedules for leagues' };
const DESC = {
  fr: 'Notre Ligue gère les présences, trouve des remplaçants et génère le calendrier de ta ligue sportive. Gratuit sous 15 joueurs, 2 mois gratuits, sans carte.',
  en: 'Notre Ligue handles attendance, finds subs and builds the schedule for your sports league. Free under 15 players, 2 months free, no card.'
};

function checkHead(html, lang, canonicalPath) {
  expect(attr(html, /<html lang="([^"]+)"/)).toBe(lang === 'en' ? 'en-CA' : 'fr-CA');
  expect(attr(html, /<title>([^<]*)<\/title>/)).toBe(TITLE[lang]);
  expect(attr(html, /<meta name="description" content="([^"]*)">/)).toBe(DESC[lang]);
  expect(DESC[lang].length).toBeLessThanOrEqual(160);
  expect(attr(html, /<link rel="canonical" href="([^"]+)">/)).toBe(ORIGIN + canonicalPath);
  expect(attr(html, /<link rel="alternate" hreflang="fr-CA" href="([^"]+)">/)).toBe(ORIGIN + '/fr');
  expect(attr(html, /<link rel="alternate" hreflang="en-CA" href="([^"]+)">/)).toBe(ORIGIN + '/en');
  expect(attr(html, /<link rel="alternate" hreflang="x-default" href="([^"]+)">/)).toBe(ORIGIN + '/');
  expect(attr(html, /<meta property="og:url" content="([^"]+)">/)).toBe(ORIGIN + canonicalPath);
  expect(attr(html, /<meta property="og:title" content="([^"]+)">/)).toBe(TITLE[lang]);
  expect(attr(html, /<meta property="og:description" content="([^"]+)">/)).toBe(DESC[lang]);
  expect(attr(html, /<meta property="og:locale" content="([^"]+)">/)).toBe(lang === 'en' ? 'en_CA' : 'fr_CA');
  expect(attr(html, /<meta property="og:locale:alternate" content="([^"]+)">/)).toBe(lang === 'en' ? 'fr_CA' : 'en_CA');
  expect(html).toContain('<meta property="og:type" content="website">');
  expect(html).toContain('<meta property="og:site_name" content="Notre Ligue">');
  // The share image (test/part221_canonical_host_share.spec.js checks it in full).
  expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  expect(html).toMatch(/<meta property="og:image" content="[^"]+\/share\/notre-ligue\.png">/);
  // Structure: one H1, section titles H2 before any H3, landmarks.
  expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
  const headings = [...html.matchAll(/<h([1-6])[\s>]/g)].map(m => m[1]);
  expect(headings.slice(0, 2)).toEqual(['1', '2']);
  for (const tag of ['<header', '<nav', '<main>', '</main>', '<footer']) expect(html).toContain(tag);
  for (const id of ['features', 'pricing', 'how-it-works']) expect(html).toContain(`id="${id}"`);
  for (const a of ['#features', '#pricing', '#how-it-works']) expect(html).toContain(`href="${a}"`);
  // JSON-LD: one script, valid JSON, offers as on the page.
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  const ld = JSON.parse(scripts[0][1]);
  const org = ld['@graph'].find(x => x['@type'] === 'Organization');
  const app = ld['@graph'].find(x => x['@type'] === 'SoftwareApplication');
  expect(org).toMatchObject({ name: 'Notre Ligue', url: ORIGIN + '/', email: 'bonjour@notreligue.ca', founder: { name: 'Roberto Santana' } });
  expect(app).toMatchObject({ name: 'Notre Ligue', applicationCategory: 'BusinessApplication', inLanguage: lang === 'en' ? 'en-CA' : 'fr-CA' });
  expect(app.offers.map(o => [o.price, o.priceCurrency])).toEqual([['0', 'CAD'], ['9.99', 'CAD'], ['19.99', 'CAD']]);
  expect(app.offers.slice(1).map(o => o.priceSpecification.referenceQuantity.unitCode)).toEqual(['MON', 'MON']);
  expect(JSON.stringify(ld)).not.toMatch(/rating|review/i);
}

describe('/, /fr and /en', () => {
  it('/ in French by default, canonical /', async () => {
    const res = await home('/');
    expect((res.headers.get('vary') || '').toLowerCase()).toContain('accept-language');
    checkHead(await res.text(), 'fr', '/');
  });
  it('/ in English from Accept-Language, canonical still /', async () => {
    checkHead(await (await home('/', { 'accept-language': 'en-CA' })).text(), 'en', '/');
  });
  it('?lang=fr and ?lang=en on / point their canonical to /fr and /en', async () => {
    checkHead(await (await home('/?lang=en', { 'accept-language': 'fr-CA' })).text(), 'en', '/en');
    checkHead(await (await home('/?lang=fr', { 'accept-language': 'en-CA' })).text(), 'fr', '/fr');
  });
  it('/fr ignores Accept-Language en and the cookie, never redirects, sets the cookie', async () => {
    const res = await home('/fr', { 'accept-language': 'en-CA,en;q=0.9', cookie: 'nl_lang=en' });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^nl_lang=fr;/);
    const html = await res.text();
    checkHead(html, 'fr', '/fr');
    expect(html).toContain("window.__nlServerLang = 'fr';");
    expect(html).toContain('<h1 data-i18n="heroTitle">Tes joueurs répondent sans compte et sans application.</h1>');
  });
  it('/en ignores Accept-Language fr and the cookie, never redirects, sets the cookie', async () => {
    const res = await home('/en', { 'accept-language': 'fr-CA,fr;q=0.9', cookie: 'nl_lang=fr' });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^nl_lang=en;/);
    const html = await res.text();
    checkHead(html, 'en', '/en');
    expect(html).toContain("window.__nlServerLang = 'en';");
  });
  it('the FR/EN toggle links to /fr and /en and still sets the cookie', async () => {
    const html = await (await home('/')).text();
    expect(html).toContain(`<a id="btn-lang-fr" href="/fr" hreflang="fr-CA" lang="fr-CA" aria-current="true" onclick="window.__setLang('fr')">FR</a>`);
    expect(html).toContain(`<a id="btn-lang-en" href="/en" hreflang="en-CA" lang="en-CA" onclick="window.__setLang('en')">EN</a>`);
  });
  it('SMBHL hostnames: / and /fr unchanged', async () => {
    const root = await SELF.fetch('https://rsvp.smbhl.com/', { redirect: 'manual' });
    expect(root.status).toBe(302);
    const fr = await SELF.fetch('https://rsvp.smbhl.com/fr', { redirect: 'manual' });
    expect(fr.status).toBe(404);
  });
});

describe('sitemap.xml and robots.txt', () => {
  it('sitemap.xml lists the five public pages, with the fr/en alternates', async () => {
    const res = await fetchWith(DEMO, ORIGIN + '/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('xml');
    const xml = await res.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    // Well formed: every element closes in order.
    const stack = [];
    for (const m of xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([a-zA-Z:]+)[^>]*?(\/?)>/g)) {
      if (m[3]) continue;
      if (m[1]) expect(stack.pop()).toBe(m[2]); else stack.push(m[2]);
    }
    expect(stack).toEqual([]);
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    expect(locs).toEqual(['/', '/fr', '/en', '/confidentialite', '/conditions'].map(p => ORIGIN + p));
    expect(xml.match(/<xhtml:link rel="alternate" hreflang="fr-CA" href="https:\/\/notreligue\.ca\/fr"\/>/g)).toHaveLength(3);
    expect(xml.match(/hreflang="en-CA" href="https:\/\/notreligue\.ca\/en"/g)).toHaveLength(3);
  });

  it('robots.txt allows the homepage, disallows private routes, names the sitemap', async () => {
    const res = await fetchWith(DEMO, ORIGIN + '/robots.txt');
    expect(res.status).toBe(200);
    const txt = await res.text();
    expect(txt).toContain('Sitemap: https://notreligue.ca/sitemap.xml');
    const disallows = txt.split('\n').filter(l => l.startsWith('Disallow:')).map(l => l.slice(9).trim());
    for (const d of disallows) {
      expect(d).not.toBe('/');
      expect(d).not.toBe('/$');
      for (const pub of ['/', '/fr', '/en', '/confidentialite', '/conditions', '/signup', '/ligue-du-dimanche']) {
        const re = new RegExp('^' + d.replace(/[.?]/g, c => '[' + c + ']').replace(/\$$/, '$'));
        expect(re.test(pub), `${d} blocks ${pub}`).toBe(false);
      }
    }
    for (const p of ['/admin', '/super-admin', '/dashboard', '/league/', '/rsvp?', '/team-rsvp?', '/avail?', '/poll?', '/reset-password?', '/auth/'])
      expect(disallows).toContain(p.endsWith('/') || p.endsWith('?') ? p : p + '$');
  });

  it('the demo on workers.dev still disallows everything and has no sitemap', async () => {
    const txt = await (await fetchWith(DEMO, 'https://smbhl-rsvp-demo.example.workers.dev/robots.txt')).text();
    expect(txt).toBe('User-agent: *\nDisallow: /\n');
    expect((await fetchWith(DEMO, 'https://smbhl-rsvp-demo.example.workers.dev/sitemap.xml')).status).toBe(404);
  });

  it('SMBHL: no robots.txt or sitemap.xml of its own, as before', async () => {
    expect((await SELF.fetch('https://rsvp.smbhl.com/robots.txt')).status).toBe(404);
    expect((await SELF.fetch('https://rsvp.smbhl.com/sitemap.xml')).status).toBe(404);
  });
});

describe('X-Robots-Tag', () => {
  it('demo on notreligue.ca: the public pages are indexable, private routes are not', async () => {
    for (const p of ['/', '/fr', '/en', '/?lang=en', '/confidentialite', '/conditions'])
      expect((await fetchWith(DEMO, ORIGIN + p)).headers.get('x-robots-tag'), p).toBeNull();
    for (const p of ['/admin', '/dashboard', '/league/rsvp?token=x', '/rsvp?t=x', '/avail', '/poll', '/super-admin', '/reset-password?token=x'])
      expect((await fetchWith(DEMO, ORIGIN + p)).headers.get('x-robots-tag'), p).toMatch(/noindex/);
    expect((await fetchWith(DEMO, 'https://rsvp.notreligue.ca/fr')).headers.get('x-robots-tag')).toBeNull();
  });
  it('demo on workers.dev: everything noindex, nofollow, as before', async () => {
    expect((await fetchWith(DEMO, 'https://smbhl-rsvp-demo.example.workers.dev/')).headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
  it('Notre Ligue outside the demo: private routes noindex, the homepage not', async () => {
    expect((await fetchWith(PRODUCT, ORIGIN + '/league/rsvp?token=x')).headers.get('x-robots-tag')).toBe('noindex');
    expect((await fetchWith(PRODUCT, ORIGIN + '/')).headers.get('x-robots-tag')).toBeNull();
  });
  it('SMBHL: no X-Robots-Tag added', async () => {
    expect((await SELF.fetch('https://rsvp.smbhl.com/admin/contacts')).headers.get('x-robots-tag')).toBeNull();
  });
});

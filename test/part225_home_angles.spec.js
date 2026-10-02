// Ad test, item 1 (2026-10-02): ?a=comptes|remplacants|prix on /fr, /en and
// / swaps only the hero's headline and subhead. Title, description,
// canonical, hreflang and JSON-LD stay those of the plain page; a page with
// ?a= or a utm_ parameter is kept out of the index (noindex, follow).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const get = async (path, headers = {}) => {
  const res = await SELF.fetch('https://notreligue.ca' + path, { headers, redirect: 'manual' });
  return { res, html: await res.text() };
};
const h1 = html => (html.match(/<h1 data-i18n="heroTitle">([^<]*)<\/h1>/) || [])[1];
const sub = html => (html.match(/<p data-i18n="heroBody">([^<]*)<\/p>/) || [])[1];
const head = html => ({
  title: (html.match(/<title>([^<]*)<\/title>/) || [])[1],
  description: (html.match(/<meta name="description" content="([^"]*)"/) || [])[1],
  canonical: (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1],
  hreflang: [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)].map(m => m[1] + ' ' + m[2]),
  ld: (html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1]
});
const unescape = s => s.replace(/&#39;/g, "'").replace(/&amp;/g, '&');

beforeAll(async () => { await applyRealSchema(env); });

const EXPECTED = {
  fr: {
    comptes: ['Tes joueurs répondent sans compte et sans application.', 'Chaque semaine, Notre Ligue demande qui joue, compte les réponses et trouve des remplaçants quand il manque du monde. Toi, tu joues.'],
    remplacants: ['Il manque du monde? Tes remplaçants sont invités automatiquement.', "Notre Ligue invite ta liste de remplaçants à un rythme raisonnable, avec une liste d'attente. Toi, tu joues."],
    prix: ['Gratuit sous 15 joueurs. Ensuite, un prix fixe par mois.', 'Pas de crédits à acheter, et rien ne bloque ton calendrier. 2 mois gratuits, sans carte.']
  },
  en: {
    comptes: ['Your players answer without an account or an app.', "Every week, Notre Ligue asks who's playing, counts the answers and finds subs when you're short. You just play."],
    remplacants: ['Short on players? Your subs are invited automatically.', 'Notre Ligue invites your sub list at a steady pace, with a waitlist. You just play.'],
    prix: ['Free under 15 players. Then one flat monthly price.', 'No credits to buy, and nothing blocks your schedule. 2 months free, no card.']
  }
};

describe('the hero for each angle, in both languages', () => {
  for (const lang of ['fr', 'en']) for (const a of ['comptes', 'remplacants', 'prix']) {
    it(`/${lang}?a=${a}`, async () => {
      const { res, html } = await get(`/${lang}?a=${a}`);
      expect(res.status).toBe(200);
      expect(unescape(h1(html))).toBe(EXPECTED[lang][a][0]);
      expect(unescape(sub(html))).toBe(EXPECTED[lang][a][1]);
      // The toggle's other language keeps the angle too.
      const other = lang === 'fr' ? 'en' : 'fr';
      expect(html).toContain(`"heroTitle":${JSON.stringify(EXPECTED[other][a][0])}`);
    });
  }

  it('a missing or unknown a: the plain hero', async () => {
    for (const path of ['/fr', '/fr?a=autre', '/fr?a=', '/fr?a=__proto__']) {
      const { html } = await get(path);
      expect(unescape(h1(html)), path).toBe(EXPECTED.fr.comptes[0]);
      expect(unescape(sub(html)), path).toBe(EXPECTED.fr.comptes[1]);
    }
  });

  it('on /, once the language resolves', async () => {
    const { html } = await get('/?a=prix', { 'accept-language': 'en-CA' });
    expect(unescape(h1(html))).toBe(EXPECTED.en.prix[0]);
    const fr = await get('/?a=remplacants');
    expect(unescape(h1(fr.html))).toBe(EXPECTED.fr.remplacants[0]);
  });

  it('everything else on the page is the same', async () => {
    const plain = (await get('/fr')).html;
    const variant = (await get('/fr?a=prix')).html;
    // The sign-up links carry the a parameter (ad test item 2): set aside.
    const cut = s => s.replace(/<h1 data-i18n="heroTitle">[^<]*<\/h1>/, '').replace(/<p data-i18n="heroBody">[^<]*<\/p>/, '').replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<meta name="robots"[^>]*>\n?/, '').replace(/href="\/signup[^"]*"/g, 'href="/signup"');
    expect(cut(variant)).toBe(cut(plain));
  });
});

describe('SEO stays that of the plain page', () => {
  it('title, description, canonical, hreflang and JSON-LD unchanged; canonical has no parameter', async () => {
    for (const lang of ['fr', 'en']) {
      const plain = head((await get(`/${lang}`)).html);
      for (const q of ['?a=remplacants', '?a=prix&utm_source=facebook&utm_content=prix-fr', '?utm_campaign=test1', '?lang=en&a=prix']) {
        const v = head((await get(`/${lang}${q}`)).html);
        expect(v, `${lang}${q}`).toEqual(plain);
        expect(v.canonical).toBe(`https://notreligue.ca/${lang}`);
      }
    }
  });

  it('noindex, follow only when a or a utm_ parameter is present', async () => {
    const robots = html => (html.match(/<meta name="robots" content="([^"]*)"/) || [])[1] || null;
    expect(robots((await get('/fr')).html)).toBeNull();
    expect(robots((await get('/fr?lang=fr')).html)).toBeNull();
    expect(robots((await get('/')).html)).toBeNull();
    expect(robots((await get('/fr?a=prix')).html)).toBe('noindex, follow');
    expect(robots((await get('/en?a=autre')).html)).toBe('noindex, follow');
    expect(robots((await get('/en?utm_source=facebook')).html)).toBe('noindex, follow');
    expect(robots((await get('/?utm_medium=paid')).html)).toBe('noindex, follow');
  });

  it('never cached: a plain page is never served for ?a= and the reverse', async () => {
    for (const path of ['/', '/fr', '/fr?a=prix']) expect((await get(path)).res.headers.get('cache-control')).toBe('no-store');
  });

  it('the sitemap is unchanged', async () => {
    const sm = await (await SELF.fetch('https://notreligue.ca/sitemap.xml')).text();
    expect(sm).not.toContain('a=');
    expect(sm).not.toContain('utm_');
  });
});

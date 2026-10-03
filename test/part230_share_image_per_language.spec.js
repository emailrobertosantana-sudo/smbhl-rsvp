// Homepage polish, item 1: a share image per language. /en and an English
// browser on / name the English image; /fr and a French browser the French
// one. Each image has its own absolute URL (Facebook caches previews by
// image URL), its own alt text, and is served as a 1200 by 630 PNG with a
// long cache. ?a= and utm_ variants carry the same image as the plain page.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { SHARE_IMAGES } from '../src/share_image.js';

beforeAll(async () => { await applyRealSchema(env); env.LEAGUE_PRODUCT = 'true'; });
afterAll(() => { delete env.LEAGUE_PRODUCT; });

const ALT = {
  fr: 'Notre Ligue : tes joueurs répondent sans compte et sans application.',
  en: 'Notre Ligue: your players answer without an account or an app.'
};
const tag = (html, attr, name) => { const m = html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)">`)); return m ? m[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&') : null; };
const page = async (path, headers = {}) => (await SELF.fetch('https://notreligue.ca' + path, { headers, redirect: 'manual' })).text();
const tags = html => ({
  image: tag(html, 'property', 'og:image'),
  width: tag(html, 'property', 'og:image:width'),
  height: tag(html, 'property', 'og:image:height'),
  type: tag(html, 'property', 'og:image:type'),
  alt: tag(html, 'property', 'og:image:alt'),
  card: tag(html, 'name', 'twitter:card'),
  twImage: tag(html, 'name', 'twitter:image'),
  twAlt: tag(html, 'name', 'twitter:image:alt')
});

describe('a share image per language', () => {
  const cases = [
    ['/fr', {}, 'fr'],
    ['/en', {}, 'en'],
    ['/', { 'accept-language': 'en-CA,en;q=0.9' }, 'en'],
    ['/', { 'accept-language': 'fr-CA,fr;q=0.9' }, 'fr']
  ];
  for (const [path, headers, lang] of cases) {
    it(`${path} (${headers['accept-language'] || 'no header'}): the ${lang} image, absolute, with its alt`, async () => {
      const t = tags(await page(path, headers));
      expect(t.image).toBe('https://notreligue.ca' + SHARE_IMAGES[lang].path);
      expect(t).toMatchObject({ width: '1200', height: '630', type: 'image/png', alt: ALT[lang], card: 'summary_large_image', twImage: t.image, twAlt: ALT[lang] });
      const img = await SELF.fetch(t.image);
      expect(img.status).toBe(200);
      expect(img.headers.get('content-type')).toBe('image/png');
      expect(img.headers.get('cache-control')).toMatch(/max-age=(\d{7,})/);
      const b = new DataView(await img.arrayBuffer());
      expect([b.getUint32(16), b.getUint32(20)]).toEqual([1200, 630]);
    });
  }

  it('the two languages never share one URL', async () => {
    const fr = tags(await page('/fr')).image;
    const en = tags(await page('/en')).image;
    expect(fr).not.toBe(en);
    expect(SHARE_IMAGES.fr.base64).not.toBe(SHARE_IMAGES.en.base64);
  });

  it('?a= and utm_ variants carry the same image as the plain page', async () => {
    for (const lang of ['fr', 'en']) {
      const plain = tags(await page(`/${lang}`));
      for (const q of ['?a=prix', '?a=comptes&utm_source=facebook&utm_medium=paid&utm_campaign=test1&utm_content=comptes-' + lang, '?utm_source=x']) {
        expect(tags(await page(`/${lang}${q}`)), lang + q).toEqual(plain);
      }
    }
  });
});

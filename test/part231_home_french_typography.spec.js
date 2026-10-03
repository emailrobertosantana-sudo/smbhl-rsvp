// Homepage polish, item 2: Quebec typography on the French homepage, so it
// cannot regress. Checked on the rendered /fr (and its ?a= variants): the
// visible text, and the title, description, og and twitter text tags, the
// image alt texts, and the JSON-LD name and description fields.
//   - no space or non-breaking space before ? or !
//   - a space before a colon in running text (not in URLs or times)
//   - no em dash
//   - « remplaçant », never « substitut »; « joueur », never "skater"
//   - no gendered forms with a middle dot (« inscrit·e »)
//   - « guillemets » with a non-breaking space inside
//   - "tu", never « vous » or « votre » (reported by this test, never
//     rewritten automatically)
// /en is only checked for em dashes and the word "skater".
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

beforeAll(async () => { await applyRealSchema(env); env.LEAGUE_PRODUCT = 'true'; });
afterAll(() => { delete env.LEAGUE_PRODUCT; });

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', laquo: '«', raquo: '»' };
const decode = s => s.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (m, e) => {
  if (ENTITIES[e] !== undefined) return ENTITIES[e];
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return m;
});
// The French text a reader sees or a sharer gets: visible text nodes, then
// the head's text tags and the JSON-LD name and description fields.
function frenchTexts(html) {
  const out = [];
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<head[\s\S]*?<\/head>/i, ' ');
  for (const part of body.split(/<[^>]+>/)) { const t = decode(part).replace(/[ \t\r\n]+/g, ' ').trim(); if (t) out.push(['text', t]); }
  for (const m of html.matchAll(/<(?:img|svg|button|a|input)[^>]*\b(?:alt|aria-label|title|placeholder)="([^"]+)"/gi)) out.push(['attribute', decode(m[1])]);
  const t = html.match(/<title>([^<]*)<\/title>/);
  if (t) out.push(['title', decode(t[1])]);
  for (const m of html.matchAll(/<meta (?:name|property)="(description|og:title|og:description|twitter:title|twitter:description|og:image:alt|twitter:image:alt)" content="([^"]*)">/g)) out.push([m[1], decode(m[2])]);
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if ((k === 'name' || k === 'description') && typeof x === 'string') out.push(['json-ld ' + k, x]); else walk(x); } };
    walk(JSON.parse(m[1]));
  }
  return out;
}
const NB = '[\\u00a0\\u202f]';
const CHECKS = [
  ['space before ? or !', /[   ][?!]/],
  // A colon right after a letter or a closing mark: not in URLs (https:, mailto:) or times.
  ['no space before a colon', /(?<!\bhttps?|\bmailto)[A-Za-zÀ-ÿ»)\]]:(?!\/\/)/],
  ['em dash', /\u2014/],
  ['« substitut »', /\bsubstituts?\b/i],
  ['"skater"', /\bskaters?\b/i],
  ['gendered middle dot', /[a-zà-ÿ]·[a-zà-ÿ]/i],
  ['« without a non-breaking space', new RegExp('«(?!' + NB + ')')],
  ['» without a non-breaking space', new RegExp('(?<!' + NB + ')»')]
];
const VOUS = /\b(vous|votre|vos)\b/i;
export function frenchHits(html) {
  const hits = [];
  for (const [where, s] of frenchTexts(html)) {
    for (const [name, re] of CHECKS) if (re.test(s)) hits.push(`${name} (${where}): ${s}`);
    if (VOUS.test(s)) hits.push(`« vous » register (${where}): ${s}`);
  }
  return hits;
}
const page = async path => (await SELF.fetch('https://notreligue.ca' + path, { redirect: 'manual' })).text();

describe('French homepage typography', () => {
  for (const path of ['/fr', '/fr?a=comptes', '/fr?a=remplacants', '/fr?a=prix']) {
    it(`${path}: no typography problem`, async () => {
      expect(frenchHits(await page(path))).toEqual([]);
    });
  }

  it('the scan reads the page: its H1, its head tags and its JSON-LD', async () => {
    const texts = frenchTexts(await page('/fr'));
    const where = new Set(texts.map(([w]) => w));
    expect(texts.length).toBeGreaterThan(60);
    expect(texts.map(([, t]) => t)).toContain('Tes joueurs répondent sans compte et sans application.');
    for (const w of ['title', 'description', 'og:title', 'og:description', 'twitter:title', 'twitter:description', 'og:image:alt', 'twitter:image:alt', 'json-ld name', 'json-ld description']) expect(where.has(w), w).toBe(true);
  });

  it('/en: no em dash and no "skater"', async () => {
    const html = await page('/en');
    const text = html.replace(/<script(?! type="application\/ld\+json")[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    expect(text).not.toMatch(/\u2014/);
    expect(text.replace(/<[^>]+>/g, ' ')).not.toMatch(/\bskaters?\b/i);
  });

  it('the checks catch what they are meant to', () => {
    const bad = '<html><head><title>Notre Ligue: test</title></head><body><p>Prêt ?</p><p>Les substituts \u2014 inscrit·e « ici »</p></body></html>';
    const hits = frenchHits(bad);
    for (const name of ['space before ? or !', 'no space before a colon', 'em dash', '« substitut »', 'gendered middle dot', '« without a non-breaking space', '» without a non-breaking space']) {
      expect(hits.some(h => h.startsWith(name)), name).toBe(true);
    }
  });
});

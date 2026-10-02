// Ad test, item 2 (2026-10-02): the homepage's sign-up links carry a and four
// utm_ keys (cleaned) and the page's language; sign-up carries them from step
// to step in the URL and sends them with the new league, which stores them
// (migrate-057.sql). No cookie, no storage: no parameters, no attribution.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { cleanAttributionValue, attributionFrom, attributionQuery } from '../src/attribution.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.226.${++ip}` },
    body: JSON.stringify({ accept_terms: true, email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = (s, path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const home = async path => (await SELF.fetch('https://notreligue.ca' + path)).text();
const signupHrefs = html => [...html.matchAll(/href="(\/signup[^"]*)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
const COLS = 'angle, utm_source, utm_medium, utm_campaign, utm_content, landing_language, attributed_at';

beforeAll(async () => { env.AUTH_SECRET = 'p226-auth'; env.LEAGUE_PRODUCT = 'true'; await applyRealSchema(env); });

describe('cleaning', () => {
  it('letters, digits, hyphen, underscore and dot only; at most 64 characters', () => {
    expect(cleanAttributionValue('prix-fr')).toBe('prix-fr');
    expect(cleanAttributionValue('test 1 <b>bold</b>')).toBe('test1bboldb');
    expect(cleanAttributionValue('a.b_c-d')).toBe('a.b_c-d');
    expect(cleanAttributionValue('x'.repeat(80))).toHaveLength(64);
    expect(cleanAttributionValue('é"\'<>&')).toBe('');
  });
  it('only the five keys, an empty value dropped, lang_landing fr or en', () => {
    const p = new URLSearchParams('a=prix&utm_source=facebook&utm_term=x&evil=1&utm_medium=&lang_landing=de');
    expect(attributionFrom(p)).toEqual({ a: 'prix', utm_source: 'facebook' });
    expect(attributionQuery(new URLSearchParams('evil=1'), 'fr')).toBe('');
  });
});

describe('the homepage sign-up links', () => {
  it('carry the allowed keys and the language, drop the others', async () => {
    const html = await home('/fr?a=prix&utm_source=facebook&utm_medium=paid&utm_campaign=test1&utm_content=prix-fr&utm_term=x&fbclid=abc&evil=1');
    const hrefs = signupHrefs(html);
    expect(hrefs).toHaveLength(5); // the hero, three tiers, the closing call to action
    for (const h of hrefs) expect(h).toBe('/signup?a=prix&utm_source=facebook&utm_medium=paid&utm_campaign=test1&utm_content=prix-fr&lang_landing=fr');
    const en = signupHrefs(await home('/en?utm_content=comptes-en'));
    expect(en.every(h => h === '/signup?utm_content=comptes-en&lang_landing=en')).toBe(true);
  });

  it('values with spaces, angle brackets or over 64 characters are cleaned', async () => {
    const long = 'c'.repeat(70);
    const html = await home(`/fr?utm_campaign=${encodeURIComponent('test 1<script>')}&utm_content=${long}`);
    const h = signupHrefs(html)[0];
    expect(h).toBe(`/signup?utm_campaign=test1script&utm_content=${'c'.repeat(64)}&lang_landing=fr`);
    expect(html).not.toContain('<script>"');
  });

  it('a page with none of the keys keeps its plain /signup links', async () => {
    expect(signupHrefs(await home('/fr')).every(h => h === '/signup')).toBe(true);
    expect(signupHrefs(await home('/en?lang=en&foo=bar')).every(h => h === '/signup')).toBe(true);
  });
});

describe('sign-up carries them, and the league stores them', () => {
  it('step 1 to step 2 to step 3 keep them in the URL; steps 2 and 3 send them', async () => {
    const step1 = await (await SELF.fetch('http://example.com/signup?a=prix&utm_source=facebook&lang_landing=fr')).text();
    expect(step1).toContain("window.__navWithLang('/signup?step=2&a=prix&utm_source=facebook&lang_landing=fr')");
    const s = await signup('p226.steps@example.com');
    const step2 = await (await SELF.fetch('http://example.com/signup?step=2&a=prix&utm_source=facebook&lang_landing=fr', { headers: { cookie: s.cookie } })).text();
    expect(step2).toContain('var NL_ATTR = {"a":"prix","utm_source":"facebook","lang_landing":"fr"};');
    expect(step2).toContain("&a=prix&utm_source=facebook&lang_landing=fr');");
    const step3 = await (await SELF.fetch('http://example.com/signup?step=3&a=prix&utm_source=facebook&lang_landing=fr', { headers: { cookie: s.cookie } })).text();
    expect(step3).toContain('attribution: {"a":"prix","utm_source":"facebook","lang_landing":"fr"} };');
  });

  it('a league created with parameters stores them', async () => {
    const s = await signup('p226.with@example.com');
    const id = (await (await post(s, '/leagues/create', { name: 'P226 With', teamNames: ['A', 'B'], attribution: { a: 'remplacants', utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'test1', utm_content: 'remplacants-fr', lang_landing: 'fr', utm_term: 'dropped' } })).json()).league.id;
    const row = await env.DB.prepare(`SELECT ${COLS} FROM leagues WHERE id = ?`).bind(id).first();
    expect(row).toMatchObject({ angle: 'remplacants', utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'test1', utm_content: 'remplacants-fr', landing_language: 'fr' });
    expect(Date.parse(row.attributed_at)).toBeGreaterThan(Date.now() - 60000);
  });

  it('values are cleaned again on the server', async () => {
    const s = await signup('p226.dirty@example.com');
    const id = (await (await post(s, '/leagues/create', { name: 'P226 Dirty', teamNames: ['A', 'B'], attribution: { utm_campaign: 'a b<c>' + 'x'.repeat(80), lang_landing: 'xx' } })).json()).league.id;
    const row = await env.DB.prepare(`SELECT ${COLS} FROM leagues WHERE id = ?`).bind(id).first();
    expect(row.utm_campaign).toBe(('abc' + 'x'.repeat(80)).slice(0, 64));
    expect(row.landing_language).toBeNull();
  });

  it('a league created without them stores nulls', async () => {
    const s = await signup('p226.without@example.com');
    const id = (await (await post(s, '/leagues/create', { name: 'P226 Without', teamNames: ['A', 'B'] })).json()).league.id;
    const row = await env.DB.prepare(`SELECT ${COLS} FROM leagues WHERE id = ?`).bind(id).first();
    expect(Object.values(row).every(v => v === null)).toBe(true);
    const s2 = await signup('p226.empty@example.com');
    const id2 = (await (await post(s2, '/leagues/create', { name: 'P226 Empty', teamNames: ['A', 'B'], attribution: { lang_landing: 'fr', utm_term: 'x' } })).json()).league.id;
    expect(Object.values(await env.DB.prepare(`SELECT ${COLS} FROM leagues WHERE id = ?`).bind(id2).first()).every(v => v === null)).toBe(true);
  });
});

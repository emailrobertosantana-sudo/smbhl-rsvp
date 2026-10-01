// Notre Ligue's legal pages (src/legal.js): /confidentialite and
// /conditions, French then English, the review note left out, "last
// updated" at the top; /privacy and /terms redirect to them; none of it
// on SMBHL's host. The links in Notre Ligue page and email footers. A
// permanent league deletion also erases the league's payment details and
// dual-role notes (the policy says deletion erases the league).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must } from './support/league_season.js';
import { legalLinksEmailHtml, nlLegalEmailWrap, legalMarkdownToHtml, legalDate } from '../src/legal.js';
import { LEGAL_TEXT } from '../src/legal_text.js';
import { performLeagueHardDelete } from '../src/hard_delete.js';

const get = (path, opts = {}) => SELF.fetch('http://example.com' + path, { redirect: 'manual', ...opts });

beforeAll(async () => {
  env.AUTH_SECRET = 'p201-auth'; env.RSVP_SECRET = 'p201-rsvp';
  await applyRealSchema(env);
});
afterAll(() => { delete env.LEAGUE_PRODUCT; });

describe('the pages, on the Notre Ligue host', () => {
  beforeAll(() => { env.LEAGUE_PRODUCT = 'true'; });

  for (const [path, fr, en, line] of [
    ['/confidentialite', 'Notre Ligue : Politique de confidentialité', 'Notre Ligue: Privacy Policy', 'Nous ne vendons aucun renseignement et ne les utilisons pas pour de la publicité.'],
    ['/conditions', "Notre Ligue : Conditions d'utilisation", 'Notre Ligue: Terms of Service', 'Tu peux annuler en tout temps.']
  ]) {
    it(`${path}: French, then English, the date, no review note`, async () => {
      const res = await get(path);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<html lang="fr-CA">');
      expect(html).toContain(`<h1>${fr.replace("'", '&#39;')}</h1>`);
      expect(html).toContain('Dernière mise à jour : 1er octobre 2026');
      expect(html).toContain('<a href="#en" lang="en-CA">English version</a>');
      expect(html).toContain(`<section id="en" lang="en-CA">`);
      expect(html).toContain(`<h2>${en}</h2>`);
      expect(html).toContain('Last updated: October 1, 2026');
      expect(html.indexOf('Last updated')).toBeGreaterThan(html.indexOf('Dernière mise à jour'));
      expect(html).toContain(line.replace("'", '&#39;'));
      for (const note of ['Statut / Status', 'Ébauche', 'Draft, not yet in force', '@Roberto', 'avocat']) expect(html).not.toContain(note);
      expect(html).toContain('<a href="mailto:bonjour@notreligue.ca">bonjour@notreligue.ca</a>');
    });
  }

  it('/privacy and /terms redirect, permanently', async () => {
    for (const [from, to] of [['/privacy', '/confidentialite'], ['/terms', '/conditions']]) {
      const res = await get(from);
      expect(res.status).toBe(301);
      expect(new URL(res.headers.get('location')).pathname).toBe(to);
    }
  });

  it('the review note is not in the published text at all', () => {
    for (const kind of ['privacy', 'terms']) {
      const all = JSON.stringify(LEGAL_TEXT[kind]);
      expect(all).not.toContain('Statut');
      expect(all).not.toContain('lawyer');
    }
  });

  it('the markdown: headings, lists, tables, bold, escaped text', () => {
    const html = legalMarkdownToHtml('### 1. Titre\n\n- **Un :** <b>deux</b>\n- trois\n\n| A | B |\n| --- | --- |\n| x | y |\n\nÉcris à bonjour@notreligue.ca.');
    expect(html).toContain('<h3>1. Titre</h3>');
    expect(html).toContain('<li><strong>Un :</strong> &lt;b&gt;deux&lt;/b&gt;</li><li>trois</li>');
    expect(html).toContain('<th scope="col">A</th>');
    expect(html).toContain('<td>y</td>');
    expect(html).toContain('<a href="mailto:bonjour@notreligue.ca">bonjour@notreligue.ca</a>');
    expect(legalDate('2026-10-01', 'fr')).toBe('1er octobre 2026');
    expect(legalDate('2026-10-15', 'fr')).toBe('15 octobre 2026');
    expect(legalDate('2026-10-01', 'en')).toBe('October 1, 2026');
  });
});

describe("not on SMBHL's host", () => {
  it('no legal page and no redirect', async () => {
    delete env.LEAGUE_PRODUCT;
    for (const path of ['/confidentialite', '/conditions', '/privacy', '/terms']) {
      const res = await get(path);
      expect(res.status, path).not.toBe(200);
      expect(res.status, path).not.toBe(301);
      expect(await res.text(), path).not.toContain('Politique de confidentialité');
    }
  });
});

describe('the links', () => {
  it('in a Notre Ligue email footer, in its language', () => {
    expect(legalLinksEmailHtml('fr')).toContain('>Confidentialité</a> · ');
    expect(legalLinksEmailHtml('fr')).toContain('href="https://notreligue.ca/conditions"');
    expect(legalLinksEmailHtml('en')).toContain('href="https://notreligue.ca/confidentialite#en"');
    expect(legalLinksEmailHtml('en')).toContain('>Terms</a>');
    expect(legalLinksEmailHtml('both')).toContain('Confidentialité / Privacy');
    const html = nlLegalEmailWrap({ languageMode: 'fr', brandName: 'Ligue', bodyHtml: '<p>x</p>', footerHtml: 'Envoyé par Notre Ligue' });
    expect(html).toContain('Envoyé par Notre Ligue<br><a href="https://notreligue.ca/confidentialite"');
  });

  it('on the sign-up page and a public league page', async () => {
    env.LEAGUE_PRODUCT = 'true';
    const signup = await (await get('/signup')).text();
    expect(signup).toContain('<a href="/confidentialite" data-i18n="legalPrivacy">Confidentialité</a>');
    expect(signup).toContain('<a href="/conditions" data-i18n="legalTerms">Conditions</a>');
    const a = await admin('p201.links');
    const league = (await must(a.post('/leagues/create', { name: 'Ligue Légale', teamNames: ['A', 'B'] }), 'league')).league;
    const slug = (await env.DB.prepare('SELECT slug FROM leagues WHERE id = ?').bind(league.id).first()).slug;
    const pub = await (await get('/' + slug)).text();
    expect(pub).toContain('<a class="pb-foot" href="/confidentialite" data-i18n="legalPrivacy">Confidentialité</a>');
    expect(pub).toContain('legalTerms');
    const home = await (await get('/')).text();
    expect(home).toContain('<a href="/confidentialite">Confidentialité</a> · <a href="/conditions">Conditions</a>');
  });
});

describe('a permanent deletion erases the league\'s settings', () => {
  it('payment details and dual-role notes included', async () => {
    env.LEAGUE_PRODUCT = 'true';
    const a = await admin('p201.delete');
    const league = (await must(a.post('/leagues/create', { name: 'Ligue Effacée', teamNames: ['A', 'B'] }), 'league')).league;
    const ev = `${league.id}:2099-05-05`;
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'S1', 1, '2099-05-05', 'Gym', 'open', '19:00', ?)`).bind(ev, league.id).run();
    for (const key of [`payment_info:${league.id}`, `dual_goalie_alert:${ev}`, `dual_role:${ev}:${league.id}:P1`]) {
      await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(key, '{}').run();
    }
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind('dual_role:other:P1', '{}').run();
    await performLeagueHardDelete(env, league.id, 'Ligue Effacée', 'test', 'test');
    const left = ((await env.DB.prepare("SELECT key FROM settings WHERE key LIKE 'payment_info:%' OR key LIKE 'dual_%'").all()).results || []).map(r => r.key);
    expect(left).toEqual(['dual_role:other:P1']);
  });
});

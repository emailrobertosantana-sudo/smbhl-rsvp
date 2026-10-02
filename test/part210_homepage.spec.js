// Homepage review batch: the marketing homepage (notreligue.ca).
//   Item 1: the hero, how it works, the nav, and the language default
//   (?lang, then the remembered choice, then Accept-Language, then French),
//   with <html lang> and Vary so caches never mix the two languages.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

beforeAll(async () => { await applyRealSchema(env); });

const home = (path = '/', headers = {}) => SELF.fetch(`http://notreligue.ca${path}`, { headers });
const langOf = html => (/<html lang="([^"]+)"/.exec(html) || [])[1];

describe('item 1: the language default', () => {
  const cases = [
    ['no header', '/', {}, 'fr'],
    ['Accept-Language en-CA', '/', { 'accept-language': 'en-CA,en;q=0.9' }, 'en'],
    ['Accept-Language fr-CA', '/', { 'accept-language': 'fr-CA,fr;q=0.9,en;q=0.5' }, 'fr'],
    ['?lang=en over a French browser', '/?lang=en', { 'accept-language': 'fr-CA' }, 'en'],
    ['the remembered choice over the browser', '/', { cookie: 'nl_lang=en', 'accept-language': 'fr-CA' }, 'en'],
    ['?lang=fr over the remembered choice', '/?lang=fr', { cookie: 'nl_lang=en', 'accept-language': 'en-CA' }, 'fr']
  ];
  for (const [name, path, headers, want] of cases) {
    it(name, async () => {
      const res = await home(path, headers);
      expect(res.status).toBe(200);
      const vary = (res.headers.get('vary') || '').toLowerCase();
      expect(vary).toContain('accept-language');
      expect(vary).toContain('cookie');
      const html = await res.text();
      expect(langOf(html)).toBe(want === 'en' ? 'en-CA' : 'fr-CA');
      expect(html).toContain(`window.__nlServerLang = '${want}';`);
      if (want === 'en') expect(html).toContain('<h1 data-i18n="heroTitle">Your league, without the <u>paperwork</u>.</h1>');
      else expect(html).toContain('<h1 data-i18n="heroTitle">Ta ligue, sans la <u>paperasse</u>.</h1>');
    });
  }

  it('the toggle still switches in place and remembers the choice', async () => {
    const html = await (await home('/')).text();
    expect(html).toContain("onclick=\"window.__setLang('en')\"");
    expect(html).toContain("document.cookie = 'nl_lang=' + l");
  });
});

describe('item 1: the copy', () => {
  it('French', async () => {
    const html = await (await home('/', { 'accept-language': 'fr-CA' })).text();
    for (const s of [
      '<a href="#fonctionnalites" data-i18n="navFeatures">Fonctionnalités</a>',
      '<a href="#comment-ca-marche" data-i18n="navHow">Comment ça marche</a>',
      '<a href="#pricing" data-i18n="navPricing">Tarifs</a>',
      'Notre Ligue invite tes joueurs, compte qui sera là et trouve des remplaçants quand il manque du monde. Toi, tu joues.',
      'href="/signup" data-i18n="cta">Créer ma ligue</a>',
      'Prêt en 5 minutes. 2 mois gratuits, sans carte. Gratuit sous 15 joueurs.',
      'Ligues bêta : ton essai de 2 mois commence le jour du lancement de la facturation.',
      'Créer ta ligue', "Le nom, ta formule de jeu, l'adresse de ta page. Cinq minutes.",
      'Ajouter tes joueurs', 'Un nom et un courriel. Importe une liste si tu en as une.',
      "On s'occupe du reste", 'Invitations, rappels, remplaçants. Tu reçois une alerte seulement si quelque chose coince.'
    ]) expect(html).toContain(s);
    expect(html).not.toContain('En français et en anglais');
  });

  it('English', async () => {
    const html = await (await home('/?lang=en')).text();
    for (const s of [
      '>Features</a>', '>How it works</a>', '<a href="#pricing" data-i18n="navPricing">Pricing</a>', '>Log in</a>',
      "Notre Ligue messages your players, counts who's in and finds subs when you're short. You just play.",
      '>Create my league</a>',
      'Ready in 5 minutes. 2 months free, no card. Free under 15 players.',
      'Beta leagues: your 2-month trial starts the day billing launches.',
      'Create your league', 'Name, how it runs, your page address. Five minutes.',
      'Add your players', 'A name and an email. Import a list if you have one.',
      'We handle the rest', "Invites, reminders, subs. You get an alert only if something's stuck."
    ]) expect(html).toContain(s);
    expect(html).not.toContain('In French and English');
  });
});

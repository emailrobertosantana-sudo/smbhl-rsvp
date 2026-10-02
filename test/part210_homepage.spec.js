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
      if (want === 'en') expect(html).toContain('<h1 data-i18n="heroTitle">Your players answer without an account or an app.</h1>');
      else expect(html).toContain('<h1 data-i18n="heroTitle">Tes joueurs répondent sans compte et sans application.</h1>');
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
      '<a href="#features" data-i18n="navFeatures">Fonctionnalités</a>',
      '<a href="#how-it-works" data-i18n="navHow">Comment ça marche</a>',
      '<a href="#pricing" data-i18n="navPricing">Tarifs</a>',
      'Chaque semaine, Notre Ligue demande qui joue, compte les réponses et trouve des remplaçants quand il manque du monde. Toi, tu joues.',
      'href="/signup" data-i18n="cta">Créer ma ligue</a>',
      'Prêt en 5 minutes. 2 mois gratuits, sans carte. Gratuit sous 15 joueurs.',
      'Créer ta ligue', "Le nom, ta formule de jeu, l'adresse de ta page. Cinq minutes.",
      'Ajouter tes joueurs', 'Un nom et un courriel. Importe une liste si tu en as une.',
      "On s'occupe du reste", 'Invitations, rappels, remplaçants. Tu reçois une alerte seulement si quelque chose coince.'
    ]) expect(html).toContain(s);
    expect(html).not.toContain('En français et en anglais');
    // Billing launched on 2026-10-02: no beta wording anywhere on the page.
    expect(html).not.toMatch(/b[eê]ta|lancement de la facturation/i);
  });

  it('English', async () => {
    const html = await (await home('/?lang=en')).text();
    for (const s of [
      '>Features</a>', '>How it works</a>', '<a href="#pricing" data-i18n="navPricing">Pricing</a>', '>Log in</a>',
      "Every week, Notre Ligue asks who's playing, counts the answers and finds subs when you're short. You just play.",
      '>Create my league</a>',
      'Ready in 5 minutes. 2 months free, no card. Free under 15 players.',
      'Create your league', 'Name, how it runs, your page address. Five minutes.',
      'Add your players', 'A name and an email. Import a list if you have one.',
      'We handle the rest', "Invites, reminders, subs. You get an alert only if something's stuck."
    ]) expect(html).toContain(s);
    expect(html).not.toContain('In French and English');
    expect(html).not.toMatch(/\bbeta\b|billing launches/i);
  });
});

describe('item 2: six feature cards', () => {
  it('French and English cards, one icon style, no warning triangle', async () => {
    const fr = await (await home('/', { 'accept-language': 'fr-CA' })).text();
    for (const s of [
      "Ce qu'on prend en charge", "Le travail ennuyeux d'une ligue, fait automatiquement.",
      'Présence en un clic', "Chaque semaine, tes joueurs reçoivent un message et répondent oui ou non d'un clic.",
      'Remplaçants automatiques', "Il manque du monde? On invite ta liste de remplaçants à un rythme raisonnable, avec une liste d'attente.",
      'Ta formule, ton choix', 'Équipes fixes, tirage de la semaine ou sans équipes. Un joueur peut aussi être gardien.',
      'Calendrier et séries', 'Matchs, séries éliminatoires et rappels automatiques, sans rien relancer à la main.',
      'Paiements et finances', 'Rappels de paiement avec tes coordonnées Interac, et le suivi des finances de ta ligue.',
      'Une page pour ta ligue', 'Calendrier, équipes, résultats et statistiques sur une page publique à partager dans le groupe.'
    ]) expect(fr).toContain(s);
    expect(fr.match(/class="home-feat"/g)).toHaveLength(6);
    const feats = fr.slice(fr.indexOf('id="features"'), fr.indexOf('id="how-it-works"'));
    expect(feats).not.toContain('M10 3l8 14H2z');
    expect(fr).not.toMatch(/home-i[1-4]/);
    expect(fr).toContain('grid-template-columns: repeat(3, 1fr)');
    const en = await (await home('/?lang=en')).text();
    for (const s of [
      'What we handle for you', 'The boring league work, done automatically.',
      'Every week, players get a message and answer yes or no with one tap.',
      'Short on players? We invite your sub list at a steady pace, with a waitlist.',
      'Your format, your choice', 'Fixed teams, weekly draw or no teams. A player can also play goalie.',
      'Schedule and playoffs', 'Games, playoffs and automatic reminders, with no chasing by hand.',
      'Payments and finances', "Payment reminders with your Interac e-Transfer details, and your league's finances in one place.",
      'A page for your league', 'Schedule, teams, results and stats on a public page you can share in the group chat.'
    ]) expect(en).toContain(s);
  });
});

describe('item 3: the pricing section', () => {
  it('after the cards and before how it works, four tiers, no payment button', async () => {
    const fr = await (await home('/', { 'accept-language': 'fr-CA' })).text();
    const at = id => fr.indexOf(`id="${id}"`);
    expect(at('pricing')).toBeGreaterThan(at('features'));
    expect(at('pricing')).toBeLessThan(at('how-it-works'));
    const sec = fr.slice(at('pricing'), at('how-it-works'));
    for (const s of [
      '>Tarifs<', 'Un prix fixe par mois.', 'Pas de crédits à acheter, et rien ne bloque ton calendrier.',
      'Gratuit', 'Moins de 15 joueurs', '0 $',
      'Standard', '15 à 50 joueurs', '9,99 $ CAD par mois, ou 99,90 $ par an',
      'Plus', '51 à 100 joueurs', '19,99 $ CAD par mois, ou 199,90 $ par an',
      'Sur mesure', 'Plus de 100 joueurs', '<a href="mailto:bonjour@notreligue.ca" data-i18n="writeUs">Écris-nous</a>',
      'Prix avant taxes. Seuls les joueurs réguliers avec un courriel comptent. 2 mois gratuits pour chaque ligue, sans carte. Les forfaits mensuels peuvent être mis en pause pendant la saison morte.'
    ]) expect(sec).toContain(s);
    // Billing is live (2026-10-02): no "coming soon" badge on the cards.
    expect(sec).not.toMatch(/bientôt disponible|nl-badge/);
    expect(sec.match(/href="\/signup"/g)).toHaveLength(3);
    expect(sec).not.toMatch(/stripe|checkout|acheter maintenant|s'abonner/i);
    const en = await (await home('/?lang=en')).text();
    for (const s of ['>Pricing<', 'One flat monthly price.', 'No credits to buy, and nothing blocks your schedule.', 'Under 15 players', '$0',
      '$9.99 CAD per month, or $99.90 per year', '$19.99 CAD per month, or $199.90 per year', 'Custom', 'Over 100 players', '>Write to us</a>',
      'Prices before tax. Only regular players with an email count. 2 months free for every league, no card. Monthly plans can pause for the off-season.'
    ]) expect(en).toContain(s);
    expect(en).not.toContain('Billing coming soon');
  });
});

describe('batch 3, item 2: dark mode', () => {
  it('no hard-coded hex or rgb color in the sections added in batch 1', async () => {
    const html = await (await home('/?lang=fr')).text();
    const css = html.slice(html.indexOf('<body')).match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '');
    const scoped = /\.home-(feats|feat|ico|tiers|tier|beta-note|fine|sub|trust|trust-text|sign|final|final-cta|footer|operator|proof|beta|mock)\b/;
    const hard = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), decl: m[2] }));
    const scopedRules = rules.filter(r => scoped.test(r.sel) || /^\.nl$/.test(r.sel));
    expect(scopedRules.length).toBeGreaterThan(20);
    for (const r of scopedRules) expect(r.decl, r.sel).not.toMatch(hard);
    // Inline styles inside those sections.
    const body = html.slice(html.indexOf('class="home-mock"'), html.indexOf('</footer>'));
    for (const m of body.matchAll(/style="([^"]*)"/g)) expect(m[1]).not.toMatch(hard);
    // The icon tiles swap with the scheme: a dark tile with a yellow glyph
    // in light, a yellow tile with a dark glyph in dark.
    expect(css).toContain('.home-ico { background: var(--home-tile); color: var(--home-glyph); }');
    expect(css).toContain('.nl { --home-tile: var(--surface-hero); --home-glyph: var(--yellow);');
    expect(css).toContain('@media (prefers-color-scheme: dark) { .nl { --home-tile: var(--yellow); --home-glyph: var(--on-yellow);');
  });
});

describe('item 4: trust block, closing call to action, footer', () => {
  it('French and English, in page order, every href kept', async () => {
    const fr = await (await home('/', { 'accept-language': 'fr-CA' })).text();
    const trust = fr.indexOf("Notre Ligue est née de ma propre ligue de hockey cosom, à Laval. C'est moi qui réponds à tes courriels. Fait au Québec, en français d'abord.");
    expect(trust).toBeGreaterThan(fr.indexOf('id="how-it-works"'));
    expect(trust).toBeLessThan(fr.indexOf('class="home-final"'));
    expect(fr).toContain('Roberto Santana · <a href="mailto:bonjour@notreligue.ca">bonjour@notreligue.ca</a>');
    const final = fr.slice(fr.indexOf('class="home-final"'));
    expect(final).toContain('Ta prochaine saison commence ici.');
    expect(final).toContain('<a class="nl-btn nl-btn--primary nl-btn--lg" href="/signup" data-i18n="cta">Créer ma ligue</a>');
    expect(final).toContain('2 mois gratuits, sans carte.');
    expect(fr).toContain('<a href="/confidentialite">Confidentialité</a> · <a href="/conditions">Conditions</a> · <a href="mailto:bonjour@notreligue.ca">Contact</a>');
    expect(fr).toContain('Notre Ligue · Fait au Québec');
    expect(fr).toContain('Exploité par Roberto Santana, faisant affaire sous le nom Notre Ligue.');
    const en = await (await home('/?lang=en')).text();
    for (const s of [
      "Notre Ligue grew out of my own ball hockey league in Laval. I'm the one who answers your emails. Made in Quebec, French first.",
      'Your next season starts here.', '2 months free, no card.',
      '<a href="/confidentialite#en">Privacy</a> · <a href="/conditions#en">Terms</a>', 'Notre Ligue · Made in Quebec',
      'Operated by Roberto Santana, doing business as Notre Ligue.'
    ]) expect(en).toContain(s);
  });

  it('no channel is named, no em dash, French typography', async () => {
    for (const path of ['/?lang=fr', '/?lang=en']) {
      const html = await (await home(path)).text();
      const text = html.slice(html.indexOf('<body')).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
      expect(text).not.toMatch(/texto|SMS|\btext(s|ing)?\b/i);
      expect(text).not.toContain('—');
      expect(text).not.toMatch(/ [?!]/);
      expect(text).not.toMatch(/substitut|skater/i);
    }
  });
});

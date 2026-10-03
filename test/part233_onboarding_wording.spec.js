// Onboarding review, item 2: the new wording, on the pages that carry it,
// French and English. Notre Ligue only: SMBHL's own pages keep theirs.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must } from './support/league_season.js';

beforeAll(async () => {
  env.AUTH_SECRET = 'p233-auth'; env.LEAGUE_PRODUCT = 'true'; env.BILLING_LAUNCH_AT = '2026-10-02';
  await applyRealSchema(env);
});
afterAll(() => { delete env.LEAGUE_PRODUCT; delete env.BILLING_LAUNCH_AT; });

const dictOf = html => JSON.parse(html.match(/var __I18N = (\{[\s\S]*?\});\n/)[1]);
async function newLeague(tag, structure = 'fixed') {
  const a = await admin(tag);
  await must(a.post('/leagues/create', { name: `Ligue ${tag}`, teamStructure: structure, teamNames: structure === 'headcount' ? undefined : ['A', 'B'] }), 'create');
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  return a;
}

describe('sign-up', () => {
  it('step 1: a few minutes, and an account already', async () => {
    const d = dictOf(await (await SELF.fetch('http://example.com/signup?step=1')).text());
    expect(d.fr.sub1).toBe('Quelques minutes, promis.');
    expect(d.en.sub1).toBe('A few minutes, promise.');
    expect(d.fr.alreadySignedUp).toBe('Tu as déjà un compte?');
    expect(d.en.alreadySignedUp).toBe('Already have an account?');
  });
  it('step 2: the address help and two structure names that no longer look alike', async () => {
    const a = await admin('p233s2');
    const d = dictOf((await a.get('/signup?step=2')).text);
    expect(d.fr.slugHelp).toBe('Elle ne pourra plus changer une fois ta ligue créée, pour que les liens que tu partages fonctionnent toujours.');
    expect(d.fr.structureHeadcountTitle).toBe('Liste des présents seulement (drop-in)');
    expect(d.en.structureHeadcountTitle).toBe('Attendance list only (drop-in)');
    expect(d.fr.structureHeadcountDesc).toBe('Tu formes les équipes sur place.');
    expect(d.fr.structureWeeklyTitle).toBe('Équipes formées à chaque match');
    expect(d.en.structureWeeklyTitle).toBe('Teams formed every game');
    expect(d.fr.structureWeeklyDesc).toBe('Tirage automatique ou équipes choisies par toi.');
    expect(d.en.doneTitle).toBe('Your league is ready.');
    expect(d.fr.doneTitle).toBe('Ta ligue est créée.');
  });
});

describe('the wizard', () => {
  it('roster, options and money steps', async () => {
    const a = await newLeague('p233w');
    const roster = dictOf((await a.get('/onboarding/season?step=1')).text);
    expect(roster.fr.rosterSubTeam).toBe("Ces nombres s'appliquent à chaque équipe. Laisse vide si tu ne sais pas encore.");
    expect(roster.fr.lblMinGoalies).toBe('Minimum de gardiens (facultatif)');
    const opts = (await a.get('/onboarding/season?step=3')).text;
    const o = dictOf(opts);
    expect(o.fr.playoffsSub).toBe("Les séries utilisent les dernières semaines de ta saison. L'horaire de la saison régulière s'ajuste en conséquence.");
    expect(o.fr.playoffsEnabledLabel).toBe('Oui, il y a des séries');
    expect(o.en.playoffsEnabledLabel).toBe('Yes, there are playoffs');
    expect(o.fr.reminder72Label).toBe("Rappel 72 h avant, à ceux qui n'ont pas répondu");
    expect(o.fr.reminder24Label).toBe("Rappel 24 h avant, à ceux qui n'ont pas répondu");
    expect(o.fr.reminder12Label).toBe('Détails 12 h avant, aux joueurs confirmés');
    expect(o.en.reminder72Label).toBe("72h reminder, to those who haven't answered");
    expect(o.en.reminder12Label).toBe('12h details, to confirmed players');
    expect(o.fr.remindersSub).toContain('dans les Paramètres.');
    expect(o.fr.statsSub).toContain('dans les Paramètres.');
    expect(o.fr.lblTracksResultsDesc).toBe('Le pointage de chaque match, et le classement (V-D-N) qui en découle.');
    expect(o.en.lblTracksResultsDescPickup).toBe("Each game's score, kept as history. Teams change every game, so there's no standings table.");
    const fin = dictOf((await a.get('/onboarding/season?step=4')).text);
    expect(fin.fr.financeTitle).toBe('Veux-tu faire le suivi des finances de ta ligue?');
    expect(fin.en.financeTitle).toBe("Do you want to track your league's money?");
    expect(fin.fr.financeSub).toContain('sur la page Finances.');
    expect(fin.fr.financeFeesLabel).toBe('Frais des joueurs');
    expect(fin.fr.lblGamePlayer).toBe('Frais par match (joueur)');
    expect(fin.fr.lblGameGoalie).toBe('Frais par match (gardien)');
    expect(fin.fr.catRental).toBe('Location du lieu (glace, terrain ou gymnase)');
    expect(fin.en.catRental).toBe('Venue rental (ice, field or gym)');
  });
});

describe('the pages after it', () => {
  it('the Finances page names the rental the same way', async () => {
    const a = await newLeague('p233f');
    const page = (await a.get('/league/finances')).text;
    expect(page).toContain('Location du lieu (glace, terrain ou gymnase)');
    expect(page).not.toContain('Location de glace ou de terrain');
  });
  it('the players page: the import help and the progress sentence', async () => {
    const a = await newLeague('p233r');
    await must(a.post('/league/settings/structure', { min_players: 6, max_players: 10 }), 'structure');
    await must(a.post('/league/season/publish', { season_name: 'S1', min_players: 6, max_players: 10 }), 'publish');
    await must(a.post('/league/contacts', { name: 'Léa Joueuse', role: 'roster', team: 'A', emailChoice: 'skip' }), 'contact');
    const page = (await a.get('/league/roster')).text;
    expect(page).toContain("Une ligne d'en-tête est acceptée, elle sera ignorée.");
    expect(page).toContain('1 joueur ajouté sur les 12 nécessaires (6 par équipe, remplaçants compris).');
    expect(page).toContain('1 player added of the 12 needed (6 per team, subs included).');
    expect(page).toContain('Courriel (facultatif)');
    expect(page).not.toContain('(optionnel)');
  });
  it('a no-teams league: the progress sentence without a per-team count', async () => {
    const a = await newLeague('p233h', 'headcount');
    await must(a.post('/league/settings/structure', { min_players: 8, max_players: 12 }), 'structure');
    await must(a.post('/league/season/publish', { season_name: 'S1', min_players: 8, max_players: 12 }), 'publish');
    await must(a.post('/league/contacts', { name: 'Léa Joueuse', role: 'roster', emailChoice: 'skip' }), 'contact');
    expect((await a.get('/league/roster')).text).toContain('1 joueur ajouté sur les 8 nécessaires (remplaçants compris).');
  });
  it('the schedule and settings say « dans les Paramètres », never « (optionnel) »', async () => {
    const a = await newLeague('p233sc');
    const sched = (await a.get('/league/schedule')).text;
    expect(sched).toContain('Lieu (facultatif)');
    expect(sched).not.toContain('(optionnel)');
    const settings = (await a.get('/league/settings')).text;
    expect(settings).not.toContain('(optionnel)');
    expect(settings).not.toMatch(/dans Paramètres|dans les réglages/);
  });
  it('the billing page of a free league says it is free, without the count line', async () => {
    const a = await newLeague('p233b');
    const page = (await a.get('/league/billing')).text;
    expect(page).toContain('Ta ligue est gratuite (moins de 15 joueurs réguliers).');
    expect(page).not.toMatch(/Ta ligue compte [^<]*forfait Gratuit/);
  });
});

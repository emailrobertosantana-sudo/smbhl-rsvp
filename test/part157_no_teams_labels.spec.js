// D5 (decided 2026-09-29): the no-teams structure serves a single squad
// too ("Just my team") as well as drop-in ("Drop-in, no fixed teams") --
// two labels, one structure (rendered: test/rendered/
// signup_no_teams_labels.spec.mjs). What follows must read right for a
// single team: no standings, no matchups, no "name your teams", and no
// copy claiming the league "has no teams".
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must } from './support/league_season.js';
import { withGameTimes } from './support/game_times.js';

beforeAll(async () => { env.AUTH_SECRET = 'p157'; env.RSVP_SECRET = 'p157r'; await applyRealSchema(env); });

const visible = html => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const dictOf = html => { const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/); return m ? JSON.parse(m[1]) : null; };

describe('Signup offers both labels', () => {
  it('both are the no-teams structure, in both languages', async () => {
    const a = await admin('d5signup');
    const html = (await a.get('/signup?step=2')).text;
    expect(html).toContain('<input type="radio" name="su_structure" value="headcount" id="su_structure_my_team">');
    expect(html).toContain('<input type="radio" name="su_structure" value="headcount" id="su_structure_drop_in">');
    const d = dictOf(html);
    expect(d.fr.structureMyTeamTitle).toBe('Juste mon équipe');
    expect(d.en.structureMyTeamTitle).toBe('Just my team');
    expect(d.fr.structureMyTeamDesc).toBe("Une seule équipe qui joue dans une autre ligue, celle d'une ville par exemple : présences et remplaçants, sans classement.");
    expect(d.en.structureMyTeamDesc).toBe("One team playing in someone else's league, a city or rec league for example: attendance and subs, no standings.");
    expect(d.fr.structureHeadcountTitle).toBe('Drop-in, sans équipes attitrées');
    expect(d.en.structureHeadcountTitle).toBe('Drop-in, no fixed teams');
    // Pickup keeps its own label, distinct from drop-in.
    expect(d.fr.structureWeeklyTitle).toBe('Sans équipes fixes');
    expect(d.en.structureWeeklyTitle).toBe('Pickup with teams');
  });
});

describe('A single team\'s league reads right', () => {
  it('no standings, no matchups, no team naming, no "has no teams" -- dashboard, schedule, settings, onboarding, public page', async () => {
    const a = await admin('d5flow');
    const lg = (await must(a.post('/leagues/create', { name: 'Les Castors', teamStructure: 'headcount' }), 'create')).league;
    const onboarding = [];
    for (let step = 1; step <= 6; step++) onboarding.push((await a.get(`/onboarding/season?step=${step}`)).text);
    await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
    await must(a.post('/league/contacts', { name: 'Ann Player', email: 'ann@example.com' }), 'contact');
    await must(a.post('/league/events', withGameTimes({ date: '2099-05-05', season: 'S1', venue: 'Parc', start_time: '19:00' })), 'event');
    const pages = { dashboard: (await a.get('/dashboard')).text, schedule: (await a.get('/league/schedule')).text, settings: (await a.get('/league/settings')).text, public: (await a.get('/' + lg.slug)).text };
    for (const [name, html] of [...Object.entries(pages), ...onboarding.map((h, i) => [`onboarding ${i + 1}`, h])]) {
      const text = visible(html);
      for (const bad of ["n'a pas d'équipes", 'has no teams', 'no fixed teams —', 'Classement', 'Standings', 'Nommer tes équipes', 'Confirme les noms des équipes', 'Assigner les affrontements'])
        expect(text.includes(bad) ? text.slice(Math.max(0, text.indexOf(bad) - 120), text.indexOf(bad) + 80) : '', `${name}: ${bad}`).toBe('');
    }
    expect(visible(pages.dashboard)).toContain('Une seule liste de joueurs, sans répartition en équipes.');
    expect(visible(pages.settings)).toContain("Pas d'équipes à nommer dans cette ligue.");
    expect(visible(pages.settings)).toContain('Juste mon équipe, ou drop-in');
    const sd = dictOf(pages.settings);
    expect(sd.en.structureHeadcountTitle).toBe('Just my team, or drop-in');
    expect(sd.en.structureHeadcountDesc).toBe('No split into teams: one player list, with attendance and subs.');
    expect(sd.en.teamsHeadcountNote).toBe('No teams to name in this league.');
    expect(sd.en.rosterSubHeadcount).toBe('Everyone who confirms counts toward this total.');
    expect(dictOf(pages.dashboard).en.noFixedTeamsDesc).toBe('One player list, with no split into teams.');
  });
});

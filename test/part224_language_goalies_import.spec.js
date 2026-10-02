// Onboarding batch 2 (2026-10-02), Notre Ligue only:
//   1. the league's language, asked at sign-up step 2 (the admin's own by
//      default), saved in the existing setting, shown in the summary;
//   2. whether the league has goalies -- no goalies: minimum 0, no goalie
//      option, sub call or shortage anywhere; a Settings switch; existing
//      leagues have goalies, as always;
//   3. an optional team column in the player import, matched regardless of
//      case and accents (fixed teams), ignored with a note elsewhere.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { DAY, local, mail, installMailCapture, removeMailCapture, admin, must, one, rows } from './support/league_season.js';
import { callSubsForShortfall } from '../src/index.js';
import { getLeagueSeasonConfig, matchTeamName } from '../src/leagues.js';
import { sportHasGoalie } from '../src/season_config.js';

const START = Date.UTC(2026, 9, 5, 16, 0);
beforeAll(async () => {
  env.LEAGUE_PRODUCT = 'true'; env.RESEND_API_KEY = 'x'; env.RSVP_SECRET = 'p224'; env.AUTH_SECRET = 'p224-auth'; env.MAIL_DAILY_CAP = ''; env.PUBLIC_URL = 'https://rsvp.example.com';
  vi.useFakeTimers({ toFake: ['Date'] });
  await applyRealSchema(env);
  installMailCapture();
});
beforeEach(() => { vi.setSystemTime(new Date(START)); mail.sent.length = 0; });
afterAll(() => { removeMailCapture(); vi.useRealTimers(); delete env.LEAGUE_PRODUCT; });

const page = async (a, path) => (await a.get(path)).text;
async function create(tag, body) {
  const a = await admin(tag);
  const lg = (await must(a.post('/leagues/create', { name: `P224 ${tag}`, ...body }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  return { a, lg };
}

describe("1. the league's language", () => {
  it('sign-up step 2 asks it, the admin\'s own language chosen by default', async () => {
    const a = await admin('lang.form');
    const fr = await page(a, '/signup?step=2&lang=fr');
    expect(fr).toContain('data-i18n="langLabel">Langue de ta ligue<');
    expect(fr).toContain('<input type="radio" name="su_lang" value="fr" checked>');
    expect(fr).toContain('La langue des courriels et des pages de tes joueurs. Tu peux la changer plus tard dans les Paramètres.');
    expect(fr).toContain('>Les deux / Both<');
    const en = await page(a, '/signup?step=2&lang=en');
    expect(en).toContain('<input type="radio" name="su_lang" value="en" checked>');
    expect(en).toContain(`"langHelp":"The language of your players' emails and pages. You can change it later in Settings."`);
  });

  it('saved in the existing setting; the summary shows it; a caller that sends none stays bilingual', async () => {
    const { a, lg } = await create('lang.en', { teamNames: ['A', 'B'], languageMode: 'en' });
    expect((await one('SELECT language_mode FROM leagues WHERE id = ?', lg.id)).language_mode).toBe('en');
    const sum = await page(a, '/onboarding/season?step=summary');
    expect(sum).toContain('data-i18n="sumLanguage">Langue<');
    expect(sum).toContain('data-date-fr="Anglais." data-date-en="English."');
    const plain = await create('lang.none', { teamNames: ['A', 'B'] });
    expect((await one('SELECT language_mode FROM leagues WHERE id = ?', plain.lg.id)).language_mode).toBe('both');
  });
});

describe('2. goalies', () => {
  it('sign-up step 2 asks, right after the structure, yes by default', async () => {
    const a = await admin('goalies.form');
    const html = await page(a, '/signup?step=2&lang=fr');
    expect(html).toContain('data-i18n="goaliesLabel">Ta ligue a des gardiens?<');
    expect(html).toContain('<input type="radio" name="su_goalies" value="yes" checked>');
    expect(html.indexOf('id="su_structure_radio"')).toBeLessThan(html.indexOf('id="su_goalies_radio"'));
  });

  it('no goalies: minimum 0, no goalie option on the roster, the stats, the game page, the money step, Finances or the public page', async () => {
    const { a, lg } = await create('nogoal', { teamNames: ['Red', 'Blue'], hasGoalies: false });
    expect((await one('SELECT min_goalies, max_goalies FROM leagues WHERE id = ?', lg.id))).toEqual({ min_goalies: 0, max_goalies: 0 });
    const cfg = await getLeagueSeasonConfig(env, lg.id);
    expect(sportHasGoalie(cfg.sportType)).toBe(false);
    expect(cfg.goaliesPerTeam).toBe(0);
    expect(await page(a, '/league/roster')).not.toContain('id="r_goalie_field"');
    expect(await page(a, '/onboarding/season?step=1')).not.toContain('id="ob_min_goalies"');
    expect(await page(a, '/onboarding/season?step=5')).not.toContain('data-i18n="statsExplainGoalies"');
    const money = await page(a, '/onboarding/season?step=6');
    expect(money).not.toContain('id="ob_price_goalie"');
    expect(money).not.toContain('id="ob_game_goalie"');
    expect(await page(a, '/league/finances')).toMatch(/data-no-goalies hidden><label class="nl-label" for="fin-price-goalie"/);
    const settings = await page(a, '/league/settings');
    expect(settings).toContain('id="se_goalies_switch" data-i18n-aria="goaliesSwitchLabel"');
    expect(settings).toContain('aria-checked="false" id="se_goalies_switch"');
    expect(settings).toContain('<div class="su-two" style="display:none">\n        <div class="nl-field">\n          <label class="nl-label" for="se_min_goalies"'.replace(/\n/g, settings.includes('\r\n') ? '\r\n' : '\n'));
    await must(a.post('/league/settings/identity', { tracksResults: true, tracksPlayerStats: true, publicPageEnabled: true }), 'identity');
    const slug = (await one('SELECT slug FROM leagues WHERE id = ?', lg.id)).slug;
    const pub = await (await SELF.fetch(`http://example.com/${slug}`)).text();
    expect(pub).not.toContain('data-i18n="navGoalies"');
    expect(pub).not.toContain('data-i18n="goalieStats"');
  });

  it('a no-goalie league never calls a goalie sub; the same league with goalies does', async () => {
    const setup = async (tag, hasGoalies) => {
      const { a, lg } = await create(tag, { teamStructure: 'weekly_draw', teamNames: ['Dark', 'Light'], hasGoalies });
      await must(a.post('/league/settings/structure', { min_players: 4, max_players: 10, min_goalies: 1 }), 'limits');
      await must(a.post('/league/season/publish', { season_name: 'S1' }), 'republish');
      for (let i = 0; i < 4; i++) await must(a.post('/league/contacts', { name: `${tag} Reg${i}`, email: `${tag}.reg${i}@example.com` }), 'reg');
      await must(a.post('/league/contacts', { name: `${tag} Goalie Sub`, email: `${tag}.gsub@example.com`, role: 'sub_skater', is_goalie: true }), 'gsub');
      const { date, time } = local(START + 3 * DAY);
      const id = `${lg.id}:g:${date}`;
      await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, auto_reminders_enabled) VALUES (?, 'S1', 1, ?, 'Gym', 'open', ?, ?, 1)`).bind(id, date, time, lg.id).run();
      return one('SELECT * FROM events WHERE id = ?', id);
    };
    const withG = await setup('withg', undefined);
    expect(await callSubsForShortfall(env, withG)).toBeGreaterThan(0);
    expect((await rows(`SELECT dedup_key FROM outbox WHERE event_id = ? AND kind = 'sub_call'`, withG.id)).some(r => String(r.dedup_key).includes(':goalie:'))).toBe(true);
    const noG = await setup('nog', false);
    expect(await callSubsForShortfall(env, noG)).toBe(0);
    expect(await rows(`SELECT dedup_key FROM outbox WHERE event_id = ?`, noG.id)).toEqual([]);
    // Its "goalie sub" was saved as a plain sub: no goalie flag in a league with none.
    expect((await one(`SELECT is_goalie FROM contacts WHERE email = 'nog.gsub@example.com'`)).is_goalie).toBe(0);
  });

  it('the Settings switch: off, then on again (minimum back to 1, the options back)', async () => {
    const { a, lg } = await create('toggle', { teamNames: ['Red', 'Blue'] });
    expect(await page(a, '/league/roster')).toContain('id="r_goalie_field"');
    expect((await a.post('/league/settings/goalies', { hasGoalies: false })).status).toBe(200);
    expect((await one('SELECT min_goalies FROM leagues WHERE id = ?', lg.id)).min_goalies).toBe(0);
    expect(await page(a, '/league/roster')).not.toContain('id="r_goalie_field"');
    expect((await a.post('/league/settings/goalies', { hasGoalies: true })).status).toBe(200);
    expect((await one('SELECT min_goalies FROM leagues WHERE id = ?', lg.id)).min_goalies).toBe(1);
    expect(await page(a, '/league/roster')).toContain('id="r_goalie_field"');
    const cfg = await getLeagueSeasonConfig(env, lg.id);
    expect(sportHasGoalie(cfg.sportType)).toBe(true);
    expect(cfg.goaliesPerTeam).toBeGreaterThanOrEqual(1);
    expect((await a.post('/league/settings/goalies', { hasGoalies: 'no' })).status).toBe(400);
  });

  it('an existing league (no setting) has goalies, unchanged', async () => {
    const { a, lg } = await create('existing', { teamNames: ['Red', 'Blue'] });
    expect(await one(`SELECT 1 AS x FROM settings WHERE key = ?`, `league_goalies:${lg.id}`)).toBeNull();
    const cfg = await getLeagueSeasonConfig(env, lg.id);
    expect(sportHasGoalie(cfg.sportType)).toBe(true);
    expect(await page(a, '/league/roster')).toContain('id="r_goalie_field"');
    expect(await page(a, '/league/settings')).toContain('aria-checked="true" id="se_goalies_switch"');
  });
});

describe('3. the team column in the import', () => {
  it('matches regardless of case and accents', () => {
    expect(matchTeamName(['Rouge', 'Écureuils'], 'rouge')).toBe('Rouge');
    expect(matchTeamName(['Rouge', 'Écureuils'], ' ECUREUILS ')).toBe('Écureuils');
    expect(matchTeamName(['Rouge'], 'Bleu')).toBeNull();
  });

  it('fixed teams: with and without the column, an unknown team added without one and listed', async () => {
    const { a, lg } = await create('imp.fixed', { teamNames: ['Rouge', 'Écureuils'] });
    const res = await must(a.post('/league/contacts/bulk', { emailChoice: 'skip', contacts: [
      { name: 'Ann Rouge', email: 'ann@example.com', team: 'rouge' },
      { name: 'Ben Ecureuil', email: 'ben@example.com', team: 'ECUREUILS' },
      { name: 'Cal Nowhere', email: 'cal@example.com', team: 'Aigles' },
      { name: 'Dee Plain', email: 'dee@example.com' }
    ] }), 'bulk');
    expect(res.createdCount).toBe(4);
    expect(res.teamUnmatched).toEqual([{ name: 'Cal Nowhere', team: 'Aigles' }]);
    expect(res.teamIgnored).toBe(false);
    const teams = Object.fromEntries((await rows('SELECT name, preferred_team FROM contacts WHERE league_id = ?', lg.id)).map(r => [r.name, r.preferred_team]));
    expect(teams).toEqual({ 'Ann Rouge': 'Rouge', 'Ben Ecureuil': 'Écureuils', 'Cal Nowhere': null, 'Dee Plain': null });
  });

  it('everyone placed by the import: no "put your players on a team" step', async () => {
    const { a } = await create('imp.placed', { teamNames: ['Rouge', 'Bleu'] });
    await must(a.post('/league/contacts/bulk', { emailChoice: 'skip', contacts: [{ name: 'Ann One', team: 'rouge' }, { name: 'Ben Two', team: 'BLEU' }] }), 'bulk');
    expect(await page(a, '/dashboard')).not.toContain('data-i18n="nsAssignTeams"');
    const b = await create('imp.half', { teamNames: ['Rouge', 'Bleu'] });
    await must(b.a.post('/league/contacts/bulk', { emailChoice: 'skip', contacts: [{ name: 'Ann One', team: 'rouge' }, { name: 'Ben Two', team: 'Vert' }] }), 'bulk');
    expect(await page(b.a, '/dashboard')).toContain('data-i18n="nsAssignTeams"');
  });

  it('a no-teams league: the column is ignored, with a note', async () => {
    const { a, lg } = await create('imp.none', { teamStructure: 'headcount' });
    const res = await must(a.post('/league/contacts/bulk', { emailChoice: 'skip', contacts: [{ name: 'Ann One', team: 'Rouge' }] }), 'bulk');
    expect(res.createdCount).toBe(1);
    expect(res.teamIgnored).toBe(true);
    expect(res.teamUnmatched).toEqual([]);
    expect((await one('SELECT preferred_team FROM contacts WHERE league_id = ?', lg.id)).preferred_team).toBeNull();
  });

  it('the import help says so, in both languages, with an example', async () => {
    const { a } = await create('imp.help', { teamNames: ['Rouge', 'Bleu'] });
    const html = await page(a, '/league/roster');
    expect(html).toContain("Colonnes : nom, courriel, téléphone et, en dernier, l&#39;équipe (optionnelle, équipes fixes seulement). Exemple : Marie Tremblay, marie@example.com, 514-555-0100, Rouge");
    expect(html).toContain('Columns: name, email, phone and, last, the team (optional, fixed teams only). Example: John Smith, john@example.com, 514-555-0100, Red');
  });
});

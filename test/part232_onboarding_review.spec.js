// Onboarding review (Roberto's walk through onboarding-review/), items 1 and
// 3b. Notre Ligue only.
//   1a every sign-up and onboarding heading has its own line height
//   1b the import preview always has the team column (fixed teams) and marks
//      a team that matches none of the league's
//   1c the summary's finance line
//   1d the shortage badge only when it is real
//   1e « Étape N sur T » and the bar on every step; Back on every step
//      after the account, the first onboarding step included
//   1f an empty schedule: no matchups button, a short empty state
//   3b playoffs, reminders and stats are one options step; resume and the
//      checklist still work, for leagues part-way through before the merge
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must } from './support/league_season.js';

beforeAll(async () => {
  env.AUTH_SECRET = 'p232-auth'; env.RSVP_SECRET = 'p232-rsvp'; env.LEAGUE_PRODUCT = 'true';
  delete env.RESEND_API_KEY; delete env.MAIL_PROVIDER;
  await applyRealSchema(env);
});
afterAll(() => { delete env.LEAGUE_PRODUCT; });

const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const flat = s => s.replace(/[  ]/g, ' ');
async function newLeague(tag, { structure = 'fixed', teams = ['A', 'B'], season = 'S1', publish = {} } = {}) {
  const a = await admin(tag);
  const lg = (await must(a.post('/leagues/create', { name: `Ligue ${tag}`, teamStructure: structure, teamNames: structure === 'headcount' ? undefined : teams }), 'create')).league;
  if (season) await must(a.post('/league/season/publish', { season_name: season, ...publish }), 'publish');
  return { a, id: lg.id };
}
const mark = (a, step, action = 'done') => must(a.post('/league/onboarding/step', { step, action }), `mark ${step}`);

describe('1a: headings never touch', () => {
  it('the sign-up and onboarding pages give the done heading the title style', async () => {
    const page = await (await SELF.fetch('http://example.com/signup')).text();
    expect(page).toContain('.su-title h1, .su-done h1 { font: 700 28px/34px');
    expect(page).toContain('.su-body h2 { font: 700 20px/26px');
  });
});

describe('1b: the import preview team column', () => {
  it('a fixed-teams league always shows the column and names the unknown-team mark in both languages', async () => {
    const { a } = await newLeague('p232b');
    const page = (await a.get('/league/roster')).text;
    expect(page).toContain('var ROSTER_TEAM_SHAPED = true;');
    expect(page).toContain('Aucune équipe de ce nom');
    expect(page).toContain('No team by that name');
  });
  it('a no-teams league does not', async () => {
    const { a } = await newLeague('p232b2', { structure: 'headcount' });
    expect((await a.get('/league/roster')).text).toContain('var ROSTER_TEAM_SHAPED = false;');
  });
});

describe('1c: the summary finance line', () => {
  it('fees and expenses, in both languages', async () => {
    const { a } = await newLeague('p232c');
    await must(a.post('/league/finances/pricing', { season: 'S1', mode: 'season', price_player: 120, price_goalie: 60, price_game_player: 15, price_game_goalie: 0 }), 'pricing');
    await must(a.post('/league/finances/cost', { season: 'S1', category: 'rental', description: 'Glace', amount: 1800 }), 'cost');
    const page = flat((await a.get('/onboarding/season?step=summary')).text);
    expect(page).toContain('data-i18n="sumFinance">Finances</dt>');
    expect(page).toContain('Frais de saison : 120 $ (joueur), 60 $ (gardien). Par match : 15 $. Dépenses : 1 800 $ pour la saison.');
    expect(page).toContain('Season fees: $120 (player), $60 (goalie). Per game: $15. Expenses: $1,800 for the season.');
  });
  it('nothing recorded: not tracked for now', async () => {
    const { a } = await newLeague('p232c2');
    const page = (await a.get('/onboarding/season?step=summary')).text;
    expect(page).toContain('Pas de suivi pour l&#39;instant.');
    expect(page).toContain('Not tracked for now.');
  });
});

describe('1d: the shortage badge only when it is real', () => {
  async function shortLeague(tag, inDays) {
    const L = await newLeague(tag, { publish: { goalies_per_team: 0, skaters_per_team: 4, min_skaters: 3 } });
    // Each team: its goalie (the season asks for one) and 3 players, the minimum.
    for (const t of ['A', 'B']) {
      await must(L.a.post('/league/contacts', { name: `Gardien ${t} ${tag}`, email: `g${t.toLowerCase()}.${tag}@example.com`, role: 'roster', team: t, is_goalie: true, emailChoice: 'skip' }), 'goalie');
      for (let i = 0; i < 3; i++) await must(L.a.post('/league/contacts', { name: `Joueur ${t}${i} ${tag}`, email: `${t.toLowerCase()}${i}.${tag}@example.com`, role: 'roster', team: t, emailChoice: 'skip' }), 'contact');
    }
    const ev = (await must(L.a.post('/league/events', { date: day(inDays), start_time: '19:00', end_time: '20:00', venue: 'Aréna', season: 'S1', home_team: 'A', away_team: 'B' }), 'event')).event;
    return { ...L, ev };
  }
  const shows = async (a, ev) => {
    const dash = (await a.get('/dashboard')).text;
    const game = (await a.get(`/league/events/detail?e=${encodeURIComponent(ev.id)}`)).text;
    return { dash: dash.includes('class="nl-badge nl-badge--short" data-i18n="weekStatusShort"'), game: /nl-badge--short" data-short="[1-9]/.test(game) };
  };
  it('days before the game, before any ask: no alarm; the counts stay', async () => {
    const { a, ev } = await shortLeague('p232d', 6);
    expect(await shows(a, ev)).toEqual({ dash: false, game: false });
    expect((await a.get('/dashboard')).text).toMatch(/8 <span data-i18n="weekStatusNoResponse">/);
  });
  it('after the first ask: only when confirmed plus no reply is under the minimum', async () => {
    const { a, id, ev } = await shortLeague('p232d2', 6);
    await env.DB.prepare(`INSERT INTO league_reminder_log (event_id, kind, league_id, sent_at, recipient_count) VALUES (?, 'reminder_72h', ?, ?, 6)`).bind(ev.id, id, new Date().toISOString()).run();
    // Everyone still to answer: 3 could come, the minimum is 3. No alarm.
    expect(await shows(a, ev)).toEqual({ dash: false, game: false });
    // One player says no: at most 2 of 3. The alarm.
    const p = await env.DB.prepare("SELECT player_id FROM contacts WHERE league_id = ? AND preferred_team = 'A' AND is_goalie = 0 LIMIT 1").bind(id).first();
    await must(a.post('/league/rsvp/admin', { event_id: ev.id, player_id: p.player_id, status: 'out' }), 'out');
    expect(await shows(a, ev)).toEqual({ dash: true, game: true });
  });
  it('inside the sub-call window: the shortage that calls subs', async () => {
    const { a, ev } = await shortLeague('p232d3', 2);
    expect(await shows(a, ev)).toEqual({ dash: true, game: true });
  });
});

describe('1e: the step counter and Back', () => {
  it('steps 1 and 2: « Étape N sur 8 » and the bar; step 2 follows the structure', async () => {
    const one = await (await SELF.fetch('http://example.com/signup?step=1')).text();
    expect(one).toContain('Étape 1 sur 8');
    expect(one).toMatch(/class="nl-steps"[^>]*aria-valuemax="8" aria-valuenow="1"/);
    const { a } = await newLeague('p232e0', { season: null });
    const two = (await a.get('/signup?step=2&new=1')).text;
    expect(two).toContain('id="su_flow_label"');
    expect(two).toContain('var FLOW_TOTALS = {"fixed":8,"headcount":6,"weekly_draw":6};');
    expect(two).toMatch(/aria-valuemax="8" aria-valuenow="2"/);
  });
  it('the first onboarding step has Back, to the season screen with the season named', async () => {
    const { a } = await newLeague('p232e');
    const roster = (await a.get('/onboarding/season?step=1')).text;
    expect(roster).toContain('Combien de joueurs?');
    expect(roster).toContain("location.href='/onboarding/season?step=season'");
    const season = (await a.get('/onboarding/season?step=season')).text;
    expect(season).toMatch(/id="ob_season_name"[^>]*value="S1" readonly/);
    expect(season).toContain('href="/onboarding/season?step=1"');
    expect(season).toContain('id="ob_back"');
    expect(season).not.toContain("addEventListener('keydown'");
  });
});

describe('1f: an empty schedule', () => {
  it('no matchups button, a short empty state with the weekly series as its main action', async () => {
    const { a } = await newLeague('p232f');
    const empty = (await a.get('/league/schedule')).text;
    expect(empty).toContain('id="sc_empty"');
    expect(empty).toContain('Commence par créer les matchs de ta saison : un par semaine, même heure et même lieu.');
    expect(empty).toContain("Start by creating your season's games: one a week, same time and place.");
    expect(empty).toMatch(/id="sc_empty_bulk"[^>]*data-i18n="bulkCreateBtn">Créer plusieurs matchs/);
    // The empty state holds the main action: one weekly-series button, and
    // « Créer un match » as a secondary one.
    expect(empty.split('onclick="openBulkPanel()"').length - 1).toBe(1);
    expect(empty).toContain('class="nl-btn nl-btn--secondary" onclick="openSchedulePanel()"');
    expect(empty).not.toContain('onclick="toggleMatchupsPanel()" data-i18n="matchupsGenBtn">Assigner les affrontements</button>\n      <button');
    await must(a.post('/league/events', { date: day(10), start_time: '19:00', end_time: '20:00', venue: 'Aréna', season: 'S1' }), 'event');
    const one = (await a.get('/league/schedule')).text;
    expect(one).not.toContain('id="sc_empty"');
    expect(one).toContain('onclick="toggleMatchupsPanel()" data-i18n="matchupsGenBtn"');
  });
});

describe('3b: one options step', () => {
  it('fixed teams: 8 steps, options is step 7 with playoffs, reminders and stats in that order', async () => {
    const { a } = await newLeague('p232o');
    const page = (await a.get('/onboarding/season?step=3')).text;
    expect(page).toContain('Étape 7 sur 8');
    expect(page).toContain('Options de ta ligue');
    const order = ['ob_h_playoffs', 'ob_h_reminders', 'ob_h_stats'].map(id => page.indexOf(`id="${id}"`));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    for (const id of ['ob_playoffs_enabled', 'ob_reminder_72h', 'ob_reminder_24h', 'ob_reminder_12h', 'ob_tracks_results', 'ob_tracks_player_stats']) expect(page).toContain(`id="${id}"`);
    expect((await a.get('/onboarding/season?step=4')).text).toContain('Étape 8 sur 8');
  });
  it('no teams and pickup: 6 steps, no playoffs section', async () => {
    for (const structure of ['headcount', 'weekly_draw']) {
      const { a } = await newLeague('p232o-' + structure, { structure });
      const page = (await a.get('/onboarding/season?step=2')).text;
      expect(page, structure).toContain('Étape 5 sur 6');
      expect(page).toContain('id="ob_h_reminders"');
      expect(page).not.toContain('id="ob_h_playoffs"');
    }
  });
  it('saving the step marks options done; resume goes past it', async () => {
    const { a } = await newLeague('p232o2');
    for (const s of ['season', 'roster', 'teams']) await mark(a, s);
    expect((await a.get('/onboarding/season')).text).toContain('Options de ta ligue');
    await mark(a, 'options');
    expect((await a.get('/onboarding/season')).text).toContain('data-i18n="financeTitle"');
  });
  it('a league part-way through before the merge: options open until each old part was answered', async () => {
    const { a } = await newLeague('p232o3');
    for (const s of ['season', 'roster', 'teams', 'playoffs', 'reminders']) await mark(a, s);
    expect((await a.get('/onboarding/season')).text).toContain('Options de ta ligue');
    await mark(a, 'stats');
    expect((await a.get('/onboarding/season')).text).toContain('data-i18n="financeTitle"');
  });
  it('skipped, or an old part skipped: one checklist item, to the options step', async () => {
    const { a } = await newLeague('p232o4');
    for (const s of ['season', 'roster', 'teams']) await mark(a, s);
    await mark(a, 'stats', 'skip');
    const dash = (await a.get('/dashboard')).text;
    expect(dash).toContain('data-i18n="nsOptions"');
    expect(dash).toContain('/onboarding/season?step=3');
    expect(dash).not.toContain('data-i18n="nsStats"');
  });
});

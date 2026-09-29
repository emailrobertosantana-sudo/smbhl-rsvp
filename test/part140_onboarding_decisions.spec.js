// Onboarding decisions (items 1-7 of the onboarding follow-up).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { teamState } from '../src/index.js';
import { getLeagueSeasonConfig } from '../src/leagues.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.140.${++ip}` },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = async (s, path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const page = async (s, path) => (await SELF.fetch('http://example.com' + path, { headers: s ? { cookie: s.cookie } : {}, redirect: 'manual' })).text();

beforeAll(async () => {
  env.AUTH_SECRET = 'p140-auth';
  await applyRealSchema(env);
});

describe('1. The step counter waits for the structure', () => {
  it('steps 1 and 2 show no total; once chosen, the real total (8 fixed, 6 pickup, 5 no teams)', async () => {
    const step1 = await page(null, '/signup?step=1');
    expect(step1).toContain('data-i18n="step1">Étape 1<');
    expect(step1).not.toContain('role="progressbar"');
    for (const [structure, total, extra] of [['fixed', 8, { teamNames: ['A', 'B'] }], ['weekly_draw', 5, { teamNames: ['A', 'B'] }], ['headcount', 5, {}]]) {
      const s = await signup(`p140.count.${structure}@example.com`);
      expect(await page(s, '/signup?step=2')).not.toContain('role="progressbar"');
      await post(s, '/leagues/create', { name: `P140 ${structure}`, teamStructure: structure, ...extra });
      await post(s, '/league/season/publish', { season_name: 'S1' });
      const ob = await page(s, '/onboarding/season?step=1');
      expect(ob).toContain(`aria-valuemax="${total}"`);
      expect(ob).toMatch(new RegExp(`Étape \\d sur ${total}`));
    }
  });
});

describe('2. The mid-flow screen says created, not ready', () => {
  it('the league-created screen does not claim the league is ready, and says what is left', async () => {
    const s = await signup('p140.done@example.com');
    await post(s, '/leagues/create', { name: 'P140 Done', teamNames: ['A', 'B'] });
    const html = await page(s, '/signup?step=done');
    expect(html).toContain('data-i18n="doneTitle">Ta ligue est créée.<');
    expect(html).toContain('data-i18n="doneNext">Il reste quelques étapes : crée ta saison, puis ton horaire et tes joueurs.<');
    expect(html).toContain('"doneTitle":"Your league is created."');
    expect(html).not.toContain('est prête');
    expect(html).not.toContain('is ready');
  });
});

describe('3. Skip advances, and what was skipped stays on the checklist', () => {
  it('Skip on each step leads to the NEXT step (the last one to the dashboard)', async () => {
    const s = await signup('p140.skip.links@example.com');
    await post(s, '/leagues/create', { name: 'P140 Skip Links', teamNames: ['A', 'B'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    // fixed: roster, teams, playoffs, reminders, stats
    for (let step = 1; step <= 4; step++) {
      expect(await page(s, `/onboarding/season?step=${step}`)).toContain(`href="/onboarding/season?step=${step + 1}" id="ob_skip"`);
    }
    expect(await page(s, '/onboarding/season?step=5')).toContain('href="/dashboard" id="ob_skip"');
  });

  it('skipped reminders, stats and playoffs appear on the dashboard checklist; done or reminders on, they go', async () => {
    const s = await signup('p140.skip.list@example.com');
    await post(s, '/leagues/create', { name: 'P140 Skip List', teamNames: ['Otters', 'Bears'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    // Reminders start on; skipped WITH them off, the step stays on the checklist.
    await post(s, '/league/reminders/settings', { reminder72h: false, reminder24h: false, reminder12h: false });
    for (const step of ['playoffs', 'reminders', 'stats']) expect((await post(s, '/league/onboarding/step', { step, action: 'skip' })).status).toBe(200);
    let html = await page(s, '/dashboard');
    expect(html).toContain('href="/onboarding/season?step=3" data-i18n="nsPlayoffs">Configurer les séries<');
    expect(html).toContain('href="/onboarding/season?step=4" data-i18n="nsReminders">Choisir tes rappels<');
    expect(html).toContain('href="/onboarding/season?step=5" data-i18n="nsStats">Choisir les statistiques<');
    expect(html).toContain('"nsReminders":"Choose your reminders"');
    // Stats completed later through its step; reminders turned on in Settings.
    await post(s, '/league/onboarding/step', { step: 'stats', action: 'done' });
    await post(s, '/league/reminders/settings', { reminder24h: true });
    html = await page(s, '/dashboard');
    expect(html).not.toContain('data-i18n="nsStats"');
    expect(html).not.toContain('data-i18n="nsReminders"');
    expect(html).toContain('data-i18n="nsPlayoffs"');
  });

  it('a skipped step keeps the completion card away until it is done', async () => {
    const s = await signup('p140.skip.card@example.com');
    await post(s, '/leagues/create', { name: 'P140 Skip Card', teamNames: ['Otters', 'Bears'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    await post(s, '/league/settings/structure', { min_players: 1, max_players: 20 });
    await post(s, '/league/events', { date: '2099-06-07', season: 'S1', venue: 'Parc', start_time: '19:00' });
    await post(s, '/league/contacts', { name: 'Lea Player', role: 'roster', team: 'Otters' });
    await post(s, '/league/onboarding/step', { step: 'stats', action: 'skip' });
    expect(await page(s, '/dashboard')).not.toContain('id="setup_done_card"');
    expect(await page(s, '/league/roster')).not.toContain('id="setup_done_card"');
    await post(s, '/league/onboarding/step', { step: 'stats', action: 'done' });
    expect(await page(s, '/dashboard')).toContain('id="setup_done_card"');
  });
});

describe('4. Pickup leagues are not asked to name teams', () => {
  it('a pickup league keeping "Équipe 1/2" reaches the completion card', async () => {
    const s = await signup('p140.pickup@example.com');
    await post(s, '/leagues/create', { name: 'P140 Pickup', teamStructure: 'weekly_draw', teamNames: ['Équipe 1', 'Équipe 2'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    expect(await page(s, '/onboarding/season?step=2')).not.toContain('id="ob_teams"');
    await post(s, '/league/settings/structure', { min_players: 1, max_players: 20 });
    await post(s, '/league/events', { date: '2099-06-07', season: 'S1', venue: 'Parc', start_time: '19:00' });
    await post(s, '/league/contacts', { name: 'Lea Player', role: 'roster' });
    const html = await page(s, '/dashboard');
    expect(html).not.toContain('data-i18n="nsNameTeams"');
    expect(html).toContain('id="setup_done_card"');
  });
});

describe('5. "Nommer les équipes" waits for a season', () => {
  it('no team-naming item before a season; a fixed league gets it as a next step once one exists', async () => {
    const s = await signup('p140.noseason@example.com');
    await post(s, '/leagues/create', { name: 'P140 No Season', teamNames: ['Équipe 1', 'Équipe 2'] });
    let html = await page(s, '/dashboard');
    expect(html).toContain('data-i18n="checklistTitle"');
    expect(html).not.toContain('data-i18n="ckTeams"');
    await post(s, '/league/season/publish', { season_name: 'S1' });
    html = await page(s, '/dashboard');
    expect(html).toContain('data-i18n="nsNameTeams"');
  });
});

describe('6. Fixed-teams roster labels say "per team" themselves', () => {
  it('fixed: "Minimum/Maximum de joueurs par équipe"; pickup and no teams keep "total"', async () => {
    for (const [structure, extra, fr, en] of [
      ['fixed', { teamNames: ['A', 'B'] }, 'Minimum de joueurs par équipe', 'Minimum players per team'],
      ['weekly_draw', { teamNames: ['A', 'B'] }, 'Minimum total de joueurs', 'Minimum total players'],
      ['headcount', {}, 'Minimum total de joueurs', 'Minimum total players']
    ]) {
      const s = await signup(`p140.labels.${structure}@example.com`);
      await post(s, '/leagues/create', { name: `P140 Labels ${structure}`, teamStructure: structure, ...extra });
      await post(s, '/league/season/publish', { season_name: 'S1' });
      for (const path of ['/onboarding/season?step=1', '/league/settings']) {
        const html = await page(s, path);
        expect(html, `${structure} ${path}`).toContain(`>${fr}</label>`);
      }
      expect(await page(s, '/onboarding/season?step=1')).toContain(en);
    }
    const s = await signup('p140.labels.max@example.com');
    await post(s, '/leagues/create', { name: 'P140 Labels Max', teamNames: ['A', 'B'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const html = await page(s, '/onboarding/season?step=1');
    expect(html).toContain('>Maximum de joueurs par équipe</label>');
    expect(html).toContain('"lblMaxPlayersTeam":"Maximum players per team"');
  });
});

describe('7. Roster readiness: subs count, and the season minimum is the one in force', () => {
  const setup = async (email, perTeam) => {
    const s = await signup(email);
    const league = (await (await post(s, '/leagues/create', { name: `P140 ${email}`, teamNames: ['Otters', 'Bears'] })).json()).league;
    await post(s, '/league/settings/structure', { min_players: perTeam, max_players: 20 });
    return { s, league };
  };
  it('regulars AND subs count toward roster readiness', async () => {
    const { s } = await setup('p140.ready.subs@example.com', 2); // 2 per team x 2 teams = 4
    await post(s, '/league/season/publish', { season_name: 'S1' });
    await post(s, '/league/contacts', { name: 'Reg One', role: 'roster', team: 'Otters' });
    for (const n of ['Sub One', 'Sub Two']) await post(s, '/league/contacts', { name: n, role: 'sub_skater' });
    let html = await page(s, '/league/roster');
    expect(html).toContain('<span class="tnum">3</span> <span data-i18n="rosterProgressOfWord">sur</span> <span class="tnum">4</span>');
    await post(s, '/league/contacts', { name: 'Sub Three', role: 'sub_skater' });
    html = await page(s, '/league/roster');
    expect(html).not.toContain('data-i18n="rosterProgressLabel"'); // 4 of 4: ready
  });
  it('the season\'s minimum wins over the league default', async () => {
    const { s } = await setup('p140.ready.season@example.com', 1); // league default: 1 per team
    await post(s, '/league/season/publish', { season_name: 'S1', min_players: 3, max_players: 20 }); // this season: 3 per team
    for (const n of ['Reg One', 'Reg Two']) await post(s, '/league/contacts', { name: n, role: 'roster', team: 'Otters' });
    const html = await page(s, '/league/roster');
    expect(html).toContain('data-i18n="rosterProgressLabel"'); // 2 would satisfy the league default of 2
    expect(html).toContain('<span class="tnum">2</span> <span data-i18n="rosterProgressOfWord">sur</span> <span class="tnum">6</span>');
  });
});

describe('7 (continued). The per-event shortfall is unchanged', () => {
  it('counts only the people available for that game -- subs on file do not fill a team', async () => {
    const s = await signup('p140.shortfall@example.com');
    const league = (await (await post(s, '/leagues/create', { name: 'P140 Shortfall', teamNames: ['Otters', 'Bears'] })).json()).league;
    await post(s, '/league/settings/structure', { min_players: 3, max_players: 10 });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const ev = (await (await post(s, '/league/events', { date: '2099-06-07', season: 'S1', venue: 'Parc', start_time: '19:00' })).json()).event;
    const reg = (await (await post(s, '/league/contacts', { name: 'Reg One', role: 'roster', team: 'Otters' })).json()).contact;
    for (const n of ['Sub One', 'Sub Two', 'Sub Three', 'Sub Four']) await post(s, '/league/contacts', { name: n, role: 'sub_skater' });
    await post(s, '/league/rsvp/admin', { event_id: ev.id, player_id: reg.player_id, status: 'in' });
    const cfg = await getLeagueSeasonConfig(env, league.id);
    const st = await teamState(env.DB, ev.id, 'Otters', cfg);
    expect(st.skaters).toBe(1);
    expect(st.short).toBe(true);
    // Six people on file (3 per team x 2 teams): the setup step is done --
    // and the game is still short, because only one of them is in.
    await post(s, '/league/contacts', { name: 'Sub Five', role: 'sub_skater' });
    expect(await page(s, '/league/roster')).not.toContain('data-i18n="rosterProgressLabel"');
    expect((await teamState(env.DB, ev.id, 'Otters', cfg)).short).toBe(true);
  });
});

describe('8. Theme names are translated', () => {
  it('all four theme names switch with the language (Settings picker and the preview banner)', async () => {
    const s = await signup('p140.themes@example.com');
    const league = (await (await post(s, '/leagues/create', { name: 'P140 Themes', teamNames: ['A', 'B'] })).json()).league;
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const html = await page(s, '/league/settings');
    for (const [key, fr, en] of [
      ['themeArene', 'Arène (sombre, actuel)', 'Arena (dark, current)'],
      ['themeClean', 'Épuré (blanc, minimal)', 'Clean (white, minimal)'],
      ['themeClassique', 'Classique (couleurs de la ligue, gras)', 'Classic (bold, league colours)'],
      ['themeQuartier', 'Quartier (chaleureux, arrondi)', 'Neighbourhood (warm, rounded)']
    ]) {
      expect(html).toContain(`data-i18n="${key}"`);
      expect(html).toContain(`"${key}":"${fr}"`);
      expect(html).toContain(`"${key}":"${en}"`);
    }
    await post(s, '/league/settings/identity', { publicPageEnabled: true });
    const pub = await (await SELF.fetch(`http://example.com/league/public?league=${league.id}&theme=clean`)).text();
    expect(pub).toContain('Épuré');
    expect(pub).toContain('Preview of the Clean theme');
  });
});

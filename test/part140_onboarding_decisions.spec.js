// Onboarding decisions (items 1-7 of the onboarding follow-up).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

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

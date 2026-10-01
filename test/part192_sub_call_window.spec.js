// "Start calling subs" (src/sub_call_window.js): how long before a game a
// Notre Ligue league's subs may be called. 72 hours unless the league chose
// otherwise. SMBHL keeps its 8-day horizon.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { H, local, installMailCapture, removeMailCapture, admin, must, one } from './support/league_season.js';
import { callSubsForShortfall } from '../src/index.js';
import { getSubCallHours, SUB_CALL_HOURS_DEFAULT, SUB_CALL_HOURS_CHOICES, subCallWindowText } from '../src/sub_call_window.js';

const START = Date.UTC(2026, 9, 5, 16, 0); // Mon 2026-10-05 12:00 Toronto
let n = 0;

beforeAll(async () => {
  env.LEAGUE_PRODUCT = 'true';
  env.RESEND_API_KEY = 'x'; env.RSVP_SECRET = 'p192'; env.AUTH_SECRET = 'p192-auth';
  env.MAIL_DAILY_CAP = '';
  env.PUBLIC_URL = 'https://rsvp.example.com';
  vi.useFakeTimers({ toFake: ['Date'] });
  await applyRealSchema(env);
  installMailCapture();
});
beforeEach(() => { vi.setSystemTime(new Date(START)); });
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

// A fixed-teams league with two subs and no regular players: every team is
// short at every game, so a game inside the window calls subs at once.
async function league(tag) {
  const a = await admin(tag);
  const lg = (await must(a.post('/leagues/create', { name: `W ${tag}`, teamStructure: 'fixed', teamNames: ['Red', 'Blue'], tracksStats: true }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  for (const s of ['One', 'Two']) await must(a.post('/league/contacts', { name: `Sub ${s} ${tag}`, email: `sub.${s.toLowerCase()}.${tag}@example.com`, role: 'sub_skater', emailChoice: 'send' }), 'sub');
  return { a, id: lg.id };
}
async function game(leagueId, hoursOut) {
  const { date, time } = local(START + hoursOut * H);
  const id = `${leagueId}:g${++n}:${date}`;
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, home_team, away_team) VALUES (?, 'S1', 1, ?, 'Gym', 'open', ?, ?, 'Red', 'Blue')`)
    .bind(id, date, time, leagueId).run();
  return one('SELECT * FROM events WHERE id = ?', id);
}

describe('the setting', () => {
  it('is 72 hours for a league that never chose', async () => {
    expect(SUB_CALL_HOURS_DEFAULT).toBe(72);
    expect(await getSubCallHours(env.DB, 'no-such-league')).toBe(72);
  });

  it('accepts only the offered choices', async () => {
    const { a, id } = await league('route');
    const bad = await a.post('/league/settings/sub-calls', { hours: 50 });
    expect(bad.status).toBe(400);
    expect(bad.json.errorKey).toBe('SUB_CALL_HOURS_INVALID');
    for (const h of SUB_CALL_HOURS_CHOICES) {
      expect((await a.post('/league/settings/sub-calls', { hours: h })).status).toBe(200);
      expect(await getSubCallHours(env.DB, id)).toBe(h);
    }
  });

  it('the settings page offers it, and the players page names the window', async () => {
    const { a } = await league('page');
    await must(a.post('/league/settings/sub-calls', { hours: 48 }), 'save');
    const settings = (await a.get('/league/settings')).text;
    expect(settings).toContain('Commencer à appeler les remplaçants');
    expect(settings).toContain('Combien de temps avant un match on peut appeler les remplaçants quand il manque de joueurs.');
    expect(settings).toMatch(/<option value="48" selected[^>]*>48 heures avant<\/option>/);
    const roster = (await a.get('/league/roster')).text;
    expect(roster).toContain('quand un match des 48 heures à venir manque de joueurs');
    expect(roster).toContain('when a game in the next 48 hours is short of players');
    expect(roster).not.toMatch(/8 prochains jours|next 8 days/);
  });

  it('words the window in hours up to 72, then in days', () => {
    expect(subCallWindowText(24, 'fr')).toBe('24 heures');
    expect(subCallWindowText(72, 'en')).toBe('72 hours');
    expect(subCallWindowText(168, 'fr')).toBe('7 jours');
    expect(subCallWindowText(192, 'en')).toBe('8 days');
  });
});

describe('sub calls start only inside the window', () => {
  it('the default, 72 hours: a short game 75 hours out calls nobody, 70 hours out calls subs', async () => {
    const { id } = await league('default');
    expect(await callSubsForShortfall(env, await game(id, 75))).toBe(0);
    expect(await callSubsForShortfall(env, await game(id, 70))).toBeGreaterThan(0);
  });

  for (const hours of [24, 72, 192]) {
    it(`${hours} hours: just outside calls nobody, just inside calls subs`, async () => {
      const { a, id } = await league('w' + hours);
      await must(a.post('/league/settings/sub-calls', { hours }), 'save');
      // 192 is also the cron's own horizon: nothing beyond it is ever called.
      expect(await callSubsForShortfall(env, await game(id, hours + 3))).toBe(0);
      expect(await callSubsForShortfall(env, await game(id, hours - 3))).toBeGreaterThan(0);
    });
  }
});

// SMBHL keeps its 8-day horizon: proven by the SMBHL golden recording
// (test/part114_reminders_golden_smbhl.spec.js), unchanged by this setting,
// whose scenario sends SMBHL sub calls six days before the game. The
// setting's route refuses SMBHL (ROUTE_BLOCKED_CONTACTS).

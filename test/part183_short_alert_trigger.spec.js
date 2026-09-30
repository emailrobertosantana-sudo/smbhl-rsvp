// The "short of players" email to a league's admins: when it is sent.
//
// Never for a league still being set up: a team with no player on it, or
// nobody asked yet (more than 72 hours before the game, the hour the first
// reminder goes out). Once per game for a real shortage, however often it
// is checked. What it says is in test/part181_short_alert_copy.spec.js.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { H, DAY, local, mail, installMailCapture, removeMailCapture, admin, must, one, rows } from './support/league_season.js';
import { callSubsForShortfall, drain } from '../src/index.js';

const START = Date.UTC(2027, 2, 1, 16, 0);
beforeAll(async () => {
  env.LEAGUE_PRODUCT = 'true'; env.RESEND_API_KEY = 'x'; env.RSVP_SECRET = 'p181'; env.AUTH_SECRET = 'p181-auth'; env.MAIL_DAILY_CAP = ''; env.PUBLIC_URL = 'https://rsvp.example.com';
  vi.useFakeTimers({ toFake: ['Date'] });
  await applyRealSchema(env);
  installMailCapture();
});
beforeEach(() => { vi.setSystemTime(new Date(START)); mail.sent.length = 0; });
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

const EM_DASH = '—';
async function game(leagueId, home, away, at) {
  const { date, time } = local(at);
  const id = `${leagueId}:g:${date}`;
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, home_team, away_team, auto_reminders_enabled) VALUES (?, 'S1', 1, ?, 'Gym', 'open', ?, ?, ?, ?, 1)`).bind(id, date, time, leagueId, home, away).run();
  return one('SELECT * FROM events WHERE id = ?', id);
}
const alertRows = evId => rows(`SELECT id FROM outbox WHERE event_id = ? AND kind = 'short_alert'`, evId);
const alertsTo = tag => mail.sent.filter(m => m.to === `admin.${tag}@example.com` && /Short of players|Manque de joueurs/.test(m.subject));
// A fixed-teams league (minimum 1 goalie and 5 players a team, the default),
// with `bulls` and `parade` = [goalies, players] on each team.
async function fixed(tag, { bulls = [0, 0], parade = [0, 0], teamless = 0, lang = null } = {}) {
  const a = await admin(tag);
  const lg = (await must(a.post('/leagues/create', { name: `P181 ${tag}`, teamNames: ['Bulls', 'Parade'] }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  if (lang) await env.DB.prepare('UPDATE leagues SET language_mode = ? WHERE id = ?').bind(lang, lg.id).run();
  let n = 0;
  for (const [team, [g, p]] of [['Bulls', bulls], ['Parade', parade]]) {
    for (let i = 0; i < g; i++) await must(a.post('/league/contacts', { name: `${team} Goalie${String.fromCharCode(65 + i)}`, email: `${tag}.${++n}@example.com`, team, is_goalie: true }), 'g');
    for (let i = 0; i < p; i++) await must(a.post('/league/contacts', { name: `${team} Player${String.fromCharCode(65 + i)}`, email: `${tag}.${++n}@example.com`, team }), 'p');
  }
  for (let i = 0; i < teamless; i++) await must(a.post('/league/contacts', { name: `Nobody Team${String.fromCharCode(65 + i)}`, email: `${tag}.${++n}@example.com` }), 't');
  return { a, lg };
}
const min = async lg => { const r = await one('SELECT min_players, min_goalies FROM leagues WHERE id = ?', lg.id); return r; };

describe('Short of players: when it is sent', () => {
  it('a league being set up, its only player on no team: nothing, at any hour', async () => {
    const { lg } = await fixed('setup.noteam', { teamless: 1 });
    const at = START + 7 * DAY;
    const ev = await game(lg.id, 'Bulls', 'Parade', at);
    for (const t of [START, at - 71 * H, at - 20 * H, at - 3 * H]) {
      vi.setSystemTime(new Date(t));
      await callSubsForShortfall(env, ev);
      await drain(env);
    }
    expect(await alertRows(ev.id)).toHaveLength(0);
    expect(alertsTo('setup.noteam')).toHaveLength(0);
  });

  it('one team has players, the other has none yet: only the team that exists is reported', async () => {
    const { lg } = await fixed('setup.oneteam', { bulls: [1, 3] });
    const ev = await game(lg.id, 'Bulls', 'Parade', START + 2 * DAY);
    await callSubsForShortfall(env, ev);
    await drain(env);
    const [m] = alertsTo('setup.oneteam');
    expect(m.text).toContain('Bulls, players: 3 of 5 needed (confirmed or no reply yet).');
    expect(m.text).not.toContain('Parade');
  });

  it('nobody asked yet (more than 72 hours before the game): nothing; from the hour the first reminder goes out: the email', async () => {
    const { lg } = await fixed('early', { bulls: [1, 3], parade: [1, 6] });
    const at = START + 7 * DAY;
    const ev = await game(lg.id, 'Bulls', 'Parade', at);
    for (const t of [START, at - 5 * DAY, at - 73 * H]) {
      vi.setSystemTime(new Date(t));
      await callSubsForShortfall(env, ev);
      await drain(env);
    }
    expect(await alertRows(ev.id)).toHaveLength(0);
    expect(alertsTo('early')).toHaveLength(0);
    vi.setSystemTime(new Date(at - 71 * H));
    await callSubsForShortfall(env, ev);
    await drain(env);
    expect(alertsTo('early')).toHaveLength(1);
    expect(alertsTo('early')[0].text).toContain('Bulls, players: 3 of 5 needed (confirmed or no reply yet).');
  });

  it('a real shortage, checked again and again: one email for the game, to each admin once', async () => {
    const { lg } = await fixed('once', { bulls: [1, 3], parade: [1, 6] });
    const at = START + 2 * DAY;
    const ev = await game(lg.id, 'Bulls', 'Parade', at);
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(new Date(START + i * 15 * 60000));
      await callSubsForShortfall(env, ev);
      await drain(env);
    }
    // Later the same day, and the day of the game: still the one email.
    for (const t of [at - 30 * H, at - 20 * H, at - 3 * H]) {
      vi.setSystemTime(new Date(t));
      await callSubsForShortfall(env, ev);
      await drain(env);
    }
    expect(alertsTo('once')).toHaveLength(1);
    expect(await alertRows(ev.id)).toHaveLength(1);
    // Players were not told.
    expect(mail.sent.filter(m => m.to.startsWith('once.'))).toEqual([]);
  });
});

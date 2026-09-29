// D7 (decided 2026-09-29): renaming a team (Blue -> Navy) left its players
// behind on "Blue", so Navy's games reached nobody and Navy looked empty.
// A rename now moves everything that holds the team by name: players, and
// for the current season and every open game the matchup (results are
// keyed on it), answers, stats, team messages, unsent mail, and the
// season's own team list and standings. Closed seasons keep the name they
// had -- their history.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { H, DAY, local, mail, installMailCapture, removeMailCapture, admin, must, one, rows, pass } from './support/league_season.js';
import { getLeagueDataJson } from '../src/leagues.js';
import { teamRenames } from '../src/leagues.js';

const START = Date.UTC(2026, 9, 5, 16, 0);
beforeAll(async () => {
  env.LEAGUE_PRODUCT = 'true'; env.RESEND_API_KEY = 'x'; env.RSVP_SECRET = 'p161'; env.AUTH_SECRET = 'p161-auth'; env.MAIL_DAILY_CAP = ''; env.PUBLIC_URL = 'https://rsvp.example.com';
  vi.useFakeTimers({ toFake: ['Date'] });
  await applyRealSchema(env);
  installMailCapture();
});
beforeEach(() => { vi.setSystemTime(new Date(START)); mail.sent.length = 0; });
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

describe('Which list changes are renames', () => {
  it('a changed name at the same place, to a new name; not a reorder, an addition or a removal', () => {
    expect(teamRenames(['Red', 'Blue'], ['Red', 'Navy'])).toEqual([{ from: 'Blue', to: 'Navy' }]);
    expect(teamRenames(['Red', 'Blue'], ['Blue', 'Red'])).toEqual([]);
    expect(teamRenames(['Red', 'Blue'], ['Red', 'Blue', 'Green'])).toEqual([]);
    expect(teamRenames(['Red', 'Blue', 'Green'], ['Red', 'Blue'])).toEqual([]);
  });
});

describe('Renaming a team moves its players and everything else', () => {
  it('Blue -> Navy: nothing current or open is left on "Blue"; the closed season keeps it; Navy\'s players get their reminder', async () => {
    const a = await admin('d7');
    const lg = (await must(a.post('/leagues/create', { name: 'P161 League', teamNames: ['Red', 'Blue'], tracksStats: true }), 'create')).league;
    const ins = (id, season, date, time, state, home, away, extra = '') => env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, home_team, away_team, auto_reminders_enabled) VALUES (?, ?, 1, ?, 'Gym', ?, ?, ?, ?, ?, 1)`).bind(id, season, date, state, time, lg.id, home, away).run();
    // A closed season with a Blue game.
    await must(a.post('/league/season/publish', { season_name: 'S0' }), 'S0');
    await ins(`${lg.id}:s0:2026-01-10`, 'S0', '2026-01-10', '19:00', 'open', 'Red', 'Blue');
    const players = {};
    for (const t of ['Red', 'Blue']) for (let i = 0; i < 6; i++) players[`${t}${i}`] = (await must(a.post('/league/contacts', { name: `${t} P${i}`, email: `${t.toLowerCase()}.p${i}@example.com`, team: t, ...(i === 0 ? { is_goalie: true } : {}) }), 'p')).contact.player_id;
    const rsvp = (ev, pid, team, status = 'in') => env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, ?, ?, 'roster', 'self', ?, ?)`).bind(ev, pid, team, status, new Date().toISOString(), lg.id).run();
    await rsvp(`${lg.id}:s0:2026-01-10`, players.Blue1, 'Blue');
    await env.DB.prepare(`UPDATE events SET state = 'done', home_score = 2, away_score = 5, result_entered_at = ? WHERE id = ?`).bind(new Date().toISOString(), `${lg.id}:s0:2026-01-10`).run();
    // The current season: a played game Blue won, and one coming up in 3 days.
    await must(a.post('/league/season/publish', { season_name: 'S1' }), 'S1');
    const played = `${lg.id}:p:2026-10-01`;
    await ins(played, 'S1', '2026-10-01', '19:00', 'open', 'Red', 'Blue');
    await rsvp(played, players.Blue1, 'Blue');
    await env.DB.prepare(`UPDATE events SET home_score = 1, away_score = 4, result_entered_at = ? WHERE id = ?`).bind(new Date().toISOString(), played).run();
    await env.DB.prepare(`INSERT INTO player_game_stats (event_id, player_id, league_id, team, role, goals, assists, updated_at) VALUES (?, ?, ?, 'Blue', 'skater', 2, 1, ?)`).bind(played, players.Blue1, lg.id, new Date().toISOString()).run();
    const { date, time } = local(START + 3 * DAY);
    const next = `${lg.id}:n:${date}`;
    await ins(next, 'S1', date, time, 'open', 'Blue', 'Red');
    await rsvp(next, players.Blue2, 'Blue', 'out');
    await env.DB.prepare(`INSERT INTO team_messages (event_id, team, player_name, player_id, message, created_at, league_id) VALUES (?, 'Blue', 'Blue P3', ?, 'Maillots foncés', ?, ?)`).bind(next, players.Blue3, new Date().toISOString(), lg.id).run();
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, payload, send_after, created_at, league_id) VALUES ('sub_call', ?, NULL, 'Blue', '{}', ?, ?, ?)`).bind(next, new Date(START + 30 * DAY).toISOString(), new Date().toISOString(), lg.id).run(); // waits (never sent here)

    const r = await a.post('/league/settings/teams', { teamNames: ['Red', 'Navy'] });
    expect(r.status).toBe(200);
    expect(r.json.renamed).toEqual([{ from: 'Blue', to: 'Navy' }]);

    // Players.
    expect((await rows(`SELECT preferred_team t FROM contacts WHERE league_id = ? AND role = 'roster'`, lg.id)).filter(x => x.t === 'Blue')).toEqual([]);
    expect((await rows(`SELECT preferred_team t FROM contacts WHERE league_id = ? AND preferred_team = 'Navy'`, lg.id))).toHaveLength(6);
    // The current season and open games: nothing left on Blue.
    const s1 = [played, next];
    for (const ev of s1) {
      const e = await one('SELECT home_team, away_team FROM events WHERE id = ?', ev);
      expect([e.home_team, e.away_team]).not.toContain('Blue');
      expect([e.home_team, e.away_team]).toContain('Navy');
      expect(await rows(`SELECT 1 FROM rsvp WHERE event_id = ? AND team = 'Blue'`, ev)).toEqual([]);
      expect(await rows(`SELECT 1 FROM player_game_stats WHERE event_id = ? AND team = 'Blue'`, ev)).toEqual([]);
      expect(await rows(`SELECT 1 FROM team_messages WHERE event_id = ? AND team = 'Blue'`, ev)).toEqual([]);
    }
    expect((await one(`SELECT team FROM player_game_stats WHERE event_id = ?`, played)).team).toBe('Navy');
    expect((await one(`SELECT team FROM team_messages WHERE event_id = ?`, next)).team).toBe('Navy');
    expect((await one(`SELECT team FROM outbox WHERE event_id = ? AND kind = 'sub_call'`, next)).team).toBe('Navy');
    const data = await getLeagueDataJson(env, lg.id);
    const S1 = data.seasons.find(x => x.name === 'S1'), S0 = data.seasons.find(x => x.name === 'S0');
    expect(JSON.stringify(S1.config.teams)).toContain('Navy');
    expect(JSON.stringify(S1.config.teams)).not.toContain('Blue');
    expect(JSON.stringify(S1.standings || [])).not.toContain('Blue');
    // The closed season keeps its history.
    expect(JSON.stringify(S0.config.teams)).toContain('Blue');
    expect((await one('SELECT away_team FROM events WHERE id = ?', `${lg.id}:s0:2026-01-10`)).away_team).toBe('Blue');
    expect((await one('SELECT team FROM rsvp WHERE event_id = ?', `${lg.id}:s0:2026-01-10`)).team).toBe('Blue');
    // Standings: Navy has Blue's win.
    const pub = (await a.get('/' + lg.slug)).text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(pub).toMatch(/Navy 1 1 0/);
    expect(pub).not.toMatch(/Blue \d/);

    // The original bug: Navy's players get the reminder for Navy's game.
    mail.sent.length = 0;
    for (let t = START + H; t <= START + 2 * DAY; t += H) await pass(t);
    const got = new Set(mail.sent.filter(m => /décidé|decided/.test(m.subject)).map(m => m.to));
    for (let i = 0; i < 6; i++) if (i !== 2) expect(got.has(`blue.p${i}@example.com`)).toBe(true); // Blue2 said out
  }, 120000);
});

// D3 (decided 2026-09-29): a short game with no sub to call did nothing and
// told nobody (the no-teams fixture: 8 players against a minimum of 10).
// The league's admins are now emailed that the game is short -- once per
// game, every shortage in one email -- and not while a called sub has yet
// to answer. Players are not told. Inside the last 24 h, in a league with
// no subs, only players who said yes count (the fixture's case: 2 never
// answered, so "available" said 10 while 8 came).
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { H, DAY, local, mail, installMailCapture, removeMailCapture, admin, must, one, rows } from './support/league_season.js';
import { callSubsForShortfall, drain } from '../src/index.js';

const START = Date.UTC(2026, 9, 5, 16, 0);
beforeAll(async () => {
  env.LEAGUE_PRODUCT = 'true'; env.RESEND_API_KEY = 'x'; env.RSVP_SECRET = 'p159'; env.AUTH_SECRET = 'p159-auth'; env.MAIL_DAILY_CAP = ''; env.PUBLIC_URL = 'https://rsvp.example.com';
  vi.useFakeTimers({ toFake: ['Date'] });
  await applyRealSchema(env);
  installMailCapture();
});
beforeEach(() => { vi.setSystemTime(new Date(START)); mail.sent.length = 0; });
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

async function game(leagueId, home = null, away = null, at = START + 3 * DAY) {
  const { date, time } = local(at);
  const id = `${leagueId}:g:${date}`;
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, home_team, away_team, auto_reminders_enabled) VALUES (?, 'S1', 1, ?, 'Gym', 'open', ?, ?, ?, ?, 1)`).bind(id, date, time, leagueId, home, away).run();
  return one('SELECT * FROM events WHERE id = ?', id);
}
const alertRows = evId => rows(`SELECT id FROM outbox WHERE event_id = ? AND kind = 'short_alert'`, evId);
const adminAlerts = who => mail.sent.filter(m => m.to === `admin.${who}@example.com` && /Short of players/.test(m.subject));
async function noTeams(tag, players) {
  const a = await admin(tag);
  const lg = (await must(a.post('/leagues/create', { name: `P159 ${tag}`, teamStructure: 'headcount', minPlayers: 10, maxPlayers: 12, minGoalies: 0 }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  const ids = [];
  for (let i = 0; i < players; i++) ids.push((await must(a.post('/league/contacts', { name: `${tag} P${i}`, email: `${tag}.p${i}@example.com` }), 'p')).contact.player_id);
  return { a, lg, ids };
}
const answer = (ev, pid, status) => env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, 'Tous', ?, 'roster', 'self', ?, ?)`).bind(ev.id, pid, status, new Date().toISOString(), ev.league_id).run();

describe('A short game with no subs tells the admin', () => {
  it('no-teams, 8 players against a minimum of 10, no subs: one email to the admin, none to players', async () => {
    const { lg } = await noTeams('hc', 8);
    const ev = await game(lg.id);
    expect(await callSubsForShortfall(env, ev)).toBe(0);
    await drain(env);
    expect(adminAlerts('hc')).toHaveLength(1);
    const m = adminAlerts('hc')[0];
    expect(m.subject).toMatch(/^Manque de joueurs · .+ \/ Short of players · /);
    expect(m.text).toContain("Joueurs : 8 sur 10 requis (confirmés ou sans réponse). Il ne reste aucun substitut à appeler. Vos joueurs n'ont pas été avisés de ce manque.");
    expect(m.text).toContain('Players: 8 of 10 needed (confirmed or no reply yet). No substitutes are left to call. Your players have not been told about this shortage.');
    expect(m.text).not.toContain('Tous');
    expect(mail.sent.filter(x => x.to.startsWith('hc.'))).toEqual([]);
    // Once per game.
    await callSubsForShortfall(env, ev);
    await drain(env);
    expect(adminAlerts('hc')).toHaveLength(1);
    expect(await alertRows(ev.id)).toHaveLength(1);
  });

  it('the fixture\'s case: 2 never answer -- no alert while they might, then in the last 24 h only the 8 who said yes count', async () => {
    const { lg, ids } = await noTeams('late', 12);
    const at = START + 3 * DAY;
    const ev = await game(lg.id, null, null, at);
    for (const [i, pid] of ids.entries()) if (i < 10) await answer(ev, pid, i < 8 ? 'in' : 'out');
    // 8 in, 2 out, 2 not answered: 10 counted available -- not short yet.
    expect(await callSubsForShortfall(env, ev)).toBe(0);
    expect(await alertRows(ev.id)).toHaveLength(0);
    vi.setSystemTime(new Date(at - 20 * H));
    await callSubsForShortfall(env, ev);
    await drain(env);
    expect(adminAlerts('late')).toHaveLength(1);
    expect(adminAlerts('late')[0].text).toContain('Players: 8 of 10 needed (confirmed).');
    expect(adminAlerts('late')[0].text).toContain('Joueurs : 8 sur 10 requis (confirmés).');
  });

  it('fixed teams: not while a called sub has yet to answer; once they decline, one email names each short team', async () => {
    const a = await admin('fx');
    const lg = (await must(a.post('/leagues/create', { name: 'P159 Fixed', teamNames: ['Red', 'Blue'] }), 'create')).league;
    await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
    for (let i = 0; i < 7; i++) await must(a.post('/league/contacts', { name: `Blue P${i}`, email: `blue.p${i}@example.com`, team: 'Blue', ...(i === 0 ? { is_goalie: true } : {}) }), 'b');
    await must(a.post('/league/contacts', { name: 'Red Goalie', email: 'red.g@example.com', team: 'Red', is_goalie: true }), 'r');
    for (let i = 0; i < 3; i++) await must(a.post('/league/contacts', { name: `Red P${i}`, email: `red.p${i}@example.com`, team: 'Red' }), 'r');
    const sub = (await must(a.post('/league/contacts', { name: 'Only Sub', email: 'only.sub@example.com', role: 'sub_skater' }), 's')).contact.player_id;
    const ev = await game(lg.id, 'Red', 'Blue');
    expect(await callSubsForShortfall(env, ev)).toBe(1); // Red: 3 skaters < 5; the one sub is called
    expect(await alertRows(ev.id)).toHaveLength(0);
    expect(await callSubsForShortfall(env, ev)).toBe(0); // nobody left, but the sub may still say yes
    expect(await alertRows(ev.id)).toHaveLength(0);
    await env.DB.prepare(`INSERT INTO availability (event_id, player_id, need, status, answered_at, league_id) VALUES (?, ?, 'skater', 'no', ?, ?)`).bind(ev.id, sub, new Date().toISOString(), lg.id).run();
    await callSubsForShortfall(env, ev);
    expect(await alertRows(ev.id)).toHaveLength(1);
    await drain(env);
    const m = adminAlerts('fx')[0];
    expect(m.text).toContain('Red, joueurs : 3 sur 5 requis (confirmés ou sans réponse).');
    expect(m.text).toContain('Red, players: 3 of 5 needed (confirmed or no reply yet).');
    expect(m.text).not.toContain('Blue');
  });
});

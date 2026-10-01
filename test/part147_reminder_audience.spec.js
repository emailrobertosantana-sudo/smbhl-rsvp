// A league game's reminders go to the players IN that game. In a fixed-
// teams league with three teams and two games a night, every player used
// to be reminded about both games -- including the one their team isn't
// in (getNonResponders took every player with a team). Now a game with a
// matchup is for its two teams; a game with no matchup yet stays
// league-wide (nobody knows who plays). SMBHL is not on this path: its
// reminders are per night, to the whole league (runSchedule), unchanged.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { getNonResponders, getConfirmedPlayers, runLeagueReminders } from '../src/index.js';
import { formatEventTime } from '../src/date_format.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.147.${++ip}` },
    body: JSON.stringify({ accept_terms: true, email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = async (s, path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

function montreal(hoursAhead) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(Date.now() + hoursAhead * 3600000));
  const g = t => parts.find(p => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}

// A league with its teams and 2 players per team; returns ids.
async function league(tag, teams) {
  const s = await signup(`p147.${tag}@example.com`);
  const lg = (await (await post(s, '/leagues/create', { name: `P147 ${tag}`, teamNames: teams })).json()).league;
  await post(s, '/league/season/publish', { season_name: 'S1' });
  await post(s, '/league/reminders/settings', { reminder72h: true, reminder24h: true, reminder12h: true });
  const players = {};
  for (const t of teams) for (const n of [1, 2]) {
    const c = (await (await post(s, '/league/contacts', { name: `${t} Player${n}`, role: 'roster', team: t, email: `${tag}.${t.toLowerCase()}${n}@example.com` })).json()).contact;
    (players[t] = players[t] || []).push(c.player_id);
  }
  return { s, id: lg.id, players };
}
// A game inserted directly (so the create-time window-skip rule doesn't
// mark its already-open windows as skipped).
async function game(leagueId, idSuffix, hoursAhead, home, away) {
  const { date, time } = montreal(hoursAhead);
  const id = `${leagueId}:${idSuffix}:${date}`;
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, home_team, away_team, auto_reminders_enabled) VALUES (?, 'S1', 1, ?, 'Gym', 'open', ?, ?, ?, ?, 1)`)
    .bind(id, date, time, leagueId, home, away).run();
  return id;
}
const teamOf = (lg, pid) => Object.keys(lg.players).find(t => lg.players[t].includes(pid));

beforeAll(async () => {
  env.AUTH_SECRET = 'p147-auth'; env.RSVP_SECRET = 'p147'; env.RESEND_API_KEY = 'p147';
  await applyRealSchema(env);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('3 teams, two games a night: each game reminds only its two teams', () => {
  it('the 72h/24h audience (getNonResponders) and the 12h audience (getConfirmedPlayers) are the game\'s teams', async () => {
    const lg = await league('three', ['Red', 'Blue', 'White']);
    const g1 = await game(lg.id, 'a', 60, 'Blue', 'White');
    const g2 = await game(lg.id, 'b', 61, 'White', 'Red');
    const teams1 = (await getNonResponders(env, lg.id, g1, 'S1')).map(c => teamOf(lg, c.player_id));
    const teams2 = (await getNonResponders(env, lg.id, g2, 'S1')).map(c => teamOf(lg, c.player_id));
    expect([...new Set(teams1)].sort()).toEqual(['Blue', 'White']);
    expect([...new Set(teams2)].sort()).toEqual(['Red', 'White']);
    expect(teams1.length).toBe(4);
    // Confirmed for the 12h details: a Red player marked in on g1 (Red isn't in it) is not told.
    for (const [pid, team] of [[lg.players.Blue[0], 'Blue'], [lg.players.Red[0], 'Red']]) {
      await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, ?, 'in', 'roster', 'self', ?, ?)`).bind(g1, pid, team, new Date().toISOString(), lg.id).run();
    }
    expect((await getConfirmedPlayers(env, lg.id, g1)).map(c => c.player_id)).toEqual([lg.players.Blue[0]]);
  });

  // Nights (D1, 2026-09-30): the two games are one night -- one 72h email
  // per player, about their team's games that night: White's lists both.
  it('through the real cron pass: one 72h email per player for the night, about their own team\'s games', async () => {
    const lg = await league('cron', ['Red', 'Blue', 'White']);
    const h1 = montreal(60).time >= '22:30' ? 57 : 60; // both games on the same day
    const g1 = await game(lg.id, 'a', h1, 'Blue', 'White');
    const g2 = await game(lg.id, 'b', h1 + 1, 'White', 'Red');
    const sent = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('api.resend.com')) { sent.push(JSON.parse(opts.body).to[0]); return new Response('{"id":"x"}', { status: 200 }); }
      return new Response('{}', { status: 404 });
    };
    try { await runLeagueReminders(env); } finally { globalThis.fetch = original; }
    const rows = (await env.DB.prepare(`SELECT event_id, player_id, payload FROM outbox WHERE league_id = ? AND kind = 'reminder_72h'`).bind(lg.id).all()).results;
    expect(rows.length).toBe(6);
    expect(rows.every(r => r.event_id === g1)).toBe(true); // the night's first game
    for (const t of ['red', 'blue', 'white']) expect(sent.filter(to => to.startsWith('cron.' + t)).length).toBe(2); // 2 players, 1 email each
    const textOf = t => JSON.parse(rows.find(r => teamOf(lg, r.player_id) === t).payload).prerendered.text;
    const startOf = async id => (await env.DB.prepare('SELECT start_time FROM events WHERE id = ?').bind(id).first()).start_time;
    const [t1, t2] = [await startOf(g1), await startOf(g2)];
    const fmt = hhmm => formatEventTime(hhmm, 'en');
    expect(textOf('White')).toContain(`${fmt(t1)} and ${fmt(t2)}`);
    expect(textOf('Blue')).not.toContain(fmt(t2));
    expect(textOf('Red')).toContain(fmt(t2));
    expect(textOf('Red')).not.toContain(` ${fmt(t1)}`);
    // Logged for both games: the next pass sends nothing more.
    const logged = (await env.DB.prepare(`SELECT event_id FROM league_reminder_log WHERE kind = 'reminder_72h' AND event_id IN (?, ?)`).bind(g1, g2).all()).results;
    expect(logged.length).toBe(2);
  });

  it('the event page\'s "remind now" count is the game\'s teams too', async () => {
    const lg = await league('page', ['Red', 'Blue', 'White']);
    const g = await game(lg.id, 'a', 60, 'Blue', 'White');
    const html = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(g)}`, { headers: { cookie: lg.s.cookie } })).text();
    expect(html).toContain('var EV_REMIND_NOW_COUNT = 4;');
  });
});

describe('Unchanged where it was right', () => {
  it('a single game between the only two teams: the whole league, as before', async () => {
    const lg = await league('two', ['Otters', 'Bears']);
    const g = await game(lg.id, 'a', 60, 'Otters', 'Bears');
    expect((await getNonResponders(env, lg.id, g, 'S1')).length).toBe(4);
  });
  it('a game with no matchup yet: the whole league (nobody knows who plays yet)', async () => {
    const lg = await league('nomatch', ['Red', 'Blue', 'White']);
    const g = await game(lg.id, 'a', 60, null, null);
    expect((await getNonResponders(env, lg.id, g, 'S1')).length).toBe(6);
  });
});

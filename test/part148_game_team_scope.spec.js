// The shortage check, sub placement, wave stopping and the status displays
// work on the teams IN the game (gameTeamNames): a league's fixed-teams game
// with a matchup is its two teams. They used to loop over every team in the
// league, so a team not playing -- nobody of theirs in the game -- looked
// short: subs got called for it, placed on it, and the waves never stopped.
// SMBHL (a night where every team plays) is unchanged; the golden cron
// records prove it.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { callSubsForShortfall, stopWaves, maybeInviteSubsForShortage, gameTeamNames, acceptAvailability } from '../src/index.js';
import { getLeagueSeasonConfig } from '../src/leagues.js';
import { DEFAULT_SEASON_CONFIG } from '../src/season_config.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.148.${++ip}` },
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

// Red has nobody; Blue and White are full rosters. Two subs in the pool.
async function league(tag) {
  const s = await signup(`p148.${tag}@example.com`);
  const lg = (await (await post(s, '/leagues/create', { name: `P148 ${tag}`, teamNames: ['Red', 'Blue', 'White'] })).json()).league;
  await post(s, '/league/season/publish', { season_name: 'S1' });
  const cfg = await getLeagueSeasonConfig(env, lg.id, 'S1');
  const ins = async (pid, team, role, goalie) => env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id, preferred_team, is_active) VALUES (?, ?, ?, ?, ?, ?, 's', ?, ?, 1)`)
    .bind(pid, `${pid} X`, `${pid.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.com`, role, role === 'roster' ? 0 : 1, goalie ? 1 : 0, lg.id, team).run();
  const roster = {};
  for (const team of ['Blue', 'White']) {
    roster[team] = [];
    for (let i = 0; i < cfg.skatersPerTeam; i++) { const pid = `${lg.id}:${team}${i}`; await ins(pid, team, 'roster', false); roster[team].push(pid); }
    const g = `${lg.id}:${team}G`; await ins(g, team, 'roster', true); roster[team].push(g);
  }
  for (const n of [1, 2]) await ins(`${lg.id}:SUB${n}`, null, 'sub_skater', false);
  return { s, id: lg.id, cfg, roster };
}
async function game(lg, suffix, hoursAhead, home, away) {
  const { date, time } = montreal(hoursAhead);
  const id = `${lg.id}:${suffix}:${date}`;
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, home_team, away_team, auto_reminders_enabled) VALUES (?, 'S1', 1, ?, 'Gym', 'open', ?, ?, ?, ?, 1)`)
    .bind(id, date, time, lg.id, home, away).run();
  return env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
}
const calls = async evId => (await env.DB.prepare(`SELECT team, cancelled FROM outbox WHERE event_id = ? AND kind = 'sub_call'`).bind(evId).all()).results;

beforeAll(async () => {
  env.AUTH_SECRET = 'p148-auth'; env.RSVP_SECRET = 'p148';
  await applyRealSchema(env);
});

describe('The teams a game involves', () => {
  it('a league game with a matchup is its two teams; no matchup, or SMBHL, is every team', () => {
    const cfg = { ...DEFAULT_SEASON_CONFIG, teams: ['Red', 'Blue', 'White'].map(name => ({ name })), teamStructure: 'fixed' };
    expect(gameTeamNames({ league_id: 'lg', home_team: 'Blue', away_team: 'White' }, cfg)).toEqual(['Blue', 'White']);
    expect(gameTeamNames({ league_id: 'lg', home_team: null, away_team: null }, cfg)).toEqual(['Red', 'Blue', 'White']);
    expect(gameTeamNames({ league_id: 'smbhl', home_team: 'Blue', away_team: 'White' }, cfg)).toEqual(['Red', 'Blue', 'White']);
    expect(gameTeamNames({ league_id: 'lg', home_team: 'Blue', away_team: 'White' }, { ...cfg, teamStructure: 'weekly_draw' })).toEqual(['Red', 'Blue', 'White']);
  });
});

describe('Shortfall check', () => {
  it('calls subs only for a team in the game: Red (empty) is not short on a Blue vs White game', async () => {
    const lg = await league('short');
    const bw = await game(lg, 'bw', 60, 'Blue', 'White');
    expect(await callSubsForShortfall(env, bw)).toBe(0);
    expect(await calls(bw.id)).toEqual([]);
    // Red IS short on a game it plays.
    const rb = await game(lg, 'rb', 61, 'Red', 'Blue');
    expect(await callSubsForShortfall(env, rb)).toBeGreaterThan(0);
    expect([...new Set((await calls(rb.id)).map(c => c.team))]).toEqual(['Red']);
  });

  it('a player out on a game their team is not in calls nobody', async () => {
    const lg = await league('out');
    const bw = await game(lg, 'bw', 60, 'Blue', 'White');
    const redPlayer = `${lg.id}:REDX`;
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, token_salt, league_id, preferred_team, is_active) VALUES (?, 'Red Guy', 'redx@example.com', 'roster', 0, 's', ?, 'Red', 1)`).bind(redPlayer, lg.id).run();
    await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, 'Red', 'out', 'roster', 'self', ?, ?)`).bind(bw.id, redPlayer, new Date().toISOString(), lg.id).run();
    const contact = await env.DB.prepare('SELECT * FROM contacts WHERE player_id = ?').bind(redPlayer).first();
    const r = await maybeInviteSubsForShortage(env, lg.id, bw, contact);
    expect(r).toEqual({ invited: 0, reason: 'team-not-in-game' });
  });
});

describe('Placing a sub who accepts', () => {
  it('only on a team that is playing -- never on Red for a Blue vs White game', async () => {
    const lg = await league('place');
    const bw = await game(lg, 'bw', 60, 'Blue', 'White');
    const r = await acceptAvailability(env, bw, `${lg.id}:SUB1`, 'skater');
    expect(['Blue', 'White']).toContain(r.placed);
  });

  it('when the playing teams are full: waitlisted, not placed on the team with room that is not playing', async () => {
    const lg = await league('full');
    const bw = await game(lg, 'bw', 60, 'Blue', 'White');
    for (const team of ['Blue', 'White']) for (const pid of lg.roster[team]) {
      await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, ?, 'in', 'roster', 'self', ?, ?)`).bind(bw.id, pid, team, new Date().toISOString(), lg.id).run();
    }
    const r = await acceptAvailability(env, bw, `${lg.id}:SUB2`, 'skater');
    expect(r.placed).toBeNull();
  });
});

describe('Stopping the waves', () => {
  it('pending calls are cancelled once the playing teams are full, whatever Red looks like', async () => {
    const lg = await league('waves');
    const bw = await game(lg, 'bw', 60, 'Blue', 'White');
    for (const n of [1, 2]) {
      await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at, league_id) VALUES ('sub_call', ?, ?, 'Blue', ?, '{"need":"skater"}', ?, ?, ?)`)
        .bind(bw.id, `${lg.id}:SUB${n}`, `call:${bw.id}:skater:${lg.id}:SUB${n}`, new Date(Date.now() + 3600000).toISOString(), new Date().toISOString(), lg.id).run();
    }
    for (const team of ['Blue', 'White']) for (const pid of lg.roster[team]) {
      await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, ?, 'in', 'roster', 'self', ?, ?)`).bind(bw.id, pid, team, new Date().toISOString(), lg.id).run();
    }
    await stopWaves(env, bw.id, 'skater', lg.cfg);
    expect((await calls(bw.id)).map(c => c.cancelled)).toEqual([1, 1]);
  });
});

describe('Status displays', () => {
  it('the event status route lists the two teams in the game', async () => {
    const lg = await league('status');
    const bw = await game(lg, 'bw', 60, 'Blue', 'White');
    const res = await (await SELF.fetch(`http://example.com/league/events/status?e=${encodeURIComponent(bw.id)}`, { headers: { cookie: lg.s.cookie } })).json();
    expect(res.teams.map(t => t.team)).toEqual(['Blue', 'White']);
  });
  it('the "invite subs" button refuses a team not in the game', async () => {
    const lg = await league('button');
    const bw = await game(lg, 'bw', 60, 'Blue', 'White');
    const res = await post(lg.s, '/league/events/invite-subs', { event_id: bw.id, team: 'Red', need: 'skater' });
    expect(res.status).toBe(400);
    expect((await res.json()).errorKey).toBe('TEAM_NOT_IN_GAME');
  });
});

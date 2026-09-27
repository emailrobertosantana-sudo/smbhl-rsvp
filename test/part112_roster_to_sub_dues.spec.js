// A regular who converts to sub is charged, per game, for the games they
// already played this season.
//
// Production: Yannick Gauthier (P0271) played one game as a roster
// player (rsvp role 'roster'), never paid, then became a sub. Finance
// showed him owing nothing. Cause: finance COMPUTES sub dues (games x sub
// rate) and counted a sub's games only from rsvp rows with role = 'sub'
// (plus data.json's current-season stats, where he has none) -- his game
// is a 'roster' row, so it counted 0 and he was left out entirely.
// Nothing ever creates a player_dues row automatically; those rows hold
// payments / custom amounts the admin records.
//
// Now a current sub is charged the sub rate for every game they played
// this season (status 'in' on a completed event, whatever their role
// then), with any payment toward the season fee credited, and a credit
// shown as a credit.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const ADMIN_KEY = 'test-part112-admin';
const SEASON = 'Fall 2026';
const DONE = ['2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27', '2026-10-04'];
const CANCELLED = '2026-10-11';
const OPEN = '2026-10-18';

const admin = (path, body) => SELF.fetch('http://example.com' + path, {
  method: body ? 'POST' : 'GET', headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
});
async function finance() {
  const res = await admin(`/admin/finances/data?s=${encodeURIComponent(SEASON)}`);
  expect(res.status).toBe(200);
  const d = await res.json();
  return { d, row: id => d.players.find(p => p.player_id === id) };
}
const played = (pid, events, role = 'roster', team = 'Red') => Promise.all(events.map(ev => env.DB.prepare(
  `INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, ?, 'in', ?, ?, 'smbhl')`
).bind(ev, pid, team, role, new Date().toISOString()).run()));
const contact = (pid, role, goalie = false) => env.DB.prepare(
  `INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, ?, ?, ?, 's', 'smbhl')`
).bind(pid, pid, `${pid.toLowerCase()}@example.com`, role, role === 'roster' ? 0 : 1, goalie ? 1 : 0).run();
const convert = (pid, role = 'sub_skater') => admin('/admin/contacts', { action: 'add', player_id: pid, role });

beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  await applyRealSchema(env);
  for (const d of DONE) await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, ?, 1, 'done', '20:30', 'smbhl')`).bind(d, d, SEASON).run();
  await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, ?, 6, 'cancelled', '20:30', 'smbhl')`).bind(CANCELLED, CANCELLED, SEASON).run();
  await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, ?, 7, 'open', '20:30', 'smbhl')`).bind(OPEN, OPEN, SEASON).run();
  await env.DB.prepare(`INSERT INTO season_pricing (season, price_player, price_goalie, price_sub_player, price_sub_goalie, etransfer_phone, updated_at) VALUES (?, 170, 85, 5, 3, '', ?)`).bind(SEASON, new Date().toISOString()).run();
  // In the league's records (data.json) but, like Yannick, with no current-season stats.
  await env.SHEETS_KV.put('data_json', JSON.stringify({
    current_season: SEASON, seasons: [{ name: SEASON, standings: [], fixtures: [] }],
    players: ['CONV3', 'CONVPAID', 'CONVG', 'ALWAYSSUB'].map(id => ({ id, name: id, seasons: { 'Winter 2026': { team: 'Red', gp: 10 } } }))
  }));

  // A: regular, no contacts row (SMBHL seeds roster rsvp from data.json), 3 games + a cancelled one + an upcoming one.
  await played('CONV3', [...DONE.slice(0, 3), CANCELLED, OPEN]);
  // B: regular with a contact, paid the 170 season fee, 5 games.
  await contact('CONVPAID', 'roster');
  await played('CONVPAID', DONE);
  await env.DB.prepare(`INSERT INTO player_dues (season, player_id, amount_paid, updated_at) VALUES (?, 'CONVPAID', 170, ?)`).bind(SEASON, new Date().toISOString()).run();
  // D: rostered goalie, 2 games in net.
  await contact('CONVG', 'roster', true);
  await played('CONVG', DONE.slice(0, 2));
  // C: always a sub, 2 games as a sub.
  await contact('ALWAYSSUB', 'sub_skater');
  await played('ALWAYSSUB', DONE.slice(0, 2), 'sub');
});

describe('Roster -> sub conversion: retroactive per-game dues', () => {
  it('before converting, the regulars owe the season fee and the always-sub owes 2 x 5', async () => {
    const { row } = await finance();
    expect(row('CONVPAID')).toMatchObject({ is_sub: false, total_due: 170, amount_paid: 170, outstanding: 0 });
    expect(row('ALWAYSSUB')).toMatchObject({ is_sub: true, games_played: 2, total_due: 10 });
  });

  it('a regular with 3 games converting to sub is charged 3 x the sub rate; a cancelled game and an upcoming one do not count; previous_role is recorded', async () => {
    expect((await convert('CONV3')).status).toBe(200);
    const c = await env.DB.prepare(`SELECT role, is_sub, previous_role FROM contacts WHERE player_id = 'CONV3'`).first();
    expect(c).toEqual({ role: 'sub_skater', is_sub: 1, previous_role: 'roster' });
    const { row } = await finance();
    expect(row('CONV3')).toMatchObject({ is_sub: true, games_played: 3, total_due: 15, amount_paid: 0, outstanding: 15, credit: 0, status: 'unpaid' });
  });

  it('a regular who paid the 170 season fee and played 5 games converts into a CREDIT of 145, not zero', async () => {
    expect((await convert('CONVPAID')).status).toBe(200);
    expect((await env.DB.prepare(`SELECT previous_role FROM contacts WHERE player_id = 'CONVPAID'`).first()).previous_role).toBe('roster');
    const { d, row } = await finance();
    expect(row('CONVPAID')).toMatchObject({ is_sub: true, games_played: 5, total_due: 25, amount_paid: 170, outstanding: -145, credit: 145 });
    expect(d.summary.totalCredit).toBeGreaterThanOrEqual(145);
    // The finance page shows a credit as "+145 $ credit", never "0 $".
    const html = await (await admin('/admin/finances')).text();
    const creditBranch = html.indexOf("if (p.outstanding < 0) {");
    const zeroBranch = html.indexOf("} else if (p.outstanding === 0 && p.total_due > 0) {");
    expect(creditBranch).toBeGreaterThan(-1);
    expect(zeroBranch).toBeGreaterThan(creditBranch);
  });

  it('a goalie is charged the goalie sub rate for games played in net', async () => {
    expect((await convert('CONVG', 'sub_goalie')).status).toBe(200);
    const { row } = await finance();
    expect(row('CONVG')).toMatchObject({ is_sub: true, is_goalie: true, games_played: 2, total_due: 6 });
  });

  it('a player who was always a sub is unaffected', async () => {
    const { row } = await finance();
    expect(row('ALWAYSSUB')).toMatchObject({ is_sub: true, games_played: 2, total_due: 10, credit: 0 });
    expect((await env.DB.prepare(`SELECT previous_role FROM contacts WHERE player_id = 'ALWAYSSUB'`).first()).previous_role).toBeNull();
  });
});

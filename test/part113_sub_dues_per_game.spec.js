// Subs are charged per GAME, not per night.
//
// SMBHL plays two games per player per night, and one event (events.id
// is a date) is one night. Finance counted a sub's events and charged
// events x sub rate -- half. Production: Yannick Gauthier (P0271), one
// event on 2026-09-20 (two games), charged $5 instead of $10.
//
// Now: events x gamesPerNight x sub rate. gamesPerNight lives in the
// season config (season_config.js): 2 for SMBHL when its season doesn't
// set one, 1 for any other league with none, a season's own value wins.
// Subs whose dues row already recorded a payment are settled: migrate-
// 052.sql snapshots their nights (settled_nights), which stay at one
// game each; only later nights count in full.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { gamesPerNight, getSeasonConfig, normalizeSeasonConfig, SMBHL_GAMES_PER_NIGHT, DEFAULT_GAMES_PER_NIGHT } from '../src/season_config.js';
import { SMBHL_LEAGUE_ID } from '../src/league_ids.js';
import mig052 from '../migrate-052.sql?raw';

const ADMIN_KEY = 'test-part113-admin';
const SEASON = 'Fall 2026';
const ONE_A_NIGHT = 'Summer 2026';
const admin = path => SELF.fetch('http://example.com' + path, { headers: { 'x-admin': ADMIN_KEY } });
async function finance(season = SEASON) {
  const res = await admin(`/admin/finances/data?s=${encodeURIComponent(season)}`);
  expect(res.status).toBe(200);
  const d = await res.json();
  return id => d.players.find(p => p.player_id === id);
}
const ev = (id, season, state = 'done') => env.DB.prepare(
  `INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, ?, 1, ?, '10:30', 'smbhl')`
).bind(id, id, season, state).run();
const played = (pid, events, role = 'sub') => Promise.all(events.map(e => env.DB.prepare(
  `INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, 'Red', 'in', ?, ?, 'smbhl')`
).bind(e, pid, role, new Date().toISOString()).run()));
const contact = (pid, role, goalie = false) => env.DB.prepare(
  `INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, ?, ?, ?, 's', 'smbhl')`
).bind(pid, pid, `${pid.toLowerCase()}@example.com`, role, role === 'roster' ? 0 : 1, goalie ? 1 : 0).run();
// migrate-052.sql's snapshot statement, run as written against seeded data.
const snapshotStatement = mig052.split('\n').map(l => l.split('--')[0]).join('\n').split(';').map(s => s.trim()).find(s => s.startsWith('UPDATE player_dues'));

beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  await applyRealSchema(env);
  const price = (season, sub, subGoalie) => env.DB.prepare(
    `INSERT INTO season_pricing (season, price_player, price_goalie, price_sub_player, price_sub_goalie, etransfer_phone, updated_at) VALUES (?, 170, 85, ?, ?, '', ?)`
  ).bind(season, sub, subGoalie, new Date().toISOString()).run();
  await price(SEASON, 5, 3);
  await price(ONE_A_NIGHT, 5, 3);
  for (const d of ['2026-09-06', '2026-09-13', '2026-09-20']) await ev(d, SEASON);
  await ev('2026-09-27', SEASON, 'cancelled');
  for (const d of ['2026-07-05', '2026-07-12']) await ev(d, ONE_A_NIGHT);
  // Fall 2026 has no config of its own (as in production); Summer 2026 is
  // a season configured for one game a night.
  await env.SHEETS_KV.put('data_json', JSON.stringify({
    current_season: SEASON,
    seasons: [{ name: SEASON, standings: [], fixtures: [] }, { name: ONE_A_NIGHT, config: { gamesPerNight: 1 } }],
    players: []
  }));

  // Like Yannick: one night (2026-09-20), no data.json stats, no dues row.
  await contact('YANNICK', 'sub_skater');
  await played('YANNICK', ['2026-09-20']);
  // A sub goalie, two nights in net.
  await contact('SUBG', 'sub_goalie', true);
  await played('SUBG', ['2026-09-06', '2026-09-13']);
  // A sub who had played two nights and paid $10 for them before this
  // rule, then played a third night after it.
  await contact('SETTLED', 'sub_skater');
  await played('SETTLED', ['2026-09-06', '2026-09-13']);
  await env.DB.prepare(`INSERT INTO player_dues (season, player_id, amount_paid, updated_at) VALUES (?, 'SETTLED', 10, ?)`).bind(SEASON, new Date().toISOString()).run();
  // Same, with no game since: exactly as before, paid up.
  await contact('SETTLED2', 'sub_skater');
  await played('SETTLED2', ['2026-09-06', '2026-09-13']);
  await env.DB.prepare(`INSERT INTO player_dues (season, player_id, amount_paid, updated_at) VALUES (?, 'SETTLED2', 10, ?)`).bind(SEASON, new Date().toISOString()).run();
  // A sub with a dues row but no payment: not settled.
  await contact('NOPAY', 'sub_skater');
  await played('NOPAY', ['2026-09-06', '2026-09-13']);
  await env.DB.prepare(`INSERT INTO player_dues (season, player_id, amount_paid, notes, updated_at) VALUES (?, 'NOPAY', 0, 'note only', ?)`).bind(SEASON, new Date().toISOString()).run();
  // A sub in a one-game-a-night season.
  await contact('ONESUB', 'sub_skater');
  await played('ONESUB', ['2026-07-05', '2026-07-12']);

  // The migration runs now (production: when applied), then the third night is played.
  await env.DB.prepare(snapshotStatement).run();
  await played('SETTLED', ['2026-09-20']);
});

describe('Where games per night comes from', () => {
  it('SMBHL: 2 when its season sets none; any other league: 1; a season\'s own value wins', () => {
    expect(SMBHL_GAMES_PER_NIGHT).toBe(2);
    expect(DEFAULT_GAMES_PER_NIGHT).toBe(1);
    expect(gamesPerNight(getSeasonConfig({ seasons: [{ name: SEASON }] }, SEASON), SMBHL_LEAGUE_ID)).toBe(2);
    expect(gamesPerNight(getSeasonConfig(null), 'some-league')).toBe(1);
    expect(gamesPerNight(normalizeSeasonConfig({ teams: ['Red'] }), 'some-league')).toBe(1);
    expect(gamesPerNight(normalizeSeasonConfig({ gamesPerNight: 3 }), 'some-league')).toBe(3);
    expect(gamesPerNight(normalizeSeasonConfig({ gamesPerNight: 1 }), SMBHL_LEAGUE_ID)).toBe(1);
  });
});

describe('Sub dues = events x games per night x sub rate', () => {
  it('a sub with one event owes two games at the SMBHL rate (Yannick: $10, not $5)', async () => {
    const row = await finance();
    expect(row('YANNICK')).toMatchObject({ is_sub: true, games_played: 2, total_due: 10, outstanding: 10, status: 'unpaid' });
  });

  it('the goalie sub rate applies the same way', async () => {
    const row = await finance();
    expect(row('SUBG')).toMatchObject({ is_sub: true, is_goalie: true, games_played: 4, total_due: 12 });
  });

  it('a one-game-per-night season is unaffected: events x 1', async () => {
    const row = await finance(ONE_A_NIGHT);
    expect(row('ONESUB')).toMatchObject({ is_sub: true, games_played: 2, total_due: 10 });
  });

  it('a sub whose dues row recorded a payment is not recalculated: settled nights stay at one game, later nights count in full', async () => {
    const snap = await env.DB.prepare(`SELECT player_id, settled_nights FROM player_dues WHERE season = ? ORDER BY player_id`).bind(SEASON).all();
    expect(snap.results).toEqual([{ player_id: 'NOPAY', settled_nights: null }, { player_id: 'SETTLED', settled_nights: 2 }, { player_id: 'SETTLED2', settled_nights: 2 }]);
    const row = await finance();
    // 2 settled nights x 1 + 1 later night x 2 = 4 games = $20; paid $10.
    expect(row('SETTLED')).toMatchObject({ games_played: 4, total_due: 20, amount_paid: 10, outstanding: 10 });
    // Nothing played since the snapshot: the same $10 as before, paid up.
    expect(row('SETTLED2')).toMatchObject({ games_played: 2, total_due: 10, amount_paid: 10, outstanding: 0, status: 'paid' });
    // A dues row with no payment recorded is not settled: 2 nights x 2.
    expect(row('NOPAY')).toMatchObject({ games_played: 4, total_due: 20 });
  });
});

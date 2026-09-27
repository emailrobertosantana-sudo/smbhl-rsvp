// Subs are charged per GAME -- and (sub dues task B2) only for games
// confirmed by a PUBLISHED scoresheet.
//
// History: finance first charged a sub's nights x sub rate (half, since
// SMBHL plays two games a night -- Yannick Gauthier, P0271: $5 for two
// games); then nights x gamesPerNight; and it took the LARGER of that and
// the scoresheet count. A sub marked "in" by a teammate who then did not
// play (Elliot Locas, week 3) was charged for games he never played.
//
// Now: the season stats in data.json, which publishing writes and which
// already count GAMES, are the only source. A night played but not yet
// published is not charged; it is reported as awaiting_sheet_nights.
// gamesPerNight (season config) still exists -- the invite and game-day
// emails use it -- and migrate-052's settled_nights snapshot is no longer
// read by finance.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { gamesPerNight, getSeasonConfig, normalizeSeasonConfig, SMBHL_GAMES_PER_NIGHT, DEFAULT_GAMES_PER_NIGHT } from '../src/season_config.js';
import { SMBHL_LEAGUE_ID } from '../src/league_ids.js';
import mig052 from '../migrate-052.sql?raw';

const ADMIN_KEY = 'test-part113-admin';
const SEASON = 'Fall 2026';
async function finance() {
  const res = await SELF.fetch(`http://example.com/admin/finances/data?s=${encodeURIComponent(SEASON)}`, { headers: { 'x-admin': ADMIN_KEY } });
  expect(res.status).toBe(200);
  const d = await res.json();
  return id => d.players.find(p => p.player_id === id);
}
const ev = (id, state) => env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, ?, 1, ?, '10:30', 'smbhl')`).bind(id, id, SEASON, state).run();
const played = (pid, events, role = 'sub') => Promise.all(events.map(e => env.DB.prepare(
  `INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, 'Red', 'in', ?, ?, 'smbhl')`
).bind(e, pid, role, new Date().toISOString()).run()));
const contact = (pid, role, goalie = false) => env.DB.prepare(
  `INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, ?, ?, ?, 's', 'smbhl')`
).bind(pid, pid, `${pid.toLowerCase()}@example.com`, role, role === 'roster' ? 0 : 1, goalie ? 1 : 0).run();
const snapshotStatement = mig052.split('\n').map(l => l.split('--')[0]).join('\n').split(';').map(s => s.trim()).find(s => s.startsWith('UPDATE player_dues'));

beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  await applyRealSchema(env);
  await env.DB.prepare(`INSERT INTO season_pricing (season, price_player, price_goalie, price_sub_player, price_sub_goalie, etransfer_phone, updated_at) VALUES (?, 170, 85, 5, 3, '', ?)`).bind(SEASON, new Date().toISOString()).run();
  await ev('2026-09-13', 'done');
  await ev('2026-09-20', 'done');
  await ev('2026-09-27', 'locked'); // played, scoresheet not yet published
  // Published season stats (games): Yannick 2 (his one night), the sub goalie 4 in net,
  // Elliot 2 -- though a teammate also marked him "in" for a night the sheets do not list him.
  await env.SHEETS_KV.put('data_json', JSON.stringify({
    current_season: SEASON, seasons: [{ name: SEASON, standings: [], fixtures: [] }],
    players: [
      { id: 'YANNICK', name: 'YANNICK', seasons: { [SEASON]: { team: null, gp: 2, g: 0, a: 0, pts: 0 } } },
      { id: 'SUBG', name: 'SUBG', gseasons: { [SEASON]: { team: null, gp: 4, ga: 0, w: 0, l: 0, t: 0, so: 0 } } },
      { id: 'ELLIOT', name: 'ELLIOT', seasons: { [SEASON]: { team: null, gp: 2, g: 5, a: 0, pts: 5, with: { Black: { gp: 2, g: 5, a: 0, pts: 5 } } } } }
    ]
  }));
  await contact('YANNICK', 'sub_skater');
  await played('YANNICK', ['2026-09-20'], 'roster');
  await contact('SUBG', 'sub_goalie', true);
  await played('SUBG', ['2026-09-13', '2026-09-20']);
  await contact('ELLIOT', 'sub_skater');
  await played('ELLIOT', ['2026-09-13', '2026-09-20']); // the 20th: marked in, not on the sheet
  // Played last night; the sheet is not published yet.
  await contact('PENDING', 'sub_skater');
  await played('PENDING', ['2026-09-27']);
  // migrate-052's snapshot still runs; finance no longer reads it.
  await env.DB.prepare(`INSERT INTO player_dues (season, player_id, amount_paid, updated_at) VALUES (?, 'ELLIOT', 0, ?)`).bind(SEASON, new Date().toISOString()).run();
  await env.DB.prepare(snapshotStatement).run();
});

describe('Where games per night comes from (used by the invite and game-day emails)', () => {
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

describe('Sub dues = games on published scoresheets x sub rate', () => {
  it('Yannick: his one night is two published games -> $10', async () => {
    const row = await finance();
    expect(row('YANNICK')).toMatchObject({ is_sub: true, games_played: 2, total_due: 10, outstanding: 10, status: 'unpaid' });
  });

  it('the goalie sub rate applies the same way: 4 games in net x $3', async () => {
    const row = await finance();
    expect(row('SUBG')).toMatchObject({ is_sub: true, is_goalie: true, games_played: 4, total_due: 12 });
  });

  it('Elliot: marked "in" for two nights, on the sheets for one -> 2 games, $10 (never the larger count)', async () => {
    const row = await finance();
    expect(row('ELLIOT')).toMatchObject({ is_sub: true, games_played: 2, total_due: 10, awaiting_sheet_nights: 0 });
  });

  it('a night played but not yet published is not charged -- and is reported as awaiting its scoresheet', async () => {
    const row = await finance();
    expect(row('PENDING')).toMatchObject({ is_sub: true, games_played: 0, total_due: 0, awaiting_sheet_nights: 1 });
  });
});

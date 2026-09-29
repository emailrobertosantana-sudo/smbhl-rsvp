// TESTER1 on demo, 2026-09-29: a no-teams league whose league row says
// min 10 / max 12 players, whose season says min 7 / max 12, one goalie
// wanted and -- saved from the season form -- a maximum of 0 goalies.
// With 8 in (one goalie, one who can also play goalie) the game page said
// "0/1 gardiens confirmés" and "Manque 5".
//  - the season's numbers win over the league row's, on every surface;
//  - a goalie maximum under the minimum is refused, and one already saved
//    reads as the minimum (the goalie is counted);
//  - "Manque N" is what is missing to the MINIMUM; spots to the maximum
//    are "places libres".
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must, one, rows, installMailCapture, removeMailCapture, local, DAY } from './support/league_season.js';
import { getLeagueSeasonConfig } from '../src/leagues.js';

beforeAll(async () => {
  env.AUTH_SECRET = 'p174'; env.RSVP_SECRET = 'p174r'; env.RESEND_API_KEY = 'p174'; env.MAIL_DAILY_CAP = '';
  await applyRealSchema(env);
  installMailCapture();
});
afterAll(() => removeMailCapture());

// TESTER1's shape: league row 10/12, one goalie min and max; the season
// published at 7/12, then (as the season form could) a max of 0 goalies.
async function tester1(tag, { storedMaxGoalies = 0 } = {}) {
  const a = await admin(tag);
  const lg = (await must(a.post('/leagues/create', { name: 'Tester ' + tag, teamStructure: 'headcount', minPlayers: 10, maxPlayers: 12, minGoalies: 1 }), 'create')).league;
  await must(a.post('/league/settings/structure', { team_structure: 'headcount', min_players: 10, max_players: 12, min_goalies: 1, max_goalies: 1 }), 'league row');
  await must(a.post('/league/season/publish', { season_name: 'Winter', min_players: 7, max_players: 12, min_goalies: 1 }), 'publish');
  if (storedMaxGoalies != null) {
    const key = `data_json:${lg.id}`;
    const doc = JSON.parse(await env.SHEETS_KV.get(key));
    doc.seasons[0].config.maxGoalies = storedMaxGoalies;
    await env.SHEETS_KV.put(key, JSON.stringify(doc));
  }
  const names = ['Ava', 'Isabella', 'Jackson', 'Liam', 'Mason', 'Mia', 'Olivia', 'Sophia', 'Ethan'];
  const cs = {};
  for (const n of names) {
    cs[n] = (await must(a.post('/league/contacts', { name: `${n} Test`, email: `${n.toLowerCase()}.${tag}@example.com`, role: 'roster', ...(n === 'Liam' ? { is_goalie: true } : {}), ...(n === 'Mason' ? { is_backup_goalie: true } : {}) }), 'contact')).contact;
  }
  await env.DB.prepare('UPDATE contacts SET is_goalie = 1 WHERE player_id = ?').bind(cs.Liam.player_id).run();
  await env.DB.prepare('UPDATE contacts SET is_backup_goalie = 1 WHERE player_id = ?').bind(cs.Mason.player_id).run();
  const date = local(Date.now() + 20 * DAY).date;
  const ev = (await must(a.post('/league/events', { date, season: 'Winter', venue: 'Letendre', start_time: '16:30', end_time: '17:30' }), 'game')).event;
  for (const n of names) await must(a.post('/league/rsvp/admin', { event_id: ev.id, player_id: cs[n].player_id, status: n === 'Ethan' ? 'out' : 'in' }), n);
  return { a, lg, ev, cs };
}

describe('A goalie maximum under the minimum', () => {
  it('is refused when the season is saved', async () => {
    const a = await admin('p174refuse');
    await must(a.post('/leagues/create', { name: 'Refuse', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12, minGoalies: 1 }), 'create');
    const r = await a.post('/league/season/publish', { season_name: 'S1', min_players: 7, max_players: 12, min_goalies: 1, max_goalies: 0 });
    expect(r.status).toBe(400);
    expect(r.json.errorKey).toBe('HEADCOUNT_MAX_GOALIES_TOO_LOW');
    await must(a.post('/league/season/publish', { season_name: 'S1', min_players: 7, max_players: 12, min_goalies: 1, max_goalies: 2 }), 'coherent');
  });

  it('already saved, reads as the minimum: the season wins over the league row, and the goalie counts', async () => {
    const { lg, ev } = await tester1('p174read');
    const cfg = await getLeagueSeasonConfig(env, lg.id, 'Winter');
    expect([cfg.minSkaters, cfg.skatersPerTeam, cfg.goaliesPerTeam, cfg.maxGoalies]).toEqual([7, 12, 1, 1]);
    const row = await one('SELECT min_players, max_players FROM leagues WHERE id = ?', lg.id);
    expect([row.min_players, row.max_players]).toEqual([10, 12]); // the league row disagrees; the season wins
    const { teamState } = await import('../src/index.js');
    const st = await teamState(env.DB, ev.id, 'Tous', cfg);
    expect([st.goalies, st.skaters, st.short]).toEqual([1, 7, false]);
  });
});

describe('A shortage is measured against the season minimum, on every surface', () => {
  const page = async (a, ev) => (await a.get(`/league/events/detail?e=${encodeURIComponent(ev.id)}`)).text;

  it('8 in (a goalie among them) against a minimum of 7 and a goalie: not short anywhere', async () => {
    const { a, ev } = await tester1('p174surfaces');
    const html = await page(a, ev);
    expect(html).toContain('data-short="0"');
    expect(html).toContain('data-i18n="minReached"'); // spots remain to the maximum of 12
    expect(html).not.toContain('nl-card--short ev-team');
    expect(html).toMatch(/data-open-spots>5</); // 12 skaters + 1 goalie - 8
    expect(html).toContain('<span class="stat tnum">1/1</span>'); // goalies confirmed
    const status = await a.get(`/league/events/status?e=${encodeURIComponent(ev.id)}`);
    expect(status.json.teams[0].short).toBe(false);
    // The automatic sub call reads the same numbers: a goalie sub is not
    // called for a game that has its goalie.
    await env.DB.prepare('UPDATE events SET date = ? WHERE id = ?').bind(local(Date.now() + 3 * DAY).date, ev.id).run();
    await must(a.post('/league/contacts', { name: 'Lucas Vance', email: 'lucas.p174@example.com', role: 'sub_skater', is_goalie: true }), 'goalie sub');
    expect(await rows("SELECT 1 FROM outbox WHERE event_id = ? AND kind = 'sub_call'", ev.id)).toEqual([]);
  });

  it('6 in: "Manque" counts what is missing to the minimum, not to the maximum', async () => {
    const { a, ev, cs } = await tester1('p174short');
    for (const n of ['Mia', 'Olivia']) await must(a.post('/league/rsvp/admin', { event_id: ev.id, player_id: cs[n].player_id, status: 'out' }), n);
    const html = await page(a, ev);
    expect(html).toContain('data-short="2"'); // 5 skaters + the goalie: 2 short of 7 skaters
    expect(html).toMatch(/data-open-spots>7</); // 12 - 5
    expect(html).toContain('Minimum atteint');
    expect(html).toContain('Minimum reached');
  });
});

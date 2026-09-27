// Finance: regular or sub comes from the CONTACT record, not from which team
// someone played for.
//
// Production, Fall 2026: Carlo Russo (roster, is_sub 0) showed as "Sub
// Player", 6 games x $5 = $30 against $170 paid (+$140 credit); Brandon
// Cummings (roster) showed as "Sub Player" too, but owing $170 because an
// admin had set custom_due 170. Cause: finance read data.json's season
// "team", and publishing a scoresheet sets that to null for anyone marked a
// sub for a game -- a regular filling in for another team included -- and
// null meant "sub" to finance. A real sub is still charged per game.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const ADMIN_KEY = 'test-part120-admin';
const SEASON = 'Fall 2026';
async function finance() {
  const res = await SELF.fetch(`http://example.com/admin/finances/data?s=${encodeURIComponent(SEASON)}`, { headers: { 'x-admin': ADMIN_KEY } });
  expect(res.status).toBe(200);
  const d = await res.json();
  return id => d.players.find(p => p.player_id === id);
}
const contact = (pid, name, role) => env.DB.prepare(
  `INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, ?, ?, 0, 's', 'smbhl')`
).bind(pid, name, `${pid.toLowerCase()}@example.com`, role, role === 'roster' ? 0 : 1).run();
const row = (ev, pid, team, status, role) => env.DB.prepare(
  `INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, ?, ?, ?, '2026-09-20T00:00:00Z', 'smbhl')`
).bind(ev, pid, team, status, role).run();

beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  await applyRealSchema(env);
  await env.DB.prepare('DELETE FROM contacts').run();
  await env.DB.prepare(`INSERT INTO season_pricing (season, price_player, price_goalie, price_sub_player, price_sub_goalie, etransfer_phone, updated_at) VALUES (?, 170, 85, 5, 0, '', '2026-09-01T00:00:00Z')`).bind(SEASON).run();
  for (const [id, week] of [['2026-09-20', 2], ['2026-09-27', 3]]) {
    await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time) VALUES (?, ?, ?, ?, 'done', '10:30')`).bind(id, id, SEASON, week).run();
  }
  // data.json exactly as production has it: a published scoresheet nulled
  // both regulars' season team (and logged their games under "with").
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: SEASON, seasons: [{ name: SEASON, standings: [], fixtures: [] }], players: [
    { id: 'P0050', name: 'Carlo Russo', seasons: { [SEASON]: { team: null, pos: 'D', gp: 6, g: 3, a: 4, pts: 7, with: { White: { gp: 2, g: 1, a: 1, pts: 2 } } } } },
    { id: 'P0291', name: 'Brandon Cummings', seasons: { [SEASON]: { team: null, pos: 'F', gp: 2, g: 1, a: 0, pts: 1, with: { Red: { gp: 2, g: 1, a: 0, pts: 1 } } } } },
    { id: 'P0301', name: 'Elliot Locas', seasons: { [SEASON]: { team: null, pos: null, gp: 2, g: 5, a: 0, pts: 5, with: { Black: { gp: 2, g: 5, a: 0, pts: 5 } } } } }
  ] }));
  // Carlo: a White regular who played week 3 for Red. Paid 170.
  await contact('P0050', 'Carlo Russo', 'roster');
  await row('2026-09-20', 'P0050', 'White', 'in', 'roster');
  await row('2026-09-27', 'P0050', 'Red', 'in', 'roster');
  await env.DB.prepare(`INSERT INTO player_dues (season, player_id, amount_paid, updated_at) VALUES (?, 'P0050', 170, '2026-09-18T00:00:00Z')`).bind(SEASON).run();
  // Brandon: a Black regular who played week 3 for Red. Admin set 170 due, paid 170.
  await contact('P0291', 'Brandon Cummings', 'roster');
  await row('2026-09-20', 'P0291', 'Black', 'out', 'roster');
  await row('2026-09-27', 'P0291', 'Red', 'in', 'roster');
  await env.DB.prepare(`INSERT INTO player_dues (season, player_id, custom_due, amount_paid, updated_at) VALUES (?, 'P0291', 170, 170, '2026-09-27T00:00:00Z')`).bind(SEASON).run();
  // Elliot: a real sub, two nights.
  await contact('P0301', 'Elliot Locas', 'sub_skater');
  await row('2026-09-20', 'P0301', 'Black', 'in', 'sub');
  await row('2026-09-27', 'P0301', 'Red', 'in', 'sub');
  // A regular who paid in advance and has not played: only a dues row.
  await contact('P0400', 'Early Payer', 'roster');
  await env.DB.prepare(`INSERT INTO player_dues (season, player_id, amount_paid, updated_at) VALUES (?, 'P0400', 170, '2026-09-10T00:00:00Z')`).bind(SEASON).run();
});

describe('Regular or sub comes from the contact record', () => {
  it('a regular who filled in for another team is labelled a regular and owes the season fee (Carlo)', async () => {
    const row = await finance();
    expect(row('P0050')).toMatchObject({ is_sub: false, role: 'roster_skater', total_due: 170, amount_paid: 170, outstanding: 0, credit: 0, status: 'paid' });
  });

  it("the same for a regular whose due an admin set by hand (Brandon): a regular, and the admin's amount stands", async () => {
    const row = await finance();
    expect(row('P0291')).toMatchObject({ is_sub: false, role: 'roster_skater', total_due: 170, amount_paid: 170, status: 'paid' });
  });

  it('a real sub is still charged per game: two nights = four games x $5 (Elliot)', async () => {
    const row = await finance();
    expect(row('P0301')).toMatchObject({ is_sub: true, role: 'sub_skater', games_played: 4, total_due: 20, amount_paid: 0, outstanding: 20 });
  });

  it('a regular known only from a dues row is a regular owing the season fee', async () => {
    const row = await finance();
    expect(row('P0400')).toMatchObject({ is_sub: false, role: 'roster_skater', total_due: 170, amount_paid: 170, status: 'paid' });
  });
});

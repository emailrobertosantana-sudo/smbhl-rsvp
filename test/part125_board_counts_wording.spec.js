// The subs board said "0 skaters, 0G" under "3 skater(s) needed" for a new
// game: the zero is the CONFIRMED count and the need is against a full team,
// so the teams looked empty when Red had 5 regulars who simply had not
// answered. It now says what each number is.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { extractInlineScripts, assertNoSyntaxError } from './support/inline_scripts.js';

const ADMIN_KEY = 'test-part125-admin';
const EV = 'smbhl:2099-10-04';
beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  await applyRealSchema(env);
  await env.DB.prepare('DELETE FROM contacts').run();
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: 'Fall 2026', seasons: [{ name: 'Fall 2026', config: { teams: [{ name: 'Red' }, { name: 'White' }], goaliesPerTeam: 1, skatersPerTeam: 8 }, standings: [], fixtures: [] }], players: [] }));
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'Fall 2026', 4, 'Sunday October 4 2099', 'Aréna', 'open', '10:30', 'smbhl')`).bind(EV).run();
  // Week 4's shape at creation: Red 1 goalie + 5 skaters pending, 1 out; White 1 + 6 pending.
  for (const [team, n, out] of [['Red', 5, 1], ['White', 6, 0]]) {
    for (let i = 0; i <= n + out; i++) {
      const pid = `${team}${i}`;
      await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, 'roster', 0, ?, 's', 'smbhl')`).bind(pid, pid, `${pid}@example.com`, i === 0 ? 1 : 0).run();
      await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, ?, ?, 'roster', '2099-09-27T14:30:00Z', 'smbhl')`).bind(EV, pid, team, i > n ? 'out' : 'pending').run();
    }
  }
});

describe('Subs board: confirmed vs not answered yet', () => {
  it('reports confirmed AND not-yet-answered counts per team', async () => {
    const d = await (await SELF.fetch(`http://example.com/admin/subs/data?e=${encodeURIComponent(EV)}`, { headers: { 'x-admin': ADMIN_KEY } })).json();
    const red = d.shortages.find(s => s.team === 'Red'), white = d.shortages.find(s => s.team === 'White');
    expect(red).toMatchObject({ skaters: 0, goalies: 0, pendingSkaters: 5, pendingGoalies: 1, openSkaters: 3 });
    expect(white).toMatchObject({ skaters: 0, goalies: 0, pendingSkaters: 6, pendingGoalies: 1, openSkaters: 2 });
  });

  it('the board page carries the new wording in both languages, and its script parses', async () => {
    const html = await (await SELF.fetch('http://example.com/admin/subs', { headers: { 'x-admin': ADMIN_KEY } })).text();
    for (const s of ["neededForFull: 'manquant{s} pour une équipe complète'", "neededForFull: 'short of a full team'", "confirmedLabel: 'Confirmés'", "confirmedLabel: 'Confirmed'", "noAnswerLabel: 'Sans réponse'", "noAnswerLabel: 'No answer yet'"]) {
      expect(html).toContain(s);
    }
    assertNoSyntaxError(extractInlineScripts(html), 'subs board');
  });
});

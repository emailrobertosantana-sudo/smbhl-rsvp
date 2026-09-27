// Finance page: accented names render correctly. "François Beaucaire-
// Gaudreau" showed as "Fran|ºois": production's data.json holds
// "Fran├ºois" (its UTF-8 bytes were once read through the Windows console
// code page 850 and saved back -- 54 strings, all between the 20 and 27
// Sept backups), and finance showed data.json's name. The contact record
// is correct, and is now the name finance shows.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const ADMIN_KEY = 'test-part124-admin';
beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  await applyRealSchema(env);
  await env.DB.prepare('DELETE FROM contacts').run();
  await env.DB.prepare(`INSERT INTO season_pricing (season, price_player, price_goalie, price_sub_player, price_sub_goalie, etransfer_phone, updated_at) VALUES ('Fall 2026', 170, 85, 5, 0, '', '2026-09-01T00:00:00Z')`).run();
  await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES ('P0087', 'François Beaucaire-Gaudreau', 'f@example.com', 'roster', 0, 0, 's', 'smbhl')`).run();
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: 'Fall 2026', seasons: [{ name: 'Fall 2026', standings: [], fixtures: [] }],
    players: [{ id: 'P0087', name: 'Fran├ºois Beaucaire-Gaudreau', seasons: { 'Fall 2026': { team: 'Red', gp: 4 } } }] }));
});

describe('Finance: accented names', () => {
  it("shows the contact's name, not data.json's damaged copy", async () => {
    const res = await SELF.fetch('http://example.com/admin/finances/data?s=Fall%202026', { headers: { 'x-admin': ADMIN_KEY } });
    const d = await res.json();
    expect(d.players.find(p => p.player_id === 'P0087').name).toBe('François Beaucaire-Gaudreau');
  });

  it('the finance page and its data are served as UTF-8', async () => {
    const page = await SELF.fetch('http://example.com/admin/finances', { headers: { 'x-admin': ADMIN_KEY } });
    expect(page.headers.get('content-type')).toMatch(/charset=utf-8/i);
    const data = await SELF.fetch('http://example.com/admin/finances/data?s=Fall%202026', { headers: { 'x-admin': ADMIN_KEY } });
    expect(data.headers.get('content-type')).toMatch(/json/);
  });
});

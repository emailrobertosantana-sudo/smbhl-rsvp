// The game-day email's sub fee is per GAME x games per night, from the season
// config (gamesPerNight, 7c2f04d) -- no longer a hardcoded 2. SMBHL with no
// setting: 2 games; a season set to one game a night: 1.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { drain } from '../src/index.js';

let originalFetch;
const sent = [];
beforeAll(async () => {
  env.RSVP_SECRET = 'p126'; env.RESEND_API_KEY = 'p126'; env.MAIL_DAILY_CAP = '100';
  await applyRealSchema(env);
  await env.DB.prepare('DELETE FROM contacts').run();
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('email_cadence_settings', '{"quiet_hours_enabled":false}')`).run();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) { const b = JSON.parse(opts.body); sent.push({ to: b.to[0], html: b.html, text: b.text }); return new Response('{"id":"x"}', { status: 200 }); }
    return new Response('{}', { status: 404 });
  };
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: 'Fall 2099', seasons: [
    { name: 'Fall 2099', standings: [], fixtures: [] },
    { name: 'One Game 2099', config: { gamesPerNight: 1 }, standings: [], fixtures: [] }
  ], players: [] }));
  for (const [id, season] of [['2099-10-04', 'Fall 2099'], ['2099-10-05', 'One Game 2099']]) {
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, ?, 4, ?, 'Aréna', 'open', '10:30', 'smbhl')`).bind(id, season, `Sunday ${id}`).run();
    await env.DB.prepare(`INSERT INTO season_pricing (season, price_player, price_goalie, price_sub_player, price_sub_goalie, etransfer_phone, updated_at) VALUES (?, 170, 85, 5, 0, '514-555-0000', '2099-01-01T00:00:00Z')`).bind(season).run();
  }
  await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES ('S126', 'Sub Fee', 'sub126@example.com', 'sub_skater', 1, 0, 's', 'smbhl')`).run();
  for (const id of ['2099-10-04', '2099-10-05']) {
    await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, 'S126', 'Red', 'in', 'sub', '2099-01-01T00:00:00Z', 'smbhl')`).bind(id).run();
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at, league_id) VALUES ('gameday', ?, 'S126', 'Red', ?, '{}', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z', 'smbhl')`).bind(id, `gd:${id}`).run();
  }
});
afterAll(() => { globalThis.fetch = originalFetch; });

describe('Game-day sub fee follows games per night', () => {
  it('SMBHL (no setting): 2 games x $5 = 10,00 $; a one-game-a-night season: 5,00 $', async () => {
    await drain(env);
    expect(sent).toHaveLength(2);
    const [smbhl, oneGame] = sent;
    expect(smbhl.text).toContain('Frais de substitut / Sub Fee : 10,00 $');
    expect(oneGame.text).toContain('Frais de substitut / Sub Fee : 5,00 $');
  });
});

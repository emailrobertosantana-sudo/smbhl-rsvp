// SMBHL's Comms lists SMBHL's own open games only. On a database shared
// with the league product (demo), its event pickers listed every league's.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

beforeAll(async () => {
  env.ADMIN_KEY = 'p138-admin';
  await applyRealSchema(env);
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES ('smbhl:2099-02-01', 'Fall 2099', 1, 'Sunday February 1 2099', 'Aréna', 'open', '10:30', 'smbhl')`).run();
  await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at) VALUES ('u-p138', 'o@p138.example', 'x', '2099-01-01T00:00:00Z')`).run();
  await env.DB.prepare(`INSERT INTO leagues (id, name, tracks_stats, team_count, team_names, created_by, created_at) VALUES ('lg-p138', 'Other', 1, 2, '["A","B"]', 'u-p138', '2099-01-01T00:00:00Z')`).run();
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES ('lg-p138:2099-02-02', 'S1', 1, '2099-02-02', 'Rink', 'open', '19:00', 'lg-p138')`).run();
});

describe('SMBHL Comms event pickers', () => {
  it('list SMBHL games only', async () => {
    const res = await SELF.fetch('http://example.com/admin/comms/data', { headers: { 'x-admin': 'p138-admin' } });
    const data = await res.json();
    expect(data.open_events.map(e => e.id)).toEqual(['smbhl:2099-02-01']);
  });
});

describe('SMBHL Comms outbox', () => {
  it('shows SMBHL\'s rows and the system rows, nothing from other leagues -- in the list and the counts', async () => {
    for (const [lg, key] of [['smbhl', 'o-smbhl'], ['system', 'o-system'], ['lg-p138', 'o-other']]) {
      await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, dedup_key, payload, send_after, created_at, league_id) VALUES ('broadcast', 'smbhl:2099-02-01', NULL, ?, '{}', '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z', ?)`).bind(key, lg).run();
    }
    const data = await (await SELF.fetch('http://example.com/admin/comms/data', { headers: { 'x-admin': 'p138-admin' } })).json();
    expect(data.outbox.map(o => o.dedup_key).sort()).toEqual(['o-smbhl', 'o-system']);
    expect(data.stats.total).toBe(2);
  });
});

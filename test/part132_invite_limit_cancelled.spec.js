// Item 13: a cancelled invite was never delivered and must not count.
// Week 4 (smbhl:2026-10-04) had 81 sub_call rows cancelled before any sent
// (the quiet-hours bug). Those subs must still get their two automatic
// invites: only a row that actually SENT counts toward the limit, and a
// cancelled row does not stop callSubs from calling the sub again.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { drain } from '../src/index.js';

const KEY = 'p132-admin';
const iso = d => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const EV = `smbhl:${iso(5)}`;
let originalFetch;
const sent = [];
const rows = () => env.DB.prepare(`SELECT id, sent_at, cancelled, error, dedup_key FROM outbox WHERE event_id = ? AND player_id = 'S1' ORDER BY id`).bind(EV).all().then(r => r.results);
const queue = key => env.DB.prepare(
  `INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at, league_id, quiet_exempt) VALUES ('sub_call', ?, 'S1', 'Red', ?, '{"need":"skater"}', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z', 'smbhl', 1)`
).bind(EV, key).run();

beforeAll(async () => {
  env.ADMIN_KEY = KEY; env.RESEND_API_KEY = 'p132'; env.RSVP_SECRET = 'p132'; env.MAIL_DAILY_CAP = '100';
  await applyRealSchema(env);
  await env.DB.prepare('DELETE FROM contacts').run();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) { sent.push(JSON.parse(opts.body).to[0]); return new Response('{"id":"x"}', { status: 200 }); }
    return new Response('{}', { status: 404 });
  };
  await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('email_cadence_settings', '{"quiet_hours_enabled":false}')`).run();
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: 'Fall 2099', seasons: [{ name: 'Fall 2099', standings: [], fixtures: [] }], players: [] }));
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'Fall 2099', 4, 'Sunday', 'Aréna', 'open', '10:30', 'smbhl')`).bind(EV).run();
  await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES ('S1', 'Sam Sub', 's1@example.com', 'sub_skater', 1, 0, 's', 'smbhl')`).run();
  // What the quiet-hours bug left: an invite queued and cancelled, never sent.
  await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at, league_id, cancelled) VALUES ('sub_call', ?, 'S1', 'Red', 'call:old', '{"need":"skater"}', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z', 'smbhl', 1)`).bind(EV).run();
});
afterAll(() => { globalThis.fetch = originalFetch; });

describe('Invite limit counts only invites actually sent', () => {
  it('a sub with only a cancelled invite is called again', async () => {
    const res = await SELF.fetch('http://example.com/admin/subs/call', {
      method: 'POST', headers: { 'x-admin': KEY, 'content-type': 'application/json' }, body: JSON.stringify({ event_id: EV, team: 'Red', need: 'skater' })
    });
    expect(res.status).toBe(200);
    const live = (await rows()).filter(r => !r.cancelled);
    expect(live).toHaveLength(1);
    expect(live[0].dedup_key).toBe(`call:${EV}:skater:S1`);
  });

  it('the cancelled one does not count: first invite sends, second sends, third is refused', async () => {
    await drain(env);
    expect(sent.filter(t => t === 's1@example.com')).toHaveLength(1);
    await queue('p132-second');
    await drain(env);
    expect(sent.filter(t => t === 's1@example.com')).toHaveLength(2);
    await queue('p132-third');
    await drain(env);
    expect(sent.filter(t => t === 's1@example.com')).toHaveLength(2);
    const third = (await rows()).find(r => r.dedup_key === 'p132-third');
    expect(third.cancelled).toBe(1);
    expect(third.error).toBe('invite limit reached (2 per sub per event)');
  });
});

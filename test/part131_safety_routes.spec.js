// Item 14: two safety problems.
// 14a /api/send-sample-invites sends real mail, spending the day's Resend
//     budget: it now needs the admin key like every other admin route.
// 14b a cancellation TEST send used to cancel the event's queued mail before
//     checking it was a test; a test now touches nothing, the real notice
//     still cancels it.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const KEY = 'p131-admin';
const EV = 'smbhl:2099-03-01';
let originalFetch;
const sent = [];
const pending = () => env.DB.prepare(`SELECT count(*) n FROM outbox WHERE event_id = ? AND sent_at IS NULL AND cancelled = 0`).bind(EV).first().then(r => r.n);

beforeAll(async () => {
  env.ADMIN_KEY = KEY; env.RESEND_API_KEY = 'p131'; env.RSVP_SECRET = 'p131'; env.ADMIN_EMAIL = 'admin@p131.example';
  await applyRealSchema(env);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) { sent.push(JSON.parse(opts.body)); return new Response('{"id":"x"}', { status: 200 }); }
    return new Response('{}', { status: 404 });
  };
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'Fall 2099', 3, 'Sunday March 1 2099', 'Aréna', 'cancelled', '10:30', 'smbhl')`).bind(EV).run();
  for (const [kind, key] of [['gameday', 'gd1'], ['chase', 'ch1']]) {
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, dedup_key, payload, send_after, created_at, league_id) VALUES (?, ?, 'P1', ?, '{}', '2099-02-28T00:00:00Z', '2099-01-01T00:00:00Z', 'smbhl')`).bind(kind, EV, key).run();
  }
});
afterAll(() => { globalThis.fetch = originalFetch; });

const cancel = testOnly => SELF.fetch('http://example.com/admin/schedule/send-cancellation', {
  method: 'POST', headers: { 'x-admin': KEY, 'content-type': 'application/json' }, body: JSON.stringify({ event_id: EV, test_only: testOnly })
});

describe('14a: sample invites need the admin key', () => {
  it('refused without it, and nothing is sent', async () => {
    const before = sent.length;
    const res = await SELF.fetch('http://example.com/api/send-sample-invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(403);
    expect(sent.length).toBe(before);
  });
});

describe('14b: a cancellation test send leaves the queued mail alone', () => {
  it('test send: goes to the admin only, both pending rows untouched', async () => {
    expect(await pending()).toBe(2);
    const res = await cancel(true);
    expect((await res.json()).test).toBe(true);
    expect(sent.at(-1).to).toEqual(['admin@p131.example']);
    expect(await pending()).toBe(2);
  });
  it('the real notice still cancels them', async () => {
    const res = await cancel(false);
    expect((await res.json()).ok).toBe(true);
    expect(await pending()).toBe(0);
  });
});

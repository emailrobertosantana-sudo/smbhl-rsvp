// Live-testing task (batch 4), Part 1: SMBHL bug -- the Comms "trigger
// immediate delivery" (manual drain) button called
// drain(env, 50, true). drain()'s third parameter is filterEventId, a
// string ANDed into the query as `event_id = ?`; passing the boolean
// `true` filtered for `event_id = true`, which no real row ever has,
// so it always matched zero rows and silently reported success
// ({sent: 0, failed: 0}) regardless of what was actually pending.
//
// This test is the regression that would have caught it: insert a
// genuinely due outbox row, call the REAL route (not drain()
// directly), and assert it actually sends.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const ADMIN_KEY = 'test-part1-batch4-drain-admin-key';
const RSVP_SECRET = 'test-part1-batch4-drain-rsvp-secret';

async function withMailMock(fn) {
  const originalFetch = globalThis.fetch;
  const sentMails = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      sentMails.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ id: 'mock_resend_id' }), { status: 200 });
    }
    return originalFetch(url, opts);
  };
  try {
    return { sentMails, result: await fn(sentMails) };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('Part 1 (live-testing task, batch 4): the manual drain button genuinely drains, and reports honestly', () => {
  beforeAll(async () => {
    env.ADMIN_KEY = ADMIN_KEY;
    env.RSVP_SECRET = RSVP_SECRET;
    env.RESEND_API_KEY = 'test-part1-batch4-resend-key';
    await applyRealSchema(env);
  });

  async function seedDuePlayerAndEvent(playerId, eventId, email) {
    await env.DB.prepare(
      `INSERT INTO contacts (player_id, name, email, role, token_salt) VALUES (?, 'Drain Test Player', ?, 'roster', 'salt-drain')`
    ).bind(playerId, email).run();
    await env.DB.prepare(
      `INSERT INTO events (id, season, week, date, venue, state) VALUES (?, 'Fall 2026', 1, ?, 'Gym', 'open')`
    ).bind(eventId, eventId).run();
  }

  it('a genuinely due outbox row is actually sent by the real /admin/emails/drain route (the exact regression the bug produced)', async () => {
    const playerId = 'P_DRAIN_1';
    const eventId = '2026-11-10';
    await seedDuePlayerAndEvent(playerId, eventId, 'draintest1@example.com');
    const past = new Date(Date.now() - 60000).toISOString();
    await env.DB.prepare(
      `INSERT INTO outbox (kind, event_id, player_id, send_after, created_at) VALUES ('invite', ?, ?, ?, ?)`
    ).bind(eventId, playerId, past, past).run();

    const { sentMails, result: res } = await withMailMock(() =>
      SELF.fetch('http://example.com/admin/emails/drain', { method: 'POST', headers: { 'x-admin': ADMIN_KEY } })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // The exact regression: before the fix, this was always {due: 0,
    // sent: 0, failed: 0} no matter what was actually queued.
    expect(body.drain.due).toBe(1);
    expect(body.drain.sent).toBe(1);
    expect(body.drain.failed).toBe(0);
    expect(sentMails.length).toBe(1);
    expect(sentMails[0].to).toEqual(['draintest1@example.com']);

    const row = await env.DB.prepare('SELECT sent_at FROM outbox WHERE player_id = ?').bind(playerId).first();
    expect(row.sent_at).not.toBeNull();
  });

  it('reports due: 0 honestly when nothing is actually pending -- never a false "success" the same shape as a real send', async () => {
    const res = await SELF.fetch('http://example.com/admin/emails/drain', { method: 'POST', headers: { 'x-admin': ADMIN_KEY } });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.drain.due).toBe(0);
    expect(body.drain.sent).toBe(0);
  });

  it('reports a genuine failure honestly -- sent and failed are both visible, not folded into a blanket success', async () => {
    const playerId = 'P_DRAIN_FAIL';
    const eventId = '2026-11-11';
    await seedDuePlayerAndEvent(playerId, eventId, 'drainfail@example.com');
    const past = new Date(Date.now() - 60000).toISOString();
    await env.DB.prepare(
      `INSERT INTO outbox (kind, event_id, player_id, send_after, created_at) VALUES ('invite', ?, ?, ?, ?)`
    ).bind(eventId, playerId, past, past).run();

    // Deliberately not mocking api.resend.com -- the real fetch reaches
    // the actual Resend API with a fake test key and returns a real
    // auth error, exercising drain()'s own catch/error-recording path
    // exactly as it would for any genuine send failure.
    const res = await SELF.fetch('http://example.com/admin/emails/drain', { method: 'POST', headers: { 'x-admin': ADMIN_KEY } });
    const body = await res.json();
    expect(body.drain.due).toBe(1);
    expect(body.drain.failed).toBe(1);
    expect(body.drain.sent).toBe(0);

    const row = await env.DB.prepare('SELECT sent_at, error FROM outbox WHERE player_id = ?').bind(playerId).first();
    expect(row.sent_at).toBeNull();
    expect(row.error).toBeTruthy();
  });

  it('requires ADMIN_KEY -- unauthenticated requests never trigger a drain', async () => {
    const res = await SELF.fetch('http://example.com/admin/emails/drain', { method: 'POST' });
    expect(res.status).not.toBe(200);
  });
});
// NOTE on SMBHL's normal cron-driven drain: runSchedule's own drain
// call (`await drain(env)`, no third argument) never passed the buggy
// `true` -- the bug was isolated entirely to handleEmailsDrain's own
// call site, fixed above. Not re-tested here on purpose: every one of
// SMBHL's existing, unmodified test files already exercises
// runSchedule's real enqueue+drain behavior, and continuing to pass
// them unchanged in the same full-suite run this task requires after
// every part is the actual proof, not a new assertion duplicating it.

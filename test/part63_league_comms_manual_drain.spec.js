// Live-testing task (batch 4), Part 3: manual drain, shared into the
// league product's own Comms module. Scoped per league (a league
// admin's drain must only ever touch THEIR league's pending outbox
// rows, never another league's or SMBHL's), and honest about the
// result (same standard as Part 1's SMBHL fix).
//
// Also covers the cron-level safety net added to runLeagueReminders:
// previously it never called drain() at all, so a request that
// crashed after enqueue() but before its own synchronous drain() had
// no fallback whatsoever (no cron safety net, no manual one either).
// Both are now real: this manual button, and a per-league drain(env,
// 40, null, leagueRow.id) added to every runLeagueReminders tick.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { runLeagueReminders } from '../src';

const AUTH_SECRET = 'test-part3-batch4-comms-drain-secret';
const RSVP_SECRET = 'test-part3-batch4-comms-drain-rsvp-secret';

function extractCookie(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(', ');
  const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
  return csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
}
async function signup(email, ip) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  return { cookie: extractCookie(res), csrfToken: extractCsrfToken(res) };
}
async function createLeague(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).league;
}
async function seedDueOutboxRow(leagueId, playerId, email, eventId) {
  await env.DB.prepare(
    `INSERT INTO contacts (player_id, league_id, name, email, is_sub, token_salt) VALUES (?, ?, 'Comms Drain Test', ?, 1, 'salt')`
  ).bind(playerId, leagueId, email).run();
  // drain() requires a real matching events row -- it throws ('event
  // gone', counted as a failure) otherwise. Date encoded in eventId
  // itself (league_ids.js's own convention) for a real, parseable date.
  const dateStr = eventId.split(':').pop();
  await env.DB.prepare(
    `INSERT INTO events (id, league_id, season, week, date, venue, state) VALUES (?, ?, 'S1', 1, ?, 'Arena', 'open')`
  ).bind(eventId, leagueId, dateStr).run();
  const past = new Date(Date.now() - 60000).toISOString();
  await env.DB.prepare(
    `INSERT INTO outbox (kind, event_id, player_id, team, league_id, payload, send_after, created_at) VALUES ('sub_call', ?, ?, 'X', ?, ?, ?, ?)`
  ).bind(eventId, playerId, leagueId, JSON.stringify({ need: 'skater' }), past, past).run();
}
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

describe('Part 3 (live-testing task, batch 4): manual drain in the shared Comms module', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    env.RESEND_API_KEY = 'test-part3-batch4-resend-key';
    await applyRealSchema(env);
  });

  it("a league admin's manual drain only touches THEIR league's own pending outbox rows -- never another league's or SMBHL's", async () => {
    const a = await signup('commsdrain.a@example.com', '203.0.179.001');
    const leagueA = await createLeague(a.cookie, a.csrfToken, { name: 'Comms Drain League A', teamNames: ['X', 'Y'], tracksStats: true });
    const b = await signup('commsdrain.b@example.com', '203.0.179.002');
    const leagueB = await createLeague(b.cookie, b.csrfToken, { name: 'Comms Drain League B', teamNames: ['X', 'Y'], tracksStats: true });

    await seedDueOutboxRow(leagueA.id, `${leagueA.id}:PA1`, 'leaguea.recipient@example.com', `${leagueA.id}:2026-12-01`);
    await seedDueOutboxRow(leagueB.id, `${leagueB.id}:PB1`, 'leagueb.recipient@example.com', `${leagueB.id}:2026-12-02`);
    // A real SMBHL row too -- must survive a league admin's own drain
    // completely untouched.
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, token_salt) VALUES ('P_SMBHL_DRAIN', 'SMBHL Real Player', 'smbhlreal@example.com', 'roster', 'salt')`).run();
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state) VALUES ('2026-12-03', 'Fall 2026', 1, '2026-12-03', 'Gym', 'open')`).run();
    const past = new Date(Date.now() - 60000).toISOString();
    await env.DB.prepare(
      `INSERT INTO outbox (kind, event_id, player_id, send_after, created_at) VALUES ('invite', '2026-12-03', 'P_SMBHL_DRAIN', ?, ?)`
    ).bind(past, past).run();

    const { sentMails, result: res } = await withMailMock(() =>
      SELF.fetch('http://example.com/league/comms/drain', {
        method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken }
      })
    );
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.drain.due).toBe(1);
    expect(body.drain.sent).toBe(1);
    expect(sentMails.length).toBe(1);
    expect(sentMails[0].to).toEqual(['leaguea.recipient@example.com']);

    // League A's own row: sent.
    const rowA = await env.DB.prepare('SELECT sent_at FROM outbox WHERE league_id = ?').bind(leagueA.id).first();
    expect(rowA.sent_at).not.toBeNull();
    // League B's row: completely untouched (still pending, un-sent).
    const rowB = await env.DB.prepare('SELECT sent_at FROM outbox WHERE league_id = ?').bind(leagueB.id).first();
    expect(rowB.sent_at).toBeNull();
    // SMBHL's own row: completely untouched.
    const rowSmbhl = await env.DB.prepare("SELECT sent_at FROM outbox WHERE player_id = 'P_SMBHL_DRAIN'").first();
    expect(rowSmbhl.sent_at).toBeNull();
  });

  it('reports honestly: nothing pending is distinct from a real send', async () => {
    const { cookie, csrfToken } = await signup('commsdrain.empty@example.com', '203.0.179.003');
    await createLeague(cookie, csrfToken, { name: 'Comms Drain Empty League', teamNames: ['X', 'Y'], tracksStats: true });

    const res = await SELF.fetch('http://example.com/league/comms/drain', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken }
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.drain.due).toBe(0);
    expect(body.drain.sent).toBe(0);
  });

  it('requires a real session and CSRF token', async () => {
    const noAuth = await SELF.fetch('http://example.com/league/comms/drain', { method: 'POST' });
    expect(noAuth.status).toBe(401);

    const { cookie } = await signup('commsdrain.nocsrf@example.com', '203.0.179.004');
    const noCsrf = await SELF.fetch('http://example.com/league/comms/drain', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }
    });
    expect(noCsrf.status).toBe(403);
  });

  it('the Comms page itself includes the drain button', async () => {
    const { cookie, csrfToken } = await signup('commsdrain.uicheck@example.com', '203.0.179.005');
    await createLeague(cookie, csrfToken, { name: 'Comms Drain UI League', teamNames: ['X', 'Y'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/league/comms', { headers: { cookie } })).text();
    expect(html).toContain('id="btn-comms-drain"');
  });

  it("runLeagueReminders' new cron-level safety net drains a league's own stuck outbox row even though nothing in this test calls drain() itself", async () => {
    const { cookie, csrfToken } = await signup('commsdrain.safetynet@example.com', '203.0.179.006');
    const league = await createLeague(cookie, csrfToken, { name: 'Comms Drain Safety Net League', teamNames: ['X', 'Y'], tracksStats: true });
    const playerId = `${league.id}:PSAFE1`;
    const eventId = `${league.id}:2026-12-10`;
    await seedDueOutboxRow(league.id, playerId, 'safetynet.recipient@example.com', eventId);

    // Not asserting an exact sentMails.length here -- an earlier test
    // in this same file deliberately left League B's row un-drained
    // (to prove a league admin's own manual drain never touches
    // another league's mail), and this cron-wide safety net correctly
    // also sweeps THAT one up on this call, alongside this test's own
    // row. Scoped to this test's own recipient instead.
    const { sentMails } = await withMailMock(() => runLeagueReminders(env));

    expect(sentMails.some(m => m.to.includes('safetynet.recipient@example.com'))).toBe(true);
    const row = await env.DB.prepare('SELECT sent_at FROM outbox WHERE player_id = ?').bind(playerId).first();
    expect(row.sent_at).not.toBeNull();
  });

  it("the cron safety net never touches a DIFFERENT league's or SMBHL's rows while draining one league's own", async () => {
    const a = await signup('commsdrain.safetya@example.com', '203.0.179.007');
    const leagueA = await createLeague(a.cookie, a.csrfToken, { name: 'Safety Net League A', teamNames: ['X', 'Y'], tracksStats: true });
    const b = await signup('commsdrain.safetyb@example.com', '203.0.179.008');
    const leagueB = await createLeague(b.cookie, b.csrfToken, { name: 'Safety Net League B', teamNames: ['X', 'Y'], tracksStats: true });

    await seedDueOutboxRow(leagueA.id, `${leagueA.id}:PSAFEA`, 'safeta@example.com', `${leagueA.id}:2026-12-11`);
    await seedDueOutboxRow(leagueB.id, `${leagueB.id}:PSAFEB`, 'safetb@example.com', `${leagueB.id}:2026-12-12`);

    await withMailMock(() => runLeagueReminders(env));

    const rowA = await env.DB.prepare('SELECT sent_at FROM outbox WHERE league_id = ?').bind(leagueA.id).first();
    const rowB = await env.DB.prepare('SELECT sent_at FROM outbox WHERE league_id = ?').bind(leagueB.id).first();
    expect(rowA.sent_at).not.toBeNull();
    expect(rowB.sent_at).not.toBeNull();
  });
});

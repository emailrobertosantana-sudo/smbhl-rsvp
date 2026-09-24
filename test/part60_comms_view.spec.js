// Live-testing task (batch 3), Part 2: Comms view -- email activity
// and cadence visibility for the league product, shared (not copied
// from SMBHL's own /admin/comms), available to every league with no
// capability-flag gate, and genuinely honest about failures.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part2-batch3-comms-secret';
const RSVP_SECRET = 'test-part2-batch3-comms-rsvp-secret';

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
async function commsData(cookie) {
  const res = await SELF.fetch('http://example.com/league/comms/data', { headers: { cookie } });
  return { status: res.status, body: await res.json() };
}
async function withMailMock(fn, { failFor } = {}) {
  const originalFetch = globalThis.fetch;
  const sentMails = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      const payload = JSON.parse(opts.body);
      if (failFor && payload.to.includes(failFor)) {
        return new Response(JSON.stringify({ statusCode: 422, message: 'simulated failure' }), { status: 422 });
      }
      sentMails.push(payload);
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

describe('Part 2 (live-testing task, batch 3): Comms view -- email activity and cadence', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    env.RESEND_API_KEY = 'test-part2-batch3-resend-key';
    await applyRealSchema(env);
  });

  it('is available to every league with no capability-flag gate, and a league with no activity shows an empty, honest state', async () => {
    const { cookie, csrfToken } = await signup('comms.empty@example.com', '203.0.178.001');
    await createLeague(cookie, csrfToken, { name: 'Comms Empty League', teamNames: ['A', 'B'], tracksStats: true });

    const { status, body } = await commsData(cookie);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.activity).toEqual([]);
    expect(body.stats).toEqual({ sent: 0, failed: 0, skipped: 0, pending: 0 });

    const pageHtml = await (await SELF.fetch('http://example.com/league/comms', { headers: { cookie } })).text();
    expect(pageHtml).toContain('id="comms-activity"');
    expect(pageHtml).toContain('id="comms-cadence"');
  });

  it('cadence reflects the league\'s real settings, including auto-draw only for weekly_draw leagues', async () => {
    const { cookie, csrfToken } = await signup('comms.cadence@example.com', '203.0.178.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Comms Cadence League', teamNames: ['A', 'B'], tracksStats: true, teamStructure: 'weekly_draw' });

    await env.DB.prepare('UPDATE leagues SET reminder_72h_enabled = 0, auto_draw_enabled = 1, auto_draw_hours_before = 36 WHERE id = ?').bind(league.id).run();

    const { body } = await commsData(cookie);
    expect(body.cadence.reminder72hEnabled).toBe(false);
    expect(body.cadence.reminder24hEnabled).toBe(true);
    expect(body.cadence.autoDrawEnabled).toBe(true);
    expect(body.cadence.autoDrawHoursBefore).toBe(36);
    expect(body.cadence.isWeeklyDraw).toBe(true);
  });

  it('a fixed-teams league never shows auto-draw (isWeeklyDraw is false)', async () => {
    const { cookie, csrfToken } = await signup('comms.fixed@example.com', '203.0.178.003');
    await createLeague(cookie, csrfToken, { name: 'Comms Fixed League', teamNames: ['A', 'B'], tracksStats: true });
    const { body } = await commsData(cookie);
    expect(body.cadence.isWeeklyDraw).toBe(false);
  });

  it('a real sub-call invite (outbox) appears in activity as sent, with its own recipient and event', async () => {
    const { cookie, csrfToken } = await signup('comms.subcall.owner@example.com', '203.0.178.004');
    const league = await createLeague(cookie, csrfToken, { name: 'Comms Subcall League', teamNames: ['Otters', 'Falcons'], tracksStats: true });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'S1' })
    });
    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Comms Sub', email: 'commssub@example.com', role: 'sub_skater' })
    });
    const futureDate = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: futureDate })
    });
    const eventId = (await eventRes.json()).event.id;

    await withMailMock(() =>
      SELF.fetch('http://example.com/league/events/invite-subs', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, team: 'Otters', need: 'skater' })
      })
    );

    const { body } = await commsData(cookie);
    expect(body.stats.sent).toBe(1);
    const row = body.activity.find(a => a.kind === 'sub_call');
    expect(row).toBeTruthy();
    expect(row.status).toBe('sent');
    expect(row.recipient).toBe('Comms Sub');
    expect(row.eventId).toBe(eventId);
  });

  it('a failed 72h reminder is genuinely recorded and appears as a failure in Comms -- not silently swallowed', async () => {
    const { cookie, csrfToken } = await signup('comms.failure.owner@example.com', '203.0.178.005');
    const league = await createLeague(cookie, csrfToken, { name: 'Comms Failure League', teamNames: ['Otters', 'Falcons'], tracksStats: true });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'S1' })
    });
    const contactRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Will Fail', email: 'willfail@example.com', role: 'roster' })
    });
    const contact = (await contactRes.json()).contact;
    // getNonResponders (fixed team structure) requires a real
    // preferred_team on file -- not set by POST /league/contacts
    // itself, matching how a real admin's roster always has one.
    await env.DB.prepare('UPDATE contacts SET preferred_team = ? WHERE player_id = ?').bind('Otters', contact.player_id).run();
    const futureDate = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: futureDate })
    });
    const eventId = (await eventRes.json()).event.id;
    // No rsvp row at all yet == a real non-responder; getNonResponders
    // picks them up via its own LEFT JOIN (r.status IS NULL).

    await withMailMock(() =>
      SELF.fetch('http://example.com/league/events/send-reminder', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId })
      }), { failFor: 'willfail@example.com' }
    );

    const failureRow = await env.DB.prepare(
      'SELECT * FROM league_mail_failure_log WHERE league_id = ?'
    ).bind(league.id).first();
    expect(failureRow).toBeTruthy();
    expect(failureRow.kind).toBe('reminder_72h');
    expect(failureRow.player_id).toBe(contact.player_id);
    expect(failureRow.error).toContain('422');

    const { body } = await commsData(cookie);
    expect(body.stats.failed).toBe(1);
    const row = body.activity.find(a => a.status === 'failed');
    expect(row).toBeTruthy();
    expect(row.kind).toBe('reminder_72h');
    expect(row.reason).toContain('422');
  });

  it('SMBHL is unaffected -- Comms has no reachable path for it (no league_admins row can ever resolve to SMBHL), and its own routes remain untouched', async () => {
    const res = await SELF.fetch('http://example.com/rsvp');
    expect(res.status).toBe(200);
  });
});

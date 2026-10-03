// Live-testing task (batch 2), Part 16: mail-queue await/waitUntil
// semantics -- the pre-existing flake's real root cause.
//
// FINDING: it was never an await/waitUntil unsoundness, and never a
// mock-timing race. Every mail send in this app (audited: every
// sendMail()/sendMailFunc() call site, every route handler's own
// `return await handleXxx(...)`, drain()'s own sequential per-message
// loop) is reliably awaited end to end -- reproduced the exact same
// 100%-deterministic failure on the commit this whole batch started
// from, with none of this session's own changes in play, ruling out
// both theories directly. The REAL cause: enqueue() unconditionally
// pushed every message's send_after past quiet hours (23:00-07:00
// local), including calls that explicitly asked for delayMin: 0 ("now").
// A second, more serious finding along the way: handleLeagueInviteSubs
// (the league product's manual "Invite Subs" button) never drained the
// outbox at all, and nothing else does for this deployment either
// (runLeagueReminders never calls drain(); SMBHL's own drain()-calling
// cron never runs on this deployment; a league admin has no ADMIN_KEY
// to reach the one route that does) -- so every sub it "invited" got a
// real outbox row that would sit there unsent forever in production,
// not just delayed by quiet hours.
//
// Both fixes are narrowly scoped to the league product's own two
// "a real person just asked for this right now" call sites
// (maybeInviteSubsForShortage, handleLeagueInviteSubs) via a new
// skipQuietHours parameter that defaults to false -- every one of
// SMBHL's own existing call sites (all automatic/cron/holdcall-driven)
// keeps its exact current quiet-hours behavior, unchanged.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { wideSubCallWindow, clockIntoWindow } from './support/wide_sub_call_window.js'; // the 8-day sub-call window these tests were written for
import { withGameTimes } from './support/game_times.js';

const AUTH_SECRET = 'test-part16-mail-queue-secret';
const RSVP_SECRET = 'test-part16-mail-queue-rsvp-secret';

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
    body: JSON.stringify({ accept_terms: true, email, password: 'a-strong-password-1' })
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

afterEach(() => { vi.useRealTimers(); });

describe('Part 16 (live-testing task, batch 2): mail-queue quiet-hours fix', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    env.RESEND_API_KEY = 'test-part16-resend-key';
    await applyRealSchema(env); await wideSubCallWindow(env);
  });

  // Season simulation fix C2 (2026-10-02): a league's shortage call made in
  // quiet hours for a game days away now waits for 07:00 (it used to go at
  // once, waking every sub); an urgent one still goes at once
  // (test/part229).
  it('a shortage-created sub-call at 23:30 for a game days away waits for the end of quiet hours', async () => {
    const { cookie, csrfToken } = await signup('mailqueue.immediate@example.com', '203.0.174.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Mail Queue Immediate League', teamNames: ['Otters', 'Falcons'], tracksStats: true });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'S1', goalies_per_team: 1, skaters_per_team: 1, min_skaters: 1 })
    });
    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Sub One', email: 'sub1@mailqueue.com', role: 'sub_skater' })
    });
    const playerRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Roster Player', role: 'roster' })
    });
    const playerId = (await playerRes.json()).contact.player_id;
    await env.DB.prepare(`UPDATE contacts SET preferred_team = 'Otters' WHERE player_id = ?`).bind(playerId).run();

    // Beyond the 8-day shortfall horizon: a game with a start time inside it
    // is checked for shortage at creation, which would call subs before the
    // step this test is about.
    const futureDate = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify(withGameTimes({ date: futureDate }))
    });
    const eventId = (await eventRes.json()).event.id;

    await env.DB.prepare(
      `INSERT INTO rsvp (event_id, league_id, player_id, team, status, role, status_by, updated_at)
       VALUES (?, ?, ?, 'Otters', 'in', 'roster', 'self', ?)`
    ).bind(eventId, league.id, playerId, new Date().toISOString()).run();

    // The drop-out happens inside the sub-call window, at 23:30 (quiet hours):
    // 91.5 hours before the 19:00 game.
    await clockIntoWindow(vi, env, eventId, 91.5);
    const beforeEnqueue = new Date();
    const { sentMails } = await withMailMock(() =>
      SELF.fetch('http://example.com/league/rsvp/admin', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: playerId, status: 'out' })
      })
    );

    // Nothing at 23:30; queued for 07:00 Montreal.
    expect(sentMails.length).toBe(0);
    const outboxRow = await env.DB.prepare(
      `SELECT * FROM outbox WHERE event_id = ? AND kind = 'sub_call'`
    ).bind(eventId).first();
    expect(outboxRow).toBeTruthy();
    expect(outboxRow.sent_at).toBeNull();
    const sendAfterMs = new Date(outboxRow.send_after).getTime();
    expect(sendAfterMs).toBeGreaterThan(beforeEnqueue.getTime());
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(sendAfterMs))).toBe('07:00');
  });

  it('the manual "Invite Subs" admin button now actually sends mail -- it used to enqueue and never drain, so it silently never sent in production', async () => {
    const { cookie, csrfToken } = await signup('mailqueue.invitesubs@example.com', '203.0.174.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Mail Queue Invite Subs League', teamNames: ['Otters', 'Falcons'], tracksStats: true });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'S1' })
    });
    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Sub Two', email: 'sub2@mailqueue.com', role: 'sub_skater' })
    });
    // Beyond the 8-day shortfall horizon: a game with a start time inside it
    // is checked for shortage at creation, which would call subs before the
    // step this test is about.
    const futureDate = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify(withGameTimes({ date: futureDate }))
    });
    const eventId = (await eventRes.json()).event.id;

    // Deliberately NOT calling drain() ourselves anywhere in this test --
    // the whole point is proving the ROUTE ITSELF now drains, matching
    // what a real deployed instance actually does today.
    const { sentMails, result: res } = await withMailMock(() =>
      SELF.fetch('http://example.com/league/events/invite-subs', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, team: 'Otters', need: 'skater' })
      })
    );
    expect(res.status).toBe(200);

    expect(sentMails.length).toBe(1);
    expect(sentMails[0].to).toEqual(['sub2@mailqueue.com']);
    const outboxRow = await env.DB.prepare(
      `SELECT * FROM outbox WHERE event_id = ? AND kind = 'sub_call'`
    ).bind(eventId).first();
    expect(outboxRow.sent_at).not.toBeNull();
  });
});

// NOTE on SMBHL's own automatic sub-call path (callSubs/enqueue's
// non-league call sites, all six of them -- see enqueue's own comment
// in src/index.js for the full list): deliberately NOT touched by this
// fix. skipQuietHours defaults to false, so every one of those keeps
// its exact current quiet-hours behavior. That guarantee is verified
// two ways: the default parameter value itself (read the source), and
// SMBHL's own full, unmodified reminder/sub-call test files passing
// unchanged in the same full-suite run this task requires after every
// part -- no wall-clock-controlled test was added here for that side
// on purpose, since asserting a specific quiet-hours outcome without
// faking the system clock (this suite has no existing fake-timer
// infrastructure) would itself be wall-clock-dependent, the exact
// flakiness class this whole investigation was about eliminating.

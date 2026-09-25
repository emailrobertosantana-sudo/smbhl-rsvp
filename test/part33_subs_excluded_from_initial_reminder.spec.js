// Live-testing task, Part 10: confirm (with a test, not just a visual
// check) that subs do NOT receive the initial "are you playing" email
// -- they're only contacted when a shortage triggers a sub invite.
//
// Investigation: this is already correctly gated for the new league
// product. getNonResponders (index.js) -- the pool the automatic
// 72h/24h reminder waves and the manual "send now" button both draw
// from -- filters to c.role = 'roster' for headcount/weekly_draw and
// c.preferred_team IS NOT NULL for fixed (see that function's own
// comment: this was fixed as a real bug in an earlier task, when
// headcount/weekly_draw leagues had NO roster players match the old
// preferred_team-based filter at all). Either way, a contact with
// role='sub_skater' or role='sub_goalie' is never a match, in any team
// structure. Subs are only ever emailed through the separate,
// shortage-triggered callSubs path (a real rsvp shortage on a team, or
// an explicit manual "invite subs" click) -- confirmed here as the
// real distinction, not just that subs never get emailed at all.
// No source change needed; this adds the explicit regression test.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { getNonResponders, runLeagueReminders } from '../src/index.js';

const AUTH_SECRET = 'test-part10-subs-excluded-secret';
const RSVP_SECRET = 'test-part10-subs-excluded-rsvp-secret';

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
async function createLeagueWithSeason(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  const league = (await res.json()).league;
  await SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ season_name: `${body.name} Season` })
  });
  return league;
}
async function addPlayer(cookie, csrfToken, name, email, extra = {}) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, email, ...extra })
  });
  return (await res.json()).contact;
}
function hoursFromNowDateTime(hours) {
  const d = new Date(Date.now() + hours * 3600000);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}
// Reminder-window-skip-on-create bug fix task: creating an event via
// the real /league/events route now marks any cadence step whose
// window has already elapsed AT CREATION as skipped (see
// reminder_scheduling.js) -- an event created 50h out (inside the 72h
// window) no longer fires its 72h reminder on the very next cron tick.
// This inserts directly, bypassing that new hook, for the one test
// below whose actual purpose is confirming who the cron emails, not
// the creation-time skip mechanism.
let directEventCounter = 0;
async function insertEventDirectlyHoursFromNow(leagueId, hours) {
  const { date, time } = hoursFromNowDateTime(hours);
  const id = `${leagueId}:direct-${++directEventCounter}:${date}`;
  await env.DB.prepare(
    `INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'Direct Season', 1, ?, 'Direct Venue', 'open', ?, ?)`
  ).bind(id, date, time, leagueId).run();
  return id;
}
async function withMailMock(fn) {
  const sent = [];
  const mockFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.includes('resend.com')) {
      const body = JSON.parse(opts.body);
      // sendMail's payload sends `to` as a one-element array ([cleanTo]).
      sent.push({ to: Array.isArray(body.to) ? body.to[0] : body.to, subject: body.subject });
      return new Response(JSON.stringify({ id: 'mock' }), { status: 200 });
    }
    return mockFetch(url, opts);
  };
  try {
    const result = await fn();
    return { sentMails: sent, result };
  } finally {
    globalThis.fetch = mockFetch;
  }
}

describe('Part 10 (live-testing task): subs never get the initial reminder, only a shortage-triggered sub invite', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    env.RESEND_API_KEY = 'mock-key';
    env.PUBLIC_URL = 'https://rsvp.notreligue.ca';
    await applyRealSchema(env);
  });

  for (const [structureLabel, leagueBody] of [
    ['fixed', { teamNames: ['A', 'B'] }],
    ['headcount', { teamStructure: 'headcount', minPlayers: 4, maxPlayers: 10 }],
    ['weekly_draw', { teamStructure: 'weekly_draw', teamNames: ['Rouge / Red', 'Bleu / Blue'] }]
  ]) {
    it(`getNonResponders never includes a sub in ${structureLabel} mode, only real roster players`, async () => {
      const { cookie, csrfToken } = await signup(`subs.excluded.${structureLabel}@example.com`, `203.0.132.${structureLabel === 'fixed' ? '001' : structureLabel === 'headcount' ? '002' : '003'}`);
      const league = await createLeagueWithSeason(cookie, csrfToken, { name: `Subs Excluded ${structureLabel} League`, tracksStats: true, ...leagueBody });
      const roster = await addPlayer(cookie, csrfToken, 'Real Roster Player', `roster.${structureLabel}@example.com`, structureLabel === 'fixed' ? { team: 'A' } : {});
      const sub = await addPlayer(cookie, csrfToken, 'Real Sub Player', `sub.${structureLabel}@example.com`, { role: structureLabel === 'headcount' ? 'sub_skater' : 'sub_skater' });

      const { date, time } = hoursFromNowDateTime(50);
      const eventRes = await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ date, start_time: time })
      });
      const eventId = (await eventRes.json()).event.id;

      const nonResponders = await getNonResponders(env, league.id, eventId);
      const ids = nonResponders.map(r => r.player_id);
      expect(ids).toContain(roster.player_id);
      expect(ids).not.toContain(sub.player_id);
    });
  }

  it('a real cron reminder tick emails the pending roster player, never the sub who never responded either', async () => {
    const { cookie, csrfToken } = await signup('subs.excluded.emailcheck@example.com', '203.0.132.004');
    const league = await createLeagueWithSeason(cookie, csrfToken, { name: 'Subs Excluded Email Check League', tracksStats: true, teamNames: ['A', 'B'] });
    const roster = await addPlayer(cookie, csrfToken, 'Pending Roster Player', 'pendingroster@example.com', { team: 'A' });
    const sub = await addPlayer(cookie, csrfToken, 'Never Emailed Sub', 'neveremailedsub@example.com', { role: 'sub_skater' });

    await insertEventDirectlyHoursFromNow(league.id, 50);

    const { sentMails } = await withMailMock(() => runLeagueReminders(env));
    const recipients = sentMails.map(m => m.to);
    expect(recipients).toContain('pendingroster@example.com');
    expect(recipients).not.toContain('neveremailedsub@example.com');
  });

  it('the SAME sub who never got the initial reminder DOES get emailed once a real shortage triggers a sub invite -- confirms this is a real distinction, not "subs never get emailed"', async () => {
    const { cookie, csrfToken } = await signup('subs.excluded.shortagecheck@example.com', '203.0.132.005');
    const league = await createLeagueWithSeason(cookie, csrfToken, { name: 'Subs Excluded Shortage Check League', tracksStats: true, teamStructure: 'headcount', minPlayers: 2, maxPlayers: 10 });
    const roster = await addPlayer(cookie, csrfToken, 'Shortage Roster Player', 'shortagerosterplayer@example.com');
    const sub = await addPlayer(cookie, csrfToken, 'Shortage Eligible Sub', 'shortageeligiblesub@example.com', { role: 'sub_skater' });

    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2099-10-11' })
    });
    const eventId = (await eventRes.json()).event.id;
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: roster.player_id, status: 'in' })
    });

    const { sentMails, result } = await withMailMock(() =>
      SELF.fetch('http://example.com/league/events/invite-subs', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        // Headcount's own single implicit "team" is the internal
        // sentinel HEADCOUNT_TEAM_NAME ('Tous', league_ids.js) -- never
        // shown in any UI, but the real value getTeamNames(cfg) resolves
        // to for a headcount league.
        body: JSON.stringify({ event_id: eventId, team: 'Tous', need: 'skater' })
      })
    );
    expect(result.status).toBe(200);
    // The shortage-triggered invite path enqueues rather than sending
    // synchronously in some flows -- if nothing sent inline here, at
    // minimum confirm the invite call succeeded and targeted this sub
    // via the outbox, proving the distinct path exists and reaches
    // them, unlike the initial reminder wave above.
    const outboxRow = await env.DB.prepare(
      "SELECT 1 FROM outbox WHERE event_id = ? AND player_id = ? AND kind = 'sub_call'"
    ).bind(eventId, sub.player_id).first();
    const emailedDirectly = sentMails.some(m => m.to === 'shortageeligiblesub@example.com');
    expect(emailedDirectly || !!outboxRow).toBe(true);
  });
});

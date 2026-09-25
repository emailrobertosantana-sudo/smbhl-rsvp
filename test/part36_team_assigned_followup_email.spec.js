// Live-testing task, Part 3: "team assigned" follow-up email for the
// specific case where a weekly_draw event's teams get drawn/assigned
// AFTER its 12h logistics email has already gone out (so that email
// went out with no team -- see Part 8's own fix, which made the
// logistics email correctly include the team whenever the draw
// happens BEFORE it, the normal/common case). Reuses the exact same
// league-aware template (renderLeagueLogisticsEmail) and sending
// identity (sendMail(..., cfg.league)) as every other league email --
// not a new path, just the same email sent again once the team is
// known, gated by whether the 12h wave already logged for this event
// (league_reminder_log), and made idempotent per (event, player) via
// league_team_assigned_email_log (migrate-034.sql).
import { env, SELF } from 'cloudflare:test';
import { runLeagueReminders } from '../src/index.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part3-team-assigned-followup-secret';
const RSVP_SECRET = 'test-part3-team-assigned-followup-rsvp-secret';

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
async function signupAndCreateWeeklyDrawLeague(email, ip, name) {
  const signupRes = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookie = extractCookie(signupRes);
  const csrfToken = extractCsrfToken(signupRes);
  const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, teamStructure: 'weekly_draw', teamNames: ['Rouge / Red', 'Bleu / Blue'], tracksStats: true })
  });
  const leagueId = (await leagueRes.json()).league.id;
  await SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ season_name: `${name} Season` })
  });
  return { cookie, csrfToken, leagueId };
}
function easternDateTimeHoursFromNow(hoursFromNow) {
  const target = new Date(Date.now() + hoursFromNow * 3600000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(target);
  const get = t => parts.find(p => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${(get('hour') === '24' ? '00' : get('hour'))}:${get('minute')}` };
}
async function createEventHoursFromNow(cookie, csrfToken, hoursFromNow) {
  const { date, time } = easternDateTimeHoursFromNow(hoursFromNow);
  const res = await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ date, start_time: time, venue: 'Test Gym' })
  });
  return (await res.json()).event;
}
// Reminder-window-skip-on-create bug fix task: createEventHoursFromNow
// (above) goes through the real /league/events route, which now marks
// any cadence step whose window has already elapsed AT CREATION as
// skipped (see reminder_scheduling.js) -- an event created 10h out
// (inside all 3 windows) no longer fires its 12h logistics email on
// the very next cron tick. This inserts directly, bypassing that new
// hook, for the tests below whose actual purpose is the team-assigned
// follow-up (which depends on the 12h wave having genuinely SENT, not
// merely been evaluated), not the creation-time skip mechanism.
let directEventCounter = 0;
async function insertEventDirectlyHoursFromNow(leagueId, hoursFromNow) {
  const { date, time } = easternDateTimeHoursFromNow(hoursFromNow);
  const id = `${leagueId}:direct-${++directEventCounter}:${date}`;
  await env.DB.prepare(
    `INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'Direct Season', 1, ?, 'Direct Venue', 'open', ?, ?)`
  ).bind(id, date, time, leagueId).run();
  return { id };
}
// F1 (players/reminders polish task): new leagues now start with all 3
// automated reminders OFF -- this file's tests are all about the 12h
// logistics wave genuinely firing, so arm it explicitly now that
// league creation no longer does it for them.
async function enable12hReminder(cookie, csrfToken) {
  await SELF.fetch('http://example.com/league/reminders/settings', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ reminder12h: true })
  });
}

async function addPlayer(cookie, csrfToken, name, email) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, email })
  });
  return (await res.json()).contact;
}
async function withMailMock(fn) {
  const originalFetch = globalThis.fetch;
  const sentMails = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      const body = JSON.parse(opts.body);
      sentMails.push({ to: Array.isArray(body.to) ? body.to[0] : body.to, subject: body.subject, text: body.text, html: body.html });
      return new Response(JSON.stringify({ id: 'mock' }), { status: 200 });
    }
    return originalFetch(url, opts);
  };
  try {
    return { sentMails, result: await fn() };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('Part 3 (live-testing task): team-assigned follow-up email for the late-draw case', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    env.RESEND_API_KEY = 'mock-key';
    env.PUBLIC_URL = 'https://rsvp.notreligue.ca';
    await applyRealSchema(env);
  });

  it('draw BEFORE the 12h email: team is included in that one email, no follow-up is sent', async () => {
    const { cookie, csrfToken, leagueId } = await signupAndCreateWeeklyDrawLeague('followup.before@example.com', '203.0.135.001', 'Followup Before League');
    await enable12hReminder(cookie, csrfToken);
    const player = await addPlayer(cookie, csrfToken, 'Before Draw Player', 'beforedrawplayer@example.com');
    const ev = await insertEventDirectlyHoursFromNow(leagueId, 10);
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: ev.id, player_id: player.player_id, status: 'in' })
    });

    // Draw happens FIRST -- no 12h wave logged yet, so no follow-up.
    const { sentMails: drawMails } = await withMailMock(() =>
      SELF.fetch('http://example.com/league/events/random-assign', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: ev.id })
      })
    );
    expect(drawMails.length).toBe(0);

    // THEN the 12h wave fires -- team is already assigned, so it's
    // included in this one email (Part 8's own fix).
    const { sentMails: waveMails } = await withMailMock(() => runLeagueReminders(env));
    const toPlayer = waveMails.filter(m => m.to === 'beforedrawplayer@example.com');
    expect(toPlayer.length).toBe(1);
    const assignedRow = await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(ev.id, player.player_id).first();
    expect(toPlayer[0].text).toContain(assignedRow.team);

    // No follow-up log entry either -- the normal path never needed one.
    const logRow = await env.DB.prepare('SELECT 1 FROM league_team_assigned_email_log WHERE event_id = ? AND player_id = ?').bind(ev.id, player.player_id).first();
    expect(logRow).toBeFalsy();
  });

  it('draw AFTER the 12h email: the logistics email has no team, then a follow-up arrives with it', async () => {
    const { cookie, csrfToken, leagueId } = await signupAndCreateWeeklyDrawLeague('followup.after@example.com', '203.0.135.002', 'Followup After League');
    await enable12hReminder(cookie, csrfToken);
    const player = await addPlayer(cookie, csrfToken, 'After Draw Player', 'afterdrawplayer@example.com');
    const ev = await insertEventDirectlyHoursFromNow(leagueId, 10);
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: ev.id, player_id: player.player_id, status: 'in' })
    });

    // 12h wave fires FIRST -- team is still null, so the logistics
    // email goes out with no team mentioned.
    const { sentMails: waveMails } = await withMailMock(() => runLeagueReminders(env));
    const firstMail = waveMails.find(m => m.to === 'afterdrawplayer@example.com');
    expect(firstMail).toBeTruthy();
    expect(firstMail.text).not.toContain('Rouge / Red');
    expect(firstMail.text).not.toContain('Bleu / Blue');

    // THEN the draw happens -- this is the late case: a follow-up must
    // fire with the real team.
    const { sentMails: drawMails } = await withMailMock(() =>
      SELF.fetch('http://example.com/league/events/random-assign', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: ev.id })
      })
    );
    const followup = drawMails.find(m => m.to === 'afterdrawplayer@example.com');
    expect(followup).toBeTruthy();
    const assignedRow = await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(ev.id, player.player_id).first();
    expect(followup.text).toContain(assignedRow.team);

    const logRow = await env.DB.prepare('SELECT 1 FROM league_team_assigned_email_log WHERE event_id = ? AND player_id = ?').bind(ev.id, player.player_id).first();
    expect(logRow).toBeTruthy();
  });

  it('the follow-up is idempotent -- reassigning the same player again does not re-send it', async () => {
    const { cookie, csrfToken, leagueId } = await signupAndCreateWeeklyDrawLeague('followup.idempotent@example.com', '203.0.135.003', 'Followup Idempotent League');
    await enable12hReminder(cookie, csrfToken);
    const player = await addPlayer(cookie, csrfToken, 'Idempotent Followup Player', 'idempotentfollowup@example.com');
    const ev = await insertEventDirectlyHoursFromNow(leagueId, 10);
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: ev.id, player_id: player.player_id, status: 'in' })
    });
    await runLeagueReminders(env); // logs the 12h wave for this event (a genuine send -- direct insert, not the creation-time skip hook)

    await withMailMock(() =>
      SELF.fetch('http://example.com/league/events/random-assign', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: ev.id })
      })
    );

    // Manually reassign the same player to the other team -- the
    // per-player manual assign route is the OTHER trigger point.
    const currentRow = await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(ev.id, player.player_id).first();
    const otherTeam = currentRow.team === 'Rouge / Red' ? 'Bleu / Blue' : 'Rouge / Red';
    const { sentMails: reassignMails } = await withMailMock(() =>
      SELF.fetch('http://example.com/league/events/assign-team', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: ev.id, player_id: player.player_id, team: otherTeam })
      })
    );
    expect(reassignMails.filter(m => m.to === 'idempotentfollowup@example.com').length).toBe(0);
  });

  it('the manual per-player assign route (not just bulk draw) also triggers the late-case follow-up', async () => {
    const { cookie, csrfToken, leagueId } = await signupAndCreateWeeklyDrawLeague('followup.manual@example.com', '203.0.135.004', 'Followup Manual League');
    await enable12hReminder(cookie, csrfToken);
    const player = await addPlayer(cookie, csrfToken, 'Manual Assign Followup Player', 'manualassignfollowup@example.com');
    const ev = await insertEventDirectlyHoursFromNow(leagueId, 10);
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: ev.id, player_id: player.player_id, status: 'in' })
    });
    await runLeagueReminders(env); // logs the 12h wave, no team yet

    const { sentMails } = await withMailMock(() =>
      SELF.fetch('http://example.com/league/events/assign-team', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: ev.id, player_id: player.player_id, team: 'Rouge / Red' })
      })
    );
    const followup = sentMails.find(m => m.to === 'manualassignfollowup@example.com');
    expect(followup).toBeTruthy();
    expect(followup.text).toContain('Rouge / Red');
  });

  it("fixed-mode/headcount leagues are unaffected -- this only applies to weekly_draw's own late-assignment case", async () => {
    // No rsvp.team write path outside weekly_draw ever calls
    // maybeSendTeamAssignedFollowup -- confirmed by construction (only
    // randomAssignEventTeams and handleLeagueAssignEventTeam call it,
    // and both are gated to teamStructure === 'weekly_draw' before any
    // team write happens at all). Re-confirmed here with a real fixed
    // league: a normal RSVP-in for a fixed-mode player (whose team is
    // set directly by writeLeagueRsvpStatus at RSVP time, not through
    // either of those routes) never touches league_team_assigned_email_log.
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.135.005' },
      body: JSON.stringify({ email: 'followup.fixed.unaffected@example.com', password: 'a-strong-password-1' })
    });
    const cookie = extractCookie(signupRes);
    const csrfToken = extractCsrfToken(signupRes);
    await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Followup Fixed Unaffected League', teamNames: ['A', 'B'], tracksStats: true })
    });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Fixed Unaffected Season' })
    });
    await enable12hReminder(cookie, csrfToken);
    const player = await addPlayer(cookie, csrfToken, 'Fixed Unaffected Player', 'fixedunaffected@example.com');
    const ev = await createEventHoursFromNow(cookie, csrfToken, 10);
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: ev.id, player_id: player.player_id, status: 'in' })
    });
    await runLeagueReminders(env);

    const logRow = await env.DB.prepare('SELECT 1 FROM league_team_assigned_email_log WHERE event_id = ?').bind(ev.id).first();
    expect(logRow).toBeFalsy();
  });
});

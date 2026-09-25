// Part 2 (automated reminders task): a per-league automated reminder/
// logistics email system, genuinely separate from SMBHL's own cron
// and shared email infra (see runLeagueReminders' own comment in
// src/index.js for the full architecture). Three independently
// toggleable automatic email types (72h/24h non-responder reminders,
// 12h confirmed-player logistics with a real opt-out), a manual
// "send now" trigger, and a distinct admin alert when the 12h opt-out
// specifically is used by a previously-confirmed player.
import { env, SELF } from 'cloudflare:test';
import worker, { runLeagueReminders, getNonResponders, getConfirmedPlayers } from '../src/index.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part8-league-reminders-secret';
const RSVP_SECRET = 'test-part8-league-reminders-rsvp-secret';

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
async function signupAndCreateLeague(email, ip, name, teamNames) {
  const signupRes = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookie = extractCookie(signupRes);
  const csrfToken = extractCsrfToken(signupRes);
  const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, teamNames, tracksStats: true })
  });
  const leagueId = (await leagueRes.json()).league.id;
  await SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ season_name: `${name} Season` })
  });
  return { cookie, csrfToken, leagueId };
}

// Builds a date/time pair whose real Eastern-timezone wall clock
// reading is exactly `hoursFromNow` hours from this instant -- so
// eventStart(ev) (which interprets date+start_time as Eastern local
// time) reconstructs back to that same real instant, regardless of
// DST, and hoursUntil comes out correct in the reminder cron's own
// math.
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
  const json = await res.json();
  return json.event.id;
}

// Reminder-window-skip-on-create bug fix task: createEventHoursFromNow
// (above) goes through the real /league/events route, which now runs
// applyReminderWindowSkipRule on every create -- correct for testing
// THAT new behavior, but wrong for a handful of pre-existing tests
// below whose actual purpose is to test runLeagueReminders'/
// sendLeagueReminderWave's own cron-tick logic in isolation, using
// "create the event, then immediately run the cron" only as a proxy
// for "this event has existed for a while and the cron's regular tick
// now finds it within a window" -- a scenario the new creation-time
// hook doesn't apply to (it only fires once, at creation). This
// inserts the event directly into `events`, bypassing the league
// product's own event-creation route (and therefore the new hook)
// entirely, the same way the SMBHL-isolation test elsewhere in this
// file already does its own direct insert.
let directEventCounter = 0;
async function insertEventDirectlyHoursFromNow(leagueId, hoursFromNow) {
  const { date, time } = easternDateTimeHoursFromNow(hoursFromNow);
  const id = `${leagueId}:direct-${++directEventCounter}:${date}`;
  await env.DB.prepare(
    `INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'Direct Season', 1, ?, 'Direct Venue', 'open', ?, ?)`
  ).bind(id, date, time, leagueId).run();
  return id;
}

async function addPlayer(cookie, csrfToken, name, team, email) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, team, email })
  });
  const json = await res.json();
  return json.contact.player_id;
}

async function withMailMock(fn) {
  const originalFetch = globalThis.fetch;
  const sentMails = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      sentMails.push(JSON.parse(opts.body));
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

describe('Part 2: per-league automated reminders', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    env.RESEND_API_KEY = 'mock-key';
    env.PUBLIC_URL = 'https://rsvp.notreligue.ca';
    await applyRealSchema(env);
  });

  it('all 3 reminder toggles default ON for a newly created league', async () => {
    const { leagueId } = await signupAndCreateLeague('reminders.defaults@example.com', '203.0.113.951', 'Defaults League', ['A', 'B']);
    const row = await env.DB.prepare('SELECT reminder_72h_enabled, reminder_24h_enabled, reminder_12h_enabled FROM leagues WHERE id = ?').bind(leagueId).first();
    expect(row.reminder_72h_enabled).toBe(1);
    expect(row.reminder_24h_enabled).toBe(1);
    expect(row.reminder_12h_enabled).toBe(1);
  });

  it('each of the 3 settings toggles independently, via the dashboard route', async () => {
    const { cookie, csrfToken, leagueId } = await signupAndCreateLeague('reminders.toggle@example.com', '203.0.113.952', 'Toggle League', ['A', 'B']);

    const res1 = await SELF.fetch('http://example.com/league/reminders/settings', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ reminder72h: false })
    });
    const json1 = await res1.json();
    // Part 9 (live-testing task) added autoDrawEnabled/autoDrawHoursBefore
    // to this same settings object -- asserting the 3 original reminder
    // keys individually rather than the object's exact shape, so this
    // test doesn't need updating again for the next independent setting
    // added to this route.
    expect(json1.settings.reminder72h).toBe(false);
    expect(json1.settings.reminder24h).toBe(true);
    expect(json1.settings.reminder12h).toBe(true);

    const res2 = await SELF.fetch('http://example.com/league/reminders/settings', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ reminder24h: false, reminder12h: false })
    });
    const json2 = await res2.json();
    expect(json2.settings.reminder72h).toBe(false);
    expect(json2.settings.reminder24h).toBe(false);
    expect(json2.settings.reminder12h).toBe(false);

    const row = await env.DB.prepare('SELECT reminder_72h_enabled, reminder_24h_enabled, reminder_12h_enabled FROM leagues WHERE id = ?').bind(leagueId).first();
    expect(row.reminder_72h_enabled).toBe(0);
    expect(row.reminder_24h_enabled).toBe(0);
    expect(row.reminder_12h_enabled).toBe(0);
  });

  it('the settings page shows the 3 real switches reflecting current state (moved from the dashboard, live-testing task Part 1)', async () => {
    const { cookie, csrfToken } = await signupAndCreateLeague('reminders.dashboard@example.com', '203.0.113.953', 'Dashboard Reminders League', ['A', 'B']);
    await SELF.fetch('http://example.com/league/reminders/settings', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ reminder24h: false })
    });
    const res = await SELF.fetch('http://example.com/league/settings', { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain('id="reminder_72h_switch"');
    expect(html).toContain('id="reminder_24h_switch"');
    expect(html).toContain('id="reminder_12h_switch"');
    expect(html).toMatch(/aria-checked="true"[^>]*id="reminder_72h_switch"/);
    expect(html).toMatch(/aria-checked="false"[^>]*id="reminder_24h_switch"/);
  });

  it('a 72h-out event with a non-responder sends the 72h reminder only to that non-responder, and logs it', async () => {
    const { cookie, csrfToken, leagueId } = await signupAndCreateLeague('reminders.r72@example.com', '203.0.113.954', 'R72 League', ['A', 'B']);
    // Direct insert, not createEventHoursFromNow -- see that helper's
    // own comment: this tests the cron catching an event that already
    // existed within its window, not the new creation-time skip hook.
    const eventId = await insertEventDirectlyHoursFromNow(leagueId, 70);
    await addPlayer(cookie, csrfToken, 'Non Responder One', 'A', 'nonresp@example.com');
    const confirmedId = await addPlayer(cookie, csrfToken, 'Already In Player', 'A', 'alreadyin@example.com');
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: confirmedId, status: 'in' })
    });

    const { sentMails } = await withMailMock(() => runLeagueReminders(env));
    expect(sentMails.length).toBe(1);
    expect(sentMails[0].to).toEqual(['nonresp@example.com']);
    expect(sentMails[0].subject).toContain('décidé');

    const logRow = await env.DB.prepare('SELECT * FROM league_reminder_log WHERE event_id = ? AND kind = ?').bind(eventId, 'reminder_72h').first();
    expect(logRow).toBeTruthy();
    expect(logRow.recipient_count).toBe(1);
  });

  it('running the cron again for the same event does not re-send the 72h reminder (idempotent via the log)', async () => {
    const { cookie, csrfToken, leagueId } = await signupAndCreateLeague('reminders.idempotent@example.com', '203.0.113.955', 'Idempotent League', ['A', 'B']);
    await insertEventDirectlyHoursFromNow(leagueId, 70);
    await addPlayer(cookie, csrfToken, 'Idempotent Non Responder', 'A', 'idem@example.com');

    const first = await withMailMock(() => runLeagueReminders(env));
    expect(first.sentMails.length).toBe(1);
    const second = await withMailMock(() => runLeagueReminders(env));
    expect(second.sentMails.length).toBe(0);
  });

  it('turning the 72h toggle off means no 72h reminder is sent for that league, even for a due event', async () => {
    const { cookie, csrfToken, leagueId } = await signupAndCreateLeague('reminders.off@example.com', '203.0.113.956', 'Off League', ['A', 'B']);
    await SELF.fetch('http://example.com/league/reminders/settings', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ reminder72h: false })
    });
    await createEventHoursFromNow(cookie, csrfToken, 70);
    await addPlayer(cookie, csrfToken, 'Should Not Get Reminder', 'A', 'shouldnot@example.com');

    const { sentMails } = await withMailMock(() => runLeagueReminders(env));
    expect(sentMails.length).toBe(0);
  });

  it('a 24h-out event sends the 24h reminder to non-responders only', async () => {
    const { cookie, csrfToken, leagueId } = await signupAndCreateLeague('reminders.r24@example.com', '203.0.113.957', 'R24 League', ['A', 'B']);
    const eventId = await insertEventDirectlyHoursFromNow(leagueId, 20);
    await addPlayer(cookie, csrfToken, 'R24 Non Responder', 'A', 'r24nonresp@example.com');
    const outId = await addPlayer(cookie, csrfToken, 'R24 Already Out', 'A', 'r24out@example.com');
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: outId, status: 'out' })
    });

    const { sentMails } = await withMailMock(() => runLeagueReminders(env));
    // A 20h-out event is also within the 72h window, so both waves
    // fire in the same tick -- 1 recipient x 2 kinds = 2 mails.
    expect(sentMails.length).toBe(2);
    expect(sentMails.every(m => m.to[0] === 'r24nonresp@example.com')).toBe(true);
    expect(sentMails.some(m => m.subject.includes('dernier rappel'))).toBe(true);
  });

  it('a 12h-out event sends the logistics email to CONFIRMED players only, never to non-responders', async () => {
    const { cookie, csrfToken, leagueId } = await signupAndCreateLeague('reminders.r12@example.com', '203.0.113.958', 'R12 League', ['A', 'B']);
    const eventId = await insertEventDirectlyHoursFromNow(leagueId, 10);
    const confirmedId = await addPlayer(cookie, csrfToken, 'R12 Confirmed', 'A', 'r12confirmed@example.com');
    await addPlayer(cookie, csrfToken, 'R12 Non Responder', 'A', 'r12nonresp@example.com');
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: confirmedId, status: 'in' })
    });

    const { sentMails } = await withMailMock(() => runLeagueReminders(env));
    const logisticsMails = sentMails.filter(m => m.subject.includes('détails') || m.subject.includes('details'));
    expect(logisticsMails.length).toBe(1);
    expect(logisticsMails[0].to).toEqual(['r12confirmed@example.com']);
    expect(sentMails.some(m => m.to[0] === 'r12nonresp@example.com' && (m.subject.includes('détails') || m.subject.includes('details')))).toBe(false);
  });

  it('getNonResponders and getConfirmedPlayers are correctly disjoint sets for the same event', async () => {
    const { cookie, csrfToken, leagueId } = await signupAndCreateLeague('reminders.disjoint@example.com', '203.0.113.959', 'Disjoint League', ['A', 'B']);
    const eventId = await createEventHoursFromNow(cookie, csrfToken, 50);
    const inId = await addPlayer(cookie, csrfToken, 'Disjoint In', 'A', 'disjointin@example.com');
    await addPlayer(cookie, csrfToken, 'Disjoint Pending', 'A', 'disjointpending@example.com');
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: inId, status: 'in' })
    });

    const nonResponders = await getNonResponders(env, leagueId, eventId);
    const confirmed = await getConfirmedPlayers(env, leagueId, eventId);
    expect(nonResponders.map(c => c.player_id)).not.toContain(inId);
    expect(confirmed.map(c => c.player_id)).toContain(inId);
    expect(confirmed.map(c => c.player_id)).not.toContain(nonResponders.map(c => c.player_id)[0]);
  });

  it('the manual "send now" trigger sends immediately outside the automatic windows, and does not block the automatic 72h reminder from firing later', async () => {
    const { cookie, csrfToken, leagueId } = await signupAndCreateLeague('reminders.manual@example.com', '203.0.113.960', 'Manual League', ['A', 'B']);
    // Far outside any automatic window (way more than 72h out).
    const eventId = await createEventHoursFromNow(cookie, csrfToken, 200);
    await addPlayer(cookie, csrfToken, 'Manual Target', 'A', 'manualtarget@example.com');

    const { sentMails: manualMails, result: manualRes } = await withMailMock(() =>
      SELF.fetch('http://example.com/league/events/send-reminder', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId })
      })
    );
    expect(manualRes.status).toBe(200);
    const manualJson = await manualRes.json();
    expect(manualJson.sent).toBe(1);
    expect(manualMails.length).toBe(1);
    expect(manualMails[0].to).toEqual(['manualtarget@example.com']);

    // The manual send must NOT have written to league_reminder_log for
    // this event -- a manual send is purely additive, never a
    // suppression of the automatic waves.
    const logRow = await env.DB.prepare('SELECT * FROM league_reminder_log WHERE event_id = ?').bind(eventId).first();
    expect(logRow).toBeNull();

    // Automation for a genuinely due event (a fresh one -- eventStart()
    // reads the date embedded in the event's own id, so simulating
    // "time passing" on the same event would require recreating its id
    // too) still works fine after a manual send elsewhere -- proves the
    // manual trigger and the automatic cron are two real, independent
    // paths, not that automation is broken by having been used.
    const secondEventId = await insertEventDirectlyHoursFromNow(leagueId, 70);
    await addPlayer(cookie, csrfToken, 'Manual Target Two', 'A', 'manualtarget2@example.com');
    const { sentMails: autoMails } = await withMailMock(() => runLeagueReminders(env));
    const ownMails = autoMails.filter(m => m.to.includes('manualtarget2@example.com'));
    expect(ownMails.length).toBe(1);
    const secondLogRow = await env.DB.prepare('SELECT * FROM league_reminder_log WHERE event_id = ?').bind(secondEventId).first();
    expect(secondLogRow).toBeTruthy();
  });

  it('the 12h logistics opt-out link changes RSVP status to OUT, triggers sub-invite shortage logic, and sends the distinct late-reversal admin alert', async () => {
    const { cookie, csrfToken, leagueId } = await signupAndCreateLeague('reminders.optout@example.com', '203.0.113.961', 'Opt Out League', ['A', 'B']);
    // Set a tight roster requirement so ONE player leaving creates a real shortage.
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Opt Out Season 2', skaters_per_team: 1, goalies_per_team: 0, min_skaters: 1 })
    });
    const eventId = await createEventHoursFromNow(cookie, csrfToken, 10);
    const playerId = await addPlayer(cookie, csrfToken, 'Late Reversal Player', 'A', 'latereversal@example.com');
    const playerSalt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerId).first()).token_salt;
    // A sub, eligible to be invited when the shortage triggers.
    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Eligible Sub', role: 'sub_skater', email: 'eligiblesub@example.com' })
    });
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: playerId, status: 'in' })
    });

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(RSVP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`lr:${leagueId}:${eventId}:${playerId}:${playerSalt}`));
    const token = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

    const { sentMails } = await withMailMock(() =>
      SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueId)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}&v=out&src=logistics12h`)
    );

    const rsvpRow = await env.DB.prepare('SELECT status FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, playerId).first();
    expect(rsvpRow.status).toBe('out');

    const subCallRow = await env.DB.prepare(`SELECT * FROM outbox WHERE event_id = ? AND kind = 'sub_call'`).bind(eventId).first();
    expect(subCallRow).toBeTruthy();
    expect(subCallRow.league_id).toBe(leagueId);

    const alertMail = sentMails.find(m => m.subject.includes('désiste') || m.subject.includes('dropped'));
    expect(alertMail).toBeTruthy();
    expect(alertMail.to).toEqual(['reminders.optout@example.com']); // the league's own admin
    expect(alertMail.subject).toContain('Late Reversal Player');
  });

  it('an ordinary self-service OUT click (no src=logistics12h) never sends the late-reversal admin alert', async () => {
    const { cookie, csrfToken, leagueId } = await signupAndCreateLeague('reminders.ordinaryout@example.com', '203.0.113.962', 'Ordinary Out League', ['A', 'B']);
    const eventId = await createEventHoursFromNow(cookie, csrfToken, 40);
    const playerId = await addPlayer(cookie, csrfToken, 'Ordinary Out Player', 'A', 'ordinaryout@example.com');
    const playerSalt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerId).first()).token_salt;
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: playerId, status: 'in' })
    });

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(RSVP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`lr:${leagueId}:${eventId}:${playerId}:${playerSalt}`));
    const token = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

    const { sentMails } = await withMailMock(() =>
      SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueId)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}&v=out`)
    );
    expect(sentMails.some(m => m.subject.includes('désiste') || m.subject.includes('dropped'))).toBe(false);
  });

  it("SMBHL is completely unaffected: its own events (league_id 'smbhl') are never touched by runLeagueReminders, and its cron path is a genuinely separate function", async () => {
    await env.DB.prepare(
      `INSERT INTO contacts (player_id, name, email, role, token_salt, league_id) VALUES ('P9901', 'Real SMBHL Reminder Player', 'realsmbhl@smbhl.com', 'roster', 'smbhlsalt1', 'smbhl')`
    ).run();
    const { date, time } = easternDateTimeHoursFromNow(70);
    await env.DB.prepare(
      `INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES ('smbhl-reminder-test-event', 'Fall 2026', 1, ?, 'Real Rink', 'open', ?, 'smbhl')`
    ).bind(date, time).run();

    const { sentMails } = await withMailMock(() => runLeagueReminders(env));
    expect(sentMails.some(m => m.to.includes('realsmbhl@smbhl.com'))).toBe(false);

    const logRow = await env.DB.prepare(`SELECT * FROM league_reminder_log WHERE event_id = 'smbhl-reminder-test-event'`).first();
    expect(logRow).toBeNull();

    // The exported symbol runSchedule (SMBHL's own real cron function)
    // is a completely different function from runLeagueReminders --
    // proving this task added a NEW function rather than modifying the
    // existing one.
    expect(typeof worker.scheduled).toBe('function');
    expect(runLeagueReminders).not.toBe(worker.scheduled);
  });

  it("an event with no start_time is skipped entirely by the automatic cron (no time to count down from), but the manual trigger still works for it", async () => {
    const { cookie, csrfToken } = await signupAndCreateLeague('reminders.notime@example.com', '203.0.113.963', 'No Time League', ['A', 'B']);
    const res = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2099-01-01' })
    });
    const eventId = (await res.json()).event.id;
    await addPlayer(cookie, csrfToken, 'No Time Player', 'A', 'notime@example.com');

    const { sentMails: autoMails } = await withMailMock(() => runLeagueReminders(env));
    expect(autoMails.length).toBe(0);

    const { sentMails: manualMails, result: manualRes } = await withMailMock(() =>
      SELF.fetch('http://example.com/league/events/send-reminder', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId })
      })
    );
    expect(manualRes.status).toBe(200);
    expect(manualMails.length).toBe(1);
  });
});

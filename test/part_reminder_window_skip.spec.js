// Reminder-window-skip-on-create/reschedule bug fix.
//
// CONFIRMED BUG (live on demo, real emails sent): creating a league
// event whose game is only a few days out fired every reminder wave
// whose hours-before threshold had already elapsed, all in one burst,
// on the very next cron tick -- see src/reminder_scheduling.js's own
// top comment for the full root-cause writeup. This file proves the
// fix: applyReminderWindowSkipRule, called from createLeagueEventRow
// (src/leagues.js) on every event create/bulk-create/duplicate (all
// three funnel through that one function).
import { env, SELF } from 'cloudflare:test';
import { runLeagueReminders } from '../src/index.js';
import { applyReminderWindowSkipRule } from '../src/reminder_scheduling.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-reminder-skip-secret';
const RSVP_SECRET = 'test-reminder-skip-rsvp-secret';

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

// Same helper as part8_league_reminders.spec.js -- see that file for
// why this reconstructs a real Eastern local date/time rather than a
// naive UTC offset.
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
  if (!json.ok) throw new Error(`event create failed: ${JSON.stringify(json)}`);
  return json.event.id;
}

// F1 (players/reminders polish task): new leagues now start with all 3
// automated reminders OFF (previously ON by default). This whole file
// is about the skip-marking behavior for ENABLED kinds, so most tests
// need to explicitly arm reminders now that league creation no longer
// does it for them (the dedicated "disabled kind" test below still
// covers the off case on its own terms).
async function enableAllReminders(cookie, csrfToken) {
  await SELF.fetch('http://example.com/league/reminders/settings', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ reminder72h: true, reminder24h: true, reminder12h: true })
  });
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

async function reminderLogRows(eventId) {
  return (await env.DB.prepare(
    'SELECT kind, skipped, recipient_count FROM league_reminder_log WHERE event_id = ? ORDER BY kind'
  ).bind(eventId).all()).results || [];
}

describe('Reminder-window-skip-on-create/reschedule bug fix', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    env.RESEND_API_KEY = 'mock-key';
    env.PUBLIC_URL = 'https://rsvp.notreligue.ca';
    await applyRealSchema(env);
  });

  it('an event created with ALL windows already passed (72h/24h/12h) is marked skipped for all 3 kinds, and sends nothing', async () => {
    const { cookie, csrfToken } = await signupAndCreateLeague('skip.all@example.com', '203.0.113.970', 'Skip All League', ['A', 'B']);
    await enableAllReminders(cookie, csrfToken);
    // 5 hours out: already inside all 3 windows (72/24/12) the instant
    // the event is created -- exactly the confirmed live-demo bug
    // scenario (a Friday event created a few days out, just more extreme).
    const eventId = await createEventHoursFromNow(cookie, csrfToken, 5);
    await addPlayer(cookie, csrfToken, 'Non Responder', 'A', 'skipall.nonresp@example.com');

    const rows = await reminderLogRows(eventId);
    expect(rows.length).toBe(3);
    expect(rows.every(r => r.skipped === 1)).toBe(true);
    expect(rows.map(r => r.kind).sort()).toEqual(['logistics_12h', 'reminder_24h', 'reminder_72h']);

    const { sentMails } = await withMailMock(() => runLeagueReminders(env));
    expect(sentMails.length).toBe(0);
  });

  it('an event created with SOME windows already passed (only 72h) marks just that one skipped, leaving the still-future 24h/12h windows untouched (no row at all)', async () => {
    const { cookie, csrfToken } = await signupAndCreateLeague('skip.some@example.com', '203.0.113.971', 'Skip Some League', ['A', 'B']);
    await enableAllReminders(cookie, csrfToken);
    // 50 hours out: past the 72h threshold (50 <= 72) but not yet the
    // 24h or 12h ones (50 > 24, 50 > 12).
    const eventId = await createEventHoursFromNow(cookie, csrfToken, 50);
    await addPlayer(cookie, csrfToken, 'Non Responder', 'A', 'skipsome.nonresp@example.com');

    const rows = await reminderLogRows(eventId);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('reminder_72h');
    expect(rows[0].skipped).toBe(1);

    // Nothing is due yet for this event at all (24h/12h windows genuinely
    // haven't opened; 72h is already accounted for by the skip row), so
    // running the cron right now sends nothing -- but critically, unlike
    // the old bug, that's ONLY the 72h step being correctly suppressed,
    // not a false backlog burst across all 3. The still-future 24h/12h
    // steps have no row at all, meaning nothing stops them firing
    // normally on their own schedule once genuinely due -- exactly
    // proven, for a live/due window, by part8_league_reminders.spec.js's
    // own (pre-existing, unmodified) reminder-sending tests.
    const { sentMails } = await withMailMock(() => runLeagueReminders(env));
    expect(sentMails.length).toBe(0);
  });

  it('an event created well in advance (before any window has opened) is completely unaffected: no skip rows at all, full cadence still available', async () => {
    const { cookie, csrfToken } = await signupAndCreateLeague('skip.advance@example.com', '203.0.113.972', 'Well In Advance League', ['A', 'B']);
    // 200 hours out: outside all 3 windows.
    const eventId = await createEventHoursFromNow(cookie, csrfToken, 200);
    await addPlayer(cookie, csrfToken, 'Non Responder', 'A', 'advance.nonresp@example.com');

    const rows = await reminderLogRows(eventId);
    expect(rows.length).toBe(0);

    // Nothing due yet (still 200h out) -- correct, matches pre-fix
    // behavior for an event created this far ahead.
    const { sentMails } = await withMailMock(() => runLeagueReminders(env));
    expect(sentMails.length).toBe(0);
  });

  // Rule 2 (date-change handling): no live /league/event date-edit route
  // exists yet in this codebase (confirmed by exhaustive grep of
  // leagues.js's exported event functions -- only create/bulk-create/
  // duplicate/reminders-opt-out exist). applyReminderWindowSkipRule is
  // exercised directly in both tests below -- exactly how a future
  // date-change route is meant to call it, passing the event's id and
  // its (now-updated) start_time.
  //
  // CAVEAT worth flagging plainly (per this task's own instruction to
  // say so if something doesn't fit cleanly): eventStart() -- and so
  // this function -- currently derives an event's date from the trailing
  // date suffix of its OWN id (league_ids.js), not from a separate
  // `date`/`start_time`-only column read. Under today's id scheme
  // (makeEventId(leagueId, date)), an event's id itself literally
  // encodes its date, so two calls representing "the SAME event, before
  // and after a real reschedule" cannot both use a textually identical
  // id if the id must keep parsing to the correct new date -- a genuine
  // date-edit route will need to decide how it reconciles that (e.g.
  // eventStart reading a real `date` column instead of parsing id,
  // decoupling identity from date the way this bug fix's OWN logic
  // already assumes it can). That's exactly the kind of change the
  // in-progress module extraction should resolve, not this task -- so
  // each test below drives one representative id/date rather than
  // literally reusing one id across a simulated reschedule.
  it('Rule 2 (closer): a step whose window has newly elapsed gets marked skipped; a step that already genuinely sent is left completely untouched', async () => {
    const { cookie, csrfToken, leagueId } = await signupAndCreateLeague('skip.reschedule.closer@example.com', '203.0.113.973', 'Reschedule Closer League', ['A', 'B']);
    await enableAllReminders(cookie, csrfToken);
    const { date, time } = easternDateTimeHoursFromNow(5); // past all 3 windows
    const eventId = `${leagueId}:${date}`;

    // Simulate a GENUINE prior send for reminder_72h (skipped = 0) --
    // "already sent stays sent" must hold regardless of what the event's
    // date later becomes.
    await env.DB.prepare(
      `INSERT INTO league_reminder_log (event_id, kind, league_id, sent_at, recipient_count, skipped) VALUES (?, 'reminder_72h', ?, ?, 3, 0)`
    ).bind(eventId, leagueId, new Date().toISOString()).run();

    await applyReminderWindowSkipRule(env, leagueId, { id: eventId, start_time: time });

    const rows = await reminderLogRows(eventId);
    const byKind = Object.fromEntries(rows.map(r => [r.kind, r]));
    expect(byKind.reminder_72h.skipped).toBe(0);
    expect(byKind.reminder_72h.recipient_count).toBe(3); // untouched -- already sent stays sent
    expect(byKind.reminder_24h.skipped).toBe(1);
    expect(byKind.logistics_12h.skipped).toBe(1);
  });

  it('Rule 2 (further out): a step previously marked skipped has that mark cleared once its window is legitimately back in the future; a genuinely-sent step is still left untouched', async () => {
    const { cookie, csrfToken, leagueId } = await signupAndCreateLeague('skip.reschedule.further@example.com', '203.0.113.974', 'Reschedule Further League', ['A', 'B']);
    await enableAllReminders(cookie, csrfToken);
    const { date, time } = easternDateTimeHoursFromNow(200); // well outside all 3 windows
    const eventId = `${leagueId}:${date}`;

    await env.DB.prepare(
      `INSERT INTO league_reminder_log (event_id, kind, league_id, sent_at, recipient_count, skipped) VALUES
         (?, 'reminder_72h', ?, ?, 7, 0),
         (?, 'reminder_24h', ?, ?, 0, 1),
         (?, 'logistics_12h', ?, ?, 0, 1)`
    ).bind(eventId, leagueId, new Date().toISOString(), eventId, leagueId, new Date().toISOString(), eventId, leagueId, new Date().toISOString()).run();

    await applyReminderWindowSkipRule(env, leagueId, { id: eventId, start_time: time });

    const rows = await reminderLogRows(eventId);
    const byKind = Object.fromEntries(rows.map(r => [r.kind, r]));
    expect(byKind.reminder_72h.skipped).toBe(0);
    expect(byKind.reminder_72h.recipient_count).toBe(7); // untouched -- already sent stays sent
    expect(byKind.reminder_24h).toBeUndefined(); // stale skip cleared -- can fire normally once due again
    expect(byKind.logistics_12h).toBeUndefined();
  });

  it('applies to the simple on/off toggle model too: a kind the league has disabled is never marked skipped (nothing to mark -- it was never going to send)', async () => {
    const { cookie, csrfToken, leagueId } = await signupAndCreateLeague('skip.toggleoff@example.com', '203.0.113.974', 'Toggle Off League', ['A', 'B']);
    // reminder_72h stays off (the new create-time default); 24h/12h are
    // explicitly armed so this test still proves what it always proved --
    // a disabled kind gets no row, an enabled one gets a real skip row.
    await SELF.fetch('http://example.com/league/reminders/settings', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ reminder72h: false, reminder24h: true, reminder12h: true })
    });
    // 5 hours out: past all 3 windows, but reminder_72h is disabled for this league.
    const eventId = await createEventHoursFromNow(cookie, csrfToken, 5);

    const rows = await reminderLogRows(eventId);
    const byKind = Object.fromEntries(rows.map(r => [r.kind, r]));
    expect(byKind.reminder_72h).toBeUndefined(); // disabled -- no row either way
    expect(byKind.reminder_24h.skipped).toBe(1);
    expect(byKind.logistics_12h.skipped).toBe(1);
  });

  it('an event created with auto_reminders_enabled explicitly off gets no skip rows at all, matching runLeagueReminders\' own event-level filter', async () => {
    const { cookie, csrfToken } = await signupAndCreateLeague('skip.autooff@example.com', '203.0.113.975', 'Auto Off League', ['A', 'B']);
    const { date, time } = easternDateTimeHoursFromNow(5);
    const res = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date, start_time: time, venue: 'Test Gym', auto_reminders_enabled: false })
    });
    const eventId = (await res.json()).event.id;

    const rows = await reminderLogRows(eventId);
    expect(rows.length).toBe(0);
  });
});

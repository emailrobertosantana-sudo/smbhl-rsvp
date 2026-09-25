// Live-testing task (batch 6), Part 10 (BIG): event creation warns
// before arming automated emails.
//
// Before this part, creating an event silently armed the cron-driven
// 72h/24h/12h reminder waves (runLeagueReminders) with no indication
// to the admin that real emails were about to go out, and no way to
// opt a single event out short of disabling reminders for the WHOLE
// league. Fix: the schedule page's create-event form now shows a
// warning (which reminder kinds are armed, how many real player
// emails would receive them) whenever it would actually do something
// -- never when reminders are off, never when nobody on the roster has
// a real email -- alongside a per-event opt-out checkbox. The opt-out
// is genuinely enforced (runLeagueReminders' own event query excludes
// it), not just a UI label, and stays visible/changeable afterward on
// the event detail page.
import { env, SELF } from 'cloudflare:test';
import worker, { runLeagueReminders } from '../src/index.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { extractInlineScripts, assertNoSyntaxError } from './support/inline_scripts.js';

const AUTH_SECRET = 'test-part81-reminder-warning-optout-secret';
const RSVP_SECRET = 'test-part81-reminder-warning-optout-rsvp-secret';

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
async function publishSeason(cookie, csrfToken, body) {
  return SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
}
async function addContact(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).contact;
}
async function createEvent(cookie, csrfToken, body) {
  return SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
}
// Reminder-window-skip-on-create bug fix task: createEvent (above) goes
// through the real /league/events route, which now marks any cadence
// step whose window has already elapsed AT CREATION as skipped (see
// reminder_scheduling.js) -- correct new behavior, but it means an
// event created 30h out (inside the 72h window) no longer sends its
// 72h reminder on the very next cron tick, since that reminder is now
// deliberately skipped rather than fired late. This test's own purpose
// is the auto_reminders_enabled opt-out, not the creation-time skip
// mechanism (covered by test/part_reminder_window_skip.spec.js), so
// the "armed" side inserts directly, bypassing the new hook, to
// represent an event that already existed for a while before this
// cron tick -- same pattern used in part8_league_reminders.spec.js.
let directEventCounter = 0;
async function insertEventDirectly(leagueId, date, time) {
  const id = `${leagueId}:direct-${++directEventCounter}:${date}`;
  await env.DB.prepare(
    `INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'Direct Season', 1, ?, 'Direct Venue', 'open', ?, ?)`
  ).bind(id, date, time, leagueId).run();
  return id;
}
async function disableAllReminders(cookie, csrfToken) {
  return SELF.fetch('http://example.com/league/reminders/settings', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ reminder72h: false, reminder24h: false, reminder12h: false })
  });
}
// F1 (players/reminders polish task): new leagues now start with all 3
// reminders OFF (previously ON by default) -- callers that need the
// warning/sending machinery genuinely armed must do so explicitly now.
async function enableAllReminders(cookie, csrfToken) {
  return SELF.fetch('http://example.com/league/reminders/settings', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ reminder72h: true, reminder24h: true, reminder12h: true })
  });
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

describe('Part 10 (live-testing task, batch 6): event creation warns before arming automated emails, with a real per-event opt-out', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    env.RESEND_API_KEY = 'mock-key';
    env.PUBLIC_URL = 'https://rsvp.notreligue.ca';
    await applyRealSchema(env);
  });

  it('shows the warning (recipient count + which kinds are armed) once real player emails exist and reminders are armed', async () => {
    const { cookie, csrfToken } = await signup('optout.warn@example.com', '203.0.197.001');
    await createLeague(cookie, csrfToken, { name: 'Reminder Warn League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    // F1 changed the create-time default to OFF -- explicitly arm here
    // since this test is about the warning UI, not the default itself
    // (that's covered by part7_live_bugs.spec.js's F1 tests).
    await enableAllReminders(cookie, csrfToken);
    await addContact(cookie, csrfToken, { name: 'Real Email Player', role: 'roster', email: 'realemail@example.com' });

    const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    // 'sc-reminder-warn' also names the CSS class rule itself (always
    // present in <style>, regardless of whether the box renders) -- the
    // real presence check is the checkbox/label that only exist INSIDE
    // the conditional block.
    expect(html).toContain('class="sc-reminder-warn"');
    expect(html).toContain('Rappel 72');
    expect(html).toContain('id="e_reminders_optout"');
    expect(html).toContain('id="be_reminders_optout"');
    expect(html).toContain('data-i18n="remindersOptOutLabel"');
    // The apostrophe in "Jusqu'à" is HTML-escaped (&#39;) by this page's
    // own esc() -- matches the real rendered entity, not a raw quote.
    expect(html).toMatch(/Jusqu&#39;à 1 joueur/);
  });

  it('shows no warning when every reminder is disabled for this league', async () => {
    const { cookie, csrfToken } = await signup('optout.disabled@example.com', '203.0.197.002');
    await createLeague(cookie, csrfToken, { name: 'Reminder Disabled League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await addContact(cookie, csrfToken, { name: 'Real Email Player Two', role: 'roster', email: 'realemail2@example.com' });
    await disableAllReminders(cookie, csrfToken);

    const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    expect(html).not.toContain('class="sc-reminder-warn"');
    expect(html).not.toContain('id="e_reminders_optout"');
  });

  it('shows no warning when reminders are on but nobody on the roster has a real email yet', async () => {
    const { cookie, csrfToken } = await signup('optout.noemails@example.com', '203.0.197.003');
    await createLeague(cookie, csrfToken, { name: 'Reminder No Emails League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await addContact(cookie, csrfToken, { name: 'No Email Player' });

    const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    expect(html).not.toContain('class="sc-reminder-warn"');
  });

  it('creating an event with auto_reminders_enabled: false records the opt-out; omitting it defaults to armed', async () => {
    const { cookie, csrfToken } = await signup('optout.create@example.com', '203.0.197.004');
    const league = await createLeague(cookie, csrfToken, { name: 'Reminder Create League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const optedOut = await (await createEvent(cookie, csrfToken, { date: '2099-07-01', auto_reminders_enabled: false })).json();
    expect(optedOut.event.auto_reminders_enabled).toBe(false);
    const armed = await (await createEvent(cookie, csrfToken, { date: '2099-07-02' })).json();
    expect(armed.event.auto_reminders_enabled).toBe(true);

    const rows = await env.DB.prepare('SELECT id, auto_reminders_enabled FROM events WHERE league_id = ? ORDER BY date').bind(league.id).all();
    const byId = Object.fromEntries(rows.results.map(r => [r.id, r.auto_reminders_enabled]));
    expect(byId[optedOut.event.id]).toBe(0);
    expect(byId[armed.event.id]).toBe(1);
  });

  it("genuine opt-out isolation: an opted-out event's players never receive the automated reminder, while a SIBLING armed event's players still do", async () => {
    const { cookie, csrfToken, } = await signup('optout.isolation@example.com', '203.0.197.005');
    const league = await createLeague(cookie, csrfToken, { name: 'Reminder Isolation League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await enableAllReminders(cookie, csrfToken);

    // 40h apart (both still inside the cron's 72h window) so the two
    // events are guaranteed to land on different calendar dates --
    // createLeagueEventRow keys collision detection on date alone.
    const { date: optOutDate, time: optOutTime } = easternDateTimeHoursFromNow(70);
    const optOutEv = await (await createEvent(cookie, csrfToken, { date: optOutDate, start_time: optOutTime, auto_reminders_enabled: false })).json();
    const optOutPlayer = await addContact(cookie, csrfToken, { name: 'Opted Out Event Player', role: 'roster', team: 'A', email: 'optedout@example.com' });

    const { date: armedDate, time: armedTime } = easternDateTimeHoursFromNow(30);
    const armedEventId = await insertEventDirectly(league.id, armedDate, armedTime);
    const armedPlayer = await addContact(cookie, csrfToken, { name: 'Armed Event Player', role: 'roster', team: 'A', email: 'armed@example.com' });

    // Contacts are league-wide, not per-event -- without this, EITHER
    // player would also count as a real non-responder on the OTHER
    // event (they never RSVP'd to it either), muddying which event's
    // reminder actually reached them. Confirming each player 'in' on
    // the event that ISN'T theirs isolates each one to exactly the
    // event this test cares about.
    async function setRsvpIn(eventId, playerId) {
      await SELF.fetch('http://example.com/league/rsvp/admin', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: playerId, status: 'in' })
      });
    }
    await setRsvpIn(armedEventId, optOutPlayer.player_id);
    await setRsvpIn(optOutEv.event.id, armedPlayer.player_id);

    const { sentMails } = await withMailMock(() => runLeagueReminders(env));
    const recipientAddresses = sentMails.flatMap(m => m.to);
    expect(recipientAddresses).not.toContain('optedout@example.com');
    expect(recipientAddresses).toContain('armed@example.com');

    // The opted-out event never even gets a log row for this wave --
    // confirms it was excluded at the query level, not just filtered
    // client-side.
    const optOutLog = await env.DB.prepare('SELECT 1 FROM league_reminder_log WHERE event_id = ?').bind(optOutEv.event.id).first();
    expect(optOutLog).toBeFalsy();
    const armedLog = await env.DB.prepare('SELECT 1 FROM league_reminder_log WHERE event_id = ? AND kind = ?').bind(armedEventId, 'reminder_72h').first();
    expect(armedLog).toBeTruthy();
  });

  it('the event detail page shows the current reminder state and lets an admin toggle it afterward -- visible/changeable, per the task', async () => {
    const { cookie, csrfToken } = await signup('optout.toggle@example.com', '203.0.197.006');
    await createLeague(cookie, csrfToken, { name: 'Reminder Toggle League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    // A2 (reminder-state polish task): the switch now reflects whether
    // anything would ACTUALLY send -- the AND of this event's own flag
    // (armed by default) and the league's own cadence (F1: off by
    // default). Armed explicitly here so "before: true" reflects a
    // real armed state, not the same per-event-only bug this task fixed
    // (see the dedicated A2 test below for that mismatch itself).
    await enableAllReminders(cookie, csrfToken);
    const ev = await (await createEvent(cookie, csrfToken, { date: '2099-07-03' })).json();

    const before = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(ev.event.id)}`, { headers: { cookie } })).text();
    expect(before).toMatch(/aria-checked="true"[^>]*id="ev_reminders_switch"/);

    const toggleRes = await SELF.fetch('http://example.com/league/events/reminders', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: ev.event.id, auto_reminders_enabled: false })
    });
    expect(toggleRes.status).toBe(200);
    const toggleData = await toggleRes.json();
    expect(toggleData.auto_reminders_enabled).toBe(false);

    const after = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(ev.event.id)}`, { headers: { cookie } })).text();
    expect(after).toMatch(/aria-checked="false"[^>]*id="ev_reminders_switch"/);

    const row = await env.DB.prepare('SELECT auto_reminders_enabled FROM events WHERE id = ?').bind(ev.event.id).first();
    expect(row.auto_reminders_enabled).toBe(0);
  });

  it("a league admin cannot toggle another league's event (404), and SMBHL is blocked", async () => {
    const a = await signup('optout.isoA@example.com', '203.0.197.007');
    const b = await signup('optout.isoB@example.com', '203.0.197.008');
    await createLeague(a.cookie, a.csrfToken, { name: 'Reminder Iso League A', teamNames: ['A1', 'A2'] });
    await createLeague(b.cookie, b.csrfToken, { name: 'Reminder Iso League B', teamNames: ['B1', 'B2'] });
    await publishSeason(a.cookie, a.csrfToken, { season_name: 'S1' });
    const evA = await (await createEvent(a.cookie, a.csrfToken, { date: '2099-07-04' })).json();

    const res = await SELF.fetch('http://example.com/league/events/reminders', {
      method: 'POST', headers: { cookie: b.cookie, 'content-type': 'application/json', 'x-csrf-token': b.csrfToken },
      body: JSON.stringify({ event_id: evA.event.id, auto_reminders_enabled: false })
    });
    expect(res.status).toBe(404);

    // No league at all for this session -- same SMBHL-blocked shape
    // every other ROUTE_BLOCKED_* test in this codebase uses.
    const c = await signup('optout.smbhl@example.com', '203.0.197.009');
    const smbhlRes = await SELF.fetch('http://example.com/league/events/reminders', {
      method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/json', 'x-csrf-token': c.csrfToken },
      body: JSON.stringify({ event_id: 'whatever', auto_reminders_enabled: false })
    });
    expect([403, 404]).toContain(smbhlRes.status);
  });

  it('bulk event creation carries the opt-out through to every created event', async () => {
    const { cookie, csrfToken } = await signup('optout.bulk@example.com', '203.0.197.010');
    await createLeague(cookie, csrfToken, { name: 'Reminder Bulk League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const bulkRes = await SELF.fetch('http://example.com/league/events/bulk', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ startDate: '2099-08-01', occurrences: 2, auto_reminders_enabled: false })
    });
    const bulkData = await bulkRes.json();
    expect(bulkData.createdCount).toBe(2);
    for (const r of bulkData.results) {
      const row = await env.DB.prepare('SELECT auto_reminders_enabled FROM events WHERE id = ?').bind(r.event.id).first();
      expect(row.auto_reminders_enabled).toBe(0);
    }
  });

  it('duplicating an event carries its own opt-out state forward', async () => {
    const { cookie, csrfToken } = await signup('optout.duplicate@example.com', '203.0.197.011');
    await createLeague(cookie, csrfToken, { name: 'Reminder Duplicate League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const source = await (await createEvent(cookie, csrfToken, { date: '2099-08-10', auto_reminders_enabled: false })).json();

    const dupRes = await SELF.fetch('http://example.com/league/events/duplicate', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: source.event.id, date: '2099-08-17' })
    });
    const dupData = await dupRes.json();
    expect(dupData.event.auto_reminders_enabled).toBe(false);
  });

  it('inline scripts on the schedule and event detail pages stay syntactically valid with the new warning/toggle markup', async () => {
    const { cookie, csrfToken } = await signup('optout.scripts@example.com', '203.0.197.012');
    await createLeague(cookie, csrfToken, { name: 'Reminder Scripts League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await addContact(cookie, csrfToken, { name: 'Scripts Real Email', role: 'roster', email: 'scripts@example.com' });
    const ev = await (await createEvent(cookie, csrfToken, { date: '2099-08-20' })).json();

    const scheduleHtml = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    const detailHtml = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(ev.event.id)}`, { headers: { cookie } })).text();
    for (const html of [scheduleHtml, detailHtml]) {
      const scripts = extractInlineScripts(html);
      expect(scripts.length).toBeGreaterThan(0);
      assertNoSyntaxError(scripts);
    }
  });
});

describe('F2 (players/reminders polish task): Players page shows a backstop banner when adding players close to an armed game', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    env.RESEND_API_KEY = 'mock-key';
    env.PUBLIC_URL = 'https://rsvp.notreligue.ca';
    await applyRealSchema(env);
  });

  it('shows the banner when the nearest upcoming event is inside the widest armed reminder window', async () => {
    const { cookie, csrfToken } = await signup('f2.banner.show@example.com', '203.0.197.101');
    const league = await createLeague(cookie, csrfToken, { name: 'F2 Banner Show League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await enableAllReminders(cookie, csrfToken);
    // 50h out -- inside the 72h window, outside 24h/12h.
    const { date, time } = easternDateTimeHoursFromNow(50);
    await insertEventDirectly(league.id, date, time);

    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    expect(html).toContain('id="ro-reminders-banner"');
    expect(html).toContain('data-i18n="remindersBannerTitle"');
    expect(html).toContain('data-i18n="pauseRemindersBtn"');
    // C1 (state-not-reflected polish task): active state keeps the red
    // border and active copy -- only correct while emails are actually live.
    expect(html).toContain('border-color:var(--danger,#b3122e)');
    expect(html).not.toContain('data-i18n="remindersBannerTitlePaused"');
  });

  it('no banner when reminders are off for this league (the F1 default), even with an imminent event', async () => {
    const { cookie, csrfToken } = await signup('f2.banner.off@example.com', '203.0.197.102');
    const league = await createLeague(cookie, csrfToken, { name: 'F2 Banner Off League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    // Reminders left at their F1 default (off) -- no enableAllReminders call.
    const { date, time } = easternDateTimeHoursFromNow(10);
    await insertEventDirectly(league.id, date, time);

    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    expect(html).not.toContain('id="ro-reminders-banner"');
  });

  it('no banner when the nearest event is outside every armed window', async () => {
    const { cookie, csrfToken } = await signup('f2.banner.faraway@example.com', '203.0.197.103');
    const league = await createLeague(cookie, csrfToken, { name: 'F2 Banner Faraway League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await enableAllReminders(cookie, csrfToken);
    // 200h out -- outside all 3 windows.
    const { date, time } = easternDateTimeHoursFromNow(200);
    await insertEventDirectly(league.id, date, time);

    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    expect(html).not.toContain('id="ro-reminders-banner"');
  });

  it('the banner\'s pause control sets auto_reminders_enabled: false for exactly that event, and flips to a resume label', async () => {
    const { cookie, csrfToken } = await signup('f2.banner.pause@example.com', '203.0.197.104');
    const league = await createLeague(cookie, csrfToken, { name: 'F2 Banner Pause League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await enableAllReminders(cookie, csrfToken);
    const { date, time } = easternDateTimeHoursFromNow(50);
    const eventId = await insertEventDirectly(league.id, date, time);

    const pauseRes = await SELF.fetch('http://example.com/league/events/reminders', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, auto_reminders_enabled: false })
    });
    expect(pauseRes.status).toBe(200);
    const row = await env.DB.prepare('SELECT auto_reminders_enabled FROM events WHERE id = ?').bind(eventId).first();
    expect(row.auto_reminders_enabled).toBe(0);

    // The banner itself keeps showing (still inside the window) but now
    // offers "resume" instead of "pause" -- the event query it's built
    // from reads auto_reminders_enabled fresh on every page load.
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    expect(html).toContain('id="ro-reminders-banner"');
    expect(html).toContain('data-i18n="resumeRemindersBtn"');
    expect(html).not.toContain('data-i18n="pauseRemindersBtn"');
    // C1 (state-not-reflected polish task): the banner used to keep its
    // active-state title/description/red border even once paused -- only
    // the button read the toggle. Paused state now gets neutral styling
    // and its own copy, in both languages, checked from the rendered page.
    expect(html).toContain('data-i18n="remindersBannerTitlePaused">Les rappels automatiques sont en pause<');
    expect(html).toContain('data-i18n="remindersBannerDescPaused">');
    expect(html).toContain("Ajouter des joueurs n'enverra rien tant que tu ne les reprends pas.");
    expect(html).not.toContain('data-i18n="remindersBannerTitle">');
    expect(html).not.toContain('border-color:var(--danger,#b3122e)');

    // The page ships both languages' dicts in its own inline __I18N
    // object (client-side language switch) -- this is how every other
    // language check in this codebase confirms the EN copy, not a
    // separate ?lang=en fetch (the roster page doesn't read that param).
    const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/);
    const dict = JSON.parse(m[1]);
    expect(dict.en.remindersBannerTitlePaused).toBe('Automated reminders are paused');
    expect(dict.en.remindersBannerDescPaused).toBe("Automated reminders are paused for this game. Adding players won't send anything until you resume.");
    expect(dict.fr.remindersBannerTitlePaused).toBe('Les rappels automatiques sont en pause');
    expect(dict.fr.remindersBannerDescPaused).toBe("Les rappels automatiques sont en pause pour ce match. Ajouter des joueurs n'enverra rien tant que tu ne les reprends pas.");
  });
});

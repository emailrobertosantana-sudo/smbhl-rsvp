// Live-testing task, Part 7: bulk event creation and duplicate events.
// POST /league/events/bulk creates a weekly series from a start date
// plus either an occurrence count or an end date; POST
// /league/events/duplicate copies one existing event's venue/time to a
// new date. Both reuse createLeagueEventRow (leagues.js) -- the exact
// same validation and collision-safe ID generation
// (league_ids.js's makeEventId) the single-event route uses.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part7-bulk-events-secret';

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
async function createLeagueWithSeason(cookie, csrfToken, name) {
  const res = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, teamNames: ['A', 'B'], tracksStats: true })
  });
  const league = (await res.json()).league;
  await SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ season_name: `${name} Season` })
  });
  return league;
}
async function bulkCreateEvents(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events/bulk', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}
async function duplicateEvent(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events/duplicate', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

describe('Part 7 (live-testing task): bulk event creation (POST /league/events/bulk)', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('creates N correctly weekly-spaced, collision-safe events from a start date + occurrence count', async () => {
    const { cookie, csrfToken } = await signup('bulk.events.occurrences@example.com', '203.0.129.001');
    await createLeagueWithSeason(cookie, csrfToken, 'Bulk Events Occurrences League');

    const { status, json } = await bulkCreateEvents(cookie, csrfToken, {
      startDate: '2099-11-01', occurrences: 5, start_time: '19:00', venue: 'Arena One'
    });
    expect(status).toBe(200);
    expect(json.createdCount).toBe(5);
    expect(json.skippedCount).toBe(0);
    const dates = json.results.map(r => r.event.date);
    expect(dates).toEqual(['2099-11-01', '2099-11-08', '2099-11-15', '2099-11-22', '2099-11-29']);
    expect(json.results.every(r => r.event.start_time === '19:00' && r.event.venue === 'Arena One')).toBe(true);
    expect(new Set(json.results.map(r => r.event.id)).size).toBe(5);
  });

  it('creates a weekly series from a start date + end date (occurrence count omitted)', async () => {
    const { cookie, csrfToken } = await signup('bulk.events.enddate@example.com', '203.0.129.002');
    await createLeagueWithSeason(cookie, csrfToken, 'Bulk Events End Date League');

    const { json } = await bulkCreateEvents(cookie, csrfToken, {
      startDate: '2099-12-06', endDate: '2099-12-27'
    });
    // Dec 6, 13, 20, 27 -- 4 weekly occurrences inclusive of the end date.
    expect(json.createdCount).toBe(4);
    expect(json.results.map(r => r.event.date)).toEqual(['2099-12-06', '2099-12-13', '2099-12-20', '2099-12-27']);
  });

  it('a date that already has an event is skipped with a note, the rest of the batch still succeeds', async () => {
    const { cookie, csrfToken } = await signup('bulk.events.collision@example.com', '203.0.129.003');
    await createLeagueWithSeason(cookie, csrfToken, 'Bulk Events Collision League');
    await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2099-10-18' })
    });

    const { json } = await bulkCreateEvents(cookie, csrfToken, { startDate: '2099-10-04', occurrences: 4 });
    // Oct 4, 11, 18 (collides), 25
    expect(json.createdCount).toBe(3);
    expect(json.skippedCount).toBe(1);
    const skipped = json.results.find(r => r.status === 'skipped');
    expect(skipped.date).toBe('2099-10-18');
    expect(skipped.reason).toBe('duplicate_date');
  });

  it('rejects a request with neither an occurrence count nor an end date', async () => {
    const { cookie, csrfToken } = await signup('bulk.events.norecurrence@example.com', '203.0.129.004');
    await createLeagueWithSeason(cookie, csrfToken, 'Bulk Events No Recurrence League');
    const { status, json } = await bulkCreateEvents(cookie, csrfToken, { startDate: '2099-11-01' });
    expect(status).toBe(400);
    expect(json.errorKey).toBe('BULK_EVENTS_RECURRENCE_REQUIRED');
  });

  // Flaky-timeout fix: this one HTTP call fans out into 52 sequential
  // server-side event-row creations (collision check + insert each) --
  // can intermittently exceed vitest's 5000ms default under parallel
  // test-suite load. Slow by nature, not broken.
  it('caps occurrences at 52 even if a larger number is requested', async () => {
    const { cookie, csrfToken } = await signup('bulk.events.cap@example.com', '203.0.129.005');
    await createLeagueWithSeason(cookie, csrfToken, 'Bulk Events Cap League');
    const { json } = await bulkCreateEvents(cookie, csrfToken, { startDate: '2099-01-04', occurrences: 300 });
    expect(json.createdCount).toBe(52);
  }, 15000);

  it('this route cannot be used against SMBHL', async () => {
    const { cookie, csrfToken } = await signup('bulk.events.smbhl.blocked@example.com', '203.0.129.006');
    const { status, json } = await bulkCreateEvents(cookie, csrfToken, { startDate: '2099-11-01', occurrences: 3 });
    expect(status).toBe(404);
    expect(json.errorKey).toBe('NO_LEAGUE_FOUND');
  });
});

describe('Part 7 (live-testing task): duplicate event (POST /league/events/duplicate)', () => {
  it("copies an existing event's venue/time to a new date", async () => {
    const { cookie, csrfToken } = await signup('duplicate.event.basic@example.com', '203.0.129.007');
    await createLeagueWithSeason(cookie, csrfToken, 'Duplicate Event Basic League');
    const createRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2099-09-07', start_time: '20:15', end_time: '21:15', venue: 'Rink Seven' })
    });
    const sourceEvent = (await createRes.json()).event;

    const { status, json } = await duplicateEvent(cookie, csrfToken, { event_id: sourceEvent.id, date: '2099-09-14' });
    expect(status).toBe(200);
    expect(json.event.date).toBe('2099-09-14');
    expect(json.event.start_time).toBe('20:15');
    expect(json.event.end_time).toBe('21:15');
    expect(json.event.venue).toBe('Rink Seven');
    expect(json.event.season).toBe(sourceEvent.season);
  });

  it('duplicating onto a date that already has an event is rejected (409), matching the single-create route', async () => {
    const { cookie, csrfToken } = await signup('duplicate.event.collision@example.com', '203.0.129.008');
    await createLeagueWithSeason(cookie, csrfToken, 'Duplicate Event Collision League');
    const sourceRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2099-08-03', venue: 'Rink X' })
    });
    const source = (await sourceRes.json()).event;
    await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2099-08-10' })
    });

    const { status, json } = await duplicateEvent(cookie, csrfToken, { event_id: source.id, date: '2099-08-10' });
    expect(status).toBe(409);
    expect(json.errorKey).toBe('EVENT_DATE_EXISTS');
  });

  it('cannot duplicate an event belonging to another league', async () => {
    const leagueA = await signup('duplicate.event.leaguea@example.com', '203.0.129.009');
    await createLeagueWithSeason(leagueA.cookie, leagueA.csrfToken, 'Duplicate Event League A');
    const sourceRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: leagueA.cookie, 'content-type': 'application/json', 'x-csrf-token': leagueA.csrfToken },
      body: JSON.stringify({ date: '2099-07-06' })
    });
    const source = (await sourceRes.json()).event;

    const leagueB = await signup('duplicate.event.leagueb@example.com', '203.0.129.010');
    await createLeagueWithSeason(leagueB.cookie, leagueB.csrfToken, 'Duplicate Event League B');

    const { status, json } = await duplicateEvent(leagueB.cookie, leagueB.csrfToken, { event_id: source.id, date: '2099-07-13' });
    expect(status).toBe(404);
    expect(json.errorKey).toBe('EVENT_NOT_FOUND');
  });

  it('the schedule page renders the bulk-create panel and a duplicate control per event', async () => {
    const { cookie, csrfToken } = await signup('duplicate.event.ui@example.com', '203.0.129.011');
    await createLeagueWithSeason(cookie, csrfToken, 'Duplicate Event UI League');
    await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2099-06-01' })
    });
    const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    expect(html).toContain('id="sc_bulk_panel"');
    expect(html).toContain('/league/events/bulk');
    expect(html).toContain('/league/events/duplicate');
    expect(html).toContain("toggleDuplicateRow('");
  });
});

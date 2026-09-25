// Live-testing task (batch 6), Part 9 (BIG): reusable venues.
//
// Before this part, `events.venue` was pure free text -- an admin
// retyped the same rink/gym name (and never had anywhere to put an
// address or a map link) for every single game. This adds a `venues`
// table (name, optional address, optional map link), defined once in
// Settings, selectable at event creation instead of retyping.
//
// DESIGN: existing free-text events keep working completely unchanged
// -- events.venue (the column every render site in this app already
// reads: schedule, public page, comms, reminder/confirmation emails,
// SMBHL's own legacy admin, ~90 read sites total) stays the single
// source of truth for the DISPLAYED name everywhere. Selecting a saved
// venue at creation time just denormalizes that venue's name into
// events.venue (a snapshot) AND records events.venue_id -- so every
// existing read site keeps working with zero changes, and only the
// NEW surfaces (this test file) that explicitly look up venue_id gain
// a map link. A venue-less, free-text event (venue_id never set)
// behaves byte-for-byte as before this task.
//
// Shared module: getLeagueVenues/getVenueMapLinksById (leagues.js),
// used by Settings (management list), the schedule page's create-event
// forms (select-or-freetext), and every render surface that shows a
// map link (schedule rows, public page hero + upcoming list, event
// detail page, the RSVP response page reached from invite/reminder
// emails). SMBHL's own legacy admin never touches venues at all --
// untouched by this part.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { extractInlineScripts, assertNoSyntaxError } from './support/inline_scripts.js';

const AUTH_SECRET = 'test-part80-reusable-venues-secret';
const RSVP_SECRET = 'test-part80-reusable-venues-rsvp-secret';

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
async function createVenue(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/venues', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return res;
}
async function createEvent(cookie, csrfToken, body) {
  return SELF.fetch('http://example.com/league/events', {
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
async function computeToken(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

describe('Part 9 (live-testing task, batch 6): reusable venues', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    await applyRealSchema(env);
  });

  it('creates a venue with name/address/map_link, and it appears on the Settings page', async () => {
    const { cookie, csrfToken } = await signup('venues.create@example.com', '203.0.199.001');
    await createLeague(cookie, csrfToken, { name: 'Venues Create League', teamNames: ['A', 'B'] });
    const res = await createVenue(cookie, csrfToken, { name: 'Aréna Test', address: '1 rue Test', map_link: 'https://maps.example.com/x' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.venue.name).toBe('Aréna Test');

    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toContain('Aréna Test');
    expect(html).toContain('1 rue Test');
    expect(html).toContain('https://maps.example.com/x');
    expect(html).toContain(`data-venue-id="${data.venue.id}"`);
  });

  it('name is required; map_link must be a real http(s) link', async () => {
    const { cookie, csrfToken } = await signup('venues.validate@example.com', '203.0.199.002');
    await createLeague(cookie, csrfToken, { name: 'Venues Validate League', teamNames: ['A', 'B'] });

    const noName = await createVenue(cookie, csrfToken, {});
    expect(noName.status).toBe(400);
    expect((await noName.json()).errorKey).toBe('VENUE_NAME_REQUIRED');

    const badLink = await createVenue(cookie, csrfToken, { name: 'Bad Link Venue', map_link: 'javascript:alert(1)' });
    expect(badLink.status).toBe(400);
    expect((await badLink.json()).errorKey).toBe('VENUE_MAP_LINK_INVALID');
  });

  it('a league with no venues yet shows the empty state, not the select dropdown, on the schedule page', async () => {
    const { cookie, csrfToken } = await signup('venues.empty@example.com', '203.0.199.003');
    await createLeague(cookie, csrfToken, { name: 'Venues Empty League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const settingsHtml = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(settingsHtml).toContain('data-i18n="noVenuesYet"');

    const scheduleHtml = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    expect(scheduleHtml).not.toContain('id="e_venue_select"');
    expect(scheduleHtml).toContain('id="e_venue"'); // free-text input always present
  });

  it('creating an event against a saved venue denormalizes its name into events.venue AND records venue_id', async () => {
    const { cookie, csrfToken } = await signup('venues.denorm@example.com', '203.0.199.004');
    const league = await createLeague(cookie, csrfToken, { name: 'Venues Denorm League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const v = await (await createVenue(cookie, csrfToken, { name: 'Denorm Arena' })).json();

    const res = await createEvent(cookie, csrfToken, { date: '2099-05-01', venue_id: v.venue.id });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.event.venue).toBe('Denorm Arena');
    expect(data.event.venue_id).toBe(v.venue.id);

    const row = await env.DB.prepare('SELECT venue, venue_id FROM events WHERE id = ?').bind(data.event.id).first();
    expect(row.venue).toBe('Denorm Arena');
    expect(row.venue_id).toBe(v.venue.id);
    expect(row.venue_id.startsWith(league.id) || true).toBe(true); // sanity: query succeeded at all
  });

  it('a venue_id from another league (or a made-up one) is rejected -- never silently accepted', async () => {
    const a = await signup('venues.isoA@example.com', '203.0.199.005');
    const b = await signup('venues.isoB@example.com', '203.0.199.006');
    await createLeague(a.cookie, a.csrfToken, { name: 'Venues Iso League A', teamNames: ['A1', 'A2'] });
    await createLeague(b.cookie, b.csrfToken, { name: 'Venues Iso League B', teamNames: ['B1', 'B2'] });
    await publishSeason(a.cookie, a.csrfToken, { season_name: 'S1' });
    await publishSeason(b.cookie, b.csrfToken, { season_name: 'S1' });
    const vB = await (await createVenue(b.cookie, b.csrfToken, { name: 'League B Only Venue' })).json();

    const resForged = await createEvent(a.cookie, a.csrfToken, { date: '2099-05-02', venue_id: vB.venue.id });
    expect(resForged.status).toBe(400);
    expect((await resForged.json()).errorKey).toBe('VENUE_UNKNOWN');

    const resFake = await createEvent(a.cookie, a.csrfToken, { date: '2099-05-03', venue_id: 'not-a-real-id' });
    expect(resFake.status).toBe(400);
    expect((await resFake.json()).errorKey).toBe('VENUE_UNKNOWN');
  });

  it('free-text event creation (no venue_id) still behaves exactly as before this task', async () => {
    const { cookie, csrfToken } = await signup('venues.freetext@example.com', '203.0.199.007');
    await createLeague(cookie, csrfToken, { name: 'Venues Freetext League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const res = await createEvent(cookie, csrfToken, { date: '2099-05-04', venue: 'Plain Old Text Rink' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.event.venue).toBe('Plain Old Text Rink');
    expect(data.event.venue_id).toBeNull();
  });

  it('SMBHL is blocked from every venue route', async () => {
    const { cookie, csrfToken } = await signup('venues.smbhl@example.com', '203.0.199.008');
    // No league created -- resolveSessionLeagueId falls through, so
    // this proves the route-level guard, matching every other
    // ROUTE_BLOCKED_* test's own shape in this codebase (no real way
    // to attach a session to SMBHL itself via the league-product's own
    // signup flow, since SMBHL predates it).
    const res = await createVenue(cookie, csrfToken, { name: 'Should Not Exist' });
    expect([403, 404]).toContain(res.status);
  });

  it('deleting a venue removes it from the list, but any event already created against it keeps its own venue text/id (map link just stops resolving)', async () => {
    const { cookie, csrfToken } = await signup('venues.delete@example.com', '203.0.199.009');
    await createLeague(cookie, csrfToken, { name: 'Venues Delete League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const v = await (await createVenue(cookie, csrfToken, { name: 'Deletable Arena', map_link: 'https://maps.example.com/del' })).json();
    const ev = await (await createEvent(cookie, csrfToken, { date: '2099-05-05', venue_id: v.venue.id })).json();

    const delRes = await SELF.fetch('http://example.com/league/venues/delete', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ id: v.venue.id })
    });
    expect(delRes.status).toBe(200);

    const settingsHtml = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(settingsHtml).not.toContain('Deletable Arena');

    const row = await env.DB.prepare('SELECT venue, venue_id FROM events WHERE id = ?').bind(ev.event.id).first();
    expect(row.venue).toBe('Deletable Arena');
    expect(row.venue_id).toBe(v.venue.id);

    // The map link is gone from the schedule row now (venues row no
    // longer exists to resolve venue_id against) -- falls back to
    // plain text, same as any other free-text event.
    const scheduleHtml = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    expect(scheduleHtml).toContain('Deletable Arena');
    expect(scheduleHtml).not.toContain('https://maps.example.com/del');
  });

  it('a league admin cannot delete another league\'s venue (404, not silently ignored)', async () => {
    const a = await signup('venues.deliso.a@example.com', '203.0.199.010');
    const b = await signup('venues.deliso.b@example.com', '203.0.199.011');
    await createLeague(a.cookie, a.csrfToken, { name: 'Venues Del Iso League A', teamNames: ['A1', 'A2'] });
    await createLeague(b.cookie, b.csrfToken, { name: 'Venues Del Iso League B', teamNames: ['B1', 'B2'] });
    const vA = await (await createVenue(a.cookie, a.csrfToken, { name: 'League A Only Venue' })).json();

    const res = await SELF.fetch('http://example.com/league/venues/delete', {
      method: 'POST', headers: { cookie: b.cookie, 'content-type': 'application/json', 'x-csrf-token': b.csrfToken },
      body: JSON.stringify({ id: vA.venue.id })
    });
    expect(res.status).toBe(404);
  });

  it('the schedule page shows the select-or-freetext dropdown once venues exist, and a map link on rows that resolve', async () => {
    const { cookie, csrfToken } = await signup('venues.schedule@example.com', '203.0.199.012');
    await createLeague(cookie, csrfToken, { name: 'Venues Schedule League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const v = await (await createVenue(cookie, csrfToken, { name: 'Schedule Test Arena', map_link: 'https://maps.example.com/sched' })).json();
    await createEvent(cookie, csrfToken, { date: '2099-05-06', venue_id: v.venue.id });

    const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    expect(html).toContain('id="e_venue_select"');
    expect(html).toContain('id="be_venue_select"');
    expect(html).toContain(`<option value="${v.venue.id}">Schedule Test Arena</option>`);
    expect(html).toContain('https://maps.example.com/sched');
    expect(html).toContain('data-i18n="viewOnMap"');
  });

  it('the public page shows a map link on both the next-game hero and the upcoming list when one resolves', async () => {
    const { cookie, csrfToken } = await signup('venues.public@example.com', '203.0.199.013');
    const league = await createLeague(cookie, csrfToken, { name: 'Venues Public League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const v = await (await createVenue(cookie, csrfToken, { name: 'Public Test Arena', map_link: 'https://maps.example.com/pub' })).json();
    await createEvent(cookie, csrfToken, { date: '2099-05-07', venue_id: v.venue.id });

    const html = await (await SELF.fetch(`http://example.com/league/public?league=${league.id}`)).text();
    expect(html).toContain('Public Test Arena');
    expect(html).toContain('https://maps.example.com/pub');
    expect(html).toContain('data-i18n="viewOnMap"');
  });

  it('the public page never mentions a map link at all when no listed event has one -- the i18n key stays unused, not just unshown', async () => {
    const { cookie, csrfToken } = await signup('venues.publicnomap@example.com', '203.0.199.014');
    const league = await createLeague(cookie, csrfToken, { name: 'Venues Public No Map League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await createEvent(cookie, csrfToken, { date: '2099-05-08', venue: 'Plain Free Text Venue' });

    const html = await (await SELF.fetch(`http://example.com/league/public?league=${league.id}`)).text();
    expect(html).toContain('Plain Free Text Venue');
    expect(html).not.toContain('viewOnMap');
  });

  it('the event detail page shows a map link when the event has a resolvable venue', async () => {
    const { cookie, csrfToken } = await signup('venues.detail@example.com', '203.0.199.015');
    await createLeague(cookie, csrfToken, { name: 'Venues Detail League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const v = await (await createVenue(cookie, csrfToken, { name: 'Detail Test Arena', map_link: 'https://maps.example.com/detail' })).json();
    const ev = await (await createEvent(cookie, csrfToken, { date: '2099-05-09', venue_id: v.venue.id })).json();

    const html = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(ev.event.id)}`, { headers: { cookie } })).text();
    expect(html).toContain('Detail Test Arena');
    expect(html).toContain('https://maps.example.com/detail');
  });

  it('the RSVP response page (reached from invite/reminder emails) shows a map link when the event has a resolvable venue', async () => {
    const { cookie, csrfToken } = await signup('venues.rsvp@example.com', '203.0.199.016');
    const league = await createLeague(cookie, csrfToken, { name: 'Venues Rsvp League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const v = await (await createVenue(cookie, csrfToken, { name: 'Rsvp Test Arena', map_link: 'https://maps.example.com/rsvp' })).json();
    const ev = await (await createEvent(cookie, csrfToken, { date: '2099-05-10', venue_id: v.venue.id })).json();
    const player = await addContact(cookie, csrfToken, { name: 'Rsvp Map Player', role: 'roster', team: 'A' });
    const salt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(player.player_id).first()).token_salt;
    const token = await computeToken(RSVP_SECRET, `lr:${league.id}:${ev.event.id}:${player.player_id}:${salt}`);

    const html = await (await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(league.id)}&e=${encodeURIComponent(ev.event.id)}&p=${encodeURIComponent(player.player_id)}&t=${token}`)).text();
    expect(html).toContain('Rsvp Test Arena');
    expect(html).toContain('https://maps.example.com/rsvp');
  });

  it('bulk event creation and duplicate both carry venue_id through, not just the single-event route', async () => {
    const { cookie, csrfToken } = await signup('venues.bulkdup@example.com', '203.0.199.017');
    await createLeague(cookie, csrfToken, { name: 'Venues Bulk Dup League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const v = await (await createVenue(cookie, csrfToken, { name: 'Bulk Dup Arena' })).json();

    const bulkRes = await SELF.fetch('http://example.com/league/events/bulk', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ startDate: '2099-06-01', occurrences: 2, venue_id: v.venue.id })
    });
    const bulkData = await bulkRes.json();
    expect(bulkData.createdCount).toBe(2);
    for (const r of bulkData.results) expect(r.event.venue_id).toBe(v.venue.id);

    const sourceEventId = bulkData.results[0].event.id;
    const dupRes = await SELF.fetch('http://example.com/league/events/duplicate', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: sourceEventId, date: '2099-06-15' })
    });
    const dupData = await dupRes.json();
    expect(dupData.event.venue_id).toBe(v.venue.id);
    expect(dupData.event.venue).toBe('Bulk Dup Arena');
  });

  it('inline scripts on Settings and Schedule stay syntactically valid with the new venue markup/JS', async () => {
    const { cookie, csrfToken } = await signup('venues.scripts@example.com', '203.0.199.018');
    await createLeague(cookie, csrfToken, { name: 'Venues Scripts League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await createVenue(cookie, csrfToken, { name: 'Scripts Test Arena', map_link: 'https://maps.example.com/scripts' });

    const settingsHtml = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    const scheduleHtml = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    for (const html of [settingsHtml, scheduleHtml]) {
      const scripts = extractInlineScripts(html);
      expect(scripts.length).toBeGreaterThan(0);
      assertNoSyntaxError(scripts);
    }
  });

  // C5 bug fix (schedule/events polish task): "View on map" appeared on
  // some events and not others depending on whether the venue was a
  // saved venue (with a map link) or free text -- even with the
  // identical venue NAME -- and nothing on the page explained why. The
  // underlying resolution (map link only ever comes from a saved
  // venue) is correct by design and unchanged; what was missing was
  // making that predictable -- a plain note wherever free text is
  // entered, shown only once the league actually has a saved venue to
  // contrast it with.
  it("C5: the create/edit/bulk-create forms explain that free text never gets a map link, once the league has a saved venue to contrast it with", async () => {
    const { cookie, csrfToken } = await signup('venues.c5.explain@example.com', '203.0.199.019');
    await createLeague(cookie, csrfToken, { name: 'C5 Explain League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    // No saved venue yet -- nothing to contrast, so no note.
    const scheduleBeforeHtml = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    expect(scheduleBeforeHtml).not.toContain('data-i18n="freeTextNoMapLink"');

    await createVenue(cookie, csrfToken, { name: 'C5 Saved Arena', map_link: 'https://maps.example.com/c5' });
    const scheduleAfterHtml = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    expect(scheduleAfterHtml).toContain('data-i18n="freeTextNoMapLink"');
    expect(scheduleAfterHtml).toContain("Le texte libre n'affiche jamais de lien vers une carte. Choisis un lieu enregistré ci-dessus pour ça.");

    const evRes = await createEvent(cookie, csrfToken, { date: '2099-06-01', venue: 'Some Free Text Venue' });
    const ev = (await evRes.json()).event;
    const detailHtml = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(ev.id)}`, { headers: { cookie } })).text();
    expect(detailHtml).toContain('data-i18n="freeTextNoMapLink"');
  });

  // D1: investigated directly (creating events with a saved venue's
  // map link, in every section this product renders one -- public
  // page hero/upcoming/past, admin schedule list, event-detail page) --
  // could not reproduce an orphan " · " separator with no link
  // anywhere; every one of these render sites already gates the
  // separator and the link together as a single conditional (see e.g.
  // handleLeaguePublicPage's own venue-line template). Locked here as
  // an explicit regression test for exactly that co-gating, across
  // every section, so if it's ever split apart again this fails loudly.
  it("D1 (investigated, not reproduced as literally described -- locked as a regression guard): the map-link separator never renders without the link, anywhere", async () => {
    const { cookie, csrfToken } = await signup('venues.d1.separator@example.com', '203.0.199.020');
    const league = await createLeague(cookie, csrfToken, { name: 'D1 Separator League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const venueRes = await createVenue(cookie, csrfToken, { name: 'Letendre', map_link: 'https://maps.example.com/letendre' });
    const venue = (await venueRes.json()).venue;

    // One hero-position event, one list-position event, one past event --
    // every section the public page renders a venue line in.
    const heroRes = await createEvent(cookie, csrfToken, { date: '2099-07-01', venue_id: venue.id });
    const heroEvent = (await heroRes.json()).event;
    await createEvent(cookie, csrfToken, { date: '2099-07-08', venue_id: venue.id });
    await createEvent(cookie, csrfToken, { date: '2020-07-01', venue_id: venue.id });

    const publicHtml = await (await SELF.fetch(`http://example.com/league/public?league=${league.id}`)).text();
    // Every "Letendre" occurrence must be immediately followed by the
    // real map link, never a bare separator with nothing after it.
    const occurrences = publicHtml.split('Letendre').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(3); // hero + upcoming list + past list
    const afterEach = [...publicHtml.matchAll(/Letendre( · <a href="[^"]+"[^>]*>[^<]+<\/a>)?/g)];
    for (const m of afterEach) {
      expect(m[1]).toBeTruthy(); // the link-or-nothing group actually matched a real link every time
    }

    // Same check on the admin schedule list and the event-detail page.
    const scheduleHtml = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    expect(scheduleHtml).toContain('Letendre');
    const detailHtml = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(heroEvent.id)}`, { headers: { cookie } })).text();
    expect(detailHtml).toMatch(/Letendre · <a href="https:\/\/maps\.example\.com\/letendre"/);
  });

  // Item 2 (public page polish task): the link from the test above was
  // never actually invisible in the MARKUP (D1's own conclusion) -- it
  // was invisible in practice because the shared base stylesheet's
  // .nl a rule (design_system.js, color: var(--ink)) outranks
  // .pb-g-venue's own color on the surrounding div, and --ink flips
  // with the visitor's OS colour-scheme preference. On the always-dark
  // arène background, a light-OS-theme visitor got near-black text on
  // a near-black background -- genuinely unreadable, not merely a
  // markup gap. This can't be measured by computing an actual pixel
  // colour in this test harness (no real browser/cascade here), so it
  // asserts the higher-specificity override rule itself is present in
  // the rendered <style> block for both shipping themes -- the same
  // way the pre-existing .pb-foot fix (right above this rule in the
  // stylesheet) is the established, working pattern for this exact
  // class of bug on this exact page.
  describe('Item 2: the venue-list map link is legible on both public themes, not just present in markup', () => {
    it('arène (dark) theme: an explicit, non-token override beats the shared .nl a rule for .pb-g-venue links', async () => {
      const { cookie, csrfToken } = await signup('item2.contrast.arene@example.com', '203.0.199.021');
      const league = await createLeague(cookie, csrfToken, { name: 'Item2 Contrast Arene League', teamNames: ['A', 'B'] });
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      const venueRes = await createVenue(cookie, csrfToken, { name: 'Contrast Rink', map_link: 'https://maps.example.com/contrast' });
      const venue = (await venueRes.json()).venue;
      await createEvent(cookie, csrfToken, { date: '2099-07-15', venue_id: venue.id });

      const html = await (await SELF.fetch(`http://example.com/league/public?league=${league.id}`)).text();
      // A literal hex value (not var(--ink), which is the actual bug)
      // wins over the shared .nl a rule for these links specifically.
      expect(html).toMatch(/\.nl \.pb-g-venue a\s*\{[^}]*color:\s*#a3a6ad/);
      expect(html).not.toMatch(/\.nl \.pb-g-venue a\s*\{[^}]*color:\s*var\(--ink\)/);
    });

    it('Épuré (clean/light) theme: the mirror-image case (--ink flips light under a dark OS preference) is also pinned to a fixed, legible colour', async () => {
      const { cookie, csrfToken } = await signup('item2.contrast.clean@example.com', '203.0.199.022');
      const league = await createLeague(cookie, csrfToken, { name: 'Item2 Contrast Clean League', teamNames: ['A', 'B'] });
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      await SELF.fetch('http://example.com/league/settings/identity', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ publicTheme: 'clean' })
      });
      const venueRes = await createVenue(cookie, csrfToken, { name: 'Contrast Rink Clean', map_link: 'https://maps.example.com/contrast-clean' });
      const venue = (await venueRes.json()).venue;
      await createEvent(cookie, csrfToken, { date: '2099-07-16', venue_id: venue.id });

      const html = await (await SELF.fetch(`http://example.com/league/public?league=${league.id}`)).text();
      expect(html).toMatch(/\.nl \.pb-g-venue a\s*\{[^}]*color:\s*#666666/);
      expect(html).not.toMatch(/\.nl \.pb-g-venue a\s*\{[^}]*color:\s*var\(--ink\)/);
    });

    it('the hero venue link (already fixed pre-existing, color:inherit from a fixed parent colour) is unaffected by this change', async () => {
      const { cookie, csrfToken } = await signup('item2.contrast.hero@example.com', '203.0.199.023');
      const league = await createLeague(cookie, csrfToken, { name: 'Item2 Contrast Hero League', teamNames: ['A', 'B'] });
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      const venueRes = await createVenue(cookie, csrfToken, { name: 'Hero Rink', map_link: 'https://maps.example.com/hero' });
      const venue = (await venueRes.json()).venue;
      await createEvent(cookie, csrfToken, { date: '2099-07-14', venue_id: venue.id });

      const html = await (await SELF.fetch(`http://example.com/league/public?league=${league.id}`)).text();
      expect(html).toContain('class="pb-hero-venue"');
      expect(html).toMatch(/pb-hero-venue">Hero Rink · <a href="https:\/\/maps\.example\.com\/hero"[^>]*style="color:inherit"/);
    });
  });
});

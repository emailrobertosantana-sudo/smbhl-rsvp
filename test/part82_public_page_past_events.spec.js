// Live-testing task (batch 6), Part 11 (final part of this batch):
// public page should mirror smbhl.com more closely.
//
// smbhl.com's own public site (a separate deployment this Worker only
// ever reads a data.json feed from, confirmed by grep -- there's no
// local handler to copy code from) organizes its nav around Home,
// Standings, Schedule, Leaders, All-time, Players, Goalies, History,
// Join -- a full continuous game history (not just "what's next"),
// plus deep individual/team stats pages. Copying all of that is out of
// scope and would need data this product doesn't track (no score-entry
// route exists anywhere in this codebase -- confirmed by grep before
// starting this part). The two concrete asks this part scopes to:
// (1) past events alongside upcoming, for EVERY league regardless of
// stats tracking; (2) richer views (the pre-existing standings table)
// staying gated to stats-tracking leagues only -- already true, this
// part doesn't change that gating, just locks it in as a regression
// test alongside the new past-events section.
//
// "Result" here is honestly just each past game's own state (played
// vs cancelled) -- not a score, since none exists. The standings table
// (gated, unchanged) is still the real W/L record for a stats-tracking
// league.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part82-public-page-past-events-secret';

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
async function createEvent(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).event;
}
async function fetchPublic(leagueId) {
  return (await SELF.fetch(`http://example.com/league/public?league=${leagueId}`)).text();
}
async function submitScore(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events/score', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return res.json();
}

describe('Part 11 (live-testing task, batch 6): public page shows past events alongside upcoming, for every league', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a league with no past events shows no "recent results" section at all -- not an empty placeholder', async () => {
    const { cookie, csrfToken } = await signup('pastevents.none@example.com', '203.0.200.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Past Events None League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await createEvent(cookie, csrfToken, { date: '2099-11-01' });

    const html = await fetchPublic(league.id);
    expect(html).not.toContain('data-i18n="recentResults"');
  });

  it('shows a past event alongside the upcoming list, with a "played" state badge, for a plain fixed-structure league', async () => {
    const { cookie, csrfToken } = await signup('pastevents.fixed@example.com', '203.0.200.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Past Events Fixed League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await createEvent(cookie, csrfToken, { date: '2020-01-06', venue: 'Old Rink' });
    await createEvent(cookie, csrfToken, { date: '2099-11-02', venue: 'Next Rink' });

    const html = await fetchPublic(league.id);
    expect(html).toContain('data-i18n="recentResults"');
    expect(html).toContain('Old Rink');
    expect(html).toContain('data-i18n="statePlayed"');
    // The upcoming section is unaffected -- both sections coexist.
    expect(html).toContain('Next Rink');
    expect(html).toContain('data-i18n="upcoming"');
  });

  it('a cancelled past event shows a "cancelled" badge instead of "played"', async () => {
    const { cookie, csrfToken } = await signup('pastevents.cancelled@example.com', '203.0.200.003');
    const league = await createLeague(cookie, csrfToken, { name: 'Past Events Cancelled League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2020-02-10', venue: 'Cancelled Venue' });
    await env.DB.prepare(`UPDATE events SET state = 'cancelled' WHERE id = ?`).bind(ev.id).run();

    const html = await fetchPublic(league.id);
    expect(html).toContain('Cancelled Venue');
    expect(html).toContain('data-i18n="stateCancelled"');
    expect(html).not.toContain('data-i18n="statePlayed"');
  });

  it('past events show for headcount and weekly_draw leagues too -- not gated to fixed structure the way standings are', async () => {
    const { cookie, csrfToken } = await signup('pastevents.headcount@example.com', '203.0.200.004');
    const league = await createLeague(cookie, csrfToken, { name: 'Past Events Headcount League', teamStructure: 'headcount', minPlayers: 6, maxPlayers: 12 });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await createEvent(cookie, csrfToken, { date: '2020-03-15', venue: 'Headcount Past Rink' });

    const html = await fetchPublic(league.id);
    expect(html).toContain('data-i18n="recentResults"');
    expect(html).toContain('Headcount Past Rink');
  });

  it('past events show even when the league does not track stats -- distinct from standings, which stay gated', async () => {
    const { cookie, csrfToken } = await signup('pastevents.nostats@example.com', '203.0.200.005');
    const league = await createLeague(cookie, csrfToken, { name: 'Past Events No Stats League', teamNames: ['A', 'B'], tracksStats: false });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await createEvent(cookie, csrfToken, { date: '2020-04-20', venue: 'No Stats Past Rink' });

    const html = await fetchPublic(league.id);
    expect(html).toContain('data-i18n="recentResults"');
    // Standings gating (pre-existing, unchanged by this part) locked in
    // as a regression: no stats tracking means no standings table at all.
    expect(html).not.toContain('data-i18n="standings"');
  });

  it("richer views (standings) stay gated to stats-tracking fixed-structure leagues only -- unchanged regression lock", async () => {
    const { cookie, csrfToken } = await signup('pastevents.statsgate@example.com', '203.0.200.006');
    const league = await createLeague(cookie, csrfToken, { name: 'Past Events Stats Gate League', teamNames: ['A', 'B'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    // Stats tracking task (Part 4): standings are now computed fresh
    // from real game results (computeStandings) rather than the old
    // permanently-0-0-0 season.standings array team-name placeholder --
    // a real result has to exist for a real row to appear.
    const ev = await createEvent(cookie, csrfToken, { date: '2020-05-25', season: 'S1' });
    await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: 2, away_score: 0 });

    const html = await fetchPublic(league.id);
    expect(html).toContain('data-i18n="standings"');
  });

  // Flaky-timeout fix: 12 sequential real event-creation requests, each
  // a full round trip through the Worker -- can intermittently exceed
  // vitest's 5000ms default under parallel test-suite load.
  it('shows at most 10 recent past events, most recent first', async () => {
    const { cookie, csrfToken } = await signup('pastevents.limit@example.com', '203.0.200.007');
    const league = await createLeague(cookie, csrfToken, { name: 'Past Events Limit League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    for (let m = 1; m <= 12; m++) {
      await createEvent(cookie, csrfToken, { date: `2020-${String(m).padStart(2, '0')}-01`, venue: `Rink ${m}` });
    }

    const html = await fetchPublic(league.id);
    // Most recent 10 (Dec down to Mar) present, oldest 2 (Jan, Feb) not.
    expect(html).toContain('Rink 12');
    expect(html).toContain('Rink 3');
    expect(html).not.toContain('Rink 2');
    expect(html).not.toContain('Rink 1</');
    const decemberIdx = html.indexOf('Rink 12');
    const marchIdx = html.indexOf('Rink 3');
    expect(decemberIdx).toBeLessThan(marchIdx);
  }, 15000);

  it('a map link surfaces on a past event too, when its venue resolves one', async () => {
    const { cookie, csrfToken } = await signup('pastevents.maplink@example.com', '203.0.200.008');
    const league = await createLeague(cookie, csrfToken, { name: 'Past Events Map Link League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const venueRes = await SELF.fetch('http://example.com/league/venues', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Past Map Venue', map_link: 'https://maps.example.com/pastevent' })
    });
    const venue = (await venueRes.json()).venue;
    await createEvent(cookie, csrfToken, { date: '2020-06-01', venue_id: venue.id });

    const html = await fetchPublic(league.id);
    expect(html).toContain('Past Map Venue');
    expect(html).toContain('https://maps.example.com/pastevent');
  });

  it("League A's public page never shows League B's past events", async () => {
    const a = await signup('pastevents.isoA@example.com', '203.0.200.009');
    const b = await signup('pastevents.isoB@example.com', '203.0.200.010');
    const leagueA = await createLeague(a.cookie, a.csrfToken, { name: 'Past Events Iso League A', teamNames: ['A1', 'A2'] });
    const leagueB = await createLeague(b.cookie, b.csrfToken, { name: 'Past Events Iso League B', teamNames: ['B1', 'B2'] });
    await publishSeason(a.cookie, a.csrfToken, { season_name: 'S1' });
    await publishSeason(b.cookie, b.csrfToken, { season_name: 'S1' });
    await createEvent(b.cookie, b.csrfToken, { date: '2020-07-01', venue: 'League B Only Past Rink' });

    const htmlA = await fetchPublic(leagueA.id);
    expect(htmlA).not.toContain('League B Only Past Rink');
  });

  it('never leaks SMBHL-specific content onto a league\'s public page', async () => {
    const { cookie, csrfToken } = await signup('pastevents.smbhlcheck@example.com', '203.0.200.011');
    // Deliberately a name with no "SMBHL" substring in it -- this test
    // checks for an ACCIDENTAL hardcoded leak from the template itself,
    // not the league's own (user-controlled) name.
    const league = await createLeague(cookie, csrfToken, { name: 'Past Events Isolation Check League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await createEvent(cookie, csrfToken, { date: '2020-08-01' });

    const html = await fetchPublic(league.id);
    expect(html).not.toContain('SMBHL');
    expect(html).not.toContain('smbhl.com');
  });
});

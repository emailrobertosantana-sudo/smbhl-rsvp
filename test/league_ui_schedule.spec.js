// UI task Part T: GET /league/schedule. Server-rendered from the same
// query GET /league/events (Part L) uses. Proves: real event data renders
// in the HTML; redirects to /login when unauthenticated; the create-event
// form posts to the real POST /league/events (Part K) route and the
// result is reflected on reload; each event links to its detail/status
// page; and League A cannot see League B's schedule through this page.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-ui-schedule-secret';

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(', ');
  const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
  return csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
}

async function signupAndCreateLeague(email, ip, leagueName, teamNames) {
  const signupRes = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const signupJson = await signupRes.json();
  const cookie = extractCookie(signupRes);
  const csrfToken = extractCsrfToken(signupRes);

  const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name: leagueName, teamNames, tracksStats: true })
  });
  const leagueJson = await leagueRes.json();

  return { userId: signupJson.userId, cookie, csrfToken, leagueId: leagueJson.league.id };
}

describe('UI task Part T: GET /league/schedule', () => {
  let leagueA, leagueB, cookieA, cookieB, csrfTokenA, csrfTokenB, eventA;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;

    await applyRealSchema(env);

    const a = await signupAndCreateLeague('uischedule.a@example.com', '203.0.113.361', 'UI Schedule League A', ['Otters', 'Falcons']);
    const b = await signupAndCreateLeague('uischedule.b@example.com', '203.0.113.362', 'UI Schedule League B', ['Narwhals', 'Beavers']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    csrfTokenA = a.csrfToken;
    cookieB = b.cookie;
    csrfTokenB = b.csrfToken;

    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ season_name: 'UI Schedule Season A' })
    });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ season_name: 'UI Schedule Season B' })
    });

    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ date: '2026-12-06', venue: 'Schedule Page Rink' })
    });
    eventA = (await eventRes.json()).event.id;

    await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ date: '2026-12-07', venue: 'League B Only Rink' })
    });
  });

  it('redirects to /login for an unauthenticated request', async () => {
    const res = await SELF.fetch('http://example.com/league/schedule', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location') || '').toContain('/login');
  });

  it("renders a session-authenticated admin's real events in the HTML, each linking to its detail page", async () => {
    const res = await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: cookieA } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Schedule Page Rink');
    // Superseded by live-testing task (batch 2), Part 6: dates now
    // render in the design system's own format -- 2026-12-06 is a
    // Sunday, so "Dim 6 déc" replaces the old raw ISO assertion.
    expect(html).toContain('Dim 6 déc');
    expect(html).toContain(`/league/events/detail?e=${encodeURIComponent(eventA)}`);
    expect(html).toContain('id="e_date"');
    expect(html).toContain('id="e_submit"');
  });

  it("League A's admin never sees League B's schedule through this page", async () => {
    const res = await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: cookieA } });
    const html = await res.text();
    expect(html).not.toContain('League B Only Rink');
  });

  it('an event created via the real POST /league/events route is reflected on the next page load', async () => {
    const createRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ date: '2026-12-13', venue: 'Freshly Created Venue' })
    });
    expect(createRes.status).toBe(200);

    const res = await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: cookieA } });
    const html = await res.text();
    expect(html).toContain('Freshly Created Venue');
  });

  it('a genuine same date+venue slot rejection from the API is a real, surfaceable error (fixed-teams scheduling task, Part 2: a bare date alone no longer collides -- see league_event_create.spec.js for the now-allowed different-venue/time case)', async () => {
    const res = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ date: '2026-12-06', venue: 'Schedule Page Rink' }) // same date AND venue as above
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/already exists/i);
  });

  it('an empty schedule renders a clear "no events yet" state, not a crash', async () => {
    const c = await signupAndCreateLeague('uischedule.empty@example.com', '203.0.113.363', 'UI Schedule Empty League', ['Sharks', 'Wolves']);
    const res = await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: c.cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Aucun match');
  });

  // C1 bug fix (schedule/events polish task): this list used to sort
  // strictly newest-first (ORDER BY date DESC) -- for an upcoming
  // schedule that buries the very next game under every future week
  // scheduled after it. Now: upcoming events ascending (soonest first),
  // past events below them, most recent first -- the same two-query
  // pattern the public page already used correctly, reused as the
  // reference.
  it('C1: upcoming events sort ascending (soonest first); past events sit below, most recent first', async () => {
    const c = await signupAndCreateLeague('uischedule.c1.sort@example.com', '203.0.113.364', 'UI Schedule Sort League', ['A', 'B']);
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/json', 'x-csrf-token': c.csrfToken },
      body: JSON.stringify({ season_name: 'Sort Season' })
    });
    // Deliberately created out of order, so a passing test can only mean
    // the page itself re-sorts them, not that insertion order happened
    // to match.
    const toCreate = [
      { date: '2099-03-20', venue: 'Far Future Rink' },
      { date: '2020-01-05', venue: 'Old Past Rink' },
      { date: '2099-03-10', venue: 'Near Future Rink' },
      { date: '2020-01-15', venue: 'Recent Past Rink' }
    ];
    for (const body of toCreate) {
      const res = await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/json', 'x-csrf-token': c.csrfToken },
        body: JSON.stringify(body)
      });
      expect(res.status).toBe(200);
    }

    const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: c.cookie } })).text();
    const idx = {
      nearFuture: html.indexOf('Near Future Rink'),   // 2099-03-10 -- soonest upcoming
      farFuture: html.indexOf('Far Future Rink'),      // 2099-03-20
      recentPast: html.indexOf('Recent Past Rink'),    // 2020-01-15 -- most recent past
      oldPast: html.indexOf('Old Past Rink')            // 2020-01-05
    };
    for (const v of Object.values(idx)) expect(v).toBeGreaterThan(-1);

    // Upcoming ascending: soonest (near future) before the later one.
    expect(idx.nearFuture).toBeLessThan(idx.farFuture);
    // All upcoming events appear before all past events.
    expect(idx.farFuture).toBeLessThan(idx.recentPast);
    expect(idx.farFuture).toBeLessThan(idx.oldPast);
    // Past descending: most recent past before the older one.
    expect(idx.recentPast).toBeLessThan(idx.oldPast);
  });

  // C3 bug fix (schedule/events polish task): the create-event panel
  // used to force itself open on desktop (a `@media (min-width: 900px)`
  // CSS override), completely defeating its own toggle button/'open'
  // class mechanism there -- after a successful create
  // (window.location.reload()), the server re-renders a fresh page with
  // no 'open' class, so on desktop the blank form came right back up
  // expanded regardless, reading as "keep adding events". This suite
  // can't execute real CSS layout (see other files' own stated
  // limitation), so this locks the actual mechanical fix: that
  // unconditional desktop override is gone from the served page, the
  // same collapsible-on-every-size behaviour .sc-bulk-panel already had.
  it("C3: the create-event panel no longer forces itself open on desktop -- collapsible on every screen size now", async () => {
    const c = await signupAndCreateLeague('uischedule.c3.collapse@example.com', '203.0.113.365', 'UI Schedule Collapse League', ['A', 'B']);
    const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: c.cookie } })).text();
    expect(html).not.toContain('@media (min-width: 900px) { .sc-panel { display: flex; } }');
    expect(html).toContain('.sc-panel.open { display: flex; }');
    // The panel itself never renders with the 'open' class server-side --
    // a fresh/reloaded page always starts collapsed, letting the toggle
    // button (and only the toggle button) control it.
    expect(html).not.toMatch(/class="sc-panel open"|class="open sc-panel"/);
  });

  // C4 bug fix (schedule/events polish task) originally added (a)
  // quarter-hour preset buttons beside start time and (b) prefill from
  // the league's own most recently used event start time. D2 (forms
  // polish task) removed (a) outright -- the buttons wrapped badly and
  // weren't useful -- while keeping (b), which is what the "remembered
  // start time" tests below still lock.
  describe('C4/D2: start-time presets removed, remembered start time kept', () => {
    it('D2: the quarter-hour preset buttons/function are gone from the create form', async () => {
      const c = await signupAndCreateLeague('uischedule.c4.presets@example.com', '203.0.113.366', 'UI Schedule Presets League', ['A', 'B']);
      await SELF.fetch('http://example.com/league/season/publish', {
        method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/json', 'x-csrf-token': c.csrfToken },
        body: JSON.stringify({ season_name: 'Presets Season' })
      });
      const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: c.cookie } })).text();
      expect(html).not.toContain("setTimePreset(");
      expect(html).not.toContain('function setTimePreset');
      expect(html).not.toContain('sc-time-presets');
      // The native input itself is untouched -- no step attribute
      // restricting it, still a real HTML time picker for any value.
      expect(html).toContain('id="e_start" type="time"');
      expect(html).not.toContain('step="900"');
    });

    it("a league with no prior event: start time is blank by default", async () => {
      const c = await signupAndCreateLeague('uischedule.c4.blank@example.com', '203.0.113.367', 'UI Schedule Blank Prefill League', ['A', 'B']);
      await SELF.fetch('http://example.com/league/season/publish', {
        method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/json', 'x-csrf-token': c.csrfToken },
        body: JSON.stringify({ season_name: 'Blank Prefill Season' })
      });
      const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: c.cookie } })).text();
      expect(html).toContain('id="e_start" type="time" value=""');
    });

    it("a league with a prior event: start time is prefilled with that event's own start time", async () => {
      const c = await signupAndCreateLeague('uischedule.c4.prefill@example.com', '203.0.113.368', 'UI Schedule Prefill League', ['A', 'B']);
      await SELF.fetch('http://example.com/league/season/publish', {
        method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/json', 'x-csrf-token': c.csrfToken },
        body: JSON.stringify({ season_name: 'Prefill Season' })
      });
      await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/json', 'x-csrf-token': c.csrfToken },
        body: JSON.stringify({ date: '2099-04-10', start_time: '19:45' })
      });
      const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: c.cookie } })).text();
      expect(html).toContain('id="e_start" type="time" value="19:45"');

      // A LATER-dated event's own start time becomes the new prefill.
      await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/json', 'x-csrf-token': c.csrfToken },
        body: JSON.stringify({ date: '2099-04-17', start_time: '20:15' })
      });
      const html2 = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie: c.cookie } })).text();
      expect(html2).toContain('id="e_start" type="time" value="20:15"');
    });
  });
});

// Part 4: a simple, read-only public page for a league's own players/
// fans -- GET /league/public?league=<leagueId>, deliberately unauthenticated
// (no session/ADMIN_KEY check at all), the same shape as the existing
// unauthenticated /league/rsvp magic-link page. Shows league name/
// branding, team list, and upcoming events (date/venue/time only).
// Standings only render when the league tracks stats AND its data_json
// actually has a standings array. Proves: it's safely public (no email/
// phone/contact info, no per-event attendee data leaked), and correctly
// isolated per league. Also proves the dashboard links to it (Part 4's
// only path to actually discovering/sharing the URL).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part4-public-league-secret';

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

async function signupAndCreateLeague(email, ip, leagueName, teamNames, tracksStats = true) {
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
    body: JSON.stringify({ name: leagueName, teamNames, tracksStats })
  });
  const leagueJson = await leagueRes.json();

  return { userId: signupJson.userId, cookie, csrfToken, leagueId: leagueJson.league.id };
}

describe('Part 4: GET /league/public (unauthenticated public page)', () => {
  let leagueA, leagueB, cookieA, cookieB, csrfTokenA, csrfTokenB;
  const LEAGUE_A_NAME = 'Public Page League A';

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);

    const a = await signupAndCreateLeague('part4.public.a@example.com', '203.0.113.431', LEAGUE_A_NAME, ['Otters', 'Falcons']);
    const b = await signupAndCreateLeague('part4.public.b@example.com', '203.0.113.432', 'Public Page League B', ['Narwhals', 'Beavers']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    csrfTokenA = a.csrfToken;
    cookieB = b.cookie;
    csrfTokenB = b.csrfToken;

    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ season_name: 'Part 4 Season A' })
    });
    await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ date: '2099-01-11', venue: 'Public Page Rink', season: 'Part 4 Season A' })
    });

    // A player with real, private contact info -- must never appear here.
    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ name: 'Private Contact Player', email: 'private.email@leaguea.com', phone: '514-555-1234', team: 'Otters' })
    });

    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ season_name: 'Part 4 Season B' })
    });
    await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ date: '2099-02-22', venue: 'League B Only Rink', season: 'Part 4 Season B' })
    });
  });

  it('requires no authentication at all', async () => {
    const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(leagueA)}`);
    expect(res.status).toBe(200);
  });

  it('shows the real league name/branding, team list, and upcoming schedule', async () => {
    const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(leagueA)}`);
    const html = await res.text();
    // Design system Part 4: the document title is just the league's
    // own name now, not "{title} — {league}" duplicated.
    expect(html).toContain(`<title>${LEAGUE_A_NAME}</title>`);
    expect(html).toContain('Otters');
    expect(html).toContain('Falcons');
    // Superseded by live-testing task (batch 2), Part 6: dates now
    // render in the design system's own format -- 2099-01-11 is a
    // Sunday, so "Dim 11 janv" replaces the old raw ISO assertion.
    expect(html).toContain('Dim 11 janv');
    expect(html).toContain('Public Page Rink');
  });

  it('never exposes a contact\'s email, phone, or any other private info', async () => {
    const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(leagueA)}`);
    const html = await res.text();
    expect(html).not.toContain('private.email@leaguea.com');
    expect(html).not.toContain('514-555-1234');
    expect(html).not.toContain('Private Contact Player'); // no attendee/roster names at all on the public page
  });

  it("League A's public page never shows League B's schedule or teams, and vice versa (correctly isolated)", async () => {
    const htmlA = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(leagueA)}`)).text();
    expect(htmlA).not.toContain('League B Only Rink');
    expect(htmlA).not.toContain('Narwhals');

    const htmlB = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(leagueB)}`)).text();
    expect(htmlB).not.toContain('Public Page Rink');
    expect(htmlB).not.toContain('Otters');
  });

  it('a nonexistent league id is a clean 404, not a crash', async () => {
    const res = await SELF.fetch('http://example.com/league/public?league=does-not-exist');
    expect(res.status).toBe(404);
  });

  it('a missing league param is a clean 400', async () => {
    const res = await SELF.fetch('http://example.com/league/public');
    expect(res.status).toBe(400);
  });

  it('an empty schedule shows a clear "no upcoming events" state, not a crash', async () => {
    const c = await signupAndCreateLeague('part4.public.empty@example.com', '203.0.113.433', 'Public Page Empty League', ['Reds', 'Blues']);
    const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(c.leagueId)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Aucun match à venir');
  });

  it('a league with tracksStats: false never shows a standings section', async () => {
    const c = await signupAndCreateLeague('part4.public.nostat@example.com', '203.0.113.434', 'Public Page No-Stats League', ['Gold', 'Silver'], false);
    const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(c.leagueId)}`);
    const html = await res.text();
    expect(html).not.toContain('Classement');
    expect(html).not.toContain('Standings');
  });

  it("the dashboard shows the real, copyable public page URL for the admin to share -- now a short slug (Part 2), not the raw UUID", async () => {
    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie: cookieA } });
    const html = await res.text();
    expect(html).not.toContain(`/league/public?league=${leagueA}`);
    const row = await env.DB.prepare('SELECT slug FROM leagues WHERE id = ?').bind(leagueA).first();
    expect(row.slug).toBeTruthy();
    expect(html).toContain(`/${row.slug}"`);
  });
});

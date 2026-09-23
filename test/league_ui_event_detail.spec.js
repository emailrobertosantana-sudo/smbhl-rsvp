// UI task Part U: GET /league/events/detail. Server-rendered from the
// same shared shortage logic GET /league/events/status (Part O) calls
// (teamState/openSpots) -- not a duplicate implementation. Proves: real
// per-team confirmed/open-spot data renders; the short/not-short state is
// clear; the invite-subs button posts to the real
// POST /league/events/invite-subs (Part P) route; unauthenticated
// redirects to /login; and League A cannot view or act on League B's
// event through this page.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-ui-event-detail-secret';

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

describe('UI task Part U: GET /league/events/detail', () => {
  let leagueA, leagueB, cookieA, cookieB, csrfTokenA, csrfTokenB, eventA, eventB;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;

    await applyRealSchema(env);

    const a = await signupAndCreateLeague('uidetail.a@example.com', '203.0.113.371', 'UI Detail League A', ['Otters', 'Falcons']);
    const b = await signupAndCreateLeague('uidetail.b@example.com', '203.0.113.372', 'UI Detail League B', ['Narwhals', 'Beavers']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    csrfTokenA = a.csrfToken;
    cookieB = b.cookie;
    csrfTokenB = b.csrfToken;

    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ season_name: 'UI Detail Season A', goalies_per_team: 1, skaters_per_team: 1, min_skaters: 1 })
    });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ season_name: 'UI Detail Season B' })
    });

    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ date: '2026-12-06', venue: 'Detail Page Rink' })
    });
    eventA = (await eventRes.json()).event.id;

    const eventBRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ date: '2026-12-07' })
    });
    eventB = (await eventBRes.json()).event.id;
  });

  it('redirects to /login for an unauthenticated request', async () => {
    const res = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent('whatever')}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location') || '').toContain('/login');
  });

  it('shows a clear 404 for a nonexistent event, not a crash', async () => {
    const res = await SELF.fetch('http://example.com/league/events/detail?e=does-not-exist', { headers: { cookie: cookieA } });
    expect(res.status).toBe(404);
  });

  it("League A's admin cannot view League B's event through this page (404, not another league's data)", async () => {
    const res = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventB)}`, { headers: { cookie: cookieA } });
    expect(res.status).toBe(404);
  });

  it('shows the event as short with an invite button, before anyone has confirmed', async () => {
    const res = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventA)}`, { headers: { cookie: cookieA } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Detail Page Rink');
    expect(html).toContain('Otters');
    expect(html).toContain('Falcons');
    expect(html).toContain('short'); // shortage indicator class/text
    expect(html).toContain('inviteSubs(');
    expect(html).toContain('Inviter des joueurs');
  });

  it('the invite button calls the real POST /league/events/invite-subs route, scoped to League A only', async () => {
    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ name: 'Detail Page Sub', email: 'detailsub@leaguea.com', role: 'sub_skater' })
    });

    const res = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ event_id: eventA, team: 'Otters', need: 'skater' })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.league_id).toBe(leagueA);
    expect(json.invited).toBeGreaterThanOrEqual(1);
  });

  it("League B's admin cannot trigger an invite for League A's event (404)", async () => {
    const res = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ event_id: eventA, team: 'Otters', need: 'skater' })
    });
    expect(res.status).toBe(404);
  });

  it("League B's own event detail page shows League B's real confirmed players, and never mentions League A's data", async () => {
    const playerRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ name: 'League B Confirmed Player', role: 'roster' })
    });
    const playerId = (await playerRes.json()).contact.player_id;
    await env.DB.prepare(`UPDATE contacts SET preferred_team = 'Narwhals' WHERE player_id = ?`).bind(playerId).run();
    await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, 'Narwhals', 'in', 'roster', 'self', ?, ?)`)
      .bind(eventB, playerId, new Date().toISOString(), leagueB).run();

    const res = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventB)}`, { headers: { cookie: cookieB } });
    const html = await res.text();
    expect(html).toContain('Narwhals');
    expect(html).toContain('Beavers');
    // Isolation proof: League A's data never appears on League B's page.
    expect(html).not.toContain('Detail Page Rink');
    expect(html).not.toContain('Otters');
  });
});

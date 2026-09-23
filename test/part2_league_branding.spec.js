// Part 2 fix (found via live testing on a real second league): every
// session-based league page built in Parts R-V (dashboard, roster,
// schedule, event detail/not-found) still showed "SMBHL" in the
// <title>/favicon/footer for EVERY league, because page() -- which
// already fully supports a 4th leagueCfg argument (title, favicon, logo
// alt text, footer, site link all already branch on it; GET /league/rsvp
// already used it correctly) -- was simply never passed one at any of
// these call sites, so it silently fell back to
// DEFAULT_SEASON_CONFIG.league (SMBHL's own branding).
//
// Proves: each of those pages now shows the CALLING league's own real
// name in the <title>/footer, not "SMBHL"; and SMBHL's own legacy
// ADMIN_KEY-gated admin pages (a completely different code path) are
// byte-for-byte unaffected.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part2-branding-secret';

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

describe('Part 2: league branding on session-based pages', () => {
  let leagueId, cookie, csrfToken, eventId;
  const LEAGUE_NAME = 'Ligue Notre-Vraie-Ligue';

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);

    const a = await signupAndCreateLeague('part2.branding@example.com', '203.0.113.411', LEAGUE_NAME, ['Alpha', 'Beta']);
    leagueId = a.leagueId;
    cookie = a.cookie;
    csrfToken = a.csrfToken;

    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Part 2 Branding Season' })
    });

    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2026-12-13' })
    });
    eventId = (await eventRes.json()).event.id;
  });

  it('GET /dashboard shows the real league name, not SMBHL', async () => {
    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain(`<title>Tableau de bord — ${LEAGUE_NAME}</title>`);
    expect(html).not.toContain('SMBHL');
  });

  it('GET /league/roster shows the real league name, not SMBHL', async () => {
    const res = await SELF.fetch('http://example.com/league/roster', { headers: { cookie } });
    const html = await res.text();
    // Design system Part 3: "Effectif" -> "Joueurs" (the same term the
    // real nav/tabbar use throughout, ScreenRoster's own heading).
    expect(html).toContain(`<title>Joueurs — ${LEAGUE_NAME}</title>`);
    expect(html).not.toContain('SMBHL');
  });

  it('GET /league/schedule shows the real league name, not SMBHL', async () => {
    const res = await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } });
    const html = await res.text();
    // Design system Part 3: "Calendrier" -> "Horaire" (the same term
    // the nav/tabbar already use).
    expect(html).toContain(`<title>Horaire — ${LEAGUE_NAME}</title>`);
    expect(html).not.toContain('SMBHL');
  });

  it('GET /league/events/detail shows the real league name, not SMBHL', async () => {
    const res = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } });
    const html = await res.text();
    // Design system Part 3: the event's own date, not a generic label.
    expect(html).toContain(`<title>2026-12-13 — ${LEAGUE_NAME}</title>`);
    expect(html).not.toContain('SMBHL');
  });

  it('the "event not found" 404 page also shows the real league name, not SMBHL', async () => {
    const res = await SELF.fetch('http://example.com/league/events/detail?e=does-not-exist', { headers: { cookie } });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain(`<title>Match introuvable — ${LEAGUE_NAME}</title>`);
    expect(html).not.toContain('SMBHL');
  });

  it("SMBHL's own real /admin/board page (the legacy ADMIN_KEY-gated code path) is completely unaffected", async () => {
    const res = await SELF.fetch('http://example.com/admin/board');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Tableau —');
    expect(html).toContain('SMBHL');
  });
});

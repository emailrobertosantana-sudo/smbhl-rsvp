// Onboarding fix: POST /league/season/publish (Part I) had zero UI, so a
// brand-new admin trying to create their first event hit a confusing
// "season is required" error with no path forward. The dashboard now
// shows a "start your season" prompt exactly when needed (no current
// season yet), and shows the current season plainly (no re-prompt) once
// one exists. Proves the whole onboarding path is now dead-end-free.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

const AUTH_SECRET = 'test-onboarding-season-secret';

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

async function signupAndCreateLeague(email, ip, leagueName, teamNames) {
  const signupRes = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const signupJson = await signupRes.json();
  const cookie = extractCookie(signupRes);

  const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: leagueName, teamNames, tracksStats: true })
  });
  const leagueJson = await leagueRes.json();

  return { userId: signupJson.userId, cookie, leagueId: leagueJson.league.id };
}

describe('Onboarding: dashboard "start your season" prompt', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, email_verified_at TEXT, last_login_at TEXT, session_epoch INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS signup_attempts (ip TEXT PRIMARY KEY, window_start TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leagues (id TEXT PRIMARY KEY, name TEXT NOT NULL, division_label TEXT, tracks_stats INTEGER NOT NULL DEFAULT 1, team_count INTEGER NOT NULL, team_names TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS league_admins (user_id TEXT NOT NULL, league_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL, PRIMARY KEY (user_id, league_id))`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, season TEXT, week INTEGER, date TEXT, venue TEXT, state TEXT NOT NULL DEFAULT 'open', start_time TEXT, end_time TEXT, league_id TEXT NOT NULL DEFAULT 'smbhl')`).run();
  });

  it('a brand-new league (no season yet) sees a clear, actionable "start your season" prompt on the dashboard, not a dead end', async () => {
    const { cookie } = await signupAndCreateLeague('onboard.new@example.com', '203.0.113.391', 'Onboarding New League', ['Otters', 'Falcons']);

    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Démarrer votre saison');
    expect(html).toContain('id="season_name"');
    expect(html).toContain('id="season_submit"');
    // And no confusing "current season" line, since there isn't one yet.
    expect(html).not.toContain('Saison actuelle');
  });

  it("submitting the form publishes a season via the real route, and the admin can then immediately create an event without the old 'season is required' error", async () => {
    const { cookie } = await signupAndCreateLeague('onboard.submit@example.com', '203.0.113.392', 'Onboarding Submit League', ['Comets', 'Meteors']);

    // What the dashboard's own submitSeason() JS calls.
    const publishRes = await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ season_name: 'Onboarding Test Season' })
    });
    expect(publishRes.status).toBe(200);
    const publishJson = await publishRes.json();
    expect(publishJson.current_season).toBe('Onboarding Test Season');
    expect(publishJson.teams).toEqual(['Comets', 'Meteors']); // pulled from signup, not re-asked

    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-13', venue: 'Onboarding Rink' })
    });
    expect(eventRes.status).toBe(200);
    const eventJson = await eventRes.json();
    expect(eventJson.event.season).toBe('Onboarding Test Season');
  });

  it('once a season exists, the dashboard shows it plainly and does NOT show the start-season prompt again', async () => {
    const { cookie } = await signupAndCreateLeague('onboard.existing@example.com', '203.0.113.393', 'Onboarding Existing League', ['Sharks', 'Wolves']);
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ season_name: 'Already Started Season' })
    });

    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Saison actuelle');
    expect(html).toContain('Already Started Season');
    expect(html).not.toContain('Démarrer votre saison');
    expect(html).not.toContain('id="season_name"');
  });

  it('the form surfaces a real API error (e.g. missing team names) rather than a generic failure -- exercised directly against the route the dashboard\'s JS calls', async () => {
    const { cookie } = await signupAndCreateLeague('onboard.error@example.com', '203.0.113.394', 'Onboarding Error League', ['Team X', 'Team Y']);
    const res = await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({}) // no season_name
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/season_name/i);
  });
});

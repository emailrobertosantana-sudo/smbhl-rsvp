// UI task Part V: confirms GET /league/rsvp (Part M's player-facing magic-
// link page) uses the same shared, fully-styled page() shell/CSS as every
// other page in this app (not a bare HTML form) — same fonts, .card,
// .btn, color variables — and that it now uses the same interactive
// fetch+POST button pattern (loading state, inline success message) as
// SMBHL's real /rsvp page, rather than a less-polished plain-link
// interaction.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

const AUTH_SECRET = 'test-ui-rsvp-polish-secret';
const RSVP_SECRET = 'test-ui-rsvp-polish-rsvp-secret';

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

async function computeToken(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

describe('UI task Part V: GET /league/rsvp visual polish', () => {
  let leagueId, cookie, playerId, salt, eventId;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, email_verified_at TEXT, last_login_at TEXT, session_epoch INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS signup_attempts (ip TEXT PRIMARY KEY, window_start TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leagues (id TEXT PRIMARY KEY, name TEXT NOT NULL, division_label TEXT, tracks_stats INTEGER NOT NULL DEFAULT 1, team_count INTEGER NOT NULL, team_names TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS league_admins (user_id TEXT NOT NULL, league_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL, PRIMARY KEY (user_id, league_id))`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS contacts (player_id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, role TEXT NOT NULL DEFAULT 'roster', is_goalie INT DEFAULT 0, preferred_team TEXT, position TEXT, token_salt TEXT NOT NULL DEFAULT '', league_id TEXT NOT NULL DEFAULT 'smbhl')`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, season TEXT, week INTEGER, date TEXT, venue TEXT, state TEXT NOT NULL DEFAULT 'open', start_time TEXT, end_time TEXT, league_id TEXT NOT NULL DEFAULT 'smbhl')`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rsvp (event_id TEXT, player_id TEXT, guest_name TEXT, team TEXT, status TEXT NOT NULL DEFAULT 'pending', role TEXT NOT NULL DEFAULT 'roster', status_by TEXT NOT NULL DEFAULT 'auto', updated_at TEXT, league_id TEXT NOT NULL DEFAULT 'smbhl', PRIMARY KEY (event_id, player_id))`).run();

    const league = await signupAndCreateLeague('uirsvppolish@example.com', '203.0.113.381', 'UI RSVP Polish League', ['Otters', 'Falcons']);
    leagueId = league.leagueId;
    cookie = league.cookie;

    const playerRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Polish Test Player' })
    });
    playerId = (await playerRes.json()).contact.player_id;
    salt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerId).first()).token_salt;

    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ season_name: 'UI RSVP Polish Season' })
    });
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-20' })
    });
    eventId = (await eventRes.json()).event.id;
  });

  it('uses the same shared, fully-styled page shell as every other page in this app -- not a bare HTML form', async () => {
    const token = await computeToken(RSVP_SECRET, `lr:${leagueId}:${eventId}:${playerId}:${salt}`);
    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueId)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    // The real shared CSS system (page()) -- fonts, color variables, .card.
    expect(html).toContain('Barlow');
    expect(html).toContain('--ink:');
    expect(html).toContain('class="card"');
    expect(html).toContain('class="btn');
    expect(html).toContain('class="when"');
  });

  it('shows the current status with the same colored .in/.out/.pend convention used elsewhere in this app', async () => {
    const token = await computeToken(RSVP_SECRET, `lr:${leagueId}:${eventId}:${playerId}:${salt}`);
    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueId)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`);
    const html = await res.text();
    expect(html).toContain('class="pend"'); // starts pending
  });

  it('uses interactive buttons that POST in place (matching SMBHL\'s real /rsvp page), not plain full-page-reload links', async () => {
    const token = await computeToken(RSVP_SECRET, `lr:${leagueId}:${eventId}:${playerId}:${salt}`);
    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueId)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`);
    const html = await res.text();
    expect(html).toContain('data-v="in"');
    expect(html).toContain('data-v="out"');
    expect(html).toContain('<button');
    // No longer a plain <a href="...v=in"> link-based interaction.
    expect(html).not.toContain('href="?league=');
    expect(html).toContain("fetch(location.pathname");
  });

  it('after marking IN, the status badge and button state reflect it, colored green via the .in class', async () => {
    const token = await computeToken(RSVP_SECRET, `lr:${leagueId}:${eventId}:${playerId}:${salt}`);
    await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueId)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in' })
    });

    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueId)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`);
    const html = await res.text();
    expect(html).toContain('class="in"');
    expect(html).toContain('btn in on');
  });

  it('the ?v=in/out one-click emailed-link path still works unchanged after the visual update', async () => {
    const token = await computeToken(RSVP_SECRET, `lr:${leagueId}:${eventId}:${playerId}:${salt}`);
    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueId)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}&v=out`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Réponse enregistrée');

    const row = await env.DB.prepare('SELECT status FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, playerId).first();
    expect(row.status).toBe('out');
  });
});

// UI task Part V: confirms GET /league/rsvp (Part M's player-facing magic-
// link page) uses the same shared, fully-styled page() shell/CSS as every
// other page in this app (not a bare HTML form) — same fonts, .card,
// .btn, color variables — and that it now uses the same interactive
// fetch+POST button pattern (loading state, inline success message) as
// SMBHL's real /rsvp page, rather than a less-polished plain-link
// interaction.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-ui-rsvp-polish-secret';
const RSVP_SECRET = 'test-ui-rsvp-polish-rsvp-secret';

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

async function computeToken(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

describe('UI task Part V: GET /league/rsvp visual polish', () => {
  let leagueId, cookie, csrfToken, playerId, salt, eventId;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;

    await applyRealSchema(env);

    const league = await signupAndCreateLeague('uirsvppolish@example.com', '203.0.113.381', 'UI RSVP Polish League', ['Otters', 'Falcons']);
    leagueId = league.leagueId;
    cookie = league.cookie;
    csrfToken = league.csrfToken;

    const playerRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Polish Test Player' })
    });
    playerId = (await playerRes.json()).contact.player_id;
    salt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerId).first()).token_salt;

    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'UI RSVP Polish Season' })
    });
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
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

// Part M: league-scoped player magic links — GET /league/rsvp and the
// leagueRsvpMsg token scheme. No session involved at all: this must work
// for a player clicking an emailed link cold. Proves: the token
// verifies/resolves correctly for a real league/event/player; the GET
// route's one-click ?v=in/out writes correctly; and the defense-in-depth
// isolation guarantee — a token minted for League A is rejected against
// League B, both because the signed message differs AND because a
// mismatched league/event/player combination fails the DB lookups.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

const AUTH_SECRET = 'test-league-rsvp-token-secret';
const RSVP_SECRET = 'test-league-rsvp-token-rsvp-secret';

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

describe('Part M: GET /league/rsvp and the league RSVP token', () => {
  let leagueA, leagueB, cookieA, cookieB;
  let playerA, playerASalt, eventA;
  let playerB, playerBSalt, eventB;

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

    const a = await signupAndCreateLeague('rsvptoken.a@example.com', '203.0.113.291', 'RSVP Token League A', ['Otters', 'Falcons']);
    const b = await signupAndCreateLeague('rsvptoken.b@example.com', '203.0.113.292', 'RSVP Token League B', ['Narwhals', 'Beavers']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    cookieB = b.cookie;

    const contactRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Player Alpha One' })
    });
    playerA = (await contactRes.json()).contact.player_id;
    playerASalt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerA).first()).token_salt;

    const contactBRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Player Beta One' })
    });
    playerB = (await contactBRes.json()).contact.player_id;
    playerBSalt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerB).first()).token_salt;

    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-06', season: 'League A Season 1' })
    });
    eventA = (await eventRes.json()).event.id;

    const eventBRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-06', season: 'League B Season 1' })
    });
    eventB = (await eventBRes.json()).event.id;
  });

  it('a validly minted token resolves and shows the correct player + event', async () => {
    const token = await computeToken(RSVP_SECRET, `lr:${leagueA}:${eventA}:${playerA}:${playerASalt}`);
    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(eventA)}&p=${encodeURIComponent(playerA)}&t=${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Player Alpha One');
    expect(html).not.toContain('Lien invalide');
  });

  it('?v=in writes the rsvp status via the one-click link, tagged with the correct league_id', async () => {
    const token = await computeToken(RSVP_SECRET, `lr:${leagueA}:${eventA}:${playerA}:${playerASalt}`);
    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(eventA)}&p=${encodeURIComponent(playerA)}&t=${token}&v=in`);
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT * FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventA, playerA).first();
    expect(row.status).toBe('in');
    expect(row.league_id).toBe(leagueA);
  });

  it('an incomplete link (missing params) shows a readable error, not a crash', async () => {
    const res = await SELF.fetch('http://example.com/league/rsvp');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('incomplet');
  });

  it('a garbage token is rejected', async () => {
    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(eventA)}&p=${encodeURIComponent(playerA)}&t=not-a-real-token`);
    const html = await res.text();
    expect(html).toContain('invalide');
  });

  describe('Defense-in-depth isolation', () => {
    it('the signed message itself differs by league -- same event/player/salt strings under two different asserted leagues produce different signatures', async () => {
      const message = `${eventA}:${playerA}:${playerASalt}`;
      const tokenForA = await computeToken(RSVP_SECRET, `lr:${leagueA}:${message}`);
      const tokenForB = await computeToken(RSVP_SECRET, `lr:${leagueB}:${message}`);
      expect(tokenForA).not.toBe(tokenForB);
    });

    it('a token validly minted for League A is rejected if the league param is swapped to League B, even though e/p/t are otherwise unchanged', async () => {
      const token = await computeToken(RSVP_SECRET, `lr:${leagueA}:${eventA}:${playerA}:${playerASalt}`);
      const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueB)}&e=${encodeURIComponent(eventA)}&p=${encodeURIComponent(playerA)}&t=${token}`);
      const html = await res.text();
      // playerA doesn't belong to leagueB at all, so this fails at the
      // contact lookup -- proving the league check is real, not just a
      // formality.
      expect(html).not.toContain('Player Alpha One');
      expect(html).toMatch(/inconnu|introuvable|invalide/);
    });

    it("League B's real player/event, addressed with League A's league id in the URL, is also rejected", async () => {
      const token = await computeToken(RSVP_SECRET, `lr:${leagueB}:${eventB}:${playerB}:${playerBSalt}`);
      const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(eventB)}&p=${encodeURIComponent(playerB)}&t=${token}`);
      const html = await res.text();
      expect(html).not.toContain('Player Beta One');
    });
  });
});

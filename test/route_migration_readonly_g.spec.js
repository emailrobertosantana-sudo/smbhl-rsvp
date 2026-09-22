// Part G: read-only route migration batch 2 — GET /admin/board/data,
// GET /admin/subs/data, GET /admin/outbox. Same dual-auth pattern as the
// prior batch (schedule/data, people/data) and the teams/data proof of
// concept: ADMIN_KEY path unchanged, session path new/additive and
// league_id-scoped.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

const AUTH_SECRET = 'test-route-migration-g-secret';
const ADMIN_KEY = 'test-route-migration-g-admin-key';

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

describe('Part G: /admin/board/data, /admin/subs/data, /admin/outbox', () => {
  let leagueA, leagueB, cookieA, cookieB;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.ADMIN_KEY = ADMIN_KEY;
    env.RSVP_SECRET = env.RSVP_SECRET || 'test-rsvp-secret-route-migration-g';

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, email_verified_at TEXT, last_login_at TEXT, session_epoch INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS signup_attempts (ip TEXT PRIMARY KEY, window_start TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leagues (id TEXT PRIMARY KEY, name TEXT NOT NULL, division_label TEXT, tracks_stats INTEGER NOT NULL DEFAULT 1, team_count INTEGER NOT NULL, team_names TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS league_admins (user_id TEXT NOT NULL, league_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL, PRIMARY KEY (user_id, league_id))`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS contacts (player_id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, role TEXT NOT NULL DEFAULT 'roster', is_goalie INT DEFAULT 0, is_backup_goalie INT DEFAULT 0, preferred_team TEXT, position TEXT, dormant INT DEFAULT 0, asked_streak INT DEFAULT 0, last_asked TEXT, last_played TEXT, opted_out INT DEFAULT 0, token_salt TEXT NOT NULL DEFAULT '', league_id TEXT NOT NULL DEFAULT 'smbhl')`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, season TEXT, week INTEGER, date TEXT, venue TEXT, state TEXT NOT NULL DEFAULT 'open', start_time TEXT, end_time TEXT, league_id TEXT NOT NULL DEFAULT 'smbhl')`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rsvp (event_id TEXT, player_id TEXT, guest_name TEXT, team TEXT, status TEXT NOT NULL DEFAULT 'pending', role TEXT NOT NULL DEFAULT 'roster', status_by TEXT NOT NULL DEFAULT 'auto', updated_at TEXT, PRIMARY KEY (event_id, player_id))`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS availability (event_id TEXT, player_id TEXT, need TEXT, status TEXT, answered_at TEXT, PRIMARY KEY (event_id, player_id, need))`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, event_id TEXT, player_id TEXT, team TEXT, dedup_key TEXT, payload TEXT, send_after TEXT, sent_at TEXT, cancelled INT DEFAULT 0, error TEXT, created_at TEXT, league_id TEXT NOT NULL DEFAULT 'smbhl')`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run();

    const a = await signupAndCreateLeague('routemig.g.a@example.com', '203.0.113.231', 'Route Migration G League A', ['Red', 'Blue']);
    const b = await signupAndCreateLeague('routemig.g.b@example.com', '203.0.113.232', 'Route Migration G League B', ['Gold', 'Silver']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    cookieB = b.cookie;

    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, league_id) VALUES (?, ?, ?, ?)`)
      .bind(`${leagueA}:P0001`, 'League A Contact', 'a@example.com', leagueA).run();
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, league_id) VALUES (?, ?, ?, ?)`)
      .bind(`${leagueB}:P0001`, 'League B Contact', 'b@example.com', leagueB).run();

    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, league_id) VALUES (?, 'League A Season', 1, '2026-10-04', 'League A Venue', 'open', ?)`)
      .bind(`${leagueA}:2026-10-04`, leagueA).run();
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, league_id) VALUES (?, 'League B Season', 1, '2026-10-11', 'League B Venue', 'open', ?)`)
      .bind(`${leagueB}:2026-10-11`, leagueB).run();

    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, send_after, created_at, league_id) VALUES ('invite', ?, ?, 'Red', ?, ?, ?)`)
      .bind(`${leagueA}:2026-10-04`, `${leagueA}:P0001`, new Date().toISOString(), new Date().toISOString(), leagueA).run();
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, send_after, created_at, league_id) VALUES ('invite', ?, ?, 'Gold', ?, ?, ?)`)
      .bind(`${leagueB}:2026-10-11`, `${leagueB}:P0001`, new Date().toISOString(), new Date().toISOString(), leagueB).run();
  });

  describe('GET /admin/board/data', () => {
    it('ADMIN_KEY access is unchanged: still 200 via the original boardData path', async () => {
      const res = await SELF.fetch('http://example.com/admin/board/data', { headers: { 'x-admin': ADMIN_KEY } });
      expect(res.status).toBe(200);
    });

    it('a wrong/missing ADMIN_KEY and no session is rejected exactly as before (403)', async () => {
      const res = await SELF.fetch('http://example.com/admin/board/data');
      expect(res.status).toBe(403);
    });

    it("a session-authenticated league admin sees only their own league's event", async () => {
      const res = await SELF.fetch('http://example.com/admin/board/data', { headers: { cookie: cookieA } });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.league_id).toBe(leagueA);
      expect(json.event.id).toBe(`${leagueA}:2026-10-04`);
      expect(json.events.length).toBe(1);
    });

    it("League A's admin explicitly requesting League B's league_id is rejected (403)", async () => {
      const res = await SELF.fetch(`http://example.com/admin/board/data?league_id=${encodeURIComponent(leagueB)}`, {
        headers: { cookie: cookieA }
      });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /admin/subs/data', () => {
    it('ADMIN_KEY access is unchanged: still 200 via the original subsData path', async () => {
      const res = await SELF.fetch('http://example.com/admin/subs/data', { headers: { 'x-admin': ADMIN_KEY } });
      expect(res.status).toBe(200);
    });

    it('a wrong/missing ADMIN_KEY and no session is rejected exactly as before (403)', async () => {
      const res = await SELF.fetch('http://example.com/admin/subs/data');
      expect(res.status).toBe(403);
    });

    it("a session-authenticated league admin sees only their own league's event and contacts", async () => {
      const res = await SELF.fetch('http://example.com/admin/subs/data', { headers: { cookie: cookieB } });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.league_id).toBe(leagueB);
      expect(json.event.id).toBe(`${leagueB}:2026-10-11`);
      expect(json.contacts.length).toBe(1);
      expect(json.contacts[0].name).toBe('League B Contact');
    });

    it("League B's admin explicitly requesting League A's league_id is rejected (403)", async () => {
      const res = await SELF.fetch(`http://example.com/admin/subs/data?league_id=${encodeURIComponent(leagueA)}`, {
        headers: { cookie: cookieB }
      });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /admin/outbox', () => {
    it('ADMIN_KEY access is unchanged: still returns the unscoped rows list exactly as before', async () => {
      const res = await SELF.fetch('http://example.com/admin/outbox', { headers: { 'x-admin': ADMIN_KEY } });
      expect(res.status).toBe(200);
      const json = await res.json();
      const eventIds = json.rows.map(r => r.event_id);
      expect(eventIds).toContain(`${leagueA}:2026-10-04`);
      expect(eventIds).toContain(`${leagueB}:2026-10-11`);
    });

    it('a wrong/missing ADMIN_KEY and no session is rejected exactly as before (403)', async () => {
      const res = await SELF.fetch('http://example.com/admin/outbox');
      expect(res.status).toBe(403);
    });

    it("a session-authenticated league admin sees only their own league's outbox rows", async () => {
      const res = await SELF.fetch('http://example.com/admin/outbox', { headers: { cookie: cookieA } });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.league_id).toBe(leagueA);
      expect(json.rows.length).toBe(1);
      expect(json.rows[0].event_id).toBe(`${leagueA}:2026-10-04`);
    });

    it("League A's admin explicitly requesting League B's league_id is rejected (403)", async () => {
      const res = await SELF.fetch(`http://example.com/admin/outbox?league_id=${encodeURIComponent(leagueB)}`, {
        headers: { cookie: cookieA }
      });
      expect(res.status).toBe(403);
    });
  });
});

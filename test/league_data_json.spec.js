// League-scoped data_json (season/roster/standings/fixtures KV blob).
// Chosen approach: namespace the KV KEY per league (data_json for SMBHL,
// data_json:<leagueId> for anyone else), not restructure the blob's
// top-level shape — see the task report for the full reasoning (grepped
// count of existing call sites, and why the safety constraint of "SMBHL's
// existing key/shape literally stays as-is" rules out reshaping the value
// stored at 'data_json').
//
// This file proves: (1) SMBHL's own read path (the literal 'data_json'
// key) is completely unaffected by any of this; (2) a new league's
// data_json-equivalent starts genuinely empty, not merged with or derived
// from SMBHL's; (3) the one migrated proof-of-concept route
// (GET /admin/teams/data) gives a second league's admin only their own
// league's data, and SMBHL's real data is never reachable through it.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { dataJsonKeyFor, SMBHL_LEAGUE_ID } from '../src/league_ids.js';
import { getLeagueDataJson } from '../src/leagues.js';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-league-datajson-secret';
const ADMIN_KEY = 'test-league-datajson-admin-key';

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

const SMBHL_REAL_DATA_JSON = {
  current_season: 'Fall 2026',
  seasons: [{
    name: 'Fall 2026',
    config: { teams: ['Red', 'Blue', 'White', 'Black'] },
    standings: [{ team: 'Red', w: 3, l: 1 }]
  }],
  players: [{ id: 'P0001', name: 'Real SMBHL Player', seasons: { 'Fall 2026': { team: 'Red' } } }]
};

describe('League-scoped data_json (KV key namespacing)', () => {
  let leagueA, leagueB, cookieA, cookieB;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.ADMIN_KEY = ADMIN_KEY;

    await applyRealSchema(env);

    // SMBHL's real, existing data — written at the literal 'data_json' key,
    // exactly as every existing route in this codebase already does.
    await env.SHEETS_KV.put('data_json', JSON.stringify(SMBHL_REAL_DATA_JSON));

    const a = await signupAndCreateLeague('datajson.a@example.com', '203.0.113.221', 'DataJSON League A', ['Gold', 'Silver']);
    const b = await signupAndCreateLeague('datajson.b@example.com', '203.0.113.222', 'DataJSON League B', ['Green', 'Yellow']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    cookieB = b.cookie;

    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, token_salt, league_id) VALUES (?, ?, ?, ?, ?)`)
      .bind(`${leagueA}:P0001`, 'League A Contact', 'a@example.com', 'salt-a', leagueA).run();
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, token_salt, league_id) VALUES (?, ?, ?, ?, ?)`)
      .bind(`${leagueB}:P0001`, 'League B Contact', 'b@example.com', 'salt-b', leagueB).run();
  });

  describe('dataJsonKeyFor()', () => {
    it("resolves SMBHL's key as the literal, unprefixed 'data_json' — the exact key every existing call site already hardcodes", () => {
      expect(dataJsonKeyFor(SMBHL_LEAGUE_ID)).toBe('data_json');
      expect(dataJsonKeyFor('smbhl')).toBe('data_json');
    });

    it('namespaces any other league under a distinct key that can never collide with the bare data_json key', () => {
      expect(dataJsonKeyFor(leagueA)).toBe(`data_json:${leagueA}`);
      expect(dataJsonKeyFor(leagueB)).toBe(`data_json:${leagueB}`);
      expect(dataJsonKeyFor(leagueA)).not.toBe(dataJsonKeyFor(leagueB));
    });
  });

  describe("SMBHL's existing data_json read path is provably unchanged", () => {
    it('getLeagueDataJson(env, "smbhl") returns byte-for-byte the same object stored at the literal data_json key', async () => {
      const result = await getLeagueDataJson(env, SMBHL_LEAGUE_ID);
      expect(result).toEqual(SMBHL_REAL_DATA_JSON);
    });

    it('GET /admin/teams/data via ADMIN_KEY still returns SMBHL\'s real season/team data, unchanged by any of this', async () => {
      const res = await SELF.fetch('http://example.com/admin/teams/data?season=Fall+2026', {
        headers: { 'x-admin': ADMIN_KEY }
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.current_season).toBe('Fall 2026');
      expect(json.teams.Red.some(p => p.name === 'Real SMBHL Player')).toBe(true);
    });
  });

  describe('A new league\'s data_json-equivalent starts genuinely separate/empty', () => {
    it('getLeagueDataJson for a league that has never published a season returns the empty shape, not SMBHL\'s data', async () => {
      const result = await getLeagueDataJson(env, leagueA);
      expect(result).toEqual({ current_season: null, seasons: [], players: [] });
      expect(result).not.toEqual(SMBHL_REAL_DATA_JSON);
    });

    it("a league's own key genuinely does not exist in KV until it publishes something (no silent fallback to SMBHL's key)", async () => {
      const raw = await env.SHEETS_KV.get(dataJsonKeyFor(leagueB));
      expect(raw).toBeNull();
    });
  });

  describe('GET /admin/teams/data proof of concept: session isolation', () => {
    it("League A's admin sees only their own (empty) league data and own contacts, never SMBHL's", async () => {
      const res = await SELF.fetch('http://example.com/admin/teams/data', { headers: { cookie: cookieA } });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.league_id).toBe(leagueA);
      expect(json.current_season).toBeNull();
      expect(json.seasons).toEqual([]);
      expect(json.contacts.length).toBe(1);
      expect(json.contacts[0].name).toBe('League A Contact');
      // Explicitly not SMBHL's real player, proving no fallback/merge occurred.
      expect(json.contacts.some(c => c.name === 'Real SMBHL Player')).toBe(false);
    });

    it("once League A publishes its own season data, its session view reflects THAT (and only that) -- genuine isolation, not just a different label on the same data", async () => {
      const leagueAOwnData = {
        current_season: 'League A Season 1',
        seasons: [{ name: 'League A Season 1', standings: [] }],
        players: []
      };
      await env.SHEETS_KV.put(dataJsonKeyFor(leagueA), JSON.stringify(leagueAOwnData));

      const aRes = await SELF.fetch('http://example.com/admin/teams/data', { headers: { cookie: cookieA } });
      const aJson = await aRes.json();
      expect(aJson.current_season).toBe('League A Season 1');

      // League B, and SMBHL via ADMIN_KEY, are both completely unaffected.
      const bRes = await SELF.fetch('http://example.com/admin/teams/data', { headers: { cookie: cookieB } });
      const bJson = await bRes.json();
      expect(bJson.current_season).toBeNull();

      const adminRes = await SELF.fetch('http://example.com/admin/teams/data?season=Fall+2026', {
        headers: { 'x-admin': ADMIN_KEY }
      });
      const adminJson = await adminRes.json();
      expect(adminJson.current_season).toBe('Fall 2026');
    });

    it("League B's admin explicitly requesting League A's league_id is rejected (403) -- SMBHL-equivalent data is not reachable across leagues", async () => {
      const res = await SELF.fetch(`http://example.com/admin/teams/data?league_id=${encodeURIComponent(leagueA)}`, {
        headers: { cookie: cookieB }
      });
      expect(res.status).toBe(403);
    });

    it('an unauthenticated request is rejected exactly as the underlying ADMIN_KEY gate always has (403)', async () => {
      const res = await SELF.fetch('http://example.com/admin/teams/data');
      expect(res.status).toBe(403);
    });
  });
});

// Part I: POST /league/season/publish — the first WRITE path for a second
// league's own data_json-equivalent. Session+checkLeagueAccess-gated only,
// no ADMIN_KEY door into it at all. This file proves: the write only ever
// touches the calling league's own scoped KV key (SMBHL's real data_json
// is re-verified unchanged AFTER a second league publishes); ADMIN_KEY
// alone (no session) cannot use this route; overwrite-by-season-name
// behavior; and the full sign-up-to-own-season-data milestone end to end.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { dataJsonKeyFor } from '../src/league_ids.js';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-league-season-publish-secret';
const ADMIN_KEY = 'test-league-season-publish-admin-key';

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

const SMBHL_REAL_DATA_JSON = {
  current_season: 'Fall 2026',
  seasons: [{
    name: 'Fall 2026',
    config: { teams: ['Red', 'Blue', 'White', 'Black'] },
    standings: [{ team: 'Red', w: 3, l: 1 }]
  }],
  players: [{ id: 'P0001', name: 'Real SMBHL Player', seasons: { 'Fall 2026': { team: 'Red' } } }]
};

describe('Part I: POST /league/season/publish', () => {
  let leagueA, leagueB, cookieA, cookieB;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.ADMIN_KEY = ADMIN_KEY;

    await applyRealSchema(env);

    // SMBHL's real, existing data — written at the literal 'data_json' key.
    await env.SHEETS_KV.put('data_json', JSON.stringify(SMBHL_REAL_DATA_JSON));

    const a = await signupAndCreateLeague('seasonpub.a@example.com', '203.0.113.251', 'Season Publish League A', ['Otters', 'Falcons']);
    const b = await signupAndCreateLeague('seasonpub.b@example.com', '203.0.113.252', 'Season Publish League B', ['Narwhals', 'Beavers']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    cookieB = b.cookie;
  });

  it('ADMIN_KEY alone, with no valid session, cannot use this route at all', async () => {
    const res = await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST',
      headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ season_name: 'Attempted Season' })
    });
    expect(res.status).toBe(401);

    // And SMBHL's real data really is untouched by the attempt.
    const raw = await env.SHEETS_KV.get('data_json');
    expect(JSON.parse(raw)).toEqual(SMBHL_REAL_DATA_JSON);
  });

  it('an unauthenticated request is rejected', async () => {
    const res = await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ season_name: 'Whatever' })
    });
    expect(res.status).toBe(401);
  });

  it('a session-authenticated league admin can publish their own league\'s initial season, using the team names entered at signup', async () => {
    const res = await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ season_name: 'League A Season 1' })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.league_id).toBe(leagueA);
    expect(json.current_season).toBe('League A Season 1');
    expect(json.teams).toEqual(['Otters', 'Falcons']);
    expect(json.overwritten).toBe(false);

    const raw = await env.SHEETS_KV.get(dataJsonKeyFor(leagueA));
    const stored = JSON.parse(raw);
    expect(stored.current_season).toBe('League A Season 1');
    expect(stored.seasons.length).toBe(1);
    expect(stored.seasons[0].config.teams).toEqual(['Otters', 'Falcons']);
    expect(stored.seasons[0].standings.map(s => s.team)).toEqual(['Otters', 'Falcons']);
  });

  it('this write ONLY touched League A\'s own key -- SMBHL\'s real data_json is provably still exactly what it was (re-running the equality check from prior sessions)', async () => {
    const raw = await env.SHEETS_KV.get('data_json');
    expect(JSON.parse(raw)).toEqual(SMBHL_REAL_DATA_JSON);
  });

  it('and League B\'s key was never touched either -- it still does not exist', async () => {
    const raw = await env.SHEETS_KV.get(dataJsonKeyFor(leagueB));
    expect(raw).toBeNull();
  });

  it('calling it again with the SAME season name overwrites that entry (and re-confirms current_season), rather than rejecting or duplicating', async () => {
    const res = await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ season_name: 'League A Season 1' })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.overwritten).toBe(true);

    const raw = await env.SHEETS_KV.get(dataJsonKeyFor(leagueA));
    const stored = JSON.parse(raw);
    expect(stored.seasons.length).toBe(1); // still just one entry, not duplicated
  });

  it('publishing a DIFFERENT season name adds a new entry alongside the existing one, without erasing it', async () => {
    const res = await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ season_name: 'League A Season 2' })
    });
    expect(res.status).toBe(200);

    const raw = await env.SHEETS_KV.get(dataJsonKeyFor(leagueA));
    const stored = JSON.parse(raw);
    expect(stored.current_season).toBe('League A Season 2');
    const names = stored.seasons.map(s => s.name);
    expect(names).toContain('League A Season 1');
    expect(names).toContain('League A Season 2');
    expect(stored.seasons.length).toBe(2);
  });

  it('League B publishing its own season does not affect League A\'s data, or SMBHL\'s', async () => {
    const res = await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST',
      headers: { cookie: cookieB, 'content-type': 'application/json' },
      body: JSON.stringify({ season_name: 'League B Season 1' })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.teams).toEqual(['Narwhals', 'Beavers']);

    const bRaw = JSON.parse(await env.SHEETS_KV.get(dataJsonKeyFor(leagueB)));
    expect(bRaw.current_season).toBe('League B Season 1');

    const aRaw = JSON.parse(await env.SHEETS_KV.get(dataJsonKeyFor(leagueA)));
    expect(aRaw.current_season).toBe('League A Season 2'); // unchanged by B's publish

    const smbhlRaw = JSON.parse(await env.SHEETS_KV.get('data_json'));
    expect(smbhlRaw).toEqual(SMBHL_REAL_DATA_JSON); // still untouched
  });

  it('rejects a request with no season_name', async () => {
    const res = await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(400);
  });

  it("the full milestone, end to end: sign up -> create league -> publish a season -> see that league's own real season data through a read route (not empty, not SMBHL's)", async () => {
    const c = await signupAndCreateLeague('milestone@example.com', '203.0.113.253', 'Milestone League', ['Sharks', 'Wolves', 'Bears']);

    // Before publishing: genuinely empty, as Part F/G established.
    const beforeRes = await SELF.fetch('http://example.com/admin/teams/data', { headers: { cookie: c.cookie } });
    const before = await beforeRes.json();
    expect(before.current_season).toBeNull();

    // Publish.
    const publishRes = await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST',
      headers: { cookie: c.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ season_name: 'Milestone Season' })
    });
    expect(publishRes.status).toBe(200);

    // After publishing: this league's own real season data, via the same
    // read route -- not empty, not SMBHL's, not another league's.
    const afterRes = await SELF.fetch('http://example.com/admin/teams/data', { headers: { cookie: c.cookie } });
    const after = await afterRes.json();
    expect(after.current_season).toBe('Milestone Season');
    expect(after.league_id).toBe(c.leagueId);
  });
});

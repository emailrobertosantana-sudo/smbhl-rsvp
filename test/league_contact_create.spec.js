// Part J: POST /league/contacts — league-scoped contact creation.
// Session+checkLeagueAccess-gated only, no ADMIN_KEY door. Proves: the
// write is unreachable via ADMIN_KEY-without-session; it only ever writes
// rows tagged with the calling league's own league_id (SMBHL's contacts
// re-verified unchanged after a second league adds one); and basic
// validation (name required, duplicate email within the same league
// rejected).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-league-contact-create-secret';
const ADMIN_KEY = 'test-league-contact-create-admin-key';

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

describe('Part J: POST /league/contacts', () => {
  let leagueA, leagueB, cookieA, cookieB, csrfTokenA, csrfTokenB;
  let smbhlContactsSnapshot;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.ADMIN_KEY = ADMIN_KEY;

    await applyRealSchema(env);

    // SMBHL's real, existing contacts.
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, token_salt) VALUES ('P0001', 'Real SMBHL Player', 'real@smbhl.com', 'roster', 'salt1')`).run();
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, token_salt) VALUES ('P0002', 'Another SMBHL Player', 'real2@smbhl.com', 'roster', 'salt2')`).run();

    const a = await signupAndCreateLeague('contactcreate.a@example.com', '203.0.113.261', 'Contact Create League A', ['Otters', 'Falcons']);
    const b = await signupAndCreateLeague('contactcreate.b@example.com', '203.0.113.262', 'Contact Create League B', ['Narwhals', 'Beavers']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    cookieB = b.cookie;
    csrfTokenA = a.csrfToken;
    csrfTokenB = b.csrfToken;

    smbhlContactsSnapshot = (await env.DB.prepare(
      `SELECT player_id, name, email, role FROM contacts WHERE league_id = 'smbhl' ORDER BY player_id`
    ).all()).results;
  });

  it('ADMIN_KEY alone, with no valid session, cannot use this route at all', async () => {
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Attempted Contact', email: 'attempted@example.com' })
    });
    expect(res.status).toBe(401);
  });

  it('an unauthenticated request is rejected', async () => {
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Whoever Nobody' })
    });
    expect(res.status).toBe(401);
  });

  it('a session-authenticated league admin can add a contact to their own league', async () => {
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ name: 'First Player', email: 'first@leaguea.com', role: 'roster' })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.league_id).toBe(leagueA);
    expect(json.contact.name).toBe('First Player');
    expect(json.contact.player_id).toBe(`${leagueA}:P0001`);

    const row = await env.DB.prepare('SELECT * FROM contacts WHERE player_id = ?').bind(json.contact.player_id).first();
    expect(row.league_id).toBe(leagueA);
    expect(row.email).toBe('first@leaguea.com');
  });

  it('the new contact\'s id is numbered independently per league (League B starts its own counter at P0001 too)', async () => {
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ name: 'League B Player', role: 'roster' })
    });
    const json = await res.json();
    expect(json.contact.player_id).toBe(`${leagueB}:P0001`);
  });

  it('this write ONLY touched League A/B\'s own rows -- SMBHL\'s contacts are provably still exactly what they were', async () => {
    const current = (await env.DB.prepare(
      `SELECT player_id, name, email, role FROM contacts WHERE league_id = 'smbhl' ORDER BY player_id`
    ).all()).results;
    expect(current).toEqual(smbhlContactsSnapshot);
  });

  it('rejects a request with no name', async () => {
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ email: 'noname@example.com' })
    });
    expect(res.status).toBe(400);
  });

  it('rejects a single-word name (first+last required)', async () => {
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ name: 'Madonna' })
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid role', async () => {
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ name: 'Bad Role', role: 'coach' })
    });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate email WITHIN the same league (case-insensitive exact match)', async () => {
    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ name: 'Dupe Original', email: 'DUPE@leaguea.com' })
    });
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ name: 'Dupe Second', email: 'dupe@leaguea.com' })
    });
    expect(res.status).toBe(409);
  });

  it('the SAME email is allowed across DIFFERENT leagues (dedup is scoped to league_id)', async () => {
    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ name: 'Shared Email A', email: 'shared@example.com' })
    });
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ name: 'Shared Email B', email: 'shared@example.com' })
    });
    expect(res.status).toBe(200);
  });

  it('two contacts with no email on file are never treated as duplicates of each other', async () => {
    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ name: 'No Email One' })
    });
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ name: 'No Email Two' })
    });
    expect(res.status).toBe(200);
  });
});

// Live-testing task (batch 2), Part 1: "Team settings save fails:
// Invalid or missing CSRF token" was reported on the live site.
//
// INVESTIGATION (documented per the task's own "flag genuine ambiguity
// rather than guessing" instruction -- no bug was found or fixed here):
// 1. Read handleLeagueUpdateTeams (leagues.js) and submitTeams() (the
//    settings page's own client script, index.js) end to end -- both
//    use the exact same session/CSRF/csrfHeader pattern as every OTHER
//    working save on this page (identity, structure, language mode,
//    reminders), with no difference in header name, cookie name, or
//    check order. No leftover backslash-escape issue either (this path
//    has no regexes/escapes at all, unlike the earlier roster bug).
// 2. Reproduced the full flow against THIS test harness (signup ->
//    create league -> POST /league/settings/teams with the real
//    cookie+header pair a browser would send): succeeds cleanly.
// 3. Reproduced the SAME flow against the LIVE deployed site
//    (notreligue.ca) with a real session, using curl to mirror exactly
//    what a browser sends: also succeeds cleanly (200, team names
//    updated). Fetched the live rendered settings page's actual
//    JavaScript for submitTeams() and confirmed it's byte-for-byte
//    identical to this source file.
// 4. No browser automation was available in this environment (the
//    Claude in Chrome extension is not connected), so a genuinely
//    browser-only cause (a stale cookie in one specific tester's
//    browser from earlier testing sessions, for example) could not be
//    ruled in or out directly.
//
// Given no discrepancy was found between the code, a synthetic test,
// and a live production round trip, this locks in that the mechanism
// itself is sound with real regression coverage -- if this report
// recurs, the next investigation should start from an actual captured
// browser request (headers + cookie value) rather than re-deriving
// this same analysis.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part1-batch2-teams-csrf-secret';

function extractCookie(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(', ');
  const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
  return csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
}
async function signup(email, ip) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  return { cookie: extractCookie(res), csrfToken: extractCsrfToken(res) };
}
async function createLeague(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).league;
}

describe('Part 1 (live-testing task, batch 2): settings-page team save, CSRF mechanism regression coverage', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('saving team names/colours with a real, correctly-paired cookie+header succeeds', async () => {
    const { cookie, csrfToken } = await signup('teams.csrf.happy@example.com', '203.0.161.001');
    await createLeague(cookie, csrfToken, { name: 'Teams CSRF Happy League', teamNames: ['A', 'B'], tracksStats: true });
    const res = await SELF.fetch('http://example.com/league/settings/teams', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ teamNames: ['Alpha', 'Beta'], teamColors: ['#b3122e', '#2a5fa8'] })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.teamNames).toEqual(['Alpha', 'Beta']);
  });

  it('a missing X-CSRF-Token header is correctly rejected (proves the check is actually enforced)', async () => {
    const { cookie, csrfToken } = await signup('teams.csrf.missing@example.com', '203.0.161.002');
    await createLeague(cookie, csrfToken, { name: 'Teams CSRF Missing League', teamNames: ['A', 'B'], tracksStats: true });
    const res = await SELF.fetch('http://example.com/league/settings/teams', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ teamNames: ['Alpha', 'Beta'] })
    });
    expect(res.status).toBe(403);
    expect((await res.json()).errorKey).toBe('CSRF_INVALID');
  });

  it('a stale/wrong CSRF token value is correctly rejected, not silently accepted', async () => {
    const { cookie, csrfToken } = await signup('teams.csrf.wrong@example.com', '203.0.161.003');
    await createLeague(cookie, csrfToken, { name: 'Teams CSRF Wrong League', teamNames: ['A', 'B'], tracksStats: true });
    const res = await SELF.fetch('http://example.com/league/settings/teams', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': 'deadbeef00000000000000000000000' },
      body: JSON.stringify({ teamNames: ['Alpha', 'Beta'] })
    });
    expect(res.status).toBe(403);
    expect((await res.json()).errorKey).toBe('CSRF_INVALID');
  });

  it('works identically for a weekly_draw league (teams are editable there too)', async () => {
    const { cookie, csrfToken } = await signup('teams.csrf.weekly@example.com', '203.0.161.005');
    await createLeague(cookie, csrfToken, { name: 'Teams CSRF Weekly League', teamStructure: 'weekly_draw', teamNames: ['A', 'B'], tracksStats: true });
    const res = await SELF.fetch('http://example.com/league/settings/teams', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ teamNames: ['Rouge', 'Bleu'], teamColors: ['#b3122e', '#2a5fa8'] })
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('a co-admin (invited, not the original creator) can also save teams with their own CSRF token', async () => {
    const owner = await signup('teams.csrf.owner@example.com', '203.0.161.006');
    const league = await createLeague(owner.cookie, owner.csrfToken, { name: 'Teams CSRF CoAdmin League', teamNames: ['A', 'B'], tracksStats: true });
    const inviteRes = await SELF.fetch('http://example.com/league/admins/invite', {
      method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json', 'x-csrf-token': owner.csrfToken },
      body: JSON.stringify({ email: 'teams.csrf.coadmin@example.com' })
    });
    expect(inviteRes.status).toBe(200);
    // The invite-accept flow needs the real emailed token, not directly
    // accessible here -- exercises the equivalent end state instead (a
    // second real admin on the same league, with their own independent
    // session/CSRF pair), which is what this test actually needs to
    // prove: a co-admin's own CSRF token works for this route too.
    const coAdmin = await signup('teams.csrf.coadmin2@example.com', '203.0.161.007');
    const coAdminRow = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind('teams.csrf.coadmin2@example.com').first();
    await env.DB.prepare(`INSERT INTO league_admins (user_id, league_id, role, created_at) VALUES (?, ?, 'admin', ?)`)
      .bind(coAdminRow.id, league.id, new Date().toISOString()).run();
    const res = await SELF.fetch('http://example.com/league/settings/teams', {
      method: 'POST', headers: { cookie: coAdmin.cookie, 'content-type': 'application/json', 'x-csrf-token': coAdmin.csrfToken },
      body: JSON.stringify({ teamNames: ['Alpha', 'Beta'] })
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

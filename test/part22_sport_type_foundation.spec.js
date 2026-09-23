// Part 4 of a live-testing task: add the underlying leagues.sport_type
// column (migrate-028.sql), defaulting to 'hockey' for every league
// including all existing ones -- purely foundational for a future
// task, no signup UI, no behavior change yet. Part 5 (a separate
// migration/commit) builds the actual hockey-specific goalie-axis
// behavior gated on it.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part22-sport-type-secret';

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

describe('Live-testing Part 4: sport_type foundation, silent default', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a freshly created league gets sport_type = hockey with no signup question asked at all', async () => {
    const { cookie, csrfToken } = await signup('sporttype.fresh@example.com', '203.0.125.001');
    const res = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Sport Type Fresh League', teamNames: ['A', 'B'], tracksStats: true })
    });
    const leagueId = (await res.json()).league.id;
    const row = await env.DB.prepare('SELECT sport_type FROM leagues WHERE id = ?').bind(leagueId).first();
    expect(row.sport_type).toBe('hockey');
  });

  it('every team-structure mode gets sport_type = hockey the same way, unaffected by mode', async () => {
    const { cookie, csrfToken } = await signup('sporttype.headcount@example.com', '203.0.125.002');
    const res = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Sport Type Headcount League', tracksStats: true, teamStructure: 'headcount', minPlayers: 4, maxPlayers: 8 })
    });
    const leagueId = (await res.json()).league.id;
    const row = await env.DB.prepare('SELECT sport_type FROM leagues WHERE id = ?').bind(leagueId).first();
    expect(row.sport_type).toBe('hockey');
  });

  it('the signup response/UI never mentions sport_type or asks a sport question', async () => {
    const { cookie } = await signup('sporttype.noui@example.com', '203.0.125.003');
    const step2Html = await (await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie } })).text();
    expect(step2Html.toLowerCase()).not.toContain('sport');
    expect(step2Html.toLowerCase()).not.toContain('hockey');
  });

  it("SMBHL's own bootstrap row also has sport_type = hockey (the same silent default, never asked)", async () => {
    const row = await env.DB.prepare("SELECT sport_type FROM leagues WHERE id = 'smbhl'").first();
    expect(row?.sport_type).toBe('hockey');
  });
});

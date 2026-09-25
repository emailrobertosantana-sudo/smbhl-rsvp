// Live-testing task (batch 5), Part 2: a new league showed "Tracks
// stats: Yes" without a deliberate choice. Investigation found the
// signup wizard DOES ask -- step 2 has a real, visible toggle
// ("Suivre les statistiques?" / "Track stats?", with its own
// description) -- but the toggle's initial state was aria-checked
//="true", so a user who signs up without touching it silently gets
// stats tracking on. The backend's own /leagues/create handler had
// the same silent-on default for any caller that omits the field
// entirely (body.tracksStats !== false).
//
// Decision (per the task's own guidance -- most pickup and
// weekly_draw leagues don't want stats overhead): default OFF at
// both the client toggle's initial state and the backend's fallback.
// The explicit ask itself is unchanged -- a user can still turn it on
// deliberately, and it remains a settings-page toggle away later.
// This is a NEW-league-creation-time default only; an existing
// league's stored tracks_stats value is never touched by this change
// (there is no UPDATE path here, only the INSERT at creation).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part66-tracks-stats-default-secret';

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
async function createLeagueRaw(cookie, csrfToken, body) {
  return SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
}

describe('Part 2 (live-testing task, batch 5): tracksStats no longer defaults on without being asked', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('POST /leagues/create with tracksStats omitted entirely now defaults to OFF (was silently ON before this fix)', async () => {
    const { cookie, csrfToken } = await signup('trackstats.omitted@example.com', '203.0.181.001');
    const res = await createLeagueRaw(cookie, csrfToken, { name: 'Omitted Stats League', teamNames: ['X', 'Y'] });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.league.tracksStats).toBe(false);

    const row = await env.DB.prepare('SELECT tracks_stats FROM leagues WHERE id = ?').bind(body.league.id).first();
    expect(row.tracks_stats).toBe(0);
  });

  it('POST /leagues/create with tracksStats: true still turns it on -- the explicit ask still works', async () => {
    const { cookie, csrfToken } = await signup('trackstats.explicittrue@example.com', '203.0.181.002');
    const res = await createLeagueRaw(cookie, csrfToken, { name: 'Explicit On League', teamNames: ['X', 'Y'], tracksStats: true });
    const body = await res.json();
    expect(body.league.tracksStats).toBe(true);
    const row = await env.DB.prepare('SELECT tracks_stats FROM leagues WHERE id = ?').bind(body.league.id).first();
    expect(row.tracks_stats).toBe(1);
  });

  it('POST /leagues/create with tracksStats: false is explicitly off, same as before', async () => {
    const { cookie, csrfToken } = await signup('trackstats.explicitfalse@example.com', '203.0.181.003');
    const res = await createLeagueRaw(cookie, csrfToken, { name: 'Explicit Off League', teamNames: ['X', 'Y'], tracksStats: false });
    const body = await res.json();
    expect(body.league.tracksStats).toBe(false);
  });

  // B2 bug fix (i18n/onboarding polish task): the signup wizard's own
  // stats toggle (step 2) was removed entirely -- it's asked again
  // during onboarding (the correct, non-duplicated place), so signup
  // itself no longer asks at all. The POST /leagues/create default this
  // describes (OFF when omitted) is what signup step 2 now always
  // sends, unconditionally -- still exercised by every other test in
  // this file, all still passing unmodified.
  it("the signup wizard's own stats toggle (step 2) no longer exists -- removed, not just defaulted off (asked again during onboarding instead)", async () => {
    const { cookie } = await signup('trackstats.step2html@example.com', '203.0.181.005');
    const html = await (await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie } })).text();
    expect(html).not.toContain('id="su_stats_switch"');
    expect(html).not.toContain('data-i18n="lblStats"');
    expect(html).not.toContain('data-i18n="statsHelp"');
  });

  it("an EXISTING league's stored tracksStats value is untouched by this change -- this is a new-league-creation default only", async () => {
    const { cookie, csrfToken } = await signup('trackstats.existing@example.com', '203.0.181.004');
    const created = await (await createLeagueRaw(cookie, csrfToken, { name: 'Existing League Untouched', teamNames: ['X', 'Y'], tracksStats: true })).json();
    expect(created.league.tracksStats).toBe(true);

    // Simulate time passing / other unrelated requests -- re-reading the
    // same league's row must still show the value it was created with,
    // not silently re-defaulted by anything on read.
    const row = await env.DB.prepare('SELECT tracks_stats FROM leagues WHERE id = ?').bind(created.league.id).first();
    expect(row.tracks_stats).toBe(1);
  });
});

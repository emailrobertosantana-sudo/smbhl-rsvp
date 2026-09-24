// Live-testing task (batch 2), Part 11 (BIG): super-admin layer +
// capability flags.
//
// Covered here: (1) the super-admin routes are gated by ADMIN_KEY only --
// a normal league-admin session has no path in. (2) the league list
// endpoint returns every league with metadata. (3) plan tier is
// view/edit-able and persists. (4) the capability-flag mechanism is
// view/edit-able, persists, and every league defaults to every flag
// enabled (unaffected) until a super-admin explicitly overrides one. (5)
// the one real flag built for this task (multi_admin) actually gates
// handleLeagueAdminInvite end to end. (6) SMBHL is listed but otherwise
// unaffected.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part11-super-admin-secret';
const ADMIN_KEY = 'test-part11-admin-key';

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
async function superAdminData() {
  const res = await SELF.fetch('http://example.com/super-admin/leagues/data', { headers: { 'x-admin': ADMIN_KEY } });
  return { status: res.status, body: await res.json() };
}
async function superAdminUpdate(payload) {
  const res = await SELF.fetch('http://example.com/super-admin/leagues/update', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin': ADMIN_KEY },
    body: JSON.stringify(payload)
  });
  return { status: res.status, body: await res.json() };
}

describe('Part 11 (live-testing task, batch 2): super-admin layer + capability flags', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.ADMIN_KEY = ADMIN_KEY;
    await applyRealSchema(env);
  });

  it('the data endpoint rejects an unauthenticated request and a wrong key', async () => {
    const noKey = await SELF.fetch('http://example.com/super-admin/leagues/data');
    expect(noKey.status).toBe(403);
    const wrongKey = await SELF.fetch('http://example.com/super-admin/leagues/data', { headers: { 'x-admin': 'not-the-real-key' } });
    expect(wrongKey.status).toBe(403);
  });

  it('a normal league-admin session (not ADMIN_KEY) has no access to the super-admin data endpoint', async () => {
    const { cookie, csrfToken } = await signup('superadmin.sessioncheck@example.com', '203.0.171.001');
    await createLeague(cookie, csrfToken, { name: 'Session Check League', teamNames: ['A', 'B'], tracksStats: true });
    const res = await SELF.fetch('http://example.com/super-admin/leagues/data', { headers: { cookie } });
    expect(res.status).toBe(403);
  });

  it('the login page renders the key gate when unauthenticated, and the league table shell when authenticated', async () => {
    const unauthed = await (await SELF.fetch('http://example.com/super-admin/leagues')).text();
    expect(unauthed).toContain('id="gate"');
    expect(unauthed).toContain('id="sa-main" style="display:none"');

    const authed = await (await SELF.fetch('http://example.com/super-admin/leagues', { headers: { 'x-admin': ADMIN_KEY } })).text();
    expect(authed).toContain('id="sa-table"');
  });

  it('lists every league with metadata, including SMBHL', async () => {
    const { cookie, csrfToken } = await signup('superadmin.listing@example.com', '203.0.171.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Listing League', teamNames: ['A', 'B'], tracksStats: true });

    const { status, body } = await superAdminData();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const smbhl = body.leagues.find(l => l.id === 'smbhl');
    expect(smbhl).toBeTruthy();
    expect(smbhl.planTier).toBe('gratuit');
    expect(smbhl.flags.multi_admin).toBe(true);

    const listed = body.leagues.find(l => l.id === league.id);
    expect(listed).toBeTruthy();
    expect(listed.name).toBe('Listing League');
    expect(listed.slug).toBe(league.slug);
    expect(listed.adminCount).toBe(1);
    expect(listed.publicPageEnabled).toBe(true);
    expect(listed.deactivatedAt).toBeNull();
    expect(listed.planTier).toBe('gratuit');
    expect(listed.flags.multi_admin).toBe(true);
  });

  it('safety: every league defaults to plan_tier=gratuit and every capability flag enabled -- unaffected', async () => {
    const row = await env.DB.prepare('SELECT plan_tier FROM leagues WHERE id = ?').bind('smbhl').first();
    expect(row.plan_tier).toBe('gratuit');
    const flagRow = await env.DB.prepare('SELECT * FROM league_capability_flags WHERE league_id = ?').bind('smbhl').first();
    expect(flagRow).toBeFalsy();
  });

  it('plan tier can be viewed and edited, persists, and rejects an invalid value', async () => {
    const { cookie, csrfToken } = await signup('superadmin.tier@example.com', '203.0.171.003');
    const league = await createLeague(cookie, csrfToken, { name: 'Tier League', teamNames: ['A', 'B'], tracksStats: true });

    const bad = await superAdminUpdate({ leagueId: league.id, planTier: 'not-a-real-tier' });
    expect(bad.status).toBe(400);
    expect(bad.body.errorKey).toBe('INVALID_PLAN_TIER');

    const good = await superAdminUpdate({ leagueId: league.id, planTier: 'ligue_plus' });
    expect(good.status).toBe(200);
    expect(good.body.ok).toBe(true);

    const { body } = await superAdminData();
    const listed = body.leagues.find(l => l.id === league.id);
    expect(listed.planTier).toBe('ligue_plus');
  });

  it('capability flags can be viewed, edited, and persist -- and an unknown flag key is rejected', async () => {
    const { cookie, csrfToken } = await signup('superadmin.flag@example.com', '203.0.171.004');
    const league = await createLeague(cookie, csrfToken, { name: 'Flag League', teamNames: ['A', 'B'], tracksStats: true });

    const bad = await superAdminUpdate({ leagueId: league.id, flags: { not_a_real_flag: false } });
    expect(bad.status).toBe(400);
    expect(bad.body.errorKey).toBe('INVALID_FLAG');

    const good = await superAdminUpdate({ leagueId: league.id, flags: { multi_admin: false } });
    expect(good.status).toBe(200);

    const { body } = await superAdminData();
    const listed = body.leagues.find(l => l.id === league.id);
    expect(listed.flags.multi_admin).toBe(false);

    const reenable = await superAdminUpdate({ leagueId: league.id, flags: { multi_admin: true } });
    expect(reenable.status).toBe(200);
    const { body: body2 } = await superAdminData();
    expect(body2.leagues.find(l => l.id === league.id).flags.multi_admin).toBe(true);
  });

  it('the multi_admin flag actually gates handleLeagueAdminInvite end to end', async () => {
    const { cookie, csrfToken } = await signup('superadmin.gate.owner@example.com', '203.0.171.005');
    const league = await createLeague(cookie, csrfToken, { name: 'Gate League', teamNames: ['A', 'B'], tracksStats: true });

    // Default (unaffected): inviting a second admin still works before any
    // super-admin override.
    const inviteBefore = await SELF.fetch('http://example.com/league/admins/invite', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ email: 'superadmin.gate.invitee1@example.com' })
    });
    expect(inviteBefore.status).toBe(200);
    expect((await inviteBefore.json()).ok).toBe(true);

    // Super-admin disables multi_admin for this league.
    const disable = await superAdminUpdate({ leagueId: league.id, flags: { multi_admin: false } });
    expect(disable.status).toBe(200);

    // A third admin invite (league already has 2 admins: the creator +
    // the accepted... actually invite alone doesn't create an admin row
    // until accepted, so the league still has 1 real admin -- the block
    // triggers on adminCount >= 1, which is already true for any created
    // league).
    const inviteAfter = await SELF.fetch('http://example.com/league/admins/invite', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ email: 'superadmin.gate.invitee2@example.com' })
    });
    expect(inviteAfter.status).toBe(403);
    expect((await inviteAfter.json()).errorKey).toBe('MULTI_ADMIN_DISABLED');

    // Re-enabling restores the previous, unaffected behavior.
    const reenable = await superAdminUpdate({ leagueId: league.id, flags: { multi_admin: true } });
    expect(reenable.status).toBe(200);
    const inviteRestored = await SELF.fetch('http://example.com/league/admins/invite', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ email: 'superadmin.gate.invitee3@example.com' })
    });
    expect(inviteRestored.status).toBe(200);
  });

  it('updating an unknown league id fails clearly instead of silently no-opping', async () => {
    const res = await superAdminUpdate({ leagueId: 'not-a-real-league-id', planTier: 'solo' });
    expect(res.status).toBe(404);
    expect(res.body.errorKey).toBe('LEAGUE_NOT_FOUND');
  });
});

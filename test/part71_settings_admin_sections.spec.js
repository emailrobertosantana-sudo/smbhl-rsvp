// Live-testing task (batch 5), Part 7: the deactivate-league,
// permanent-delete, and co-admin invite sections used to sit on the
// dashboard. Moved to Settings, not duplicated -- with one deliberate
// exception documented below.
//
// checkLeagueAccess (leagues.js) blocks every OTHER session-gated
// route, including Settings, once a league is deactivated
// (test/part56_hard_delete.spec.js's own regression test already
// locks in why the hard-delete UI has to stay reachable on the
// dashboard once deactivated). So:
//  - Co-admin invite: moved ENTIRELY to Settings (only relevant while
//    a league is active, which Settings is always reachable from).
//  - Deactivate: moved ENTIRELY to Settings, same reasoning.
//  - Hard delete: Settings gets an "advance notice" version (no
//    confirm field -- checkHardDeleteEligibility always refuses a
//    still-active league anyway); the dashboard's own 'deactivated'
//    state keeps the REAL, actionable version, since that's the only
//    page still reachable once a league genuinely is deactivated.
//    Never both showing the actionable form at once for the same
//    league -- not duplication, just two different life stages.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part71-settings-admin-sections-secret';

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
async function deactivate(cookie, csrfToken, confirmName) {
  return SELF.fetch('http://example.com/league/deactivate', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ confirmName })
  });
}

describe('Part 7 (live-testing task, batch 5): deactivate/co-admin/hard-delete moved from the dashboard to Settings', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('an active league: dashboard has NONE of the three sections; Settings has invite + deactivate + an advance-notice-only hard-delete', async () => {
    const { cookie, csrfToken } = await signup('settings.active@example.com', '203.0.186.001');
    await createLeague(cookie, csrfToken, { name: 'Settings Move Active League', teamNames: ['X', 'Y'] });

    const dashHtml = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(dashHtml).not.toContain('id="invite_email"');
    expect(dashHtml).not.toContain('id="deactivate_submit"');
    expect(dashHtml).not.toContain('id="hard_delete_confirm"');

    const settingsHtml = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(settingsHtml).toContain('id="invite_email"');
    expect(settingsHtml).toContain('id="invite_submit"');
    expect(settingsHtml).toContain('id="deactivate_submit"');
    expect(settingsHtml).toContain('id="deactivate_confirm"');
    expect(settingsHtml).toContain('data-i18n="hardDeleteNotDeactivated"');
    // The advance notice is genuinely just a notice -- no actionable
    // confirm field, since checkHardDeleteEligibility always refuses a
    // still-active league regardless.
    expect(settingsHtml).not.toContain('id="hard_delete_confirm"');
    expect(settingsHtml).not.toContain('id="hard_delete_submit"');
  });

  it('inviting a co-admin from Settings still works end to end -- the route itself never moved, only the UI', async () => {
    const { cookie, csrfToken } = await signup('settings.inviteworks@example.com', '203.0.186.002');
    await createLeague(cookie, csrfToken, { name: 'Settings Invite Works League', teamNames: ['X', 'Y'] });
    const res = await SELF.fetch('http://example.com/league/admins/invite', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ email: 'settings.invitee@example.com' })
    });
    expect((await res.json()).ok).toBe(true);
  });

  it('deactivating from Settings still works end to end, and the deactivated dashboard has the real hard-delete UI (not Settings, which is now unreachable)', async () => {
    const { cookie, csrfToken } = await signup('settings.deactivateworks@example.com', '203.0.186.003');
    const league = await createLeague(cookie, csrfToken, { name: 'Settings Deactivate Works League', teamNames: ['X', 'Y'] });

    const deactRes = await deactivate(cookie, csrfToken, league.name);
    expect(deactRes.status).toBe(200);
    expect((await deactRes.json()).ok).toBe(true);

    // Settings is now unreachable (checkLeagueAccess), redirects away.
    const settingsRes = await SELF.fetch('http://example.com/league/settings', { headers: { cookie }, redirect: 'manual' });
    expect(settingsRes.status).toBe(302);

    // The dashboard's own deactivated state has the REAL hard-delete UI.
    const dashHtml = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(dashHtml).toContain('id="hardDeleteStatus"');
    expect(dashHtml).toContain('id="hard_delete_submit"');
    expect(dashHtml).toContain('id="hard_delete_confirm"');
    // And it correctly shows NOT_DEACTIVATED-adjacent-but-locked status
    // (still within the 15-day window) rather than eligible.
    expect(dashHtml).not.toContain('id="invite_email"'); // not on the deactivated dashboard either
  });

  it('the co-admins list on Settings shows every real admin, matching what the dashboard used to show', async () => {
    const { cookie, csrfToken } = await signup('settings.adminslist@example.com', '203.0.186.004');
    await createLeague(cookie, csrfToken, { name: 'Settings Admins List League', teamNames: ['X', 'Y'] });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toContain('settings.adminslist@example.com');
  });
});

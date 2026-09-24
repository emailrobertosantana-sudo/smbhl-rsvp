// Live-testing task (batch 6), Part 7: the dashboard home used to show
// a full "Saisons" management form (season name, per-season structure
// override, roster limits) fully expanded once a season existed --
// disproportionate real estate for a rarely-used action, pushing the
// genuinely important tiles (players, public page, next steps) further
// down the page.
//
// DECISION: moved to Settings (not collapsed in place) -- Settings
// already hosts the closely related "current season teams" and
// "league's default structure" sections, so this keeps every
// season-shaping control in one place rather than splitting it across
// two pages. The dashboard keeps only the read-only "Saison actuelle:
// X" label, now paired with a small "Modifier" link straight to
// Settings -- still one click away, per the task's "keeping it
// reachable" requirement. Settings is also always reachable via the
// tab bar on every league-product page, independent of this link.
import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { extractInlineScripts, assertNoSyntaxError } from './support/inline_scripts.js';
import { applyRealSchema } from './support/real_schema.js';
import { env } from 'cloudflare:test';

const AUTH_SECRET = 'test-part78-dashboard-season-collapsed-secret';

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
async function publishSeason(cookie, csrfToken, seasonName) {
  return SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ season_name: seasonName })
  });
}
async function fetchDashboard(cookie) {
  return (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
}
async function fetchSettings(cookie) {
  return (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
}

describe('Part 7 (live-testing task, batch 6): the dashboard home no longer shows the full season-management form -- it moved to Settings', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a league with a published season: the dashboard shows the read-only season label but none of the season-management form controls', async () => {
    const { cookie, csrfToken } = await signup('dashseason.moved@example.com', '203.0.192.001');
    await createLeague(cookie, csrfToken, { name: 'Dash Season Moved League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, 'S1');

    const html = await fetchDashboard(cookie);
    expect(html).toContain('Saison actuelle');
    expect(html).toContain('<b>S1</b>');
    // The expanded form and its own submit function are gone from this page.
    expect(html).not.toContain('id="season_mgmt_name"');
    expect(html).not.toContain('id="season_structure_radio"');
    expect(html).not.toContain('id="season_mgmt_submit"');
    expect(html).not.toContain('submitSeasonMgmt');
  });

  it('the dashboard still offers a one-click way to reach season management -- a "Modifier" link straight to Settings, right next to the season label', async () => {
    const { cookie, csrfToken } = await signup('dashseason.link@example.com', '203.0.192.002');
    await createLeague(cookie, csrfToken, { name: 'Dash Season Link League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, 'S1');

    const html = await fetchDashboard(cookie);
    expect(html).toContain('href="/league/settings" data-i18n="editSeason"');
  });

  it('Settings now hosts the full season-management form (name, structure override, roster limits), pre-populated from the real league state', async () => {
    const { cookie, csrfToken } = await signup('dashseason.settings@example.com', '203.0.192.003');
    await createLeague(cookie, csrfToken, { name: 'Dash Season Settings League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, 'S1');

    const html = await fetchSettings(cookie);
    expect(html).toContain('id="season_mgmt_name"');
    expect(html).toContain('id="season_structure_radio"');
    expect(html).toContain('id="season_mgmt_submit"');
    expect(html).toContain('onclick="submitSeasonMgmt()"');
    expect(html).toContain('/league/season/publish');
  });

  it('Settings does not show the season-management form before any season has been published -- nothing to manage yet', async () => {
    const { cookie, csrfToken } = await signup('dashseason.noseason@example.com', '203.0.192.004');
    await createLeague(cookie, csrfToken, { name: 'Dash Season No Season League', teamNames: ['A', 'B'] });

    const html = await fetchSettings(cookie);
    expect(html).not.toContain('id="season_mgmt_name"');
  });

  it('a league that still needs its first season: the dashboard keeps its own "start a season" prompt unchanged -- distinct from the moved management form', async () => {
    const { cookie, csrfToken } = await signup('dashseason.needsseason@example.com', '203.0.192.005');
    await createLeague(cookie, csrfToken, { name: 'Dash Season Needs Season League', teamNames: ['A', 'B'] });

    const html = await fetchDashboard(cookie);
    expect(html).toContain('id="season_name"');
    expect(html).toContain('id="season_submit"');
    expect(html).toContain('onclick="submitSeason()"');
    // The needs-season prompt has no "Modifier" link -- there's no
    // existing season yet for it to point at.
    expect(html).not.toContain('data-i18n="editSeason"');
  });

  it('renaming/overriding the current season from its new home (Settings) still genuinely works end-to-end -- same route, same payload shape as before the move', async () => {
    const { cookie, csrfToken } = await signup('dashseason.functional@example.com', '203.0.192.006');
    await createLeague(cookie, csrfToken, { name: 'Dash Season Functional League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, 'S1');

    // Same route the moved form's submitSeasonMgmt() posts to --
    // re-submitting the current season's own name edits it in place.
    const res = await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'S1', team_structure: 'weekly_draw', min_players: 6, max_players: 10 })
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.team_structure).toBe('weekly_draw');
  });

  it('inline scripts on both pages stay syntactically valid after the move', async () => {
    const { cookie, csrfToken } = await signup('dashseason.scripts@example.com', '203.0.192.007');
    await createLeague(cookie, csrfToken, { name: 'Dash Season Scripts League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, 'S1');

    const dashHtml = await fetchDashboard(cookie);
    const settingsHtml = await fetchSettings(cookie);
    for (const html of [dashHtml, settingsHtml]) {
      const scripts = extractInlineScripts(html);
      expect(scripts.length).toBeGreaterThan(0);
      assertNoSyntaxError(scripts);
    }
  });
});

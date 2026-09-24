// Live-testing task (batch 2), Part 5: the dashboard's team-count stat
// tile overline read "Équipes (par match)" / "Teams (per game)" for a
// weekly_draw league -- easy to misread as "how many teams play in
// each match" rather than the intended "teams are formed fresh per
// match, not permanent." Rewritten to reuse the exact phrase the
// structure-picker itself already uses for this same concept
// (structureWeeklyTitle: "Équipes qui changent" / "Teams shuffle"),
// for consistency and genuine clarity.
//
// SUPERSEDED (batch 5, Part 5): "Équipes qui changent" over a bare
// number still didn't say WHEN teams change, so the pairing read as
// unrelated rather than "2 nouvelles équipes, chaque match". Reworded
// again, to "Nouvelles équipes chaque match" / "Fresh teams every
// game" -- reusing weeklyDrawTeamsDesc's own established wording for
// this identical concept. The ORIGINAL lesson from this file still
// holds and is still enforced below: never revert to a bare
// "(par match)"/"(per game)" qualifier with no verb, since that
// specific form is what read as a team COUNT per game rather than
// teams being reformed.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part5-batch2-teams-per-game-label-secret';

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

describe('Part 5 (live-testing task, batch 2): dashboard team-count label is clear for every structure', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('weekly_draw: the overline reuses "Nouvelles équipes chaque match" (batch 5\'s reword), never the old ambiguous "(par match)" form', async () => {
    const { cookie, csrfToken } = await signup('teamlabel.weekly@example.com', '203.0.165.001');
    await createLeague(cookie, csrfToken, { name: 'Team Label Weekly League', teamStructure: 'weekly_draw', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="teamsPerGame"');
    expect(html).toContain('Nouvelles équipes chaque match');
    expect(html).not.toContain('Équipes (par match)');
  });

  it('fixed: the overline is the plain, unambiguous "Équipes"', async () => {
    const { cookie, csrfToken } = await signup('teamlabel.fixed@example.com', '203.0.165.002');
    await createLeague(cookie, csrfToken, { name: 'Team Label Fixed League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="teams">Équipes<');
  });

  it('headcount: the value itself already reads clearly ("Aucune équipe fixe"), unaffected by this change', async () => {
    const { cookie, csrfToken } = await signup('teamlabel.headcount@example.com', '203.0.165.003');
    await createLeague(cookie, csrfToken, { name: 'Team Label Headcount League', teamStructure: 'headcount', minPlayers: 6, maxPlayers: 12, tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="noFixedTeams">Aucune équipe fixe');
  });
});

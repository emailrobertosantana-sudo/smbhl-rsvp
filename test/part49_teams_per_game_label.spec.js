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
// this identical concept.
//
// SUPERSEDED AGAIN (B2, stale-copy polish task): the structure-picker
// itself changed its own wording for this option ("Équipes qui
// changent"/"Teams shuffle" -- jargon -- became "Sans équipes fixes"/
// "Pickup with teams"), and this tile is explicitly meant to keep
// reusing that exact phrase (see its own comment, handleDashboardPage).
// This is a DELIBERATE, task-directed supersession, not a reversion to
// the original ambiguous "(par match)"/"(per game)" form the two
// entries above were about -- that specific lesson (never a bare
// qualifier with no verb) still holds and is still checked below.
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
// B1 bug fix (dashboard/schedule/events polish task): the team-count
// tile this file locks the wording of is now hidden entirely before a
// season exists (it described nothing real pre-season -- "Fresh teams
// every game / 2" -- see handleDashboardPage's own comment). This
// file's own purpose -- the WORDING is never reverted -- is unaffected
// by that; every test here now publishes a season first, so the tile
// is actually showing when its text is checked, same as it always was
// once a league is genuinely in use.
async function publishSeason(cookie, csrfToken, seasonName) {
  return SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ season_name: seasonName })
  });
}

describe('Part 5 (live-testing task, batch 2): dashboard team-count label is clear for every structure', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('weekly_draw: the overline reuses "Sans équipes fixes" (B2\'s reword, matching the structure-picker\'s own current wording), never the old ambiguous "(par match)" form', async () => {
    const { cookie, csrfToken } = await signup('teamlabel.weekly@example.com', '203.0.165.001');
    await createLeague(cookie, csrfToken, { name: 'Team Label Weekly League', teamStructure: 'weekly_draw', teamNames: ['A', 'B'], tracksStats: true });
    await publishSeason(cookie, csrfToken, 'Team Label Weekly Season');
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="teamsPerGame"');
    expect(html).toContain('Sans équipes fixes');
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
    await publishSeason(cookie, csrfToken, 'Team Label Headcount Season');
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="noFixedTeams">Aucune équipe fixe');
  });

  // B1 bug fix (dashboard/schedule/events polish task): before a
  // season exists, this tile (and the "Players" tile, and the "2
  // teams · 0 players" header line) described nothing real -- just the
  // league's own static signup-time config, not an actual season in
  // progress. Hidden entirely pre-season; the Getting Started checklist
  // and next-step card carry the screen instead. The wording itself
  // (locked above, for the post-season case) is completely untouched --
  // this only proves the tile doesn't show too early.
  it('B1: the team-count and player-count tiles (and the header count line) are hidden entirely before a season exists', async () => {
    const { cookie, csrfToken } = await signup('teamlabel.needsseason@example.com', '203.0.165.004');
    await createLeague(cookie, csrfToken, { name: 'Team Label Needs Season League', teamStructure: 'weekly_draw', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).not.toContain('data-i18n="teamsPerGame"');
    // Note: the "Équipes" TEAM-NAMES section further down the page
    // (unaffected by this fix -- team names are real, permanent league
    // config, meaningful regardless of season state) reuses the SAME
    // data-i18n="teams" key for its own heading, so that exact key
    // isn't a safe marker for "the tile is gone" on its own.
    expect(html).not.toContain('<span data-i18n="teamsLabel">');
    expect(html).not.toContain('<span data-i18n="playersLabel">');
    // The Getting Started checklist is what carries the screen instead.
    expect(html).toContain('data-i18n="checklistTitle"');
  });
});

// Live-testing task (batch 5), Part 5: the dashboard's weekly_draw
// team tile showed "TEAMS SHUFFLE" (an overline label, uppercase only
// via CSS text-transform) directly above a bare number ("2"), reading
// as two unrelated pieces of text rather than "2 teams, reformed
// every game" -- it never said WHEN teams change. Reworded to "Fresh
// teams every game" (EN) / "Nouvelles équipes chaque match" (FR),
// which pairs naturally with the number below it -- matching the same
// overline-over-big-number pattern this dashboard uses for its
// "Joueurs"/player-count tile, and reusing weeklyDrawTeamsDesc's own
// established wording for this identical concept.
//
// NOTE: an earlier task (batch 2, Part 5 -- see
// test/part49_teams_per_game_label.spec.js) already tried and
// deliberately rejected "Équipes (par match)" for this same tile: it
// read as "how many teams per game" (a count) rather than "these
// teams get reformed" (an action). This reword avoids that exact trap
// by leading with "Nouvelles" (new/fresh), which inherently signals
// reformation the way a bare "(per game)" qualifier never did --
// part49's own regression test was updated to match this wording and
// still guards against reverting to the original ambiguous form.
//
// Checked (per the task's own instruction) whether this label reads
// sensibly for every team_structure mode: it turns out this exact
// key/tile ONLY ever renders for weekly_draw leagues -- fixed and
// headcount leagues use a different, already-clear label ("Équipes"/
// "Teams", generic) paired with either the real team count (fixed) or
// "No fixed teams" text (headcount). Neither of those needed a
// reword; only the weekly_draw-specific wording was the reported bug.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { buildDashI18n } from '../src';

const AUTH_SECRET = 'test-part69-teams-shuffle-label-secret';

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
// B1 bug fix (dashboard/schedule/events polish task): this tile is now
// hidden entirely before a season exists (see part49's own version of
// this same comment). Every test here now publishes a season first.
async function publishSeason(cookie, csrfToken, seasonName) {
  return SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ season_name: seasonName })
  });
}

describe('Part 5 (live-testing task, batch 5): the weekly_draw team-count tile label is now clear', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('buildDashI18n: teamsPerGame no longer says "shuffle" in isolation, and never reverts to the previously-rejected "(par match)" form', () => {
    const { fr, en } = buildDashI18n({ state: 'active', needsSeason: false, leagueName: 'Shuffle League' });
    expect(fr.teamsPerGame).toBe('Nouvelles équipes chaque match');
    expect(en.teamsPerGame).toBe('Fresh teams every game');
    expect(en.teamsPerGame.toLowerCase()).not.toContain('shuffle');
    expect(fr.teamsPerGame).not.toContain('(par match)');
    expect(en.teamsPerGame).not.toContain('(per game)');
  });

  it('a weekly_draw league\'s dashboard renders the new label next to its real team count', async () => {
    const { cookie, csrfToken } = await signup('shufflelabel.weekly@example.com', '203.0.184.001');
    await createLeague(cookie, csrfToken, { name: 'Weekly Shuffle League', teamNames: ['A', 'B'], teamStructure: 'weekly_draw' });
    await publishSeason(cookie, csrfToken, 'Weekly Shuffle Season');
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="teamsPerGame">Nouvelles équipes chaque match<');
    expect(html).not.toContain('Équipes (par match)');
  });

  it('a fixed-structure league\'s dashboard is untouched -- still the plain, already-clear "Équipes" label', async () => {
    const { cookie, csrfToken } = await signup('shufflelabel.fixed@example.com', '203.0.184.002');
    await createLeague(cookie, csrfToken, { name: 'Fixed Structure League', teamNames: ['A', 'B'], teamStructure: 'fixed' });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="teams">Équipes<');
    // The dashboard's own [data-i18n] SWAP block never picks
    // "teamsPerGame" for this element -- only that it's a valid key IN
    // the embedded dict (buildDashI18n's active-state dict isn't
    // itself scoped by team_structure) doesn't mean this element uses
    // it as its OWN data-i18n attribute value.
    expect(html).not.toContain('data-i18n="teamsPerGame"');
  });

  it('a headcount league\'s dashboard is untouched -- still "Équipes" + "Aucune équipe fixe", never the weekly_draw tile at all', async () => {
    const { cookie, csrfToken } = await signup('shufflelabel.headcount@example.com', '203.0.184.003');
    await createLeague(cookie, csrfToken, { name: 'Headcount League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 20 });
    await publishSeason(cookie, csrfToken, 'Headcount Season');
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="teams">Équipes<');
    expect(html).toContain('data-i18n="noFixedTeams">Aucune équipe fixe<');
    expect(html).not.toContain('data-i18n="teamsPerGame"');
  });
});

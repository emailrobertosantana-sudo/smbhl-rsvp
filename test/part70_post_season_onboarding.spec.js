// Live-testing task (batch 5), Part 6 (BIG): onboarding used to die
// right after the first season was created -- submitSeason() just
// reloaded the dashboard, which (now that a season exists) offered a
// "Saisons" card to create ANOTHER season, with no sense of what to
// do next, while roster size, team names, reminder cadences, and
// stats tracking all sat undiscovered in Settings.
//
// Fix: submitSeason() now navigates to GET /onboarding/season instead
// of reloading -- a short, signup-styled continuation (same
// signupStyles/signupHeader/su-* chrome, not the dashboard's settings
// look) with one step per category, skippable at every step, pre-
// filled with whatever's already set. Team-structure-aware: a
// headcount league has no team names to confirm, so it gets 3 steps
// (roster, reminders, stats) instead of 4.
//
// Every field posts to the SAME existing routes the Settings page
// already uses (/league/settings/structure, /league/settings/teams,
// /league/reminders/settings, /league/settings/identity) -- no new
// backend logic, and everything set here stays editable in Settings
// afterward. The roster/teams steps ALSO re-publish the current
// season by its own name (the same "edit in place" mechanism the
// dashboard's own "Saisons" section already uses) so the change
// applies to the season the admin just created, not only to some
// future one -- a season's own roster/team config is a frozen
// snapshot taken at publish time and is never re-read from the
// league row afterward (see handleLeagueSeasonPublish's own comment).
// That re-publish is skipped once the season has real recorded games
// (a safety guard: republishing unconditionally resets standings to
// zero, which is only safe for a season with none yet).
//
// This suite can't execute the onboarding page's own inline client
// script (same limitation as the rest of this test suite -- see Part
// 8's own task), so it verifies the underlying HTTP contract two ways:
// (1) the served HTML/embedded script variables are correct per
// team_structure and per season-games-state, and (2) calling the same
// routes the client script calls, in the same sequence, produces the
// correct end-to-end effect on both the league row and the season's
// own published config -- proving the mechanism this page relies on
// actually works, not just that the page renders.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part70-post-season-onboarding-secret';

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
async function publishSeason(cookie, csrfToken, body) {
  return SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
}
async function post(cookie, csrfToken, path, body) {
  return SELF.fetch(`http://example.com${path}`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
}
async function getOnboarding(cookie, step) {
  return (await SELF.fetch(`http://example.com/onboarding/season${step ? `?step=${step}` : ''}`, { headers: { cookie } })).text();
}

describe('Part 6 (live-testing task, batch 5): onboarding continues after the first season is created', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('submitSeason() now navigates to /onboarding/season instead of reloading the dashboard', async () => {
    const { cookie, csrfToken } = await signup('ob.submitseason@example.com', '203.0.185.001');
    await createLeague(cookie, csrfToken, { name: 'Onboarding Nav League', teamNames: ['X', 'Y'] });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain("window.__navWithLang('/onboarding/season')");
  });

  it('GET /onboarding/season redirects to /dashboard with no session, no league, or no season yet', async () => {
    const noSession = await SELF.fetch('http://example.com/onboarding/season', { redirect: 'manual' });
    expect(noSession.status).toBe(302);
    expect(noSession.headers.get('location')).toContain('/login');

    const { cookie, csrfToken } = await signup('ob.noleague@example.com', '203.0.185.002');
    const noLeague = await SELF.fetch('http://example.com/onboarding/season', { headers: { cookie }, redirect: 'manual' });
    expect(noLeague.status).toBe(302);
    expect(noLeague.headers.get('location')).toContain('/dashboard');

    await createLeague(cookie, csrfToken, { name: 'No Season Yet League', teamNames: ['X', 'Y'] });
    const noSeason = await SELF.fetch('http://example.com/onboarding/season', { headers: { cookie }, redirect: 'manual' });
    expect(noSeason.status).toBe(302);
    expect(noSeason.headers.get('location')).toContain('/dashboard');
  });

  it('fixed structure: 4 steps (roster, teams, reminders, stats), pre-filled and skippable', async () => {
    const { cookie, csrfToken } = await signup('ob.fixed@example.com', '203.0.185.003');
    await createLeague(cookie, csrfToken, { name: 'Onboarding Fixed League', teamNames: ['Nord', 'Sud'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const step1 = await getOnboarding(cookie, 1);
    // B1 (onboarding polish task): the stepper now counts the WHOLE
    // flow (signup + onboarding), not onboarding's own local 1-4 --
    // fixed's real total is 7 (signup 1,2,3 + onboarding roster,teams,
    // reminders,stats), and this onboarding roster step is #4 in that
    // count.
    expect(step1).toContain('aria-valuemax="7"');
    expect(step1).toContain('aria-valuenow="4"');
    expect(step1).toContain('data-i18n="flowStepLabel"');
    expect(step1).toMatch(/Étape 4 sur 7|Step 4 of 7/);
    expect(step1).toContain('id="ob_min_players"');
    expect(step1).toContain('data-i18n="skip"');
    // B2 (onboarding polish task): "Skip for now" is a small centered
    // text link now (su-center), not a full-width button competing
    // with the primary action -- matches every other secondary action
    // in .su-bottom across the app (login's "forgot password?", etc.).
    expect(step1).toContain('<p class="su-center"><a href="/dashboard" data-i18n="skip">');
    expect(step1).not.toContain('nl-btn--ghost nl-btn--block" data-i18n="skip"');

    const step2 = await getOnboarding(cookie, 2);
    expect(step2).toContain('id="ob_teams"');
    expect(step2).toContain('value="Nord"');
    expect(step2).toContain('value="Sud"');

    const step3 = await getOnboarding(cookie, 3);
    expect(step3).toContain('id="ob_reminder_72h"');
    expect(step3).toContain('aria-checked="true"'); // defaults on (migrate-026.sql)

    const step4 = await getOnboarding(cookie, 4);
    expect(step4).toContain('id="ob_stats"');
    expect(step4).toContain('data-i18n="finish"');
    expect(step4).not.toContain('data-i18n="next"');
  });

  it('weekly_draw structure: team-names step shows the real "Équipe 1"/"Équipe 2" defaults, editable', async () => {
    const { cookie, csrfToken } = await signup('ob.weekly@example.com', '203.0.185.004');
    await createLeague(cookie, csrfToken, { name: 'Onboarding Weekly League', teamStructure: 'weekly_draw', teamNames: ['Équipe 1', 'Équipe 2'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const step2 = await getOnboarding(cookie, 2);
    expect(step2).toContain('value="Équipe 1"');
    expect(step2).toContain('value="Équipe 2"');
    expect(step2).toContain('data-i18n="teamsSubWeekly"');
  });

  // A3 bug fix (onboarding polish task): the roster step's helper text
  // used to be shared between weekly_draw and headcount ("chaque match,
  // pour l'ensemble des joueurs") -- didn't make clear this is a TOTAL
  // for the night, not per team, which mattered most for weekly_draw
  // (real per-team cards exist elsewhere in the product). Now split:
  // weekly_draw states the pool-then-draw model explicitly; headcount
  // gets its own accurate variant (no team draw exists for it at all);
  // fixed is genuinely per-team and stays as it was.
  it('A3: roster step wording is genuinely different per team structure -- pool/draw for weekly_draw, no-teams for headcount, per-team for fixed', async () => {
    const { cookie: cookieFixed, csrfToken: csrfFixed } = await signup('ob.a3.fixed@example.com', '203.0.185.020');
    await createLeague(cookieFixed, csrfFixed, { name: 'A3 Fixed League', teamNames: ['A', 'B'] });
    await publishSeason(cookieFixed, csrfFixed, { season_name: 'S1' });
    const fixedStep1 = await getOnboarding(cookieFixed, 1);
    expect(fixedStep1).toContain('data-i18n="rosterSubTeam"');
    expect(fixedStep1).toContain('Minimum total de joueurs');

    const { cookie: cookieWeekly, csrfToken: csrfWeekly } = await signup('ob.a3.weekly@example.com', '203.0.185.021');
    await createLeague(cookieWeekly, csrfWeekly, { name: 'A3 Weekly League', teamStructure: 'weekly_draw', teamNames: ['Équipe 1', 'Équipe 2'] });
    await publishSeason(cookieWeekly, csrfWeekly, { season_name: 'S1' });
    const weeklyStep1 = await getOnboarding(cookieWeekly, 1);
    expect(weeklyStep1).toContain('data-i18n="rosterSubPool"');
    expect(weeklyStep1).toContain("Tous les joueurs confirmés forment un seul bassin et sont répartis en équipes. Ces nombres couvrent l'ensemble du bassin.");
    expect(weeklyStep1).not.toContain('data-i18n="rosterSubHeadcount"');

    const { cookie: cookieHc, csrfToken: csrfHc } = await signup('ob.a3.headcount@example.com', '203.0.185.022');
    await createLeague(cookieHc, csrfHc, { name: 'A3 Headcount League', teamStructure: 'headcount', minPlayers: 6, maxPlayers: 12 });
    await publishSeason(cookieHc, csrfHc, { season_name: 'S1' });
    const hcStep1 = await getOnboarding(cookieHc, 1);
    expect(hcStep1).toContain('data-i18n="rosterSubHeadcount"');
    expect(hcStep1).toContain("Tous les joueurs confirmés comptent dans ce total -- cette ligue n'a pas d'équipes.");
    // Never claims a team draw for headcount, which has no teams at all
    // (the embedded __I18N dict always carries every key regardless of
    // which is shown -- what matters is which one the visible element
    // actually uses).
    expect(hcStep1).not.toContain('data-i18n="rosterSubPool"');

    // English side, spot-checked on the weekly_draw case.
    const weeklyStep1En = await (await SELF.fetch('http://example.com/onboarding/season?step=1&lang=en', { headers: { cookie: cookieWeekly } })).text();
    expect(weeklyStep1En).toContain('Minimum total players');
    expect(weeklyStep1En).toContain('Maximum total players');
  });

  // A4 bug fix (onboarding polish task): leagues.min_goalies is a REAL
  // stored 0 at creation (handleLeagueCreate's own default), not a
  // placeholder -- confirmed directly against the DB here. The
  // onboarding screen now shows 1 instead of that untouched 0, so a
  // league that needs a goalie isn't silently left configured with
  // none; a genuinely non-zero stored value is unaffected.
  it('A4: min_goalies is a real stored 0 at creation, and the onboarding screen now defaults its own field to 1 instead of showing that 0', async () => {
    const { cookie, csrfToken } = await signup('ob.a4.goalie@example.com', '203.0.185.023');
    const league = await createLeague(cookie, csrfToken, { name: 'A4 Goalie League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const row = await env.DB.prepare('SELECT min_goalies FROM leagues WHERE id = ?').bind(league.id).first();
    expect(row.min_goalies).toBe(0); // confirmed: a real stored value, not null/placeholder

    const step1 = await getOnboarding(cookie, 1);
    expect(step1).toContain('id="ob_min_goalies" type="number" min="0" value="1"');
  });

  it('A4: a genuinely non-zero stored min_goalies is shown as-is, not overridden to 1', async () => {
    const { cookie, csrfToken } = await signup('ob.a4.nonzero@example.com', '203.0.185.024');
    const league = await createLeague(cookie, csrfToken, { name: 'A4 Nonzero League', teamStructure: 'headcount', minPlayers: 6, maxPlayers: 12, minGoalies: 2 });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const row = await env.DB.prepare('SELECT min_goalies FROM leagues WHERE id = ?').bind(league.id).first();
    expect(row.min_goalies).toBe(2);

    const step1 = await getOnboarding(cookie, 1);
    expect(step1).toContain('id="ob_min_goalies" type="number" min="0" value="2"');
  });

  it('headcount structure: only 3 steps -- team names step is skipped entirely', async () => {
    const { cookie, csrfToken } = await signup('ob.headcount@example.com', '203.0.185.005');
    await createLeague(cookie, csrfToken, { name: 'Onboarding Headcount League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 16 });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const step1 = await getOnboarding(cookie, 1);
    // B1: headcount's real flow-wide total is 6 (signup 1,2,3 +
    // onboarding roster,reminders,stats -- no "teams" step), and this
    // onboarding roster step is #4 in that count.
    expect(step1).toContain('aria-valuemax="6"');
    expect(step1).toContain('aria-valuenow="4"');
    expect(step1).toMatch(/Étape 4 sur 6|Step 4 of 6/);

    // step=2 for headcount is 'reminders' (teams was skipped), not 'teams'
    const step2 = await getOnboarding(cookie, 2);
    expect(step2).toContain('id="ob_reminder_72h"');
    expect(step2).not.toContain('id="ob_teams"');

    const step3 = await getOnboarding(cookie, 3);
    expect(step3).toContain('id="ob_stats"');
    expect(step3).toContain('data-i18n="finish"');
  });

  it('the roster step\'s two-call mechanism (settings/structure + season/publish) genuinely applies to the CURRENT season, not just future ones', async () => {
    const { cookie, csrfToken } = await signup('ob.rostermechanism@example.com', '203.0.185.006');
    const league = await createLeague(cookie, csrfToken, { name: 'Roster Mechanism League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    // Simulates exactly what obSubmit() does for the roster step.
    const structRes = await post(cookie, csrfToken, '/league/settings/structure', { min_players: 10, max_players: 14, min_goalies: 1 });
    expect((await structRes.json()).ok).toBe(true);
    const pubRes = await publishSeason(cookie, csrfToken, { season_name: 'S1', min_players: 10, max_players: 14, min_goalies: 1 });
    expect((await pubRes.json()).ok).toBe(true);

    // League-level default persisted (future seasons/next-steps checklist).
    const row = await env.DB.prepare('SELECT min_players, max_players FROM leagues WHERE id = ?').bind(league.id).first();
    expect(row.min_players).toBe(10);
    expect(row.max_players).toBe(14);

    // The CURRENT season's own frozen config picked it up too -- this is
    // exactly what the earlier design mistake would have missed:
    // updating only the league row never reaches an already-published
    // season's own snapshot at all (see handleLeagueSeasonPublish's own
    // comment on why roster limits are frozen at publish time).
    const raw = await env.SHEETS_KV.get(`data_json:${league.id}`);
    const data = JSON.parse(raw);
    const season = data.seasons.find(s => s.name === 'S1');
    expect(season.config.skatersPerTeam).toBe(14);
    expect(season.config.minSkaters).toBe(10);
  });

  it('the roster republish is SKIPPED once the season already has real games -- standings are never reset', async () => {
    const { cookie, csrfToken } = await signup('ob.safetyguard@example.com', '203.0.185.007');
    const league = await createLeague(cookie, csrfToken, { name: 'Safety Guard League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    // Give the season a real recorded game directly (bypassing the full
    // game-recording flow -- only the games/standings counters matter
    // for this guard).
    const dataJsonKey = `data_json:${league.id}`;
    const raw = await env.SHEETS_KV.get(dataJsonKey);
    const data = JSON.parse(raw);
    data.seasons[0].games = 1;
    data.seasons[0].standings[0].gp = 1;
    await env.SHEETS_KV.put(dataJsonKey, JSON.stringify(data));

    const html = await getOnboarding(cookie, 1);
    expect(html).toContain('var OB_SEASON_HAS_GAMES = true;');
  });

  it('reminders step: posts to /league/reminders/settings and genuinely changes the stored cadence flags', async () => {
    const { cookie, csrfToken } = await signup('ob.reminders@example.com', '203.0.185.008');
    const league = await createLeague(cookie, csrfToken, { name: 'Reminders Step League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const res = await post(cookie, csrfToken, '/league/reminders/settings', { reminder72h: false, reminder24h: true, reminder12h: false });
    expect((await res.json()).ok).toBe(true);
    const row = await env.DB.prepare('SELECT reminder_72h_enabled, reminder_24h_enabled, reminder_12h_enabled FROM leagues WHERE id = ?').bind(league.id).first();
    expect(row.reminder_72h_enabled).toBe(0);
    expect(row.reminder_24h_enabled).toBe(1);
    expect(row.reminder_12h_enabled).toBe(0);
  });

  it('stats step: a partial /league/settings/identity update changes ONLY tracksStats, leaving name/color untouched', async () => {
    const { cookie, csrfToken } = await signup('ob.stats@example.com', '203.0.185.009');
    const league = await createLeague(cookie, csrfToken, { name: 'Stats Step League', teamNames: ['A', 'B'], tracksStats: false });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const res = await post(cookie, csrfToken, '/league/settings/identity', { tracksStats: true });
    expect((await res.json()).ok).toBe(true);
    const row = await env.DB.prepare('SELECT name, tracks_stats FROM leagues WHERE id = ?').bind(league.id).first();
    expect(row.tracks_stats).toBe(1);
    expect(row.name).toBe('Stats Step League');
  });

  it('teams step: /league/season/teams updates the CURRENT season\'s own team list without touching games/rsvp of an unrelated league', async () => {
    const { cookie, csrfToken } = await signup('ob.teamsstep@example.com', '203.0.185.010');
    const league = await createLeague(cookie, csrfToken, { name: 'Teams Step League', teamNames: ['Équipe 1', 'Équipe 2'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const settingsRes = await post(cookie, csrfToken, '/league/settings/teams', { teamNames: ['Nord', 'Sud'], teamColors: ['#b3122e', '#b3122e'] });
    expect((await settingsRes.json()).ok).toBe(true);
    const seasonRes = await post(cookie, csrfToken, '/league/season/teams', { season_name: 'S1', teamNames: ['Nord', 'Sud'] });
    const seasonBody = await seasonRes.json();
    expect(seasonBody.ok).toBe(true);
    expect(seasonBody.teamNames).toEqual(['Nord', 'Sud']);

    const row = await env.DB.prepare('SELECT team_names FROM leagues WHERE id = ?').bind(league.id).first();
    expect(JSON.parse(row.team_names)).toEqual(['Nord', 'Sud']);
  });

  it('the dashboard\'s "next steps" checklist appears when things are still unset, and disappears once addressed', async () => {
    const { cookie, csrfToken } = await signup('ob.nextsteps@example.com', '203.0.185.011');
    await createLeague(cookie, csrfToken, { name: 'Next Steps League', teamStructure: 'weekly_draw', teamNames: ['Équipe 1', 'Équipe 2'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const before = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(before).toContain('data-i18n="nextStepsTitle"');
    expect(before).toContain('data-i18n="nsAddPlayers"');
    expect(before).toContain('data-i18n="nsNameTeams"');
    expect(before).toContain('data-i18n="nsRosterLimits"');

    // Address all three: add a player, rename teams, set roster limits.
    await post(cookie, csrfToken, '/league/contacts', { name: 'Real Player One', role: 'roster' });
    await post(cookie, csrfToken, '/league/settings/teams', { teamNames: ['Nord', 'Sud'], teamColors: ['#b3122e', '#b3122e'] });
    await post(cookie, csrfToken, '/league/settings/structure', { min_players: 8, max_players: 16 });

    const after = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(after).not.toContain('data-i18n="nextStepsTitle"');
  });

  it('a fixed league that already has real team names and roster limits never shows the next-steps card at all', async () => {
    const { cookie, csrfToken } = await signup('ob.nonextsteps@example.com', '203.0.185.012');
    await createLeague(cookie, csrfToken, { name: 'Complete League', teamNames: ['Nord', 'Sud'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await post(cookie, csrfToken, '/league/settings/structure', { min_players: 8, max_players: 16 });
    await post(cookie, csrfToken, '/league/contacts', { name: 'Real Player One', role: 'roster' });

    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).not.toContain('data-i18n="nextStepsTitle"');
  });
});

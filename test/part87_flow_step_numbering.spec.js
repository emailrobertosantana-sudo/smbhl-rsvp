// B1 (onboarding/signup polish task): signup used to always claim
// "STEP n OF 3" regardless of team structure -- weekly_draw skips
// signup's own step 3 entirely (submitStep2 creates the league and
// jumps straight to done), so a weekly_draw signup showed "Step 1 of
// 3" then "Step 2 of 3" and the league was created with no step 3
// ever appearing. Onboarding's own 3-4 screens had a progress bar
// (dots) but no step NUMBER text at all.
//
// Fix: ONE continuous count spanning the whole journey, signup step 1
// through onboarding's last screen (stats) -- the done screen stays
// uncounted (never had a stepper, a one-off confirmation not a form
// step). Total varies by team structure, only known once chosen on
// step 2:
//   fixed:       signup 1,2,3 + onboarding roster,teams,playoffs,reminders,stats = 8
//   headcount:   signup 1,2,3 + onboarding roster,reminders,stats                = 6
//   weekly_draw: signup 1,2   + onboarding roster,teams,reminders,stats          = 6
// Steps 1/2 (structure not chosen yet) show the pre-selected 'fixed'
// structure's total (8) as the honest current best guess.
//
// Playoff extension: fixed gained its own conditional 'playoffs' step
// (between 'teams' and 'reminders') -- fixed's total went from 7 to 8.
// headcount/weekly_draw are untouched (playoffs are meaningless for
// both -- neither ever sees the step, so neither total changed).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part87-flow-step-numbering-secret';

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
async function getSignup(cookie, step) {
  return (await SELF.fetch(`http://example.com/signup?step=${step}`, { headers: cookie ? { cookie } : {} })).text();
}
async function getOnboarding(cookie, step) {
  return (await SELF.fetch(`http://example.com/onboarding/season?step=${step}`, { headers: { cookie } })).text();
}
function stepAttrs(html) {
  const valuenow = (html.match(/aria-valuenow="(\d+)"/) || [])[1];
  const valuemax = (html.match(/aria-valuemax="(\d+)"/) || [])[1];
  return { now: valuenow, max: valuemax };
}

describe('B1: one continuous "STEP n OF m" count, signup through onboarding', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('signup steps 1 and 2 (structure not chosen yet) show the fixed-structure default total of 8, both languages', async () => {
    const step1 = await getSignup(null, 1);
    expect(step1).toContain('data-i18n="step1">Étape 1 sur 8<');
    expect(stepAttrs(step1)).toEqual({ now: '1', max: '8' });

    const { cookie } = await signup('flow.step12@example.com', '203.0.210.001');
    const step2 = await getSignup(cookie, 2);
    expect(step2).toContain('data-i18n="step2">Étape 2 sur 8<');
    expect(stepAttrs(step2)).toEqual({ now: '2', max: '8' });
  });

  it('English copy for steps 1/2 (embedded in the page\'s own __I18N dict, applied client-side)', async () => {
    const step1 = await getSignup(null, 1);
    const m = step1.match(/var __I18N = (\{[\s\S]*?\});\n/);
    const dict = JSON.parse(m[1]);
    expect(dict.en.step1).toBe('Step 1 of 8');
    expect(dict.fr.step1).toBe('Étape 1 sur 8');
    expect(dict.en.step2).toBe('Step 2 of 8');
    expect(dict.fr.step2).toBe('Étape 2 sur 8');
  });

  it('fixed structure: signup step 3 (client-side, real total known) stays at 8; the full flow numbers 1-8 across every real screen, including the playoffs step', async () => {
    const { cookie, csrfToken } = await signup('flow.fixed@example.com', '203.0.210.002');
    const step3 = await getSignup(cookie, 3);
    // Server-rendered default (fixed IS the eventual choice here, so
    // no client-side correction needed -- confirmed via the dict/markup
    // that would drive that correction).
    expect(step3).toContain('id="su_step3_label"');
    expect(stepAttrs(step3)).toEqual({ now: '3', max: '8' });

    const league = await createLeague(cookie, csrfToken, { name: 'Flow Fixed League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'Flow Fixed Season' });

    const obRoster = await getOnboarding(cookie, 1);
    expect(stepAttrs(obRoster)).toEqual({ now: '4', max: '8' });
    expect(obRoster).toMatch(/Étape 4 sur 8/);

    const obTeams = await getOnboarding(cookie, 2);
    expect(stepAttrs(obTeams)).toEqual({ now: '5', max: '8' });
    expect(obTeams).toContain('id="ob_teams"');

    const obPlayoffs = await getOnboarding(cookie, 3);
    expect(stepAttrs(obPlayoffs)).toEqual({ now: '6', max: '8' });
    expect(obPlayoffs).toContain('id="ob_playoffs_enabled"');

    const obReminders = await getOnboarding(cookie, 4);
    expect(stepAttrs(obReminders)).toEqual({ now: '7', max: '8' });
    expect(obReminders).toContain('id="ob_reminder_72h"');

    const obStats = await getOnboarding(cookie, 5);
    expect(stepAttrs(obStats)).toEqual({ now: '8', max: '8' });
    expect(obStats).toContain('id="ob_tracks_results"');
    expect(obStats).toContain('id="ob_tracks_player_stats"');
    expect(obStats).toContain('data-i18n="finish"');
  });

  it('headcount structure: real total is 6 (no team-names step, and -- playoffs are fixed-teams only -- no playoffs step either); the flow numbers 1,2,3,4,5,6', async () => {
    const { cookie, csrfToken } = await signup('flow.headcount@example.com', '203.0.210.003');
    // Step 3's server-rendered default still claims 7 (structure isn't
    // known until the client reads sessionStorage) -- the client-side
    // correction to 6 is covered by the inline-script test below,
    // since this suite can't execute that script.
    const step3 = await getSignup(cookie, 3);
    expect(step3).toContain('id="su_step3_label"');
    expect(step3).toContain("headcount's real total is 6");

    await createLeague(cookie, csrfToken, { name: 'Flow Headcount League', teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10 });
    await publishSeason(cookie, csrfToken, { season_name: 'Flow Headcount Season' });

    const obRoster = await getOnboarding(cookie, 1);
    expect(stepAttrs(obRoster)).toEqual({ now: '4', max: '6' });
    expect(obRoster).toMatch(/Étape 4 sur 6/);

    const obReminders = await getOnboarding(cookie, 2);
    expect(stepAttrs(obReminders)).toEqual({ now: '5', max: '6' });
    expect(obReminders).not.toContain('id="ob_teams"');

    const obStats = await getOnboarding(cookie, 3);
    expect(stepAttrs(obStats)).toEqual({ now: '6', max: '6' });
    expect(obStats).toContain('data-i18n="finish"');
  });

  it('weekly_draw structure: signup skips step 3 entirely, so onboarding starts numbering at 3; real total is 6', async () => {
    const { cookie, csrfToken } = await signup('flow.weekly@example.com', '203.0.210.004');
    await createLeague(cookie, csrfToken, { name: 'Flow Weekly League', teamStructure: 'weekly_draw', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'Flow Weekly Season' });

    const obRoster = await getOnboarding(cookie, 1);
    expect(stepAttrs(obRoster)).toEqual({ now: '3', max: '6' });
    expect(obRoster).toMatch(/Étape 3 sur 6/);

    const obTeams = await getOnboarding(cookie, 2);
    expect(stepAttrs(obTeams)).toEqual({ now: '4', max: '6' });
    expect(obTeams).toContain('id="ob_teams"');

    const obReminders = await getOnboarding(cookie, 3);
    expect(stepAttrs(obReminders)).toEqual({ now: '5', max: '6' });

    const obStats = await getOnboarding(cookie, 4);
    expect(stepAttrs(obStats)).toEqual({ now: '6', max: '6' });
    expect(obStats).toContain('data-i18n="finish"');
  });

  it('the client-side headcount correction (server default 8 -> real 6) is wired into both initial render and the FR/EN toggle', async () => {
    const { cookie } = await signup('flow.headcount.client@example.com', '203.0.210.005');
    const step3 = await getSignup(cookie, 3);
    expect(step3).toContain("prog.setAttribute('aria-valuemax', '6')");
    expect(step3).toContain("while (prog.children.length > 6) prog.removeChild(prog.lastElementChild)");
    expect(step3).toContain('function applyHeadcountStepLabel()');
    // Onboarding polish task (B1): renderTeams() (the per-team name
    // input renderer) was removed along with the name-input UI itself.
    expect(step3).toContain('window.__onLangApplied = function() { applyHeadcountStepLabel(); }');
  });
});

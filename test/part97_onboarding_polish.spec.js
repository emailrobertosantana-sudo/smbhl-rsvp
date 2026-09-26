// Onboarding polish (Group B): team names asked once, not twice (B1);
// the step counter's own deliberate ending at the dashboard (B2); one
// clear next-step surface instead of two (B3); the roster-readiness
// message respecting the league's own minimum (B4).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part97-onboarding-polish-secret';

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
  const res = await SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return res.json();
}
async function getSignup(cookie, step) {
  return (await SELF.fetch(`http://example.com/signup?step=${step}`, { headers: { cookie } })).text();
}
async function getOnboarding(cookie, step) {
  return (await SELF.fetch(`http://example.com/onboarding/season?step=${step}`, { headers: { cookie } })).text();
}
async function addContact(cookie, csrfToken, name) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name })
  });
  return (await res.json()).contact;
}
async function fetchRoster(cookie) {
  return (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
}
async function setStructure(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/settings/structure', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

describe('Onboarding polish, B1: team names asked once, not twice', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('signup step 3 (fixed structure) only asks for the team COUNT -- no name-input fields, no "leave blank" copy', async () => {
    const { cookie } = await signup('b1.step3@example.com', '203.0.221.001');
    const html = await getSignup(cookie, 3);
    expect(html).toContain('id="su_team_count_out"');
    expect(html).not.toContain('id="su_teams"');
    expect(html).toContain('data-i18n="teamCountHelp"');
    expect(html).toContain('Tu nommeras tes équipes pendant la configuration de ta ligue.');
    expect(html).toContain("You'll name your teams while setting up your league.");
  });

  it('a league created via the wizard\'s own team-count-only flow gets real placeholder names (Équipe 1..N), later confirmed at onboarding\'s own "teams" step', async () => {
    const { cookie, csrfToken } = await signup('b1.placeholders@example.com', '203.0.221.002');
    // Matches what submitStep3() itself now generates -- N placeholder
    // names, no per-team text ever collected at THIS step.
    const league = await createLeague(cookie, csrfToken, { name: 'B1 League', teamNames: ['Équipe 1', 'Équipe 2', 'Équipe 3'] });
    expect(league.teamNames).toEqual(['Équipe 1', 'Équipe 2', 'Équipe 3']);
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const teamsStepHtml = await getOnboarding(cookie, 2); // 'teams' is onboardingStepsFor(fixed)[1]
    expect(teamsStepHtml).toContain('data-i18n="teamsTitle"');
    expect(teamsStepHtml).toContain('Confirme les noms des équipes');
    expect(teamsStepHtml).toContain('value="Équipe 1"');
    expect(teamsStepHtml).toContain('value="Équipe 2"');
    expect(teamsStepHtml).toContain('value="Équipe 3"');
  });

  it('headcount and weekly_draw are unaffected -- headcount never had team names at step 3 to begin with, and weekly_draw skips step 3 entirely', async () => {
    const { cookie: hcCookie } = await signup('b1.headcount@example.com', '203.0.221.003');
    const hcHtml = await getSignup(hcCookie, 3);
    expect(hcHtml).toContain('id="su_headcount_section"');
    expect(hcHtml).not.toContain('id="su_teams"');

    const { cookie: wdCookie, csrfToken: wdCsrf } = await signup('b1.weeklydraw@example.com', '203.0.221.004');
    await createLeague(wdCookie, wdCsrf, { name: 'B1 Weekly Draw League', teamStructure: 'weekly_draw', teamNames: ['A', 'B'] });
    const wdStep3 = await SELF.fetch('http://example.com/signup?step=3', { headers: { cookie: wdCookie }, redirect: 'manual' });
    // Already has a league (A2's own redirect) -- never shows step 3 at all.
    expect(wdStep3.status).toBe(302);
  });
});

describe('Onboarding polish, B4: roster readiness respects the league\'s own real minimum', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('with a real minimum set, ONE player in a league that needs 10 shows progress ("1 of 10"), not a premature "ready" claim', async () => {
    const { cookie, csrfToken } = await signup('b4.progress@example.com', '203.0.222.001');
    await createLeague(cookie, csrfToken, { name: 'B4 Progress League', teamNames: ['A', 'B', 'C', 'D'] });
    await setStructure(cookie, csrfToken, { min_players: 10, max_players: 20 });
    await addContact(cookie, csrfToken, 'Only Player');

    const html = await fetchRoster(cookie);
    expect(html).not.toContain('data-i18n="rosterNudgeTitle"'); // no premature "ready"
    expect(html).toContain('>1</span>'); // real count
    expect(html).toContain('>10</span>'); // real minimum
    expect(html).toContain('data-i18n="rosterProgressOfWord"');
    expect(html).toContain('data-i18n="rosterProgressLabel"');
  });

  it('once the real roster count reaches the configured minimum, the "ready, create your schedule" nudge appears instead of the progress message', async () => {
    const { cookie, csrfToken } = await signup('b4.ready@example.com', '203.0.222.002');
    await createLeague(cookie, csrfToken, { name: 'B4 Ready League', teamNames: ['A', 'B'] });
    await setStructure(cookie, csrfToken, { min_players: 2, max_players: 10 });
    await addContact(cookie, csrfToken, 'Player One');

    const before = await fetchRoster(cookie);
    expect(before).not.toContain('data-i18n="rosterNudgeTitle"');

    await addContact(cookie, csrfToken, 'Player Two');
    const after = await fetchRoster(cookie);
    expect(after).toContain('data-i18n="rosterNudgeTitle"');
    expect(after).not.toContain('data-i18n="rosterProgressLabel"');
  });

  it('a league that has never set a real minimum keeps the original behavior -- any player at all counts as ready (regression lock)', async () => {
    const { cookie, csrfToken } = await signup('b4.nominimum@example.com', '203.0.222.003');
    await createLeague(cookie, csrfToken, { name: 'B4 No Minimum League', teamNames: ['A', 'B'] });
    await addContact(cookie, csrfToken, 'Single Player');
    const html = await fetchRoster(cookie);
    expect(html).toContain('data-i18n="rosterNudgeTitle"');
  });

  it('both languages\' progress copy is present, verbatim', async () => {
    const { cookie, csrfToken } = await signup('b4.copy@example.com', '203.0.222.004');
    await createLeague(cookie, csrfToken, { name: 'B4 Copy League', teamNames: ['A', 'B'] });
    await setStructure(cookie, csrfToken, { min_players: 5, max_players: 10 });
    await addContact(cookie, csrfToken, 'Copy Player');
    const html = await fetchRoster(cookie);
    expect(html).toContain('Ton horaire pourra être créé une fois le minimum atteint.');
    expect(html).toContain("You'll be able to create your schedule once you reach the minimum.");
    expect(html).toContain('joueurs ajoutés');
    expect(html).toContain('players added');
  });
});

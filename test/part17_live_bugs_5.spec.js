// Bug 4 found via a real end-to-end live verification against
// notreligue.ca: the dashboard's onboarding checklist always showed
// "Nommer les équipes" ("Name the teams") as done, even for a
// headcount league that never named any teams at all -- a false
// "done" for a step that genuinely never happened.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part17-live-bugs-5-secret';

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

describe('Live-testing Bug 4: onboarding checklist accuracy per team-structure mode', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('fixed-mode league: checklist still shows "Nommer les équipes", done -- unaffected', async () => {
    const { cookie, csrfToken } = await signup('bugs5.checklist.fixed@example.com', '203.0.120.001');
    await createLeague(cookie, csrfToken, { name: 'Checklist Fixed League', teamNames: ['A', 'B'], tracksStats: true });
    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain('<span data-i18n="ckTeams">');
    expect(html).not.toContain('<span data-i18n="ckPlayerCount">');
    // Still shown as done -- real team names WERE chosen at signup for
    // this mode.
    const line = html.split('\n').find(l => l.includes('data-i18n="ckTeams"'));
    expect(line).toContain('dash-ck done');
  });

  it('headcount league: checklist shows the accurate "Choisir le nombre de joueurs" label, done, never the misleading "Nommer les équipes"', async () => {
    const { cookie, csrfToken } = await signup('bugs5.checklist.headcount@example.com', '203.0.120.002');
    await createLeague(cookie, csrfToken, { name: 'Checklist Headcount League', tracksStats: true, teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10 });
    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain('<span data-i18n="ckPlayerCount">');
    expect(html).not.toContain('<span data-i18n="ckTeams">');
    const line = html.split('\n').find(l => l.includes('data-i18n="ckPlayerCount"'));
    expect(line).toContain('dash-ck done');
  });

  it('weekly_draw league: checklist still shows "Nommer les équipes", done -- unaffected (real team names ARE chosen at signup for this mode too)', async () => {
    const { cookie, csrfToken } = await signup('bugs5.checklist.weekly@example.com', '203.0.120.003');
    await createLeague(cookie, csrfToken, { name: 'Checklist Weekly League', teamNames: ['Red', 'Blue'], tracksStats: true, teamStructure: 'weekly_draw' });
    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain('<span data-i18n="ckTeams">');
    expect(html).not.toContain('<span data-i18n="ckPlayerCount">');
  });

  // B3 (onboarding polish task): "Nommer les équipes" was ALSO showing
  // done for a league that left the team-names field at its generated
  // defaults ("Team 1"/"Team 2") -- the step happened (a signup
  // request was made), but nothing was actually named. Complete only
  // once the names genuinely differ from that generated default.
  it('B3: fixed-mode league left at the generated default team names ("Team 1"/"Team 2") -- checklist item is NOT ticked', async () => {
    const { cookie, csrfToken } = await signup('bugs5.b3.default@example.com', '203.0.120.005');
    await createLeague(cookie, csrfToken, { name: 'B3 Default Names League', teamNames: ['Team 1', 'Team 2'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    const line = html.split('\n').find(l => l.includes('data-i18n="ckTeams"'));
    expect(line).not.toContain('dash-ck done');
    expect(line).toContain('class="b n">');
  });

  it('B3: the French default pattern ("Équipe 1"/"Équipe 2") is recognized too, language-agnostic', async () => {
    const { cookie, csrfToken } = await signup('bugs5.b3.defaultfr@example.com', '203.0.120.006');
    await createLeague(cookie, csrfToken, { name: 'B3 Default Names FR League', teamNames: ['Équipe 1', 'Équipe 2'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    const line = html.split('\n').find(l => l.includes('data-i18n="ckTeams"'));
    expect(line).not.toContain('dash-ck done');
  });

  it('B3: renaming just one of two default names is enough to tick it -- "differ from default" is checked per array, not per name', async () => {
    const { cookie, csrfToken } = await signup('bugs5.b3.partial@example.com', '203.0.120.007');
    await createLeague(cookie, csrfToken, { name: 'B3 Partial Rename League', teamNames: ['Team 1', 'Dynamos'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    const line = html.split('\n').find(l => l.includes('data-i18n="ckTeams"'));
    expect(line).toContain('dash-ck done');
  });

  it('B3: a genuinely coincidental team named "Team 1" among otherwise-real names still ticks -- only an ALL-default array is unticked', async () => {
    const { cookie, csrfToken } = await signup('bugs5.b3.coincidence@example.com', '203.0.120.008');
    await createLeague(cookie, csrfToken, { name: 'B3 Coincidence League', teamNames: ['Team 1', 'Real Team Name'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    const line = html.split('\n').find(l => l.includes('data-i18n="ckTeams"'));
    expect(line).toContain('dash-ck done');
  });

  it('B3: headcount is unaffected by the team-naming check -- its own row (player count) stays done regardless', async () => {
    const { cookie, csrfToken } = await signup('bugs5.b3.headcount@example.com', '203.0.120.009');
    await createLeague(cookie, csrfToken, { name: 'B3 Headcount League', tracksStats: true, teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10 });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    const line = html.split('\n').find(l => l.includes('data-i18n="ckPlayerCount"'));
    expect(line).toContain('dash-ck done');
  });

  it('the checklist section only ever renders before the first season is published, for every mode', async () => {
    const { cookie, csrfToken } = await signup('bugs5.checklist.gone@example.com', '203.0.120.004');
    await createLeague(cookie, csrfToken, { name: 'Checklist Gone League', tracksStats: true, teamStructure: 'headcount', minPlayers: 4, maxPlayers: 8 });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Checklist Gone Season' })
    });
    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const html = await res.text();
    expect(html).not.toContain('data-i18n="checklistTitle"');
    expect(html).not.toContain('data-i18n="ckPlayerCount">');
  });
});

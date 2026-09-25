// Group C (empty-states polish task): Schedule had no next-step card
// (Players correctly nudges forward to Schedule once players exist
// and no events do yet; Schedule showed only "No events yet" and
// white space when the roster was still empty). Comms and Settings
// were checked too -- neither has an analogous "empty, needs
// guidance" state (both are always-populated forms/panels regardless
// of setup completeness), so neither needed a nudge card added.
//
// C2: the dashboard's "Pickup with teams" tile showed a bare number
// with no explanation of what it counted -- fixed-mode's own
// "Équipes" tile is self-explanatory (the label literally says
// "teams"), but "Pickup with teams" describes the STRUCTURE, not a
// literal "teams" count. A small caption now clarifies the number,
// scoped to weekly_draw only (fixed and headcount tiles are
// self-explanatory or show no number at all, respectively).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part89-group-c-empty-states-secret';

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
async function addContact(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).contact;
}

describe('C1: Schedule gets a next-step card while the roster is empty', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a season exists but no players yet: the nudge card shows, both languages, pointing to /league/roster', async () => {
    const { cookie, csrfToken } = await signup('c1.empty@example.com', '203.0.212.001');
    await createLeague(cookie, csrfToken, { name: 'C1 Empty League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="nextStep">Prochaine étape<');
    expect(html).toContain('data-i18n="scheduleNudgeTitle"');
    expect(html).toContain('href="/league/roster"');
    expect(html).toContain('data-i18n="scheduleNudgeBtn">Ajouter des joueurs<');

    const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/);
    const dict = JSON.parse(m[1]);
    expect(dict.fr.scheduleNudgeTitle).toBe("Ajoute d'abord tes joueurs. Prochaine étape : ajoute ton alignement.");
    expect(dict.en.scheduleNudgeTitle).toBe('Add your players first. Next step: add your roster.');
    // "No events yet" empty state is still there underneath -- the
    // nudge is additive, not a replacement.
    expect(html).toContain('data-i18n="noEvents"');
  });

  it('once players exist: the nudge is gone, even with zero events', async () => {
    const { cookie, csrfToken } = await signup('c1.withplayers@example.com', '203.0.212.002');
    await createLeague(cookie, csrfToken, { name: 'C1 With Players League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await addContact(cookie, csrfToken, { name: 'Real Player', role: 'roster', team: 'A' });

    const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    expect(html).not.toContain('data-i18n="scheduleNudgeTitle"');
    expect(html).toContain('data-i18n="noEvents"');
  });

  it('no season yet: the existing needsSeason empty state shows, not the new roster nudge (season is the actual blocker)', async () => {
    const { cookie, csrfToken } = await signup('c1.noseason@example.com', '203.0.212.003');
    await createLeague(cookie, csrfToken, { name: 'C1 No Season League', teamNames: ['A', 'B'] });

    const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="needsSeasonTitle"');
    expect(html).not.toContain('data-i18n="scheduleNudgeTitle"');
  });

  it('an inactive (retired) player alone does not count as "players exist" -- the nudge still shows', async () => {
    const { cookie, csrfToken } = await signup('c1.inactive@example.com', '203.0.212.004');
    await createLeague(cookie, csrfToken, { name: 'C1 Inactive Only League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const player = await addContact(cookie, csrfToken, { name: 'Retiring Player', role: 'roster', team: 'A' });
    await SELF.fetch('http://example.com/league/contacts/active', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ player_id: player.player_id, is_active: false })
    });

    const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="scheduleNudgeTitle"');
  });
});

describe('C2: the "Pickup with teams" dashboard tile explains its own number', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('weekly_draw: the tile shows a caption clarifying what the number counts, both languages', async () => {
    const { cookie, csrfToken } = await signup('c2.weekly@example.com', '203.0.212.005');
    await createLeague(cookie, csrfToken, { name: 'C2 Weekly League', teamStructure: 'weekly_draw', teamNames: ['Red', 'Blue'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="teamsPerGame">Sans équipes fixes<');
    expect(html).toContain('<div class="stat tnum">2</div>');
    expect(html).toContain('data-i18n="teamsPerGameCount">équipes disponibles<');

    const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/);
    const dict = JSON.parse(m[1]);
    expect(dict.fr.teamsPerGameCount).toBe('équipes disponibles');
    expect(dict.en.teamsPerGameCount).toBe('team names available');
  });

  it('fixed: no caption added -- the "Équipes" label already says exactly what the number is', async () => {
    const { cookie, csrfToken } = await signup('c2.fixed@example.com', '203.0.212.006');
    await createLeague(cookie, csrfToken, { name: 'C2 Fixed League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="teams">Équipes<');
    expect(html).not.toContain('data-i18n="teamsPerGameCount"');
  });

  it('headcount: still no bare number at all -- unaffected, no caption needed', async () => {
    const { cookie, csrfToken } = await signup('c2.headcount@example.com', '203.0.212.007');
    await createLeague(cookie, csrfToken, { name: 'C2 Headcount League', teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10 });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="noFixedTeams">Aucune équipe fixe<');
    expect(html).not.toContain('data-i18n="teamsPerGameCount"');
  });

  it('the existing do-not-revert wording lock is unaffected -- this is a caption addition, not a wording change', async () => {
    const { cookie, csrfToken } = await signup('c2.wordingcheck@example.com', '203.0.212.008');
    await createLeague(cookie, csrfToken, { name: 'C2 Wording League', teamStructure: 'weekly_draw', teamNames: ['Red', 'Blue'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('Sans équipes fixes');
    expect(html).not.toContain('Nouvelles équipes chaque match');
  });
});

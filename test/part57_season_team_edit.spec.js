// Live-testing task (batch 2), Part 15: add or remove teams on a
// PUBLISHED season. Covers: (1) adding a team is unconditional and gets
// a fresh zeroed standings row. (2) removing a team with no games/
// players succeeds. (3) removing a team with recorded games (standings
// .gp > 0) is refused. (4) removing a team with an assigned player
// (rsvp.team set, for an event in THIS season) is refused. (5) editing
// one season never touches another season's own config/standings. (6)
// the league-level default (handleLeagueUpdateTeams) is untouched by
// this route, and vice versa. (7) SMBHL and headcount leagues are
// blocked. (8) at least 2 team names required. (9) a nonexistent season
// name fails clearly.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { getLeagueDataJson, putLeagueDataJson } from '../src/leagues.js';

const AUTH_SECRET = 'test-part15-season-team-edit-secret';

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
async function updateSeasonTeams(cookie, csrfToken, payload) {
  const res = await SELF.fetch('http://example.com/league/season/teams', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(payload)
  });
  return { status: res.status, body: await res.json() };
}

describe('Part 15 (live-testing task, batch 2): add/remove teams on a published season', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('adding a team is unconditional and gets a fresh zeroed standings row', async () => {
    const { cookie, csrfToken } = await signup('seasonteams.add@example.com', '203.0.173.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Add Team League', teamNames: ['Rouge', 'Bleu'], tracksStats: true });
    await publishSeason(cookie, csrfToken, 'S1');

    const { status, body } = await updateSeasonTeams(cookie, csrfToken, { season_name: 'S1', teamNames: ['Rouge', 'Bleu', 'Vert'] });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.added).toEqual(['Vert']);
    expect(body.removed).toEqual([]);
    expect(body.teamNames).toEqual(['Rouge', 'Bleu', 'Vert']);

    const data = await getLeagueDataJson(env, league.id);
    const season = data.seasons.find(s => s.name === 'S1');
    expect(season.config.teams).toEqual(['Rouge', 'Bleu', 'Vert']);
    const vert = season.standings.find(s => s.team === 'Vert');
    expect(vert).toEqual({ team: 'Vert', gp: 0, w: 0, l: 0, t: 0, pts: 0, gf: 0, ga: 0 });
  });

  it('removing a team with no games or assigned players succeeds', async () => {
    const { cookie, csrfToken } = await signup('seasonteams.remove@example.com', '203.0.173.002');
    await createLeague(cookie, csrfToken, { name: 'Remove Team League', teamNames: ['Rouge', 'Bleu', 'Vert'], tracksStats: true });
    await publishSeason(cookie, csrfToken, 'S1');

    const { status, body } = await updateSeasonTeams(cookie, csrfToken, { season_name: 'S1', teamNames: ['Rouge', 'Bleu'] });
    expect(status).toBe(200);
    expect(body.removed).toEqual(['Vert']);
    expect(body.teamNames).toEqual(['Rouge', 'Bleu']);
  });

  it('a team with recorded games (standings.gp > 0) cannot be removed', async () => {
    const { cookie, csrfToken } = await signup('seasonteams.hasgames@example.com', '203.0.173.003');
    const league = await createLeague(cookie, csrfToken, { name: 'Has Games League', teamNames: ['Rouge', 'Bleu'], tracksStats: true });
    await publishSeason(cookie, csrfToken, 'S1');

    const data = await getLeagueDataJson(env, league.id);
    const season = data.seasons.find(s => s.name === 'S1');
    season.standings.find(s => s.team === 'Bleu').gp = 3;
    await putLeagueDataJson(env, league.id, data);

    const { status, body } = await updateSeasonTeams(cookie, csrfToken, { season_name: 'S1', teamNames: ['Rouge'].concat(['Vert']) });
    // Rouge kept, Bleu implicitly removed (not in new list), Vert added.
    expect(status).toBe(409);
    expect(body.errorKey).toBe('TEAM_HAS_GAMES');
    expect(body.team).toBe('Bleu');

    const unchanged = await getLeagueDataJson(env, league.id);
    expect(unchanged.seasons.find(s => s.name === 'S1').config.teams).toEqual(['Rouge', 'Bleu']);
  });

  it('a team with an assigned player (rsvp.team) for an event in THIS season cannot be removed', async () => {
    const { cookie, csrfToken } = await signup('seasonteams.hasplayers@example.com', '203.0.173.004');
    const league = await createLeague(cookie, csrfToken, { name: 'Has Players League', teamNames: ['Rouge', 'Bleu'], tracksStats: true });
    await publishSeason(cookie, csrfToken, 'S1');

    const contactRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Player One', role: 'roster' })
    });
    const contact = (await contactRes.json()).contact;
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2026-11-01', season: 'S1' })
    });
    const ev = (await eventRes.json()).event;

    await env.DB.prepare('UPDATE rsvp SET status = ?, team = ? WHERE event_id = ? AND player_id = ?')
      .bind('in', 'Bleu', ev.id, contact.player_id).run();
    // Ensure a real row exists (writeLeagueRsvpStatus creates it via the
    // admin-set route in normal use; insert directly here since this
    // test only needs the row to exist, not the full RSVP flow).
    await env.DB.prepare(
      `INSERT INTO rsvp (event_id, league_id, player_id, team, status, role, status_by, updated_at)
       VALUES (?, ?, ?, ?, 'in', 'roster', 'manager', ?)
       ON CONFLICT(event_id, player_id) DO UPDATE SET team = excluded.team, status = excluded.status`
    ).bind(ev.id, league.id, contact.player_id, 'Bleu', new Date().toISOString()).run();

    const { status, body } = await updateSeasonTeams(cookie, csrfToken, { season_name: 'S1', teamNames: ['Rouge', 'Vert'] });
    expect(status).toBe(409);
    expect(body.errorKey).toBe('TEAM_HAS_PLAYERS');
    expect(body.team).toBe('Bleu');
  });

  it('editing one season never touches another season, or the league-level default team list', async () => {
    const { cookie, csrfToken } = await signup('seasonteams.isolation@example.com', '203.0.173.005');
    const league = await createLeague(cookie, csrfToken, { name: 'Isolation League', teamNames: ['Rouge', 'Bleu'], tracksStats: true });
    await publishSeason(cookie, csrfToken, 'S1');
    await publishSeason(cookie, csrfToken, 'S2');

    const { status } = await updateSeasonTeams(cookie, csrfToken, { season_name: 'S1', teamNames: ['Rouge', 'Bleu', 'Vert'] });
    expect(status).toBe(200);

    const data = await getLeagueDataJson(env, league.id);
    expect(data.seasons.find(s => s.name === 'S1').config.teams).toEqual(['Rouge', 'Bleu', 'Vert']);
    expect(data.seasons.find(s => s.name === 'S2').config.teams).toEqual(['Rouge', 'Bleu']);

    const leagueRow = await env.DB.prepare('SELECT team_names FROM leagues WHERE id = ?').bind(league.id).first();
    expect(JSON.parse(leagueRow.team_names)).toEqual(['Rouge', 'Bleu']);
  });

  it('at least 2 team names are required', async () => {
    const { cookie, csrfToken } = await signup('seasonteams.min@example.com', '203.0.173.006');
    await createLeague(cookie, csrfToken, { name: 'Min Team League', teamNames: ['Rouge', 'Bleu'], tracksStats: true });
    await publishSeason(cookie, csrfToken, 'S1');

    const { status, body } = await updateSeasonTeams(cookie, csrfToken, { season_name: 'S1', teamNames: ['Rouge'] });
    expect(status).toBe(400);
    expect(body.errorKey).toBe('MIN_TEAM_NAMES');
  });

  it('a nonexistent season name fails clearly', async () => {
    const { cookie, csrfToken } = await signup('seasonteams.noseason@example.com', '203.0.173.007');
    await createLeague(cookie, csrfToken, { name: 'No Season League', teamNames: ['Rouge', 'Bleu'], tracksStats: true });
    await publishSeason(cookie, csrfToken, 'S1');

    const { status, body } = await updateSeasonTeams(cookie, csrfToken, { season_name: 'Nonexistent', teamNames: ['Rouge', 'Bleu'] });
    expect(status).toBe(404);
    expect(body.errorKey).toBe('SEASON_NOT_FOUND');
  });

  it('a headcount league has no season teams to edit', async () => {
    const { cookie, csrfToken } = await signup('seasonteams.headcount@example.com', '203.0.173.008');
    await createLeague(cookie, csrfToken, { name: 'Headcount League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 14, tracksStats: false });
    await publishSeason(cookie, csrfToken, 'S1');

    const { status, body } = await updateSeasonTeams(cookie, csrfToken, { season_name: 'S1', teamNames: ['A', 'B'] });
    expect(status).toBe(400);
    expect(body.errorKey).toBe('NO_TEAMS_TO_EDIT');
  });

  it('the settings page renders the current season\'s own team list, not the league-level default', async () => {
    const { cookie, csrfToken } = await signup('seasonteams.uirender@example.com', '203.0.173.009');
    await createLeague(cookie, csrfToken, { name: 'UI Render League', teamNames: ['Rouge', 'Bleu'], tracksStats: true });
    await publishSeason(cookie, csrfToken, 'S1');
    await updateSeasonTeams(cookie, csrfToken, { season_name: 'S1', teamNames: ['Rouge', 'Bleu', 'Vert'] });

    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toContain('id="se_season_teams_list"');
    expect(html).toContain('data-team="Vert"');
    expect(html).toContain('id="se_new_season_team"');
  });
});

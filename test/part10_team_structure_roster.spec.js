// Team-structure task, Part 2: roster page. Headcount leagues show no
// team control at all; weekly_draw leagues show no PERMANENT team
// control (teams are assigned per event, Part 3) but keep the real
// role split; fixed leagues are completely unchanged.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part10-team-structure-roster-secret';

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

describe('Team structure, Part 2: roster page', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  describe('FIXED MODE -- provably unaffected', () => {
    it('shows the team column, team filter pills, and team select in the add-player form, exactly as before', async () => {
      const { cookie, csrfToken } = await signup('ts.roster.fixed@example.com', '203.0.113.991');
      await createLeague(cookie, csrfToken, { name: 'Roster Fixed League', teamNames: ['Otters', 'Falcons'], tracksStats: true });
      const res = await SELF.fetch('http://example.com/league/roster', { headers: { cookie } });
      const html = await res.text();
      expect(html).toContain('data-i18n="colTeam"');
      expect(html).toContain('id="r_team"');
      expect(html).toContain('data-filter="team:Otters"');
      expect(html).toContain('data-filter="unassigned"');
      // Live-testing task, Part 2 (bug fix): role is now exactly 2
      // options everywhere -- see part37's own regression suite for the
      // full "two independent axes" redesign this superseded.
      expect(html).not.toContain('roleSubGoalie');
      expect(html).not.toContain('data-i18n="weeklyDrawNote"');
    });
  });

  describe('HEADCOUNT MODE', () => {
    it('shows no team column, no team select, no team filter pills, and a simplified 2-option role picker', async () => {
      const { cookie, csrfToken } = await signup('ts.roster.headcount@example.com', '203.0.113.992');
      await createLeague(cookie, csrfToken, { name: 'Roster Headcount League', tracksStats: true, teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12 });
      const res = await SELF.fetch('http://example.com/league/roster', { headers: { cookie } });
      const html = await res.text();
      expect(html).not.toContain('data-i18n="colTeam"');
      expect(html).not.toContain('id="r_team"');
      expect(html).not.toContain('data-filter="team:');
      expect(html).not.toContain('data-filter="unassigned"');
      expect(html).not.toContain('data-i18n="roleSubGoalie"');
      expect(html).toContain('data-i18n="roleSub"');
      // The internal sentinel team name (HEADCOUNT_TEAM_NAME) never
      // leaks into the UI as an actual team reference -- checked
      // specifically as a filter/option value, not the bare substring
      // "Tous" (which is also, coincidentally, the real French word for
      // the unrelated "All" filter pill already shown for every mode).
      expect(html).not.toContain('data-filter="team:');
      expect(html).not.toContain('value="Tous"');
    });

    it('adding a player in headcount mode never sets is_goalie (the 2-option role picker always submits sub_skater for "substitute")', async () => {
      const { cookie, csrfToken } = await signup('ts.roster.headcount.add@example.com', '203.0.113.993');
      const league = await createLeague(cookie, csrfToken, { name: 'Roster Headcount Add League', tracksStats: true, teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10 });
      const res = await SELF.fetch('http://example.com/league/contacts', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Headcount Sub Player', role: 'sub_skater' })
      });
      expect(res.status).toBe(200);
      const playerId = (await res.json()).contact.player_id;
      const row = await env.DB.prepare('SELECT is_goalie, role, preferred_team FROM contacts WHERE player_id = ?').bind(playerId).first();
      expect(row.is_goalie).toBe(0);
      expect(row.role).toBe('sub_skater');
      expect(row.preferred_team).toBeNull();
    });
  });

  describe('WEEKLY_DRAW MODE', () => {
    // Superseded by the live-testing task's Part 2 bug fix: the 3-option
    // role picker (roster/sub_skater/sub_goalie) duplicated the
    // independent Goalie/Player axis and was reported broken (two
    // controls for the same thing, able to disagree). Role is now
    // exactly 2 options for every team structure; is_goalie alone
    // carries goalie-ness, always shown, for a regular or a sub alike.
    it('shows no team column or select, but a real note explaining teams are assigned per game, and a 2-option role picker with the always-visible goalie axis', async () => {
      const { cookie, csrfToken } = await signup('ts.roster.weekly@example.com', '203.0.113.994');
      await createLeague(cookie, csrfToken, { name: 'Roster Weekly League', teamNames: ['Red', 'Blue', 'Green'], tracksStats: true, teamStructure: 'weekly_draw' });
      const res = await SELF.fetch('http://example.com/league/roster', { headers: { cookie } });
      const html = await res.text();
      expect(html).not.toContain('data-i18n="colTeam"');
      expect(html).not.toContain('id="r_team"');
      expect(html).not.toContain('data-filter="team:');
      expect(html).toContain('data-i18n="weeklyDrawNote"');
      expect(html).not.toContain('roleSubGoalie');
      expect(html).toContain('data-i18n="roleSub"');
      expect(html).toContain('id="r_goalie_radio"');
    });

    it('adding a player in weekly_draw mode stores no preferred_team at all', async () => {
      const { cookie, csrfToken } = await signup('ts.roster.weekly.add@example.com', '203.0.113.995');
      await createLeague(cookie, csrfToken, { name: 'Roster Weekly Add League', teamNames: ['A', 'B'], tracksStats: true, teamStructure: 'weekly_draw' });
      const res = await SELF.fetch('http://example.com/league/contacts', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Weekly Draw Player' })
      });
      expect(res.status).toBe(200);
      const playerId = (await res.json()).contact.player_id;
      const row = await env.DB.prepare('SELECT preferred_team FROM contacts WHERE player_id = ?').bind(playerId).first();
      expect(row.preferred_team).toBeNull();
    });
  });
});

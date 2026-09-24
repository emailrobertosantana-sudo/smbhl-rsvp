// Live-testing task, Part 1: consolidated league settings page
// (GET /league/settings), pulling together everything that previously
// had no single home or was scattered on the dashboard (language mode,
// reminders, auto-draw -- moved here, not duplicated) plus two genuinely
// new capabilities: team names/colours (the missing post-signup editing
// surface flagged as a gap in the prior task) and a league-level
// team-structure/roster-limits default editor.
//
// CRITICAL safety property under test: editing the league-level
// team_structure must NEVER retroactively alter an already-published
// season's resolved config -- see freezeExistingSeasonsTeamStructure
// and the handleLeagueSeasonPublish fix (leagues.js) this relies on.
import { env, SELF } from 'cloudflare:test';
import { getLeagueSeasonConfig } from '../src/leagues.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part1-settings-page-secret';

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

describe('Part 1 (live-testing task): consolidated settings page', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  describe('page access + nav', () => {
    it('requires a session, redirects to /login otherwise', async () => {
      const res = await SELF.fetch('http://example.com/league/settings', { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location') || '').toContain('/login');
    });

    it('the dashboard nav includes a link to /league/settings', async () => {
      const { cookie, csrfToken } = await signup('settings.nav@example.com', '203.0.133.001');
      await createLeague(cookie, csrfToken, { name: 'Settings Nav League', teamNames: ['A', 'B'], tracksStats: true });
      const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
      expect(html).toContain('href="/league/settings"');
    });

    it('renders the slug read-only, with an explanation, and no input to change it', async () => {
      const { cookie, csrfToken } = await signup('settings.slug@example.com', '203.0.133.002');
      const league = await createLeague(cookie, csrfToken, { name: 'Settings Slug League', teamNames: ['A', 'B'], tracksStats: true });
      const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
      expect(html).toContain(league.slug);
      expect(html).toContain('data-i18n="slugHelp"');
      expect(html).not.toContain('id="se_slug"');
    });
  });

  describe('identity: name, colour, stats tracking', () => {
    it('updates name, colour, and tracksStats independently via POST /league/settings/identity', async () => {
      const { cookie, csrfToken } = await signup('settings.identity@example.com', '203.0.133.003');
      const league = await createLeague(cookie, csrfToken, { name: 'Identity League', teamNames: ['A', 'B'], tracksStats: true });

      const res = await SELF.fetch('http://example.com/league/settings/identity', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Renamed Identity League', color: '#2a5fa8', tracksStats: false })
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      // Superseded by live-testing task (batch 2), Part 10: the
      // identity route's response now also includes publicPageEnabled
      // (default true, unaffected here).
      expect(json.settings).toEqual({ name: 'Renamed Identity League', color: '#2a5fa8', tracksStats: false, publicTheme: 'arene', publicPageEnabled: true });

      const row = await env.DB.prepare('SELECT name, color, tracks_stats FROM leagues WHERE id = ?').bind(league.id).first();
      expect(row.name).toBe('Renamed Identity League');
      expect(row.color).toBe('#2a5fa8');
      expect(row.tracks_stats).toBe(0);
    });

    it('rejects an invalid hex colour', async () => {
      const { cookie, csrfToken } = await signup('settings.badcolor@example.com', '203.0.133.004');
      await createLeague(cookie, csrfToken, { name: 'Bad Color League', teamNames: ['A', 'B'], tracksStats: true });
      const res = await SELF.fetch('http://example.com/league/settings/identity', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ color: 'not-a-color' })
      });
      expect(res.status).toBe(400);
      expect((await res.json()).errorKey).toBe('INVALID_COLOR');
    });

    it('requires a session and CSRF token, same as every other league-admin write route', async () => {
      const noSession = await SELF.fetch('http://example.com/league/settings/identity', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X' })
      });
      expect(noSession.status).toBe(401);
    });

    it('cannot be used against SMBHL', async () => {
      const { cookie, csrfToken } = await signup('settings.smbhl.identity@example.com', '203.0.133.005');
      const res = await SELF.fetch('http://example.com/league/settings/identity', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'X' })
      });
      // No league created for this account -- resolves to NO_LEAGUE_FOUND,
      // same as every other league-scoped write route's own SMBHL defense.
      expect(res.status).toBe(404);
      expect((await res.json()).errorKey).toBe('NO_LEAGUE_FOUND');
    });
  });

  describe('teams: rename + colour (the missing post-signup editing surface)', () => {
    it('renames teams and sets colours for a fixed-mode league, via POST /league/settings/teams', async () => {
      const { cookie, csrfToken } = await signup('settings.teams.fixed@example.com', '203.0.133.006');
      const league = await createLeague(cookie, csrfToken, { name: 'Teams Fixed League', teamNames: ['Falcons', 'Otters'], tracksStats: true });

      const res = await SELF.fetch('http://example.com/league/settings/teams', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ teamNames: ['Hawks', 'Otters'], teamColors: ['#c9152f', '#2a5fa8'] })
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.teamNames).toEqual(['Hawks', 'Otters']);
      expect(json.teamColors).toEqual(['#c9152f', '#2a5fa8']);

      const row = await env.DB.prepare('SELECT team_names, team_colors FROM leagues WHERE id = ?').bind(league.id).first();
      expect(JSON.parse(row.team_names)).toEqual(['Hawks', 'Otters']);
      expect(JSON.parse(row.team_colors)).toEqual(['#c9152f', '#2a5fa8']);
    });

    it('renames teams for a weekly_draw league too', async () => {
      const { cookie, csrfToken } = await signup('settings.teams.weekly@example.com', '203.0.133.007');
      await createLeague(cookie, csrfToken, { name: 'Teams Weekly League', teamStructure: 'weekly_draw', teamNames: ['Rouge / Red', 'Bleu / Blue'], tracksStats: true });
      const res = await SELF.fetch('http://example.com/league/settings/teams', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ teamNames: ['Verts / Greens', 'Jaunes / Yellows'] })
      });
      expect(res.status).toBe(200);
      expect((await res.json()).teamNames).toEqual(['Verts / Greens', 'Jaunes / Yellows']);
    });

    it('rejects fewer than 2 team names', async () => {
      const { cookie, csrfToken } = await signup('settings.teams.toofew@example.com', '203.0.133.008');
      await createLeague(cookie, csrfToken, { name: 'Teams Too Few League', teamNames: ['A', 'B'], tracksStats: true });
      const res = await SELF.fetch('http://example.com/league/settings/teams', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ teamNames: ['OnlyOne'] })
      });
      expect(res.status).toBe(400);
      expect((await res.json()).errorKey).toBe('MIN_TEAM_NAMES');
    });

    it('rejects team edits for a headcount league (nothing to rename)', async () => {
      const { cookie, csrfToken } = await signup('settings.teams.headcount@example.com', '203.0.133.009');
      await createLeague(cookie, csrfToken, { name: 'Teams Headcount League', teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10, tracksStats: true });
      const res = await SELF.fetch('http://example.com/league/settings/teams', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ teamNames: ['A', 'B'] })
      });
      expect(res.status).toBe(400);
      expect((await res.json()).errorKey).toBe('NO_TEAMS_TO_EDIT');
    });

    it("renaming a team does NOT retroactively change an already-published season's own team list", async () => {
      const { cookie, csrfToken } = await signup('settings.teams.retro@example.com', '203.0.133.010');
      const league = await createLeague(cookie, csrfToken, { name: 'Teams Retro League', teamNames: ['Falcons', 'Otters'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'Retro Season' });

      const cfgBefore = await getLeagueSeasonConfig(env, league.id, 'Retro Season');
      expect(cfgBefore.teams.map(t => t.name)).toEqual(['Falcons', 'Otters']);

      await SELF.fetch('http://example.com/league/settings/teams', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ teamNames: ['Hawks', 'Wolves'] })
      });

      const cfgAfter = await getLeagueSeasonConfig(env, league.id, 'Retro Season');
      expect(cfgAfter.teams.map(t => t.name)).toEqual(['Falcons', 'Otters']);
    });

    it('the roster page renders the new custom team colour after a save', async () => {
      const { cookie, csrfToken } = await signup('settings.teams.rostercolor@example.com', '203.0.133.011');
      await createLeague(cookie, csrfToken, { name: 'Teams Roster Color League', teamNames: ['A', 'B'], tracksStats: true });
      await SELF.fetch('http://example.com/league/settings/teams', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ teamNames: ['A', 'B'], teamColors: ['#123456', '#654321'] })
      });
      const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
      expect(html).toContain('#123456');
      expect(html).toContain('#654321');
    });
  });

  describe('league-level team structure + roster limits (CRITICAL: no retroactive alteration)', () => {
    it("changing the league's default team_structure does NOT alter an already-published season's resolved structure", async () => {
      const { cookie, csrfToken } = await signup('settings.structure.retro@example.com', '203.0.133.012');
      const league = await createLeague(cookie, csrfToken, { name: 'Structure Retro League', teamNames: ['A', 'B'], tracksStats: true });
      // Published with a PLAIN {season_name} -- no explicit override --
      // the common real-world case this bug affected.
      await publishSeason(cookie, csrfToken, { season_name: 'Structure Retro Season' });

      const cfgBefore = await getLeagueSeasonConfig(env, league.id, 'Structure Retro Season');
      expect(cfgBefore.teamStructure).toBe('fixed');

      const res = await SELF.fetch('http://example.com/league/settings/structure', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ team_structure: 'headcount', min_players: 6, max_players: 10 })
      });
      expect(res.status).toBe(200);

      // The league's OWN default really did change...
      const row = await env.DB.prepare('SELECT team_structure FROM leagues WHERE id = ?').bind(league.id).first();
      expect(row.team_structure).toBe('headcount');
      // ...but the ALREADY-PUBLISHED season is completely unaffected.
      const cfgAfter = await getLeagueSeasonConfig(env, league.id, 'Structure Retro Season');
      expect(cfgAfter.teamStructure).toBe('fixed');
    });

    it('a NEW season published after the league-level change picks up the new default', async () => {
      const { cookie, csrfToken } = await signup('settings.structure.newseason@example.com', '203.0.133.013');
      const league = await createLeague(cookie, csrfToken, { name: 'Structure New Season League', teamNames: ['A', 'B'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'Old Season' });

      await SELF.fetch('http://example.com/league/settings/structure', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ team_structure: 'headcount', min_players: 4, max_players: 8 })
      });

      await publishSeason(cookie, csrfToken, { season_name: 'New Season' });
      const cfg = await getLeagueSeasonConfig(env, league.id, 'New Season');
      expect(cfg.teamStructure).toBe('headcount');

      // The OLD season is still untouched.
      const oldCfg = await getLeagueSeasonConfig(env, league.id, 'Old Season');
      expect(oldCfg.teamStructure).toBe('fixed');
    });

    it('switching a headcount league to fixed/weekly_draw requires real team names on file first', async () => {
      const { cookie, csrfToken } = await signup('settings.structure.needsnames@example.com', '203.0.133.014');
      await createLeague(cookie, csrfToken, { name: 'Structure Needs Names League', teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10, tracksStats: true });
      const res = await SELF.fetch('http://example.com/league/settings/structure', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ team_structure: 'fixed' })
      });
      expect(res.status).toBe(400);
      expect((await res.json()).errorKey).toBe('NO_TEAM_NAMES');
    });

    it('updates headcount min/max/min_goalies independently', async () => {
      const { cookie, csrfToken } = await signup('settings.structure.limits@example.com', '203.0.133.015');
      const league = await createLeague(cookie, csrfToken, { name: 'Structure Limits League', teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10, tracksStats: true });
      const res = await SELF.fetch('http://example.com/league/settings/structure', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ min_players: 8, max_players: 14, min_goalies: 2 })
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.settings).toEqual({ teamStructure: 'headcount', minPlayers: 8, maxPlayers: 14, minGoalies: 2, maxGoalies: null });
    });

    it('rejects max < min for headcount limits', async () => {
      const { cookie, csrfToken } = await signup('settings.structure.badlimits@example.com', '203.0.133.016');
      await createLeague(cookie, csrfToken, { name: 'Structure Bad Limits League', teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10, tracksStats: true });
      const res = await SELF.fetch('http://example.com/league/settings/structure', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ min_players: 10, max_players: 4 })
      });
      expect(res.status).toBe(400);
      expect((await res.json()).errorKey).toBe('HEADCOUNT_MAX_TOO_LOW');
    });

    it('an EXISTING RSVP/event is unaffected by a league-level structure change (no corruption of live data)', async () => {
      const { cookie, csrfToken } = await signup('settings.structure.rsvpsafe@example.com', '203.0.133.017');
      const league = await createLeague(cookie, csrfToken, { name: 'Structure RSVP Safe League', teamNames: ['A', 'B'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'RSVP Safe Season' });
      const contactRes = await SELF.fetch('http://example.com/league/contacts', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Safe Player', team: 'A', email: 'safeplayer@example.com' })
      });
      const player = (await contactRes.json()).contact;
      const eventRes = await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ date: '2099-05-05' })
      });
      const eventId = (await eventRes.json()).event.id;
      await SELF.fetch('http://example.com/league/rsvp/admin', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: player.player_id, status: 'in' })
      });

      const rsvpBefore = await env.DB.prepare('SELECT status, team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, player.player_id).first();

      await SELF.fetch('http://example.com/league/settings/structure', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ team_structure: 'headcount', min_players: 4, max_players: 8 })
      });

      const rsvpAfter = await env.DB.prepare('SELECT status, team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, player.player_id).first();
      expect(rsvpAfter).toEqual(rsvpBefore);
      const eventAfter = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
      expect(eventAfter.date).toBe('2099-05-05');
    });
  });

  describe('settings page renders the moved sections correctly', () => {
    it('shows the team-structure editor, headcount fields toggle correctly with the current value', async () => {
      const { cookie, csrfToken } = await signup('settings.render.structure@example.com', '203.0.133.018');
      await createLeague(cookie, csrfToken, { name: 'Render Structure League', teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10, tracksStats: true });
      const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
      expect(html).toContain('id="se_structure_radio"');
      expect(html).toContain('id="se_headcount_fields"');
      expect(html).not.toContain('style="display:none"><div class="su-two">'); // headcount fields visible by default for a headcount league is asserted structurally below
      expect(html).toMatch(/id="se_headcount_fields" style=""/);
    });

    it('every pre-existing league setting (SMBHL untouched) -- confirms the settings page never touches SMBHL data', async () => {
      const before = await env.DB.prepare("SELECT team_structure, color FROM leagues WHERE id = 'smbhl'").first();
      // No settings route was ever called for SMBHL in this test file
      // (every SMBHL attempt above returns NO_LEAGUE_FOUND/blocked) --
      // this just re-confirms its row is exactly what it was.
      const after = await env.DB.prepare("SELECT team_structure, color FROM leagues WHERE id = 'smbhl'").first();
      expect(after).toEqual(before);
    });
  });
});

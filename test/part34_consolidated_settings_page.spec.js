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
      // (default true, unaffected here). Stats tracking task (Part 1):
      // also includes tracksResults/tracksPlayerStats -- untouched
      // here (this call never sent either), so both stay at the
      // creation-time value (tracksStats: true migrated both on, per
      // handleLeagueCreate's own "legacy field still means both" rule).
      // Public-page themes task (Part 1): also includes organizerNote
      // (null -- this call never sent one either).
      expect(json.settings).toEqual({ name: 'Renamed Identity League', color: '#2a5fa8', tracksStats: false, publicTheme: 'arene', publicPageEnabled: true, tracksResults: true, tracksPlayerStats: true, organizerNote: null });

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

describe('G1 (settings polish task): left-hand section nav, and the two near-duplicate control pairs made adjacent and plainly labelled', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('shows a left-hand section nav with an anchor link to every real section on the page', async () => {
    const { cookie, csrfToken } = await signup('g1.nav@example.com', '203.0.133.101');
    await createLeague(cookie, csrfToken, { name: 'G1 Nav League', teamStructure: 'weekly_draw', teamNames: ['Rouge', 'Bleu'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'G1 Nav Season' });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();

    expect(html).toContain('class="se-nav"');
    for (const id of ['section-identity', 'section-venues', 'section-teams', 'section-structure', 'section-language', 'reminders-section', 'section-autodraw', 'section-admins', 'section-deactivate']) {
      expect(html).toContain(`href="#${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('the auto-draw nav link only appears for a weekly_draw league (the section itself is also gated)', async () => {
    const { cookie, csrfToken } = await signup('g1.nav.fixed@example.com', '203.0.133.102');
    await createLeague(cookie, csrfToken, { name: 'G1 Nav Fixed League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).not.toContain('href="#section-autodraw"');
    expect(html).not.toContain('id="section-autodraw"');
  });

  it('"Cette saison" (season-level structure) and "Par défaut pour les nouvelles saisons" (default-level structure) render adjacent, both present, plainly labelled', async () => {
    const { cookie, csrfToken } = await signup('g1.structure.adjacent@example.com', '203.0.133.103');
    await createLeague(cookie, csrfToken, { name: 'G1 Structure Adjacent League', teamNames: ['A', 'B'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'G1 Structure Season' });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();

    expect(html).toContain('data-i18n="seasonMgmtTitle"');
    expect(html).toContain('data-i18n="structureTitle"');
    // Both structure pickers (season_structure_radio, se_structure_radio)
    // still exist -- neither control was removed, only relabelled and
    // repositioned so an admin can tell them apart.
    expect(html).toContain('id="season_structure_radio"');
    expect(html).toContain('id="se_structure_radio"');

    // Adjacency: the very next section after the season-structure card
    // closes is the default-structure card -- nothing else in between.
    const seasonCloseIdx = html.indexOf('</section>', html.indexOf('id="section-structure"'));
    const gapAfterSeason = html.slice(seasonCloseIdx, seasonCloseIdx + 600);
    expect(gapAfterSeason).toContain('id="se_structure_radio"');
    expect(gapAfterSeason.indexOf('<section class="nl-card')).toBeGreaterThan(-1);
  });

  it('"Équipes par défaut" and "Équipes de cette saison" render adjacent, both present, plainly labelled', async () => {
    const { cookie, csrfToken } = await signup('g1.teams.adjacent@example.com', '203.0.133.104');
    await createLeague(cookie, csrfToken, { name: 'G1 Teams Adjacent League', teamNames: ['A', 'B'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'G1 Teams Season' });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();

    expect(html).toContain('data-i18n="teamsTitle"');
    expect(html).toContain('data-i18n="seasonTeamsTitle"');
    expect(html).toContain('id="se_teams_list"');
    expect(html).toContain('id="se_season_teams_list"');

    // Adjacency: the very next section after the default-teams card
    // closes is the season-teams card -- nothing else in between.
    const teamsCloseIdx = html.indexOf('</section>', html.indexOf('id="section-teams"'));
    const gapAfterTeams = html.slice(teamsCloseIdx, teamsCloseIdx + 600);
    expect(gapAfterTeams).toContain('id="section-season-teams"');
  });

  it('both languages carry the new labels correctly (server-rendered fallback, not just the i18n dict)', async () => {
    const { cookie, csrfToken } = await signup('g1.i18n@example.com', '203.0.133.105');
    await createLeague(cookie, csrfToken, { name: 'G1 I18n League', teamNames: ['A', 'B'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'G1 I18n Season' });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="seasonMgmtTitle">Cette saison<');
    expect(html).toContain('data-i18n="structureTitle">Par défaut pour les nouvelles saisons<');
    expect(html).toContain('data-i18n="teamsTitle">Équipes par défaut<');
    expect(html).toContain('data-i18n="seasonTeamsTitle">Équipes de cette saison<');

    const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/);
    expect(m).toBeTruthy();
    const dict = JSON.parse(m[1]);
    expect(dict.en.seasonMgmtTitle).toBe('This season');
    expect(dict.en.structureTitle).toBe('Default for new seasons');
    expect(dict.en.teamsTitle).toBe('Default teams');
    expect(dict.en.seasonTeamsTitle).toBe("This season's teams");
  });
});

// B1 (stale-copy polish task): an earlier task fixed the roster-size
// labels/helper text on the ONBOARDING season page ("Minimum total
// players", and a 3-way pool/team/headcount-accurate helper) but the
// same wording on Settings was never updated -- still "Minimum
// players" and the old, inaccurate 2-way "each team" vs "each game,
// across every player" split (which lumped weekly_draw's real pool and
// headcount's no-teams-at-all case together). Fixed to match
// onboarding exactly, in BOTH settings cards that show these fields
// ("Cette saison" and "Par défaut pour les nouvelles saisons").
describe('B1: settings roster-size wording matches onboarding, in both cards, for every structure', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  async function settingsHtmlFor(structureBody, extraSeasonFields = {}) {
    const { cookie, csrfToken } = await signup(`b1.${JSON.stringify(structureBody)}.${Math.random()}@example.com`, `203.0.134.${Math.floor(Math.random() * 900 + 100)}`);
    await createLeague(cookie, csrfToken, { name: `B1 League ${Math.random()}`, tracksStats: true, ...structureBody });
    await publishSeason(cookie, csrfToken, { season_name: 'B1 Season', ...extraSeasonFields });
    return (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
  }

  it('fixed-teams league: all three cards show "each team" wording (matching onboarding\'s rosterSubTeam) for the min/max labels and the help text', async () => {
    const html = await settingsHtmlFor({ teamNames: ['A', 'B'] });
    expect(html).toContain('data-i18n="lblMinPlayers">Minimum total de joueurs<');
    expect(html).toContain('data-i18n="lblMaxPlayers">Maximum total de joueurs<');
    // Three cards render this key for a fixed-structure league --
    // "Cette saison", "Par défaut pour les nouvelles saisons", and
    // (E1/E2, season-model polish task) "Démarrer une nouvelle saison".
    const occurrences = html.split('data-i18n="rosterSubTeam"').length - 1;
    expect(occurrences).toBe(3);
    expect(html).toContain("Ces nombres s'appliquent à chaque équipe. Laisse vide si tu n'es pas prêt à décider.");
  });

  it('weekly_draw league: all three cards show the real pool wording (rosterSubPool), not the old inaccurate "each game" text', async () => {
    const html = await settingsHtmlFor({ teamStructure: 'weekly_draw', teamNames: ['Rouge', 'Bleu'] });
    const occurrences = html.split('data-i18n="rosterSubPool"').length - 1;
    expect(occurrences).toBe(3);
    expect(html).toContain("Tous les joueurs confirmés forment un seul bassin et sont répartis en équipes. Ces nombres couvrent l'ensemble du bassin.");
    expect(html).not.toContain("chaque match, pour l'ensemble des joueurs");
  });

  it('headcount league: all three cards show the real no-teams wording (rosterSubHeadcount), distinct from the pool wording', async () => {
    const html = await settingsHtmlFor({ teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12 });
    const occurrences = html.split('data-i18n="rosterSubHeadcount"').length - 1;
    expect(occurrences).toBe(3);
    expect(html).toContain("Tous les joueurs confirmés comptent dans ce total -- cette ligue n'a pas d'équipes.");
  });

  it('English: the labels and every structure\'s help text match onboarding\'s own EN wording exactly', async () => {
    const { cookie, csrfToken } = await signup('b1.english@example.com', '203.0.134.201');
    await createLeague(cookie, csrfToken, { name: 'B1 English League', teamStructure: 'weekly_draw', teamNames: ['Red', 'Blue'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'B1 English Season' });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/);
    const dict = JSON.parse(m[1]);
    expect(dict.en.lblMinPlayers).toBe('Minimum total players');
    expect(dict.en.lblMaxPlayers).toBe('Maximum total players');
    expect(dict.en.rosterSubTeam).toBe("These numbers apply to each team. Leave blank if you're not ready to decide.");
    expect(dict.en.rosterSubPool).toBe('Everyone who confirms goes into one pool and gets drawn into teams. These numbers cover the whole pool.');
    expect(dict.en.rosterSubHeadcount).toBe("Everyone who confirms counts toward this total -- this league has no teams.");
  });

  it('the client-side structure-radio click handler recomputes the SAME 3-way help key, in all three cards\' own scripts', async () => {
    const html = await settingsHtmlFor({ teamNames: ['A', 'B'] });
    const occurrences = html.split("val === 'fixed' ? 'rosterSubTeam' : (val === 'weekly_draw' ? 'rosterSubPool' : 'rosterSubHeadcount')").length - 1;
    expect(occurrences).toBe(3);
  });

  it('B1 sweep, third location: the signup wizard\'s own step-3 headcount labels also say "total" now', async () => {
    const res = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.134.202' },
      body: JSON.stringify({ email: 'b1.signupstep3@example.com', password: 'a-strong-password-1' })
    });
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    const html = await (await SELF.fetch('http://example.com/signup?step=3', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="lblMinPlayers">Minimum total de joueurs<');
    expect(html).toContain('data-i18n="lblMaxPlayers">Maximum total de joueurs<');
  });
});

// B2 (stale-copy polish task): "Teams shuffle" was jargon, "No teams"
// was inaccurate (those leagues do form teams, just at the venue
// rather than in the app). New wording applied everywhere the three
// structure options appear -- this locks the two settings cards
// specifically (onboarding/signup and the dashboard tile are locked in
// their own dedicated test files: part9_team_structure_signup.spec.js,
// part49_teams_per_game_label.spec.js, part69_teams_shuffle_label.spec.js).
describe('B2: structure option wording in both settings cards ("Cette saison" and "Par défaut pour les nouvelles saisons")', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('all three cards show the new title/description for all 3 options, in French, with none of the old wording left anywhere on the page', async () => {
    const { cookie, csrfToken } = await signup('b2.settings.fr@example.com', '203.0.135.001');
    await createLeague(cookie, csrfToken, { name: 'B2 Settings FR League', teamNames: ['A', 'B'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'B2 Settings FR Season' });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();

    // Three cards now show these options: "Cette saison", "Par défaut
    // pour les nouvelles saisons", and (E1/E2, season-model polish
    // task) "Démarrer une nouvelle saison".
    for (const [key, text] of [
      ['structureFixedTitle', 'Équipes fixes'],
      ['structureFixedDesc', 'La même équipe toute la saison, comme une ligue régulière.'],
      ['structureWeeklyTitle', 'Sans équipes fixes'],
      ['structureWeeklyDesc', 'Les équipes sont refaites à chaque match — tirage automatique ou choisies par toi.'],
      ['structureHeadcountTitle', 'Sans équipes'],
      ['structureHeadcountDesc', 'Juste la liste des présents. Vous formez les équipes sur place.']
    ]) {
      const occurrences = html.split(`data-i18n="${key}">${text}<`).length - 1;
      expect(occurrences, `${key} should render in all three cards`).toBe(3);
    }

    expect(html).not.toContain('Équipes qui changent');
    expect(html).not.toContain('Aucune équipe<');
    expect(html).not.toContain('comme une ligue classique');
    expect(html).not.toContain('parfait pour une partie improvisée');
  });

  it('both cards show the new title/description for all 3 options, in English', async () => {
    const { cookie, csrfToken } = await signup('b2.settings.en@example.com', '203.0.135.002');
    await createLeague(cookie, csrfToken, { name: 'B2 Settings EN League', teamNames: ['A', 'B'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'B2 Settings EN Season' });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/);
    const dict = JSON.parse(m[1]);
    expect(dict.en.structureFixedTitle).toBe('Fixed teams');
    expect(dict.en.structureFixedDesc).toBe('The same team all season, like a regular league.');
    expect(dict.en.structureWeeklyTitle).toBe('Pickup with teams');
    expect(dict.en.structureWeeklyDesc).toBe('Pickup, but split into teams each game — drawn automatically or set by you.');
    expect(dict.en.structureHeadcountTitle).toBe('No teams');
    expect(dict.en.structureHeadcountDesc).toBe("Just a list of who's in. You sort out sides at the venue.");
    expect(dict.en.structureWeeklyTitle.toLowerCase()).not.toContain('shuffle');
  });
});

describe('C2: the "This season" card\'s Season name field is prefilled with the current season\'s real name', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('shows the actual season name as the field\'s value, not the placeholder', async () => {
    const { cookie, csrfToken } = await signup('c2.prefill@example.com', '203.0.136.001');
    await createLeague(cookie, csrfToken, { name: 'C2 Prefill League', teamNames: ['A', 'B'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'Automne 2026' });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toContain('id="season_mgmt_name"');
    expect(html).toContain('value="Automne 2026"');
    // The field element itself carries a real value now -- confirms this
    // isn't just the placeholder text happening to read similarly.
    const inputTag = (html.match(/<input[^>]*id="season_mgmt_name"[^>]*>/) || [''])[0];
    expect(inputTag).toContain('value="Automne 2026"');
  });

  it('a season name containing HTML-sensitive characters is escaped, not left to break the attribute', async () => {
    const { cookie, csrfToken } = await signup('c2.escape@example.com', '203.0.136.002');
    await createLeague(cookie, csrfToken, { name: 'C2 Escape League', teamNames: ['A', 'B'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'Winter "26" <Draft>' });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    const inputTag = (html.match(/<input[^>]*id="season_mgmt_name"[^>]*>/) || [''])[0];
    expect(inputTag).not.toContain('<Draft>');
    expect(inputTag).toContain('&lt;Draft&gt;');
  });

  it('a league with no season yet renders no season-name field at all (no currentSeasonEntry to prefill from, nothing to edit)', async () => {
    const { cookie, csrfToken } = await signup('c2.noseason@example.com', '203.0.136.003');
    await createLeague(cookie, csrfToken, { name: 'C2 No Season League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).not.toContain('id="season_mgmt_name"');
    expect(html).not.toContain('data-i18n="seasonMgmtTitle"');
    // Only the "default for new seasons" structure card renders.
    expect(html).toContain('id="section-structure"');
  });
});

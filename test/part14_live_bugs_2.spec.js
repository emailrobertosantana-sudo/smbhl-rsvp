// Four small UI issues found via live testing on notreligue.ca, fixed
// together:
// 1. The deactivate-league confirmation box had no guidance on what to
//    type.
// 2. The "Powered by Notre Ligue" public-page/RSVP-page footer wasn't
//    a link to the marketing homepage.
// 3. The dashboard's "Équipes" tile leaked the internal
//    HEADCOUNT_TEAM_NAME sentinel ("Tous") to the league's own admin
//    for headcount leagues.
// 4. weekly_draw's per-event team assignment gained a random-draw
//    convenience alongside the existing manual assignment.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part14-live-bugs-2-secret';
const RSVP_SECRET = 'test-part14-live-bugs-2-rsvp-secret';

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
  const league = (await res.json()).league;
  await SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ season_name: `${body.name} Season` })
  });
  return league;
}
async function addPlayer(cookie, csrfToken, name, extra = {}) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, ...extra })
  });
  return (await res.json()).contact.player_id;
}
async function createEvent(cookie, csrfToken, date) {
  return (await (await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ date })
  })).json()).event.id;
}
async function setStatus(cookie, csrfToken, eventId, playerId, status) {
  return SELF.fetch('http://example.com/league/rsvp/admin', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ event_id: eventId, player_id: playerId, status })
  });
}

describe('Live-testing issues, round 2', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    await applyRealSchema(env);
  });

  describe('Issue 1: deactivate confirmation guidance', () => {
    it('shows a translated label and a placeholder matching the real league name', async () => {
      const { cookie, csrfToken } = await signup('bugs2.deactivate.guidance@example.com', '203.0.117.001');
      await createLeague(cookie, csrfToken, { name: "L'Équipe Spéciale", teamNames: ['A', 'B'], tracksStats: true });
      const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
      const html = await res.text();
      expect(html).toContain('data-i18n="deactivateConfirmLabel"');
      expect(html).toContain('placeholder="L&#39;Équipe Spéciale"');
    });

    it('a different league\'s dashboard shows ITS OWN name as the placeholder, not a generic one', async () => {
      const { cookie, csrfToken } = await signup('bugs2.deactivate.guidance2@example.com', '203.0.117.002');
      await createLeague(cookie, csrfToken, { name: 'Totally Different League Name', teamNames: ['A', 'B'], tracksStats: true });
      const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
      const html = await res.text();
      expect(html).toContain('placeholder="Totally Different League Name"');
    });
  });

  describe('Issue 2: "Powered by Notre Ligue" footer links to the marketing homepage', () => {
    it('on the public page', async () => {
      const { cookie, csrfToken } = await signup('bugs2.footer.public@example.com', '203.0.117.003');
      const league = await createLeague(cookie, csrfToken, { name: 'Footer Public League', teamNames: ['A', 'B'], tracksStats: true });
      const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`);
      const html = await res.text();
      expect(html).toContain('<a class="pb-foot" href="https://notreligue.ca" data-i18n="poweredBy">');
    });

    it('on the RSVP page (both FR and EN render the same link target)', async () => {
      const { cookie, csrfToken } = await signup('bugs2.footer.rsvp@example.com', '203.0.117.004');
      await createLeague(cookie, csrfToken, { name: 'Footer RSVP League', teamNames: ['A', 'B'], tracksStats: true });
      const eventId = await createEvent(cookie, csrfToken, '2099-08-01');
      const playerId = await addPlayer(cookie, csrfToken, 'Footer RSVP Player', { team: 'A' });
      const salt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerId).first()).token_salt;

      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey('raw', encoder.encode(RSVP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const leagueId = (await env.DB.prepare('SELECT id FROM leagues WHERE name = ?').bind('Footer RSVP League').first()).id;
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`lr:${leagueId}:${eventId}:${playerId}:${salt}`));
      const token = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

      const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueId)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`);
      const html = await res.text();
      expect(html).toContain('<a class="rv-foot" href="https://notreligue.ca" data-i18n="poweredBy">');
    });
  });

  describe('Issue 3: dashboard "Équipes" tile shows meaningful text, not the internal sentinel', () => {
    it('fixed-mode league: shows the real team count and real team names, unaffected', async () => {
      const { cookie, csrfToken } = await signup('bugs2.tile.fixed@example.com', '203.0.117.005');
      await createLeague(cookie, csrfToken, { name: 'Tile Fixed League', teamNames: ['Otters', 'Falcons'], tracksStats: true });
      const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
      const html = await res.text();
      expect(html).toContain('<div class="stat tnum">2</div>');
      expect(html).toContain('>Otters<');
      expect(html).toContain('>Falcons<');
      expect(html).not.toContain('data-i18n="noFixedTeams"');
    });

    it('headcount league: shows "no fixed teams" text, never the internal sentinel, and drops the misleading team count from the status line', async () => {
      const { cookie, csrfToken } = await signup('bugs2.tile.headcount@example.com', '203.0.117.006');
      await createLeague(cookie, csrfToken, { name: 'Tile Headcount League', tracksStats: true, teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10 });
      const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
      const html = await res.text();
      expect(html).toContain('data-i18n="noFixedTeams"');
      expect(html).toContain('data-i18n="noFixedTeamsDesc"');
      expect(html).not.toContain('>Tous<');
      expect(html).not.toContain('<div class="nl-row"><span class="grow">Tous</span></div>');
      // The dash-status line ("N équipes · M joueurs") drops the team
      // count for headcount entirely rather than showing a misleading
      // "1 équipes".
      expect(html).not.toContain('<span data-i18n="teamsLabel">');
    });

    it('weekly_draw league: shows the real team count with a "per game" clarifying label, plus a short explanatory note', async () => {
      const { cookie, csrfToken } = await signup('bugs2.tile.weekly@example.com', '203.0.117.007');
      await createLeague(cookie, csrfToken, { name: 'Tile Weekly League', teamNames: ['Red', 'Blue'], tracksStats: true, teamStructure: 'weekly_draw' });
      const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
      const html = await res.text();
      expect(html).toContain('data-i18n="teamsPerGame"');
      expect(html).toContain('<div class="stat tnum">2</div>');
      expect(html).toContain('>Red<');
      expect(html).toContain('>Blue<');
      expect(html).toContain('data-i18n="weeklyDrawTeamsDesc"');
      expect(html).not.toContain('data-i18n="noFixedTeams"');
    });
  });

  describe('Issue 4: weekly_draw random draw', () => {
    it('assigns every confirmed unassigned player, only to real team names, covering the whole pool', async () => {
      const { cookie, csrfToken } = await signup('bugs2.randomdraw.basic@example.com', '203.0.117.008');
      await createLeague(cookie, csrfToken, { name: 'Random Draw Basic League', teamNames: ['Red', 'Blue'], tracksStats: true, teamStructure: 'weekly_draw' });
      const eventId = await createEvent(cookie, csrfToken, '2099-08-08');
      const players = [];
      for (let i = 0; i < 5; i++) {
        const p = await addPlayer(cookie, csrfToken, `Random Draw Player ${i}`);
        await setStatus(cookie, csrfToken, eventId, p, 'in');
        players.push(p);
      }

      const res = await SELF.fetch('http://example.com/league/events/random-assign', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId })
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.assigned).toBe(5);

      const rows = (await env.DB.prepare('SELECT player_id, team FROM rsvp WHERE event_id = ?').bind(eventId).all()).results;
      expect(rows.length).toBe(5);
      for (const row of rows) {
        expect(['Red', 'Blue']).toContain(row.team);
      }
      // Every confirmed player got covered.
      const assignedIds = rows.map(r => r.player_id).sort();
      expect(assignedIds).toEqual([...players].sort());
    });

    it('distributes goalies evenly across teams (2 goalies, 2 teams -> exactly 1 goalie per team)', async () => {
      const { cookie, csrfToken } = await signup('bugs2.randomdraw.goalies@example.com', '203.0.117.009');
      await createLeague(cookie, csrfToken, { name: 'Random Draw Goalie League', teamNames: ['Red', 'Blue'], tracksStats: true, teamStructure: 'weekly_draw' });
      const eventId = await createEvent(cookie, csrfToken, '2099-08-15');
      const g1 = await addPlayer(cookie, csrfToken, 'Goalie One', { role: 'sub_goalie' });
      const g2 = await addPlayer(cookie, csrfToken, 'Goalie Two', { role: 'sub_goalie' });
      const s1 = await addPlayer(cookie, csrfToken, 'Skater One');
      const s2 = await addPlayer(cookie, csrfToken, 'Skater Two');
      for (const p of [g1, g2, s1, s2]) await setStatus(cookie, csrfToken, eventId, p, 'in');

      const res = await SELF.fetch('http://example.com/league/events/random-assign', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId })
      });
      expect(res.status).toBe(200);

      const goalieRows = (await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id IN (?, ?)').bind(eventId, g1, g2).all()).results;
      expect(goalieRows.map(r => r.team).sort()).toEqual(['Blue', 'Red']);
    });

    it('manual assignment still works AFTER a random draw (override, not a replacement)', async () => {
      const { cookie, csrfToken } = await signup('bugs2.randomdraw.override@example.com', '203.0.117.010');
      await createLeague(cookie, csrfToken, { name: 'Random Draw Override League', teamNames: ['Red', 'Blue'], tracksStats: true, teamStructure: 'weekly_draw' });
      const eventId = await createEvent(cookie, csrfToken, '2099-08-22');
      const p1 = await addPlayer(cookie, csrfToken, 'Override Player');
      await setStatus(cookie, csrfToken, eventId, p1, 'in');

      await SELF.fetch('http://example.com/league/events/random-assign', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId })
      });
      const beforeRow = await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, p1).first();
      expect(['Red', 'Blue']).toContain(beforeRow.team);

      const overrideTeam = beforeRow.team === 'Red' ? 'Blue' : 'Red';
      const manualRes = await SELF.fetch('http://example.com/league/events/assign-team', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: p1, team: overrideTeam })
      });
      expect(manualRes.status).toBe(200);
      const afterRow = await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, p1).first();
      expect(afterRow.team).toBe(overrideTeam);
    });

    it('a random draw with nobody unassigned is a harmless no-op', async () => {
      const { cookie, csrfToken } = await signup('bugs2.randomdraw.empty@example.com', '203.0.117.011');
      await createLeague(cookie, csrfToken, { name: 'Random Draw Empty League', teamNames: ['Red', 'Blue'], tracksStats: true, teamStructure: 'weekly_draw' });
      const eventId = await createEvent(cookie, csrfToken, '2099-08-29');
      const res = await SELF.fetch('http://example.com/league/events/random-assign', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId })
      });
      expect(res.status).toBe(200);
      expect((await res.json()).assigned).toBe(0);
    });

    it('rejects a random draw for a non-weekly_draw league', async () => {
      const { cookie, csrfToken } = await signup('bugs2.randomdraw.wrongmode@example.com', '203.0.117.012');
      await createLeague(cookie, csrfToken, { name: 'Random Draw Wrong Mode League', teamNames: ['A', 'B'], tracksStats: true });
      const eventId = await createEvent(cookie, csrfToken, '2099-09-01');
      const res = await SELF.fetch('http://example.com/league/events/random-assign', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId })
      });
      expect(res.status).toBe(400);
      expect((await res.json()).errorKey).toBe('NOT_WEEKLY_DRAW');
    });

    it('the random-draw button only renders when there is an unassigned pool and more than one team', async () => {
      const { cookie, csrfToken } = await signup('bugs2.randomdraw.button@example.com', '203.0.117.013');
      await createLeague(cookie, csrfToken, { name: 'Random Draw Button League', teamNames: ['Red', 'Blue'], tracksStats: true, teamStructure: 'weekly_draw' });
      const eventId = await createEvent(cookie, csrfToken, '2099-09-08');
      const p1 = await addPlayer(cookie, csrfToken, 'Button Test Player');
      await setStatus(cookie, csrfToken, eventId, p1, 'in');

      const beforeRes = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } });
      const beforeHtml = await beforeRes.text();
      expect(beforeHtml).toContain('data-i18n="randomDraw"');

      await SELF.fetch('http://example.com/league/events/random-assign', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId })
      });
      const afterRes = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } });
      const afterHtml = await afterRes.text();
      // Nobody left unassigned -- the button has nothing to do, so it's
      // not shown (matches the "no more unassigned players" message).
      expect(afterHtml).not.toContain('data-i18n="randomDraw"');
    });
  });
});

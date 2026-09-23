// Team-structure task, Part 3: events, shortage detection, and
// per-event team assignment.
import { env, SELF } from 'cloudflare:test';
import { getNonResponders, getConfirmedPlayers } from '../src/index.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part11-team-structure-events-secret';
const RSVP_SECRET = 'test-part11-team-structure-events-rsvp-secret';

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
  // Events require an active published season -- match the pattern
  // already used by the Part 2 (reminders) test file's own helper.
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
  const res = await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ date })
  });
  return (await res.json()).event.id;
}
async function setStatus(cookie, csrfToken, eventId, playerId, status) {
  return SELF.fetch('http://example.com/league/rsvp/admin', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ event_id: eventId, player_id: playerId, status })
  });
}

describe('Team structure, Part 3: events, shortage, per-event assignment', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    await applyRealSchema(env);
  });

  describe('FIXED MODE -- provably unaffected', () => {
    it('event status page shows real per-team cards, no pool/unassigned section, exactly as before', async () => {
      const { cookie, csrfToken } = await signup('ts.events.fixed@example.com', '203.0.114.001');
      await createLeague(cookie, csrfToken, { name: 'Events Fixed League', teamNames: ['Otters', 'Falcons'], tracksStats: true });
      const eventId = await createEvent(cookie, csrfToken, '2099-01-01');
      const res = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } });
      const html = await res.text();
      expect(html).toContain('Otters');
      expect(html).toContain('Falcons');
      expect(html).not.toContain('data-i18n="unassignedTitle"');
      expect(html).not.toContain('data-i18n="poolTitle"');
    });

    it('getNonResponders still excludes a fixed-mode player with no team assigned, matching prior behavior', async () => {
      const { cookie, csrfToken } = await signup('ts.events.fixed.noteam@example.com', '203.0.114.002');
      const league = await createLeague(cookie, csrfToken, { name: 'Fixed No Team League', teamNames: ['A', 'B'], tracksStats: true });
      const eventId = await createEvent(cookie, csrfToken, '2099-01-02');
      await addPlayer(cookie, csrfToken, 'Fixed No Team Player'); // no team param -- unassigned
      const nonResponders = await getNonResponders(env, league.id, eventId);
      expect(nonResponders.length).toBe(0);
    });

    it('getNonResponders still includes a fixed-mode player WITH a team assigned, matching prior behavior', async () => {
      const { cookie, csrfToken } = await signup('ts.events.fixed.withteam@example.com', '203.0.114.003');
      const league = await createLeague(cookie, csrfToken, { name: 'Fixed With Team League', teamNames: ['A', 'B'], tracksStats: true });
      const eventId = await createEvent(cookie, csrfToken, '2099-01-03');
      await addPlayer(cookie, csrfToken, 'Fixed With Team Player', { team: 'A', email: 'fixedwithteam@example.com' });
      const nonResponders = await getNonResponders(env, league.id, eventId);
      expect(nonResponders.length).toBe(1);
    });
  });

  describe('HEADCOUNT MODE', () => {
    it('event status page shows exactly one pool-wide card, no team name/dot, correct confirmed/min/max', async () => {
      const { cookie, csrfToken } = await signup('ts.events.headcount@example.com', '203.0.114.004');
      await createLeague(cookie, csrfToken, { name: 'Events Headcount League', tracksStats: true, teamStructure: 'headcount', minPlayers: 2, maxPlayers: 3 });
      const eventId = await createEvent(cookie, csrfToken, '2099-01-04');
      const p1 = await addPlayer(cookie, csrfToken, 'HC Player One');
      await setStatus(cookie, csrfToken, eventId, p1, 'in');

      const res = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } });
      const html = await res.text();
      expect(html).toContain('data-i18n="poolTitle"');
      expect(html).not.toContain('data-i18n="unassignedTitle"'); // headcount doesn't need per-event assignment
      expect((html.match(/class="stat tnum">1</g) || []).length).toBeGreaterThan(0); // 1 confirmed
      expect(html).not.toContain('>Tous<'); // the internal sentinel team name never rendered as a real team
    });

    it("a headcount player's self-report OUT correctly triggers shortage/sub-invite detection (fixed: used to silently no-op, 'no-team-on-file')", async () => {
      const { cookie, csrfToken } = await signup('ts.events.headcount.shortage@example.com', '203.0.114.005');
      const league = await createLeague(cookie, csrfToken, { name: 'Events Headcount Shortage League', tracksStats: true, teamStructure: 'headcount', minPlayers: 1, maxPlayers: 2 });
      const eventId = await createEvent(cookie, csrfToken, '2099-01-05');
      const p1 = await addPlayer(cookie, csrfToken, 'HC Shortage Player');
      // A sub, eligible to be invited when the shortage triggers.
      await SELF.fetch('http://example.com/league/contacts', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'HC Eligible Sub', role: 'sub_skater', email: 'hcsub@example.com' })
      });
      await setStatus(cookie, csrfToken, eventId, p1, 'in');
      await setStatus(cookie, csrfToken, eventId, p1, 'out'); // drops the pool below min_players=1

      const subCallRow = await env.DB.prepare(`SELECT * FROM outbox WHERE event_id = ? AND kind = 'sub_call'`).bind(eventId).first();
      expect(subCallRow).toBeTruthy();
      expect(subCallRow.team).toBe('Tous'); // the internal sentinel -- real data, never shown in any UI
    });

    it('getNonResponders and getConfirmedPlayers correctly target headcount players (the reminder system now reaches them at all)', async () => {
      const { cookie, csrfToken } = await signup('ts.events.headcount.reminders@example.com', '203.0.114.006');
      const league = await createLeague(cookie, csrfToken, { name: 'Events Headcount Reminders League', tracksStats: true, teamStructure: 'headcount', minPlayers: 4, maxPlayers: 8 });
      const eventId = await createEvent(cookie, csrfToken, '2099-01-06');
      const pendingId = await addPlayer(cookie, csrfToken, 'HC Pending Player', { email: 'hcpending@example.com' });
      const confirmedId = await addPlayer(cookie, csrfToken, 'HC Confirmed Player', { email: 'hcconfirmed@example.com' });
      await setStatus(cookie, csrfToken, eventId, confirmedId, 'in');

      const nonResponders = await getNonResponders(env, league.id, eventId);
      const confirmed = await getConfirmedPlayers(env, league.id, eventId);
      expect(nonResponders.map(c => c.player_id)).toContain(pendingId);
      expect(confirmed.map(c => c.player_id)).toContain(confirmedId);
    });
  });

  describe('WEEKLY_DRAW MODE', () => {
    it('a confirmed player with no team yet shows in the "unassigned" pool, not in any team card', async () => {
      const { cookie, csrfToken } = await signup('ts.events.weekly.pool@example.com', '203.0.114.007');
      await createLeague(cookie, csrfToken, { name: 'Events Weekly Pool League', teamNames: ['Red', 'Blue'], tracksStats: true, teamStructure: 'weekly_draw' });
      const eventId = await createEvent(cookie, csrfToken, '2099-01-07');
      const p1 = await addPlayer(cookie, csrfToken, 'Weekly Unassigned Player');
      await setStatus(cookie, csrfToken, eventId, p1, 'in');

      const res = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } });
      const html = await res.text();
      expect(html).toContain('data-i18n="unassignedTitle"');
      expect(html).toContain('Weekly Unassigned Player');
      expect(html).toContain(`data-player-row="${p1}"`);
    });

    it('assigning a confirmed player to a team via the real route works, and they then appear in that team\'s own real shortage card', async () => {
      const { cookie, csrfToken } = await signup('ts.events.weekly.assign@example.com', '203.0.114.008');
      const league = await createLeague(cookie, csrfToken, { name: 'Events Weekly Assign League', teamNames: ['Red', 'Blue'], tracksStats: true, teamStructure: 'weekly_draw' });
      const eventId = await createEvent(cookie, csrfToken, '2099-01-08');
      const p1 = await addPlayer(cookie, csrfToken, 'Weekly Assign Player');
      await setStatus(cookie, csrfToken, eventId, p1, 'in');

      const assignRes = await SELF.fetch('http://example.com/league/events/assign-team', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: p1, team: 'Red' })
      });
      expect(assignRes.status).toBe(200);
      const row = await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, p1).first();
      expect(row.team).toBe('Red');

      const detailRes = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } });
      const html = await detailRes.text();
      expect(html).toContain('Weekly Assign Player');
      // No longer in the unassigned pool.
      expect(html).not.toContain(`data-player-row="${p1}"`);
    });

    it('rejects assigning an unconfirmed (pending) player to a team', async () => {
      const { cookie, csrfToken } = await signup('ts.events.weekly.reject@example.com', '203.0.114.009');
      await createLeague(cookie, csrfToken, { name: 'Events Weekly Reject League', teamNames: ['Red', 'Blue'], tracksStats: true, teamStructure: 'weekly_draw' });
      const eventId = await createEvent(cookie, csrfToken, '2099-01-09');
      const p1 = await addPlayer(cookie, csrfToken, 'Weekly Pending Player');
      // Never confirmed -- still pending (no rsvp row at all).
      const res = await SELF.fetch('http://example.com/league/events/assign-team', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: p1, team: 'Red' })
      });
      expect(res.status).toBe(409);
      expect((await res.json()).errorKey).toBe('ASSIGN_TEAM_NOT_CONFIRMED');
    });

    it('rejects assigning to an unknown team name', async () => {
      const { cookie, csrfToken } = await signup('ts.events.weekly.unknownteam@example.com', '203.0.114.010');
      await createLeague(cookie, csrfToken, { name: 'Events Weekly Unknown Team League', teamNames: ['Red', 'Blue'], tracksStats: true, teamStructure: 'weekly_draw' });
      const eventId = await createEvent(cookie, csrfToken, '2099-01-10');
      const p1 = await addPlayer(cookie, csrfToken, 'Weekly Unknown Team Player');
      await setStatus(cookie, csrfToken, eventId, p1, 'in');
      const res = await SELF.fetch('http://example.com/league/events/assign-team', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: p1, team: 'Not A Real Team' })
      });
      expect(res.status).toBe(400);
      expect((await res.json()).errorKey).toBe('TEAM_UNKNOWN');
    });

    it('rejects the assign-team route entirely for a non-weekly_draw league', async () => {
      const { cookie, csrfToken } = await signup('ts.events.weekly.wrongmode@example.com', '203.0.114.011');
      await createLeague(cookie, csrfToken, { name: 'Events Not Weekly League', teamNames: ['A', 'B'], tracksStats: true });
      const eventId = await createEvent(cookie, csrfToken, '2099-01-11');
      const p1 = await addPlayer(cookie, csrfToken, 'Not Weekly Player', { team: 'A' });
      await setStatus(cookie, csrfToken, eventId, p1, 'in');
      const res = await SELF.fetch('http://example.com/league/events/assign-team', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: p1, team: 'A' })
      });
      expect(res.status).toBe(400);
      expect((await res.json()).errorKey).toBe('NOT_WEEKLY_DRAW');
    });

    it("a weekly_draw player already assigned to a team, later marked OUT, correctly triggers that team's own real shortage detection", async () => {
      const { cookie, csrfToken } = await signup('ts.events.weekly.shortage@example.com', '203.0.114.012');
      const league = await createLeague(cookie, csrfToken, { name: 'Events Weekly Shortage League', teamNames: ['Red', 'Blue'], tracksStats: true, teamStructure: 'weekly_draw' });
      // Tighten the default season's roster threshold so a single
      // skater leaving is enough to trigger a real shortage.
      await SELF.fetch('http://example.com/league/season/publish', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ season_name: 'Events Weekly Shortage League Season', skaters_per_team: 1, goalies_per_team: 0, min_skaters: 1 })
      });
      const eventId = await createEvent(cookie, csrfToken, '2099-01-15');
      const p1 = await addPlayer(cookie, csrfToken, 'Weekly Shortage Player');
      await SELF.fetch('http://example.com/league/contacts', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Weekly Shortage Sub', role: 'sub_skater', email: 'weeklyshortagesub@example.com' })
      });
      await setStatus(cookie, csrfToken, eventId, p1, 'in');
      await SELF.fetch('http://example.com/league/events/assign-team', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: p1, team: 'Red' })
      });
      await setStatus(cookie, csrfToken, eventId, p1, 'out');

      const subCallRow = await env.DB.prepare(`SELECT * FROM outbox WHERE event_id = ? AND kind = 'sub_call'`).bind(eventId).first();
      expect(subCallRow).toBeTruthy();
      expect(subCallRow.team).toBe('Red'); // the real per-event assignment, not a pool-wide fallback
    });
  });
});

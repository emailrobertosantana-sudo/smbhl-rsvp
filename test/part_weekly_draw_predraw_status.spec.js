// Group A (weekly_draw pre-draw UI bug fix task): weekly_draw leagues
// have no rsvp.team for any confirmed player until a real draw has
// happened for that event -- a per-team shortage/invite query run
// before that point sees every team as completely empty and reports
// it maximally "short" regardless of real confirmed count, and an
// "invite a goalie for Team X" button is meaningless when nobody is on
// Team X yet. Covers A1 (pool-wide pre-draw status, real per-team
// status after) and A2 (pool-wide pre-draw invite target, real
// per-team target after) specifically across the pre/post-draw
// boundary -- the bug is entirely about which side of it you're on.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-weekly-draw-predraw-secret';

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
async function createWeeklyDrawLeague(cookie, csrfToken, name, seasonOverrides = {}) {
  const res = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, teamStructure: 'weekly_draw', teamNames: ['Rouge / Red', 'Bleu / Blue'], tracksStats: true })
  });
  const league = (await res.json()).league;
  await SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    // goalies_per_team: 1 explicit (matches DEFAULT_SEASON_CONFIG anyway --
    // handleLeagueSeasonPublish's own override loop ignores a 0, `n > 0`)
    // so the pool-wide math below has a single, unambiguous known target:
    // 4 skaters/team + 1 goalie/team, x2 teams = 8 skaters + 2 goalies = 10.
    body: JSON.stringify({ season_name: `${name} Season`, skaters_per_team: 4, min_skaters: 4, goalies_per_team: 1, ...seasonOverrides })
  });
  return league;
}
async function addPlayer(cookie, csrfToken, name, email) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, email })
  });
  return (await res.json()).contact;
}
async function createEvent(cookie, csrfToken, date) {
  const res = await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ date })
  });
  return (await res.json()).event.id;
}
async function setIn(cookie, csrfToken, eventId, playerId) {
  await SELF.fetch('http://example.com/league/rsvp/admin', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ event_id: eventId, player_id: playerId, status: 'in' })
  });
}
async function detailHtml(cookie, eventId) {
  const res = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } });
  return res.text();
}
function countOccurrences(html, needle) {
  return (html.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
}

describe('A1/A2: weekly_draw pre-draw vs post-draw event status and invite targeting', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('A1 pre-draw: one pool-wide card (not one meaninglessly-short card per team)', async () => {
    const { cookie, csrfToken } = await signup('predraw.status@example.com', '203.0.140.001');
    const league = await createWeeklyDrawLeague(cookie, csrfToken, 'Predraw Status League');
    const eventId = await createEvent(cookie, csrfToken, '2099-05-01');
    // 3 confirmed, no draw yet. Pool target: (4 skaters + 1 goalie)/team x 2 teams = 10.
    for (const n of ['Player One', 'Player Two', 'Player Three']) await setIn(cookie, csrfToken, eventId, (await addPlayer(cookie, csrfToken, n)).player_id);

    const html = await detailHtml(cookie, eventId);
    // Exactly ONE pool card (poolTitle), not one per team -- the bug's
    // own symptom was every team's card independently reading "short".
    expect(countOccurrences(html, 'data-i18n="poolTitle"')).toBe(1);
    expect(countOccurrences(html, 'data-i18n="short"')).toBe(1);
    // Pool-wide confirmed count (3), not a per-team count (0, since no
    // rsvp.team is set yet) -- the exact defect A1 describes.
    expect(html).toContain('<span class="stat tnum">3</span><span data-i18n="confirmed"');
    // Pool-wide open spots: 10 needed - 3 confirmed = 7, not 10 (the old
    // per-team-with-nobody-assigned-yet reading, x2 teams).
    expect(html).toContain('<span data-i18n="short">Manque</span> 7</span>');
  });

  it('A1 post-draw: real per-team cards return once a draw has actually happened', async () => {
    const { cookie, csrfToken } = await signup('postdraw.status@example.com', '203.0.140.002');
    const league = await createWeeklyDrawLeague(cookie, csrfToken, 'Postdraw Status League');
    const eventId = await createEvent(cookie, csrfToken, '2099-05-08');
    for (const n of ['Player Four', 'Player Five', 'Player Six']) await setIn(cookie, csrfToken, eventId, (await addPlayer(cookie, csrfToken, n)).player_id);

    await SELF.fetch('http://example.com/league/events/random-assign', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId })
    });

    const html = await detailHtml(cookie, eventId);
    // No pool card once a draw has happened -- back to real per-team cards.
    expect(countOccurrences(html, 'data-i18n="poolTitle"')).toBe(0);
    expect(html).toContain('Rouge / Red');
    expect(html).toContain('Bleu / Blue');
    // 3 players split across 2 teams (4 needed each) -- both teams
    // genuinely short now, each independently, which IS correct post-draw.
    expect(countOccurrences(html, 'data-i18n="short"')).toBe(2);
  });

  it('A2 pre-draw: invite-subs targets the pool (no team required, labeled with the league\'s own name), not a specific team', async () => {
    const { cookie, csrfToken } = await signup('predraw.invite@example.com', '203.0.140.003');
    const league = await createWeeklyDrawLeague(cookie, csrfToken, 'Predraw Invite League');
    const eventId = await createEvent(cookie, csrfToken, '2099-05-15');
    await setIn(cookie, csrfToken, eventId, (await addPlayer(cookie, csrfToken, 'Sole Confirmed')).player_id);
    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Eligible Sub', email: 'eligiblesub@example.com', role: 'sub_skater' })
    });

    // No team in the request at all -- the pool card's own button posts
    // '', but the route must not depend on that; it re-derives pre/post
    // draw state itself.
    const res = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, need: 'skater' })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.invited).toBeGreaterThanOrEqual(1);
    // Never a real team name pre-draw -- the invite is labeled with the
    // league's own name instead (see handleLeagueInviteSubs' own comment).
    expect(json.team).toBe('Predraw Invite League');
    expect(['Rouge / Red', 'Bleu / Blue']).not.toContain(json.team);

    const outboxRow = await env.DB.prepare(
      `SELECT team FROM outbox WHERE event_id = ? AND kind = 'sub_call' ORDER BY id DESC LIMIT 1`
    ).bind(eventId).first();
    expect(outboxRow.team).toBe('Predraw Invite League');
  });

  it('A2 post-draw: invite-subs still requires a real, specific team name -- unchanged from before this task', async () => {
    const { cookie, csrfToken } = await signup('postdraw.invite@example.com', '203.0.140.004');
    const league = await createWeeklyDrawLeague(cookie, csrfToken, 'Postdraw Invite League');
    const eventId = await createEvent(cookie, csrfToken, '2099-05-22');
    await setIn(cookie, csrfToken, eventId, (await addPlayer(cookie, csrfToken, 'Drawn Player')).player_id);
    await SELF.fetch('http://example.com/league/events/random-assign', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId })
    });

    const missingTeamRes = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, need: 'skater' })
    });
    expect(missingTeamRes.status).toBe(400);
    expect((await missingTeamRes.json()).errorKey).toBe('TEAM_UNKNOWN');

    const realTeamRes = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, team: 'Rouge / Red', need: 'skater' })
    });
    expect(realTeamRes.status).toBe(200);
    expect((await realTeamRes.json()).team).toBe('Rouge / Red');
  });

  it('non-weekly_draw leagues are completely unaffected: invite-subs still requires a real team, fixed leagues still get per-team cards immediately', async () => {
    const { cookie, csrfToken } = await signup('fixed.unaffected@example.com', '203.0.140.005');
    const res = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Fixed Unaffected League', teamNames: ['A', 'B'], tracksStats: true })
    });
    const league = (await res.json()).league;
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Fixed Unaffected Season' })
    });
    const eventId = await createEvent(cookie, csrfToken, '2099-05-29');

    const html = await detailHtml(cookie, eventId);
    expect(countOccurrences(html, 'data-i18n="poolTitle"')).toBe(0);
    expect(countOccurrences(html, 'data-i18n="short"')).toBe(2); // both real teams, immediately, as always

    const missingTeamRes = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, need: 'skater' })
    });
    expect(missingTeamRes.status).toBe(400);
    expect((await missingTeamRes.json()).errorKey).toBe('TEAM_UNKNOWN');
  });
});

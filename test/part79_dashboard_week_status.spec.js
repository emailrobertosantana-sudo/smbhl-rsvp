// Live-testing task (batch 6), Part 8 (BIG): "current-week status" on
// the league product's dashboard home.
//
// SMBHL's own admin home is /admin/board (boardPage/boardData): for
// the next open game, it shows every team's live roster with each
// player's RSVP status, skater/goalie counts against the season's own
// targets, a shortage flag (teamState -- goalies/skaters below the
// season's minimum), a substitute waitlist, and drag-drop team
// balance. It's the FIRST thing an SMBHL admin sees on login, built to
// answer "how's tonight looking" at a glance.
//
// The league product already has an equivalent DETAIL surface for all
// of that (GET /league/events/detail, handleLeagueEventDetailPage --
// per-team rosters, invite-a-sub, assign/random-draw, reminders). What
// the dashboard HOME (GET /dashboard) was missing was SMBHL's other
// habit: the at-a-glance view on login, without opening a specific
// event. This part adds exactly that -- a compact "Cette semaine" /
// "This week" card -- and nothing more; the full roster/invite/assign
// tooling stays on the existing detail page, linked from this card.
//
// Built on eventWeekStatus (src/index.js, next to teamState/openSpots)
// -- reuses teamState for shortage detection (the SAME function
// SMBHL's own board and the league product's event-detail/public pages
// already call), not a reimplementation. confirmed/out/no-response
// counts come from one aggregate query, structure-agnostic; only the
// shortage computation branches per team_structure (see that
// function's own comment for why weekly_draw needs a pool-wide
// approximation instead of teamState's normal per-team call).
//
// SMBHL's own /admin/board is completely untouched by this part --
// this card is additive to the league product's dashboard only.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part79-dashboard-week-status-secret';

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
async function createEvent(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).event;
}
async function addContact(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).contact;
}
async function setRsvp(eventId, playerId, team, status, leagueId) {
  await env.DB.prepare(
    `INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id)
     VALUES (?, ?, ?, ?, 'roster', 'self', ?, ?)`
  ).bind(eventId, playerId, team, status, new Date().toISOString(), leagueId).run();
}
async function fetchDashboard(cookie) {
  return (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
}

describe('Part 8 (live-testing task, batch 6): dashboard home shows "current-week status" -- next event, RSVP counts, shortage state', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a league with no season yet shows no week-status card at all', async () => {
    const { cookie, csrfToken } = await signup('weekstatus.needsseason@example.com', '203.0.196.001');
    await createLeague(cookie, csrfToken, { name: 'Week Status Needs Season League', teamNames: ['A', 'B'] });
    const html = await fetchDashboard(cookie);
    expect(html).not.toContain('data-i18n="weekStatusTitle"');
  });

  it("a season with no events yet shows NO week-status card at all -- \"create the schedule\" now lives in the one, unified next-steps checklist instead (B3)", async () => {
    const { cookie, csrfToken } = await signup('weekstatus.noevents@example.com', '203.0.196.002');
    await createLeague(cookie, csrfToken, { name: 'Week Status No Events League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const html = await fetchDashboard(cookie);
    expect(html).not.toContain('data-i18n="weekStatusTitle"');
    expect(html).toContain('data-i18n="nextStepsTitle"');
    expect(html).toContain('data-i18n="nsCreateSchedule"');
    expect(html).toContain('href="/league/schedule"');
  });

  it('the week-status card only counts an UPCOMING event (a past-dated one doesn\'t show it), but a past-only schedule still counts as "already created" for the next-steps checklist -- it\'s a finished schedule, not a missing one', async () => {
    const { cookie, csrfToken } = await signup('weekstatus.pastevent@example.com', '203.0.196.003');
    await createLeague(cookie, csrfToken, { name: 'Week Status Past Event League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await createEvent(cookie, csrfToken, { date: '2020-01-01' });
    const html = await fetchDashboard(cookie);
    expect(html).not.toContain('data-i18n="weekStatusTitle"');
    expect(html).not.toContain('data-i18n="nsCreateSchedule"');
  });

  it('fixed structure: shows real confirmed/out/no-response counts for the next event, and a shortage badge while under the season minimum', async () => {
    const { cookie, csrfToken } = await signup('weekstatus.fixed@example.com', '203.0.196.004');
    const league = await createLeague(cookie, csrfToken, { name: 'Week Status Fixed League', teamNames: ['Otters', 'Falcons'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1', min_skaters: 1, skaters_per_team: 2, goalies_per_team: 0 });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-06-15', venue: 'Test Rink' });

    const p1 = await addContact(cookie, csrfToken, { name: 'Player One', role: 'roster', team: 'Otters' });
    const p2 = await addContact(cookie, csrfToken, { name: 'Player Two', role: 'roster', team: 'Otters' });
    const p3 = await addContact(cookie, csrfToken, { name: 'Player Three', role: 'roster', team: 'Falcons' });
    await setRsvp(ev.id, p1.player_id, 'Otters', 'in', league.id);
    await setRsvp(ev.id, p2.player_id, 'Otters', 'out', league.id);
    // p3 never responds -- counts as no-response.

    const html = await fetchDashboard(cookie);
    expect(html).toContain('data-i18n="weekStatusTitle"');
    expect(html).toContain('Test Rink');
    expect(html).toContain(`href="/league/events/detail?e=${encodeURIComponent(ev.id)}"`);
    const confirmedIdx = html.indexOf('nl-badge--in');
    const outIdx = html.indexOf('nl-badge--out');
    const noRespIdx = html.indexOf('nl-badge--pending', confirmedIdx);
    expect(confirmedIdx).toBeGreaterThan(-1);
    expect(outIdx).toBeGreaterThan(-1);
    expect(noRespIdx).toBeGreaterThan(-1);
    // Otters: min_skaters=1 satisfied by p1 alone -- Falcons: p3 hasn't
    // confirmed, 0 < 1 minimum -- short overall.
    expect(html).toContain('data-i18n="weekStatusShort"');
  });

  it('fixed structure: no shortage badge once every team meets its minimum (skaters AND goalies)', async () => {
    const { cookie, csrfToken } = await signup('weekstatus.fixedfull@example.com', '203.0.196.005');
    const league = await createLeague(cookie, csrfToken, { name: 'Week Status Fixed Full League', teamNames: ['Otters', 'Falcons'] });
    // goalies_per_team: 0 is silently ignored by handleLeagueSeasonPublish
    // (n > 0 required -- see its own comment) and falls back to
    // DEFAULT_SEASON_CONFIG.goaliesPerTeam (1), so a real 1 is requested
    // explicitly here and a confirmed goalie is given to each team --
    // otherwise this "no shortage" case would spuriously stay short on
    // the goalie floor alone.
    await publishSeason(cookie, csrfToken, { season_name: 'S1', min_skaters: 1, skaters_per_team: 2, goalies_per_team: 1 });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-06-16' });

    const p1 = await addContact(cookie, csrfToken, { name: 'Full Player One', role: 'roster', team: 'Otters' });
    const p2 = await addContact(cookie, csrfToken, { name: 'Full Player Two', role: 'roster', team: 'Falcons' });
    const g1 = await addContact(cookie, csrfToken, { name: 'Full Goalie One', role: 'roster', team: 'Otters', is_goalie: true });
    const g2 = await addContact(cookie, csrfToken, { name: 'Full Goalie Two', role: 'roster', team: 'Falcons', is_goalie: true });
    await setRsvp(ev.id, p1.player_id, 'Otters', 'in', league.id);
    await setRsvp(ev.id, p2.player_id, 'Falcons', 'in', league.id);
    await setRsvp(ev.id, g1.player_id, 'Otters', 'in', league.id);
    await setRsvp(ev.id, g2.player_id, 'Falcons', 'in', league.id);

    const html = await fetchDashboard(cookie);
    expect(html).not.toContain('data-i18n="weekStatusShort"');
  });

  it('headcount structure: shortage is pool-wide (single implicit team), using the same teamState the public page already relies on', async () => {
    const { cookie, csrfToken } = await signup('weekstatus.headcount@example.com', '203.0.196.006');
    const league = await createLeague(cookie, csrfToken, { name: 'Week Status Headcount League', teamStructure: 'headcount', minPlayers: 3, maxPlayers: 10 });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-06-17' });

    const p1 = await addContact(cookie, csrfToken, { name: 'Headcount Player One', role: 'roster' });
    // 'Tous' is HEADCOUNT_TEAM_NAME (league_ids.js) -- the single
    // implicit team every headcount RSVP is written against.
    await setRsvp(ev.id, p1.player_id, 'Tous', 'in', league.id);

    const html = await fetchDashboard(cookie);
    expect(html).toContain('data-i18n="weekStatusTitle"');
    // Only 1 confirmed against a minimum of 3 -- short.
    expect(html).toContain('data-i18n="weekStatusShort"');
  });

  it('weekly_draw structure: confirmed players count toward the pool total even before any per-event team draw has happened', async () => {
    const { cookie, csrfToken } = await signup('weekstatus.weeklydraw@example.com', '203.0.196.007');
    const league = await createLeague(cookie, csrfToken, { name: 'Week Status Weekly Draw League', teamStructure: 'weekly_draw', teamNames: ['Rouge', 'Bleu'] });
    // goalies_per_team: 0 is silently ignored (see the fixed-mode "no
    // shortage" test's own comment) -- 1 is requested explicitly and a
    // confirmed goalie is given, matching that same reasoning.
    await publishSeason(cookie, csrfToken, { season_name: 'S1', min_skaters: 1, skaters_per_team: 2, goalies_per_team: 1 });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-06-18' });

    const p1 = await addContact(cookie, csrfToken, { name: 'Draw Player One', role: 'roster' });
    const p2 = await addContact(cookie, csrfToken, { name: 'Draw Player Two', role: 'roster' });
    const g1 = await addContact(cookie, csrfToken, { name: 'Draw Goalie One', role: 'roster', is_goalie: true });
    const g2 = await addContact(cookie, csrfToken, { name: 'Draw Goalie Two', role: 'roster', is_goalie: true });
    // No draw has happened yet for this event -- rsvp.team is null,
    // exactly like a real pre-draw RSVP. If the shortage computation
    // wrongly used teamState per named team (WHERE r.team = ?), it
    // would see 0 confirmed for both 'Rouge' and 'Bleu' even though 4
    // real players confirmed -- the whole reason this needs its own
    // pool-wide branch instead of fixed's per-team one.
    await setRsvp(ev.id, p1.player_id, null, 'in', league.id);
    await setRsvp(ev.id, p2.player_id, null, 'in', league.id);
    await setRsvp(ev.id, g1.player_id, null, 'in', league.id);
    await setRsvp(ev.id, g2.player_id, null, 'in', league.id);

    const html = await fetchDashboard(cookie);
    expect(html).toContain('data-i18n="weekStatusTitle"');
    // 2 confirmed skaters against a need of 1 x 2 teams = 2, and 2
    // confirmed goalies against a need of 1 x 2 teams = 2 -- both
    // exactly met, not short.
    expect(html).not.toContain('data-i18n="weekStatusShort"');
  });

  it("League A's dashboard never shows League B's event/status data", async () => {
    const a = await signup('weekstatus.isoA@example.com', '203.0.196.008');
    const b = await signup('weekstatus.isoB@example.com', '203.0.196.009');
    await createLeague(a.cookie, a.csrfToken, { name: 'Week Status Iso League A', teamNames: ['A1', 'A2'] });
    await createLeague(b.cookie, b.csrfToken, { name: 'Week Status Iso League B', teamNames: ['B1', 'B2'] });
    await publishSeason(a.cookie, a.csrfToken, { season_name: 'S1' });
    await publishSeason(b.cookie, b.csrfToken, { season_name: 'S1' });
    await createEvent(b.cookie, b.csrfToken, { date: '2099-06-19', venue: 'League B Only Rink' });

    const htmlA = await fetchDashboard(a.cookie);
    expect(htmlA).not.toContain('League B Only Rink');
    expect(htmlA).not.toContain('data-i18n="weekStatusTitle"');
    expect(htmlA).toContain('data-i18n="nsCreateSchedule"');
  });
});

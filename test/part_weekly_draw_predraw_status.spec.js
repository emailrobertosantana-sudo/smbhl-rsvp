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

// Item 1 (admin-confirm-players polish task): the previous batch's
// E3 test claimed this whole feature (admin IN/OUT rows on the league
// event page) was already built and reachable -- true for fixed/
// headcount/post-draw weekly_draw (the per-team loop, handled by
// test/part3_admin_rsvp_edit.spec.js), but FALSE for a weekly_draw
// event before its first draw: that state renders poolCardHtml, which
// used to be aggregate-counts-only (a GROUP BY query, no player rows
// at all) -- exactly the state a brand-new weekly_draw event starts
// in. This proves the CONTROLS THEMSELVES are present and wired on
// the rendered page in that specific state, not just that the
// underlying route works when called directly.
describe('Item 1 (players/admin-confirm polish task): weekly_draw pre-draw pool gets real per-player IN/OUT rows, not aggregate-only', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = 'test-weekly-draw-predraw-rsvp-secret';
    await applyRealSchema(env);
  });

  it('renders one row per roster player with wired setPlayerStatus IN/OUT buttons, before any draw has happened', async () => {
    const { cookie, csrfToken } = await signup('item1.predraw.rows@example.com', '203.0.141.001');
    const league = await createWeeklyDrawLeague(cookie, csrfToken, 'Item1 Predraw Rows League');
    const p1 = await addPlayer(cookie, csrfToken, 'Predraw Row Player One', 'predraw1@example.com');
    const p2 = await addPlayer(cookie, csrfToken, 'Predraw Row Player Two', 'predraw2@example.com');
    const eventId = await createEvent(cookie, csrfToken, '2099-06-01');

    const html = await detailHtml(cookie, eventId);
    // Genuinely still pre-draw (poolTitle, not per-team cards).
    expect(html).toContain('data-i18n="poolTitle"');
    // Both players actually appear as real rows, each with its own
    // wired IN/OUT control -- not just aggregate counts.
    expect(html).toContain(`data-pool-player-row="${p1.player_id}"`);
    expect(html).toContain(`data-pool-player-row="${p2.player_id}"`);
    expect(html).toContain(`setPlayerStatus('${p1.player_id}','in',this)`);
    expect(html).toContain(`setPlayerStatus('${p1.player_id}','out',this)`);
    expect(html).toContain(`setPlayerStatus('${p2.player_id}','in',this)`);
    expect(html).toContain('Predraw Row Player One');
    expect(html).toContain('Predraw Row Player Two');
  });

  it('confirming a player IN through this pre-draw pool list is silent (no email) and the RSVP row + outbox both prove it', async () => {
    const { cookie, csrfToken } = await signup('item1.predraw.silent@example.com', '203.0.141.002');
    const league = await createWeeklyDrawLeague(cookie, csrfToken, 'Item1 Predraw Silent League');
    const player = await addPlayer(cookie, csrfToken, 'Predraw Silent Player', 'predrawsilent@example.com');
    const eventId = await createEvent(cookie, csrfToken, '2099-06-02');

    const originalFetch = globalThis.fetch;
    const sentMails = [];
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('api.resend.com')) { sentMails.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ id: 'mock' }), { status: 200 }); }
      return originalFetch(url, opts);
    };
    let res;
    try {
      // Exactly the request the rendered IN button issues.
      res = await SELF.fetch('http://example.com/league/rsvp/admin', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: player.player_id, status: 'in' })
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(res.status).toBe(200);
    expect(sentMails.length).toBe(0);

    const rsvpRow = await env.DB.prepare('SELECT status, status_by FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, player.player_id).first();
    expect(rsvpRow.status).toBe('in');
    expect(rsvpRow.status_by).toBe('manager');
    const outboxRow = await env.DB.prepare('SELECT * FROM outbox WHERE event_id = ? AND player_id = ?').bind(eventId, player.player_id).first();
    expect(outboxRow).toBeNull();

    // The row on the page now reflects it immediately (server-rendered
    // status badge, re-fetched after the change -- setPlayerStatus's
    // own reload is how the real UI does this).
    const html = await detailHtml(cookie, eventId);
    const rowIdx = html.indexOf(`data-pool-player-row="${player.player_id}"`);
    const rowEnd = html.indexOf('</div>', html.indexOf('</div>', rowIdx) + 6);
    expect(html.slice(rowIdx, rowEnd)).toContain('data-i18n="statusIn"');
  });

  it('goalies and "can also play goalie" players are distinguishable in the pre-draw pool list', async () => {
    const { cookie, csrfToken } = await signup('item1.predraw.goalie@example.com', '203.0.141.003');
    const league = await createWeeklyDrawLeague(cookie, csrfToken, 'Item1 Predraw Goalie League');
    const goalieRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Predraw Real Goalie', email: 'predrawgoalie@example.com', is_goalie: true })
    });
    const goalie = (await goalieRes.json()).contact;
    const backupRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Predraw Backup Goalie Player', email: 'predrawbackup@example.com', is_goalie: false, is_backup_goalie: true })
    });
    const backup = (await backupRes.json()).contact;
    const eventId = await createEvent(cookie, csrfToken, '2099-06-03');

    const html = await detailHtml(cookie, eventId);
    const goalieRowStart = html.indexOf(`data-pool-player-row="${goalie.player_id}"`);
    const goalieRowEnd = html.indexOf('</div>', html.indexOf('</div>', goalieRowStart) + 6);
    expect(html.slice(goalieRowStart, goalieRowEnd)).toContain('data-i18n="goalieBadge"');

    const backupRowStart = html.indexOf(`data-pool-player-row="${backup.player_id}"`);
    const backupRowEnd = html.indexOf('</div>', html.indexOf('</div>', backupRowStart) + 6);
    expect(html.slice(backupRowStart, backupRowEnd)).toContain('data-i18n="goalieBadge"');
  });

  it('the fixed/headcount/post-draw per-team list also shows the goalie badge now (same distinguishability, consistent list)', async () => {
    const { cookie, csrfToken } = await signup('item1.fixed.goalie@example.com', '203.0.141.004');
    const res = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Item1 Fixed Goalie League', teamNames: ['A', 'B'], tracksStats: true })
    });
    const league = (await res.json()).league;
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Item1 Fixed Goalie Season' })
    });
    const goalieRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Fixed Real Goalie', team: 'A', email: 'fixedgoalie@example.com', is_goalie: true })
    });
    const goalie = (await goalieRes.json()).contact;
    const eventId = await createEvent(cookie, csrfToken, '2099-06-04');

    const html = await detailHtml(cookie, eventId);
    expect(html).toContain(`setPlayerStatus('${goalie.player_id}','in',this)`);
    expect(html).toContain('data-i18n="goalieBadge"');
  });
});

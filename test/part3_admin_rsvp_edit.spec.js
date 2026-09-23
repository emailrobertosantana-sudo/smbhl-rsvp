// Part 3: the event status/detail page only showed aggregate per-team
// counts -- an admin had no way to see each rostered player's own
// current status, or correct it. GET /league/events/detail now lists
// every player rostered to each team (LEFT JOINed against this event's
// own rsvp row, so a no-response player shows "EN ATTENTE / PENDING",
// never silently omitted) with clickable IN/OUT controls that call the
// existing POST /league/rsvp/admin route (Part R backend, already
// wired to writeLeagueRsvpStatus + maybeInviteSubsForShortage's
// existing duplicate-guard logic -- no new/duplicated logic here).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part3-admin-rsvp-edit-secret';
const RSVP_SECRET = 'test-part3-admin-rsvp-edit-rsvp-secret';

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(', ');
  const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
  return csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
}

async function signupAndCreateLeague(email, ip, leagueName, teamNames) {
  const signupRes = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const signupJson = await signupRes.json();
  const cookie = extractCookie(signupRes);
  const csrfToken = extractCsrfToken(signupRes);

  const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name: leagueName, teamNames, tracksStats: true })
  });
  const leagueJson = await leagueRes.json();

  return { userId: signupJson.userId, cookie, csrfToken, leagueId: leagueJson.league.id };
}

describe('Part 3: admin can view and correct a player\'s RSVP status', () => {
  let leagueId, cookie, csrfToken, eventId, playerAId, playerBId;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    await applyRealSchema(env);

    const a = await signupAndCreateLeague('part3.rsvpedit@example.com', '203.0.113.421', 'Part 3 RSVP Edit League', ['Otters', 'Falcons']);
    leagueId = a.leagueId;
    cookie = a.cookie;
    csrfToken = a.csrfToken;

    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Part 3 Season', goalies_per_team: 1, skaters_per_team: 3, min_skaters: 1 })
    });

    const pA = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Otters Player A', team: 'Otters' })
    });
    playerAId = (await pA.json()).contact.player_id;
    const pB = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Otters Player B', team: 'Otters' })
    });
    playerBId = (await pB.json()).contact.player_id;
    // A sub who can be invited once player A is corrected to OUT.
    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Otters Sub One', email: 'sub1@part3.com', role: 'sub_skater' })
    });

    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2026-12-20', season: 'Part 3 Season' })
    });
    eventId = (await eventRes.json()).event.id;
  });

  it("GET /league/events/detail lists every rostered player's status, including 'no response' for one who hasn't answered", async () => {
    const res = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Otters Player A');
    expect(html).toContain('Otters Player B');
    expect(html).toContain('EN ATTENTE / PENDING');
    expect(html).toContain("setPlayerStatus('" + playerAId + "','in',this)");
    expect(html).toContain("setPlayerStatus('" + playerAId + "','out',this)");
  });

  it('the admin can mark a rostered player IN directly from this page (via POST /league/rsvp/admin)', async () => {
    const res = await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: playerAId, status: 'in' })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    const detailHtml = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } })).text();
    // Player A's row now reflects IN (the "on" class on the IN button).
    expect(detailHtml).toContain(`setPlayerStatus('${playerAId}','in',this)`);
    const statusRow = await env.DB.prepare('SELECT status, status_by FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, playerAId).first();
    expect(statusRow.status).toBe('in');
    expect(statusRow.status_by).toBe('manager');
  });

  it('correcting a confirmed player to OUT creates a real shortage and triggers the same sub-invite/duplicate-guard logic the self-out path uses', async () => {
    // Player A is IN (previous test); B is still pending. Marking A OUT
    // drops Otters' skater count to 0 (well under skaters_per_team:3),
    // which should trigger maybeInviteSubsForShortage exactly like a
    // player's own self-out does.
    const res = await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: playerAId, status: 'out' })
    });
    expect(res.status).toBe(200);

    const outboxRow = await env.DB.prepare(`SELECT * FROM outbox WHERE event_id = ? AND kind = 'sub_call'`).bind(eventId).first();
    expect(outboxRow).toBeTruthy();
    expect(outboxRow.league_id).toBe(leagueId);

    // Re-correcting back to OUT again immediately should not create a
    // second sub_call row within the duplicate-guard window (same as the
    // self-out path's existing dedup behavior).
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: playerAId, status: 'in' })
    });
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: playerAId, status: 'out' })
    });
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE event_id = ? AND kind = 'sub_call'`).bind(eventId).first();
    expect(count.n).toBe(1);
  });

  it('an unauthenticated request to POST /league/rsvp/admin is rejected', async () => {
    const res = await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: eventId, player_id: playerBId, status: 'in' })
    });
    expect(res.status).toBe(401);
  });
});

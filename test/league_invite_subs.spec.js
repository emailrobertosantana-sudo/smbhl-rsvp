// Part P: POST /league/events/invite-subs — manual, session-gated
// sub-invite trigger for a second league. Reuses callSubs' exact wave
// logic. Proves: unreachable via ADMIN_KEY-without-session (no ADMIN_KEY
// path exists at all); the eligible-subs pool is correctly scoped to the
// calling league only (never SMBHL's or another league's real subs —
// the bug callSubs' own league_id filter, added this session, fixes);
// the resulting invite email goes out under THIS league's own identity,
// not "SMBHL - Hockey <joueur@smbhl.com>"; and cross-league targeting is
// rejected.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { drain } from '../src';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-league-invite-subs-secret';
const RSVP_SECRET = 'test-league-invite-subs-rsvp-secret';

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

describe('Part P: POST /league/events/invite-subs', () => {
  let leagueA, leagueB, cookieA, cookieB, csrfTokenA, csrfTokenB, eventA, eventB;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;

    await applyRealSchema(env);

    const a = await signupAndCreateLeague('invitesubs.a@example.com', '203.0.113.321', 'Invite Subs League A', ['Otters', 'Falcons']);
    const b = await signupAndCreateLeague('invitesubs.b@example.com', '203.0.113.322', 'Invite Subs League B', ['Narwhals', 'Beavers']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    csrfTokenA = a.csrfToken;
    cookieB = b.cookie;
    csrfTokenB = b.csrfToken;

    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ season_name: 'League A Season 1' })
    });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ season_name: 'League B Season 1' })
    });

    // An event far enough out to clear callSubs' CUTOFF_HOURS gate.
    const futureDate = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const eventARes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ date: futureDate, season: 'League A Season 1' })
    });
    eventA = (await eventARes.json()).event.id;
    const eventBRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ date: futureDate, season: 'League B Season 1' })
    });
    eventB = (await eventBRes.json()).event.id;

    // Sub pool: one eligible sub_skater in League A, one in League B, and
    // (implicitly, via the fixed SMBHL default) SMBHL's own real subs
    // exist in the same shared contacts table.
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, answered_ever, token_salt, league_id) VALUES (?, ?, ?, 'sub_skater', 1, 'salt-a-sub', ?)`)
      .bind(`${leagueA}:P9001`, 'League A Sub', 'suba@leaguea.com', leagueA).run();
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, answered_ever, token_salt, league_id) VALUES (?, ?, ?, 'sub_skater', 1, 'salt-b-sub', ?)`)
      .bind(`${leagueB}:P9001`, 'League B Sub', 'subb@leagueb.com', leagueB).run();
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, answered_ever, token_salt) VALUES ('P9001', 'Real SMBHL Sub', 'smbhlsub@smbhl.com', 'sub_skater', 1, 'smbhl-salt')`).run();
  });

  it('an unauthenticated request cannot trigger anything', async () => {
    const res = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: eventA, team: 'Otters', need: 'skater' })
    });
    expect(res.status).toBe(401);
  });

  it('there is no ADMIN_KEY path into this route at all -- a valid ADMIN_KEY with no session is still rejected', async () => {
    env.ADMIN_KEY = 'test-invite-subs-admin-key';
    const res = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST',
      headers: { 'x-admin': env.ADMIN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: eventA, team: 'Otters', need: 'skater' })
    });
    expect(res.status).toBe(401);
  });

  it("a league admin triggers a sub invite for their own event, and the pool is scoped to ONLY their league's subs", async () => {
    const res = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ event_id: eventA, team: 'Otters', need: 'skater' })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.invited).toBe(1); // only League A's own sub, not League B's or SMBHL's

    const rows = (await env.DB.prepare(
      `SELECT * FROM outbox WHERE event_id = ? AND kind = 'sub_call'`
    ).bind(eventA).all()).results;
    expect(rows.length).toBe(1);
    expect(rows[0].player_id).toBe(`${leagueA}:P9001`);
    expect(rows[0].league_id).toBe(leagueA);
  });

  it("SMBHL's real subs and League B's subs were never touched -- no outbox row was created for them", async () => {
    const smbhlRows = (await env.DB.prepare(
      `SELECT * FROM outbox WHERE player_id = 'P9001'`
    ).all()).results;
    expect(smbhlRows.length).toBe(0);

    const bRows = (await env.DB.prepare(
      `SELECT * FROM outbox WHERE player_id = ?`
    ).bind(`${leagueB}:P9001`).all()).results;
    expect(bRows.length).toBe(0);
  });

  it("the resulting invite email goes out under League A's OWN identity, not SMBHL's", async () => {
    const originalFetch = globalThis.fetch;
    const sentMails = [];
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('api.resend.com')) {
        sentMails.push(JSON.parse(opts.body));
        return new Response(JSON.stringify({ id: 'mock_resend_id' }), { status: 200 });
      }
      return originalFetch(url, opts);
    };
    try {
      env.RESEND_API_KEY = 're_test_key_invite_subs';
      await drain(env);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(sentMails.length).toBe(1);
    expect(sentMails[0].to).toEqual(['suba@leaguea.com']);
    expect(sentMails[0].from).not.toContain('joueur@smbhl.com');
    expect(sentMails[0].from).not.toContain('SMBHL');
    // Bug 1 fix (live-testing): From is now the league's own slug under
    // the verified mail.notreligue.ca domain, not the admin's raw
    // signup email -- Reply-To (unchanged) is still the real admin
    // email.
    expect(sentMails[0].from).toContain('mail.notreligue.ca');
    expect(sentMails[0].from).not.toContain('invitesubs.a@example.com');
    expect(sentMails[0].reply_to).toBe('invitesubs.a@example.com');
  });

  it("League A's admin cannot invite subs for League B's event (404, not another league's event)", async () => {
    const res = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ event_id: eventB, team: 'Narwhals', need: 'skater' })
    });
    expect(res.status).toBe(404);
  });

  it('an unknown team for the league is rejected', async () => {
    const res = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ event_id: eventA, team: 'Not A Real Team', need: 'skater' })
    });
    expect(res.status).toBe(400);
  });

  it('an invalid need value is rejected', async () => {
    const res = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ event_id: eventA, team: 'Otters', need: 'defenseman' })
    });
    expect(res.status).toBe(400);
  });
});

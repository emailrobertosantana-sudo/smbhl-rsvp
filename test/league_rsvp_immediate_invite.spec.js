// Part R: immediate (self- or admin-triggered) sub-invite when an OUT
// creates a real shortage. Proves: a shortage-creating self-out sends an
// invite right away, under the league's own identity; a non-shortage
// self-out sends nothing; the admin-set path (session-gated, distinct
// from the player-token path) triggers the same logic; the duplicate
// guard prevents re-spamming within its window; and full per-league
// isolation, with SMBHL's data re-verified unaffected.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-immediate-invite-secret';
const RSVP_SECRET = 'test-immediate-invite-rsvp-secret';

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

async function computeToken(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function withMailMock(fn) {
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
    return { sentMails, result: await fn(sentMails) };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('Part R: immediate sub-invite on shortage-creating OUT', () => {
  let leagueA, leagueB, cookieA, cookieB, csrfTokenA, csrfTokenB;
  let smbhlContactsSnapshot, smbhlEventsSnapshot, smbhlRsvpSnapshot;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    env.RESEND_API_KEY = 're_test_key_immediate_invite';

    await applyRealSchema(env);

    // SMBHL's real, existing data.
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, token_salt) VALUES ('P0001', 'Real SMBHL Player', 'real@smbhl.com', 'roster', 'realsalt1')`).run();
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time) VALUES ('2026-09-20', 'Fall 2026', 3, '2026-09-20', 'College Jean-de-Brebeuf', 'open', '10:30')`).run();
    await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('2026-09-20', 'P0001', 'Red', 'in', 'roster', 'self', ?)`).bind(new Date().toISOString()).run();

    const a = await signupAndCreateLeague('immediateinvite.a@example.com', '203.0.113.341', 'Immediate Invite League A', ['Otters', 'Falcons']);
    const b = await signupAndCreateLeague('immediateinvite.b@example.com', '203.0.113.342', 'Immediate Invite League B', ['Narwhals', 'Beavers']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    cookieB = b.cookie;
    csrfTokenA = a.csrfToken;
    csrfTokenB = b.csrfToken;

    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ season_name: 'League A Season 1', goalies_per_team: 1, skaters_per_team: 1, min_skaters: 1 })
    });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ season_name: 'League B Season 1', goalies_per_team: 1, skaters_per_team: 1, min_skaters: 1 })
    });

    // League B has its own eligible sub, so we can prove it's never
    // touched by League A's shortages.
    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ name: 'League B Sub', email: 'bsub@leagueb.com', role: 'sub_skater' })
    });

    smbhlContactsSnapshot = (await env.DB.prepare(`SELECT * FROM contacts WHERE league_id = 'smbhl' ORDER BY player_id`).all()).results;
    smbhlEventsSnapshot = (await env.DB.prepare(`SELECT * FROM events WHERE league_id = 'smbhl' ORDER BY id`).all()).results;
    smbhlRsvpSnapshot = (await env.DB.prepare(`SELECT * FROM rsvp WHERE league_id = 'smbhl' ORDER BY event_id, player_id`).all()).results;
  });

  let nextEventDayOffset = 5;
  async function setupPlayerAndEvent(cookie, leagueId, suffix, csrfToken) {
    const playerRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: `Player ${suffix}`, role: 'roster' })
    });
    const playerId = (await playerRes.json()).contact.player_id;
    await env.DB.prepare(`UPDATE contacts SET preferred_team = 'Otters' WHERE player_id = ?`).bind(playerId).run();
    const salt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerId).first()).token_salt;

    const futureDate = new Date(Date.now() + (nextEventDayOffset++) * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      // No explicit season -- defaults to this league's own current_season
      // (published in beforeAll for both League A and League B).
      body: JSON.stringify({ date: futureDate })
    });
    const eventJson = await eventRes.json();
    if (!eventJson.event) throw new Error('event creation failed: ' + JSON.stringify(eventJson));
    const eventId = eventJson.event.id;
    return { playerId, salt, eventId };
  }

  it("a player's own out-mark that creates a shortage triggers an immediate invite, sent under League A's own identity", async () => {
    // A sub must exist for League A first.
    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ name: 'League A Sub One', email: 'asub1@leaguea.com', role: 'sub_skater' })
    });
    const { playerId, salt, eventId } = await setupPlayerAndEvent(cookieA, leagueA, 'Shortage One', csrfTokenA);
    const token = await computeToken(RSVP_SECRET, `lr:${leagueA}:${eventId}:${playerId}:${salt}`);

    const { sentMails, result: res } = await withMailMock(() =>
      SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'out' })
      })
    );

    expect(res.status).toBe(200);
    expect(sentMails.length).toBe(1);
    expect(sentMails[0].to).toEqual(['asub1@leaguea.com']);
    // Bug 1 fix (live-testing): From is now the league's own slug under
    // the verified mail.notreligue.ca domain, not the admin's raw
    // signup email -- Reply-To (unchanged) is still the real admin
    // email.
    expect(sentMails[0].from).toContain('mail.notreligue.ca');
    expect(sentMails[0].from).not.toContain('immediateinvite.a@example.com');
    expect(sentMails[0].from).not.toContain('smbhl.com');
    expect(sentMails[0].reply_to).toBe('immediateinvite.a@example.com');

    const outboxRow = await env.DB.prepare(`SELECT * FROM outbox WHERE event_id = ? AND kind = 'sub_call'`).bind(eventId).first();
    expect(outboxRow.league_id).toBe(leagueA);
    expect(outboxRow.sent_at).not.toBeNull();
  });

  it("a player's own out-mark that does NOT create a shortage triggers nothing", async () => {
    const { playerId, salt, eventId } = await setupPlayerAndEvent(cookieA, leagueA, 'No Shortage', csrfTokenA);
    // Add a second roster player on the same team so skaters_per_team:1
    // is still met after the first one leaves.
    const secondRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ name: 'Player Backup Skater', role: 'roster' })
    });
    const secondId = (await secondRes.json()).contact.player_id;
    await env.DB.prepare(`UPDATE contacts SET preferred_team = 'Otters' WHERE player_id = ?`).bind(secondId).run();
    await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, 'Otters', 'in', 'roster', 'self', ?, ?)`)
      .bind(eventId, secondId, new Date().toISOString(), leagueA).run();

    const token = await computeToken(RSVP_SECRET, `lr:${leagueA}:${eventId}:${playerId}:${salt}`);
    const { sentMails, result: res } = await withMailMock(() =>
      SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'out' })
      })
    );

    expect(res.status).toBe(200);
    expect(sentMails.length).toBe(0);
    const outboxRow = await env.DB.prepare(`SELECT * FROM outbox WHERE event_id = ? AND kind = 'sub_call'`).bind(eventId).first();
    expect(outboxRow).toBeNull();
  });

  describe('POST /league/rsvp/admin — the admin-only "mark another player" path', () => {
    it('is unreachable via a player token -- a valid RSVP token in the body/query is not a substitute for a session', async () => {
      const { playerId, salt, eventId } = await setupPlayerAndEvent(cookieA, leagueA, 'Admin Path Auth', csrfTokenA);
      const token = await computeToken(RSVP_SECRET, `lr:${leagueA}:${eventId}:${playerId}:${salt}`);

      const res = await SELF.fetch(`http://example.com/league/rsvp/admin?t=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event_id: eventId, player_id: playerId, status: 'out', t: token })
      });
      expect(res.status).toBe(401);

      const row = await env.DB.prepare('SELECT * FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, playerId).first();
      expect(row).toBeNull();
    });

    it('a session-authenticated admin can mark a player out on their behalf, and it triggers the same immediate-invite logic', async () => {
      await SELF.fetch('http://example.com/league/contacts', {
        method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
        body: JSON.stringify({ name: 'League A Sub Two', email: 'asub2@leaguea.com', role: 'sub_skater' })
      });
      const { playerId, eventId } = await setupPlayerAndEvent(cookieA, leagueA, 'Admin Marked', csrfTokenA);

      const { sentMails, result: res } = await withMailMock(() =>
        SELF.fetch('http://example.com/league/rsvp/admin', {
          method: 'POST',
          headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
          body: JSON.stringify({ event_id: eventId, player_id: playerId, status: 'out' })
        })
      );
      expect(res.status).toBe(200);

      const row = await env.DB.prepare('SELECT * FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, playerId).first();
      expect(row.status).toBe('out');
      expect(row.status_by).toBe('manager'); // distinct from 'self'

      // Every eligible League A sub gets invited at once (no wave limiting
      // per Part R's "simple and immediate" design) -- by this point in the
      // file that includes subs created by earlier tests too, so assert
      // inclusion of the new sub rather than an exact recipient count.
      expect(sentMails.length).toBeGreaterThanOrEqual(1);
      expect(sentMails.some(m => m.to.includes('asub2@leaguea.com'))).toBe(true);
      // Bug 1 fix (live-testing): From is now the league's own slug
      // under mail.notreligue.ca -- Reply-To (unchanged) is the real
      // admin email.
      expect(sentMails.every(m => m.from.includes('mail.notreligue.ca'))).toBe(true);
      expect(sentMails.every(m => m.reply_to === 'immediateinvite.a@example.com')).toBe(true);
    });

    it("an admin cannot mark a player who isn't in their own league (404)", async () => {
      const { playerId: bPlayerId, eventId: bEventId } = await setupPlayerAndEvent(cookieB, leagueB, 'League B Target', csrfTokenB);
      const res = await SELF.fetch('http://example.com/league/rsvp/admin', {
        method: 'POST',
        headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
        body: JSON.stringify({ event_id: bEventId, player_id: bPlayerId, status: 'out' })
      });
      expect(res.status).toBe(404);
    });
  });

  it('the duplicate guard prevents re-inviting within the window: flipping OUT -> IN -> OUT again quickly sends only one invite', async () => {
    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ name: 'League A Sub Three', email: 'asub3@leaguea.com', role: 'sub_skater' })
    });
    const { playerId, salt, eventId } = await setupPlayerAndEvent(cookieA, leagueA, 'Flapping', csrfTokenA);
    const token = await computeToken(RSVP_SECRET, `lr:${leagueA}:${eventId}:${playerId}:${salt}`);

    // By this point in the file, several League A subs have accumulated
    // (from earlier tests) and are ALL eligible for this brand-new event,
    // so the first OUT alone sends more than one email (no wave limiting,
    // per Part R's design) -- the guard being tested is specifically that
    // the SECOND out-mark adds zero additional sends, not an absolute
    // total of exactly one.
    let sentAfterFirstOut;
    const { sentMails } = await withMailMock(async (sentMailsSoFar) => {
      const out1 = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'out' })
      });
      expect(out1.status).toBe(200);

      const in1 = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'in' })
      });
      expect(in1.status).toBe(200);
      sentAfterFirstOut = sentMailsSoFar.length;

      const out2 = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueA)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'out' })
      });
      expect(out2.status).toBe(200);
    });

    expect(sentAfterFirstOut).toBeGreaterThanOrEqual(1);
    expect(sentMails.length).toBe(sentAfterFirstOut); // the second OUT added zero new sends
  });

  it("League B's own eligible sub was never invited by any of League A's shortages, and SMBHL's data is re-verified byte-for-byte unaffected by all of the above", async () => {
    const bOutbox = (await env.DB.prepare(`SELECT * FROM outbox WHERE league_id = ?`).bind(leagueB).all()).results;
    expect(bOutbox.length).toBe(0);

    const contactsAfter = (await env.DB.prepare(`SELECT * FROM contacts WHERE league_id = 'smbhl' ORDER BY player_id`).all()).results;
    expect(contactsAfter).toEqual(smbhlContactsSnapshot);

    const eventsAfter = (await env.DB.prepare(`SELECT * FROM events WHERE league_id = 'smbhl' ORDER BY id`).all()).results;
    expect(eventsAfter).toEqual(smbhlEventsSnapshot);

    const rsvpAfter = (await env.DB.prepare(`SELECT * FROM rsvp WHERE league_id = 'smbhl' ORDER BY event_id, player_id`).all()).results;
    expect(rsvpAfter).toEqual(smbhlRsvpSnapshot);

    const smbhlOutbox = (await env.DB.prepare(`SELECT * FROM outbox WHERE league_id = 'smbhl'`).all()).results;
    expect(smbhlOutbox.length).toBe(0);
  });
});

// Part 11: comprehensive end-to-end test of everything built across
// Parts 0-10 tonight, walked as one continuous, realistic journey on
// notreligue.ca's own deployment (env.PUBLIC_URL) rather than isolated
// unit-style checks of each route:
//   signup at notreligue.ca -> verify email -> publish a season ->
//   add players with team assignments -> create an event -> a player
//   RSVPs via their real magic link (creating a shortage, triggering an
//   automatic sub-invite) -> the admin corrects a DIFFERENT player's
//   status from the event-detail page (creating a second, distinct
//   shortage, triggering its own automatic sub-invite) -> a second
//   admin is invited by email and logs in -> the public page shows the
//   real schedule/teams -> and finally, SMBHL's own data is proven
//   byte-for-byte unaffected by every single step above.
import { env, SELF } from 'cloudflare:test';
import { formatEventDate } from '../src/date_format.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { dataJsonKeyFor } from '../src/league_ids.js';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part11-comprehensive-e2e-secret';
const RSVP_SECRET = 'test-part11-comprehensive-e2e-rsvp-secret';
const BASE = 'http://notreligue.ca';

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

async function computeRsvpToken(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

const SMBHL_REAL_DATA_JSON = {
  current_season: 'Fall 2026',
  seasons: [{
    name: 'Fall 2026',
    config: { teams: ['Red', 'Blue', 'White', 'Black'] },
    standings: [{ team: 'Red', w: 3, l: 1 }]
  }],
  players: [{ id: 'P0001', name: 'Real SMBHL Player', seasons: { 'Fall 2026': { team: 'Red' } } }]
};

describe('Part 11: the entire second-league journey, end to end', () => {
  let smbhlContactsSnapshot, smbhlEventsSnapshot, smbhlRsvpSnapshot, smbhlOutboxSnapshot, smbhlDataJsonSnapshot;
  let originalPublicUrl;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    env.RESEND_API_KEY = 're_test_key_part11';
    originalPublicUrl = env.PUBLIC_URL;

    await applyRealSchema(env);

    // SMBHL's real, existing data across every surface this journey touches.
    await env.SHEETS_KV.put('data_json', JSON.stringify(SMBHL_REAL_DATA_JSON));
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, token_salt) VALUES ('P0001', 'Real SMBHL Player', 'real@smbhl.com', 'roster', 'realsalt1')`).run();
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time) VALUES ('2026-09-20', 'Fall 2026', 3, '2026-09-20', 'College Jean-de-Brebeuf', 'open', '10:30')`).run();
    await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('2026-09-20', 'P0001', 'Red', 'in', 'roster', 'self', ?)`).bind(new Date().toISOString()).run();

    smbhlContactsSnapshot = (await env.DB.prepare(`SELECT * FROM contacts WHERE league_id = 'smbhl' ORDER BY player_id`).all()).results;
    smbhlEventsSnapshot = (await env.DB.prepare(`SELECT * FROM events WHERE league_id = 'smbhl' ORDER BY id`).all()).results;
    smbhlRsvpSnapshot = (await env.DB.prepare(`SELECT * FROM rsvp WHERE league_id = 'smbhl' ORDER BY event_id, player_id`).all()).results;
    smbhlOutboxSnapshot = (await env.DB.prepare(`SELECT * FROM outbox WHERE league_id = 'smbhl'`).all()).results;
    smbhlDataJsonSnapshot = JSON.parse(await env.SHEETS_KV.get('data_json'));
  });

  it('walks the entire flow end to end, and proves SMBHL is provably unaffected by all of it', async () => {
    env.PUBLIC_URL = 'https://notreligue.ca';
    try {
      // ---- Step 0 (Part 0): this deployment's root shows the real
      // marketing homepage, with a Get Started button leading to
      // /signup -- never smbhl.com -- the notreligue.ca consolidation.
      const rootRes = await SELF.fetch(`${BASE}/`, { redirect: 'manual' });
      expect(rootRes.status).toBe(200);
      const rootHtml = await rootRes.text();
      expect(rootHtml).toContain('Notre Ligue');
      expect(rootHtml).toContain('href="/signup"');
      expect(rootHtml).not.toContain('smbhl.com');

      // ---- Step 1 (signup) + verify email, following the REAL emailed
      // link (same as Part 5's dedicated round-trip test), on THIS
      // deployment's own PUBLIC_URL.
      const { sentMails: signupMails, result: signupRes } = await withMailMock(async () =>
        SELF.fetch(`${BASE}/auth/signup`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.511' },
          body: JSON.stringify({ email: 'part11.admin@example.com', password: 'a-strong-password-1' })
        })
      );
      expect(signupRes.status).toBe(200);
      const cookie = extractCookie(signupRes);
      const csrfToken = extractCsrfToken(signupRes);

      expect(signupMails.length).toBe(1);
      const verifyRaw = JSON.stringify(signupMails[0]);
      const verifyMatch = /\\\/auth\\\/verify\?token=([^\s"'<\\]+)/.exec(verifyRaw) || /\/auth\/verify\?token=([^\s"'<\\]+)/.exec(verifyRaw);
      if (!verifyMatch) throw new Error('No verify link found in mail body: ' + verifyRaw);
      const verifyToken = decodeURIComponent(verifyMatch[1]);
      expect(verifyRaw).toContain('notreligue.ca'); // the link is this deployment's own domain, not smbhl.com

      const verifyRes = await SELF.fetch(`${BASE}/auth/verify?token=${encodeURIComponent(verifyToken)}`);
      expect(verifyRes.status).toBe(200);
      expect((await verifyRes.json()).ok).toBe(true);

      const userRow = await env.DB.prepare('SELECT email_verified_at FROM users WHERE email = ?').bind('part11.admin@example.com').first();
      expect(userRow.email_verified_at).toBeTruthy();

      // ---- Step 2: create the league and publish a season with a tight
      // roster config, so marking one skater and one goalie OUT each
      // genuinely creates their own distinct shortage below.
      const LEAGUE_NAME = 'Ligue Notre Ligue E2E';
      const leagueRes = await SELF.fetch(`${BASE}/leagues/create`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: LEAGUE_NAME, teamNames: ['Nordiques', 'Canadiens'], tracksStats: true })
      });
      expect(leagueRes.status).toBe(200);
      const leagueId = (await leagueRes.json()).league.id;

      const publishRes = await SELF.fetch(`${BASE}/league/season/publish`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ season_name: 'Part 11 Season', goalies_per_team: 1, skaters_per_team: 1, min_skaters: 1 })
      });
      expect(publishRes.status).toBe(200);

      // ---- Step 3: add players WITH team assignments (Part 1), plus one
      // eligible skater sub and one eligible goalie sub for the two
      // distinct shortages below.
      const skaterRes = await SELF.fetch(`${BASE}/league/contacts`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Nordiques Skater One', email: 'skater1@part11.com', team: 'Nordiques' })
      });
      expect(skaterRes.status).toBe(200);
      const skaterJson = (await skaterRes.json()).contact;
      expect(skaterJson.team).toBe('Nordiques');
      const skaterId = skaterJson.player_id;
      const skaterSalt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(skaterId).first()).token_salt;

      // Live-testing task, Part 2 (bug fix): 'position: G' no longer
      // implies is_goalie, and role 'sub_goalie' is no longer a valid
      // role at all -- goalie-ness is now always the independent
      // is_goalie flag, for a regular or a sub alike (see
      // createLeagueContactRow's own comment, leagues.js).
      const goalieRes = await SELF.fetch(`${BASE}/league/contacts`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Canadiens Goalie One', team: 'Canadiens', is_goalie: true })
      });
      expect(goalieRes.status).toBe(200);
      const goalieId = (await goalieRes.json()).contact.player_id;

      await SELF.fetch(`${BASE}/league/contacts`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Part 11 Skater Sub', email: 'skatersub@part11.com', role: 'sub_skater', is_goalie: false })
      });
      await SELF.fetch(`${BASE}/league/contacts`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Part 11 Goalie Sub', email: 'goaliesub@part11.com', role: 'sub_skater', is_goalie: true })
      });

      // Roster page (Part 1/2) reflects real team assignments AND this
      // league's own branding (Part 2), not "SMBHL".
      const rosterHtml = await (await SELF.fetch(`${BASE}/league/roster`, { headers: { cookie } })).text();
      expect(rosterHtml).toContain('Nordiques Skater One');
      expect(rosterHtml).toContain('Nordiques');
      expect(rosterHtml).toContain(LEAGUE_NAME);
      expect(rosterHtml).not.toContain('SMBHL');

      // ---- Step 4: create the event, far enough out to clear callSubs'
      // cutoff/rush windows.
      const futureDate = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const eventRes = await SELF.fetch(`${BASE}/league/events`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ date: futureDate, season: 'Part 11 Season', venue: 'Aréna Notre Ligue' })
      });
      expect(eventRes.status).toBe(200);
      const eventId = (await eventRes.json()).event.id;

      // ---- Step 5: the skater RSVPs via their own real magic link,
      // marking OUT. Nordiques drops to 0 confirmed skaters (need 1),
      // which immediately queues an automatic sub-invite to the
      // eligible skater sub -- zero admin action. Live-testing task
      // (batch 2), Part 16: this used to be wall-clock-dependent --
      // afterQuiet()'s hardcoded 23:00-07:00 local delay silently
      // deferred even a delayMin: 0 "send now" enqueue, so this only
      // sent synchronously outside quiet hours. maybeInviteSubsForShortage
      // now passes skipQuietHours: true (enqueue's own comment has the
      // full root-cause writeup), so this is deterministic at any hour.
      const skaterSubId = (await env.DB.prepare('SELECT player_id FROM contacts WHERE league_id = ? AND email = ?').bind(leagueId, 'skatersub@part11.com').first()).player_id;
      const rsvpToken = await computeRsvpToken(RSVP_SECRET, `lr:${leagueId}:${eventId}:${skaterId}:${skaterSalt}`);
      const { sentMails: rsvpMails, result: rsvpRes } = await withMailMock(async () =>
        SELF.fetch(`${BASE}/league/rsvp?league=${encodeURIComponent(leagueId)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(skaterId)}&t=${rsvpToken}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'out' })
        })
      );
      expect(rsvpRes.status).toBe(200);
      expect((await rsvpRes.json()).status).toBe('out');

      const skaterInviteRow = await env.DB.prepare(
        `SELECT * FROM outbox WHERE event_id = ? AND kind = 'sub_call' AND player_id = ?`
      ).bind(eventId, skaterSubId).first();
      expect(skaterInviteRow).toBeTruthy();
      expect(skaterInviteRow.league_id).toBe(leagueId); // queued under THIS league, never SMBHL's
      expect(rsvpMails.length).toBe(1);
      expect(rsvpMails[0].to).toEqual(['skatersub@part11.com']);
      // Bug 1 fix (live-testing): From is now the league's own slug
      // under mail.notreligue.ca -- Reply-To (unchanged) is the real
      // admin email.
      expect(rsvpMails[0].from).toContain('mail.notreligue.ca');
      expect(rsvpMails[0].from).not.toContain('part11.admin@example.com');
      expect(rsvpMails[0].from).not.toContain('smbhl.com');
      expect(rsvpMails[0].reply_to).toBe('part11.admin@example.com');

      // ---- Step 6 (Part 3): the admin views the event-detail page,
      // sees the goalie still pending, and corrects a DIFFERENT
      // player's (the goalie's) status to OUT directly from that page.
      const detailHtml = await (await SELF.fetch(`${BASE}/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } })).text();
      expect(detailHtml).toContain('Canadiens Goalie One');
      expect(detailHtml).toContain('Pas répondu');

      const { sentMails: adminMails, result: adminSetRes } = await withMailMock(async () =>
        SELF.fetch(`${BASE}/league/rsvp/admin`, {
          method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({ event_id: eventId, player_id: goalieId, status: 'out' })
        })
      );
      expect(adminSetRes.status).toBe(200);
      const statusRow = await env.DB.prepare('SELECT status, status_by FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, goalieId).first();
      expect(statusRow.status).toBe('out');
      expect(statusRow.status_by).toBe('manager');

      // ---- Step 7: that admin correction creates ITS OWN distinct
      // shortage (Canadiens now has 0 confirmed goalies, need 1) and
      // queues its own automatic sub-invite, to the eligible goalie
      // sub -- a different need than Step 5's, so it is not blocked by
      // the skater shortage's own duplicate-guard window. Same
      // outbox-row ground truth as Step 5, for the same reason.
      const goalieSubId = (await env.DB.prepare('SELECT player_id FROM contacts WHERE league_id = ? AND email = ?').bind(leagueId, 'goaliesub@part11.com').first()).player_id;
      const goalieInviteRow = await env.DB.prepare(
        `SELECT * FROM outbox WHERE event_id = ? AND kind = 'sub_call' AND player_id = ?`
      ).bind(eventId, goalieSubId).first();
      expect(goalieInviteRow).toBeTruthy();
      expect(goalieInviteRow.league_id).toBe(leagueId);
      expect(adminMails.length).toBe(1);
      expect(adminMails[0].to).toEqual(['goaliesub@part11.com']);
      // Bug 1 fix (live-testing): From is now the league's own slug
      // under mail.notreligue.ca; Reply-To is the real admin email.
      expect(adminMails[0].from).toContain('mail.notreligue.ca');
      expect(adminMails[0].reply_to).toBe('part11.admin@example.com');

      const statusPageRes = await SELF.fetch(`${BASE}/league/events/status?e=${encodeURIComponent(eventId)}`, { headers: { cookie } });
      const statusJson = await statusPageRes.json();
      const canadiens = statusJson.teams.find(t => t.team === 'Canadiens');
      expect(canadiens.short).toBe(true);

      // ---- Step 8 (Part 9): the first admin invites a second admin by
      // email; the invited person has no prior account, so accepting
      // creates one and logs them straight in.
      const { sentMails: inviteMails, result: inviteRes } = await withMailMock(async () =>
        SELF.fetch(`${BASE}/league/admins/invite`, {
          method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({ email: 'part11.secondadmin@example.com' })
        })
      );
      expect(inviteRes.status).toBe(200);
      expect(inviteMails.length).toBe(1);
      const inviteRaw = JSON.stringify(inviteMails[0]);
      const inviteMatch = /\\\/league\\\/admins\\\/accept\?token=([^\s"'<\\]+)/.exec(inviteRaw) || /\/league\/admins\/accept\?token=([^\s"'<\\]+)/.exec(inviteRaw);
      if (!inviteMatch) throw new Error('No invite link found in mail body: ' + inviteRaw);
      const inviteToken = decodeURIComponent(inviteMatch[1]);

      const acceptRes = await SELF.fetch(`${BASE}/league/admins/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: inviteToken, password: 'second-admin-password' })
      });
      expect(acceptRes.status).toBe(200);
      const acceptJson = await acceptRes.json();
      expect(acceptJson.ok).toBe(true);
      expect(acceptJson.accountCreated).toBe(true);
      const secondAdminCookie = extractCookie(acceptRes);

      const secondAdminDashRes = await SELF.fetch(`${BASE}/dashboard`, { headers: { cookie: secondAdminCookie } });
      const secondAdminDashHtml = await secondAdminDashRes.text();
      expect(secondAdminDashHtml).toContain(LEAGUE_NAME);
      expect(secondAdminDashHtml).toContain('part11.admin@example.com');
      expect(secondAdminDashHtml).toContain('part11.secondadmin@example.com');

      // Both admins can now independently manage the same league.
      const adminCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM league_admins WHERE league_id = ?').bind(leagueId).first();
      expect(adminCount.n).toBe(2);

      // ---- Step 9 (Part 4): the public page, requiring no login at
      // all, shows the real branding/teams/schedule and nothing private.
      const publicRes = await SELF.fetch(`${BASE}/league/public?league=${encodeURIComponent(leagueId)}`);
      expect(publicRes.status).toBe(200);
      const publicHtml = await publicRes.text();
      expect(publicHtml).toContain(LEAGUE_NAME);
      expect(publicHtml).toContain('Nordiques');
      expect(publicHtml).toContain('Canadiens');
      // Superseded by live-testing task (batch 2), Part 6: dates now
      // render in the design system's own format, not raw ISO.
      expect(publicHtml).toContain(formatEventDate(futureDate, 'fr', 'short'));
      expect(publicHtml).toContain('Aréna Notre Ligue');
      expect(publicHtml).not.toContain('skater1@part11.com');
      expect(publicHtml).not.toContain('Nordiques Skater One'); // no roster/attendee names on the public page

      // This league's own published season data lives under its own
      // scoped KV key, never SMBHL's shared one.
      const leagueDataJson = JSON.parse(await env.SHEETS_KV.get(dataJsonKeyFor(leagueId)));
      expect(leagueDataJson.current_season).toBe('Part 11 Season');

      // ---- THE critical proof: SMBHL is provably unaffected by every
      // single step above -- every table and the KV blob, re-verified
      // byte-for-byte against the snapshots taken before this test ever
      // touched anything.
      const contactsAfter = (await env.DB.prepare(`SELECT * FROM contacts WHERE league_id = 'smbhl' ORDER BY player_id`).all()).results;
      expect(contactsAfter).toEqual(smbhlContactsSnapshot);

      const eventsAfter = (await env.DB.prepare(`SELECT * FROM events WHERE league_id = 'smbhl' ORDER BY id`).all()).results;
      expect(eventsAfter).toEqual(smbhlEventsSnapshot);

      const rsvpAfter = (await env.DB.prepare(`SELECT * FROM rsvp WHERE league_id = 'smbhl' ORDER BY event_id, player_id`).all()).results;
      expect(rsvpAfter).toEqual(smbhlRsvpSnapshot);

      const outboxAfter = (await env.DB.prepare(`SELECT * FROM outbox WHERE league_id = 'smbhl'`).all()).results;
      expect(outboxAfter).toEqual(smbhlOutboxSnapshot);

      const dataJsonAfter = JSON.parse(await env.SHEETS_KV.get('data_json'));
      expect(dataJsonAfter).toEqual(smbhlDataJsonSnapshot);
    } finally {
      env.PUBLIC_URL = originalPublicUrl;
    }
  });
});

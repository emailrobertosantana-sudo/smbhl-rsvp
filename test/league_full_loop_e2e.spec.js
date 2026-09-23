// Part Q: the single most important test in this task. Walks the ENTIRE
// second-league product loop in sequence, using real routes throughout
// (no fixtures/shortcuts for the steps under test):
//   signup -> login -> publish season -> add contact (player + sub) ->
//   create event -> mint the player's magic link -> player submits RSVP
//   via the link -> admin views shortage status -> admin triggers a
//   sub-invite -> confirm SMBHL's data_json and events/contacts are
//   byte-for-byte unaffected by all of the above.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { drain } from '../src';
import { dataJsonKeyFor } from '../src/league_ids.js';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-full-loop-e2e-secret';
const RSVP_SECRET = 'test-full-loop-e2e-rsvp-secret';

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

async function computeToken(secret, message) {
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

describe('Part Q: full second-league loop, end to end', () => {
  let smbhlContactsSnapshot, smbhlEventsSnapshot, smbhlRsvpSnapshot, smbhlDataJsonSnapshot;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;

    await applyRealSchema(env);

    // SMBHL's real, existing data across every surface this loop touches.
    await env.SHEETS_KV.put('data_json', JSON.stringify(SMBHL_REAL_DATA_JSON));
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, token_salt) VALUES ('P0001', 'Real SMBHL Player', 'real@smbhl.com', 'roster', 'realsalt1')`).run();
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time) VALUES ('2026-09-20', 'Fall 2026', 3, '2026-09-20', 'College Jean-de-Brebeuf', 'open', '10:30')`).run();
    await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('2026-09-20', 'P0001', 'Red', 'in', 'roster', 'self', ?)`).bind(new Date().toISOString()).run();

    smbhlContactsSnapshot = (await env.DB.prepare(`SELECT * FROM contacts WHERE league_id = 'smbhl' ORDER BY player_id`).all()).results;
    smbhlEventsSnapshot = (await env.DB.prepare(`SELECT * FROM events WHERE league_id = 'smbhl' ORDER BY id`).all()).results;
    smbhlRsvpSnapshot = (await env.DB.prepare(`SELECT * FROM rsvp WHERE league_id = 'smbhl' ORDER BY event_id, player_id`).all()).results;
    smbhlDataJsonSnapshot = JSON.parse(await env.SHEETS_KV.get('data_json'));
  });

  it('walks the full second-league loop end to end, then confirms SMBHL is provably untouched', async () => {
    // 1. Sign up.
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.42' },
      body: JSON.stringify({ email: 'fullloop.admin@example.com', password: 'a-strong-password-1' })
    });
    expect(signupRes.status).toBe(200);

    // 2. Log in (a separate, explicit login call on the account just created).
    const loginRes = await SELF.fetch('http://example.com/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'fullloop.admin@example.com', password: 'a-strong-password-1' })
    });
    expect(loginRes.status).toBe(200);
    const cookie = extractCookie(loginRes);

    // 3. Create the league.
    const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Full Loop League', teamNames: ['Comets', 'Meteors'], tracksStats: true })
    });
    expect(leagueRes.status).toBe(200);
    const leagueId = (await leagueRes.json()).league.id;

    // 4. Publish a season with a tight custom roster config (so marking
    // one player OUT genuinely creates a shortage below).
    const publishRes = await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ season_name: 'Full Loop Season 1', goalies_per_team: 1, skaters_per_team: 1, min_skaters: 1 })
    });
    expect(publishRes.status).toBe(200);

    // 5. Add the roster player who will RSVP.
    const playerRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Loop Roster Player', email: 'player@fullloop.com', role: 'roster' })
    });
    expect(playerRes.status).toBe(200);
    const { player_id: playerId } = (await playerRes.json()).contact;
    await env.DB.prepare(`UPDATE contacts SET preferred_team = 'Comets' WHERE player_id = ?`).bind(playerId).run();
    const playerSalt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerId).first()).token_salt;

    // Also add an eligible sub, so the later invite-subs step has someone
    // real to invite.
    const subRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Loop Sub Player', email: 'sub@fullloop.com', role: 'sub_skater' })
    });
    expect(subRes.status).toBe(200);

    // 6. Create the event, far enough out to clear callSubs' cutoff/rush windows.
    const futureDate = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ date: futureDate, season: 'Full Loop Season 1', venue: 'Full Loop Rink' })
    });
    expect(eventRes.status).toBe(200);
    const eventId = (await eventRes.json()).event.id;

    // 7. Mint the player's magic link (the way an invite email would).
    const token = await computeToken(RSVP_SECRET, `lr:${leagueId}:${eventId}:${playerId}:${playerSalt}`);

    // 8. Player submits RSVP via the link: marks OUT, creating a shortage
    // (skaters_per_team: 1, and now 0 confirmed). Since Part R, this
    // immediately (synchronously, within this same request) queues AND
    // sends a sub-invite -- no separate admin action needed for the
    // common case.
    env.RESEND_API_KEY = 're_test_key_full_loop';
    const originalFetch = globalThis.fetch;
    const sentMails = [];
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('api.resend.com')) {
        sentMails.push(JSON.parse(opts.body));
        return new Response(JSON.stringify({ id: 'mock_resend_id' }), { status: 200 });
      }
      return originalFetch(url, opts);
    };
    let rsvpRes;
    try {
      rsvpRes = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueId)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'out' })
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(rsvpRes.status).toBe(200);
    expect((await rsvpRes.json()).status).toBe('out');

    // The automatic (Part R) sub-invite email already went out under THIS
    // league's own identity, matching Part P's requirement -- proof the
    // whole chain (self-out -> shortage detected -> queued -> sent)
    // connects end to end with zero admin action.
    expect(sentMails.length).toBe(1);
    expect(sentMails[0].to).toEqual(['sub@fullloop.com']);
    expect(sentMails[0].from).toContain('fullloop.admin@example.com');
    expect(sentMails[0].from).not.toContain('smbhl.com');

    // 9. Admin views the event's shortage status -- still short, since no
    // one has answered the automatic invite yet.
    const statusRes = await SELF.fetch(`http://example.com/league/events/status?e=${encodeURIComponent(eventId)}`, {
      headers: { cookie }
    });
    expect(statusRes.status).toBe(200);
    const statusJson = await statusRes.json();
    const comets = statusJson.teams.find(t => t.team === 'Comets');
    expect(comets.short).toBe(true);
    expect(comets.openSkaters).toBeGreaterThan(0);

    // 10. Admin also has Part P's manual trigger available -- calling it
    // again right away is correctly a no-op (Part R's duplicate guard),
    // rather than re-spamming the same sub a second time.
    const inviteRes = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: eventId, team: 'Comets', need: 'skater' })
    });
    expect(inviteRes.status).toBe(200);
    expect(sentMails.length).toBe(1); // still just the one, automatic invite

    // 11. This league published its own real data_json entry, under its
    // own scoped key -- never SMBHL's.
    const leagueDataJson = JSON.parse(await env.SHEETS_KV.get(dataJsonKeyFor(leagueId)));
    expect(leagueDataJson.current_season).toBe('Full Loop Season 1');

    // ---- THE critical proof: SMBHL is provably unaffected by ALL of the
    // above -- every table and the KV blob, re-verified byte-for-byte
    // against the snapshots taken before this test ever touched anything.
    const contactsAfter = (await env.DB.prepare(`SELECT * FROM contacts WHERE league_id = 'smbhl' ORDER BY player_id`).all()).results;
    expect(contactsAfter).toEqual(smbhlContactsSnapshot);

    const eventsAfter = (await env.DB.prepare(`SELECT * FROM events WHERE league_id = 'smbhl' ORDER BY id`).all()).results;
    expect(eventsAfter).toEqual(smbhlEventsSnapshot);

    const rsvpAfter = (await env.DB.prepare(`SELECT * FROM rsvp WHERE league_id = 'smbhl' ORDER BY event_id, player_id`).all()).results;
    expect(rsvpAfter).toEqual(smbhlRsvpSnapshot);

    const dataJsonAfter = JSON.parse(await env.SHEETS_KV.get('data_json'));
    expect(dataJsonAfter).toEqual(smbhlDataJsonSnapshot);

    const smbhlOutboxRows = (await env.DB.prepare(`SELECT * FROM outbox WHERE league_id = 'smbhl'`).all()).results;
    expect(smbhlOutboxRows.length).toBe(0); // nothing was ever queued for SMBHL by any of this
  });
});

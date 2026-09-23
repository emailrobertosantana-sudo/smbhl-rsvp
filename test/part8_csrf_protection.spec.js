// Part 8: CSRF protection on every session-authenticated POST route built
// this session. Double-submit-cookie: a non-HttpOnly csrf_token cookie is
// set alongside every session cookie (login/signup/reset-password), and
// each protected route requires it echoed back as an X-CSRF-Token header,
// verified against a value derived from the session's own (userId, epoch)
// under env.AUTH_SECRET -- an attacker's cross-site page can trigger a
// request that carries the cookie, but has no way to read this origin's
// cookie value to also put it in a header.
//
// Proves: a session-authenticated POST with NO CSRF header is rejected
// (403) even though the session itself is genuinely valid; a WRONG/
// mismatched token is also rejected; the real token from signup/login
// actually works; and the legacy ADMIN_KEY-gated routes are completely
// untouched (different auth model, explicitly out of scope).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part8-csrf-secret';
const ADMIN_KEY = 'test-part8-csrf-admin-key';

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

describe('Part 8: CSRF protection', () => {
  let cookie, csrfToken, leagueId, eventId, playerId;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.ADMIN_KEY = ADMIN_KEY;
    await applyRealSchema(env);

    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.471' },
      body: JSON.stringify({ email: 'part8.csrf@example.com', password: 'a-strong-password-1' })
    });
    cookie = extractCookie(signupRes);
    csrfToken = extractCsrfToken(signupRes);
    expect(csrfToken).toBeTruthy(); // the whole mechanism depends on this cookie existing

    const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Part 8 CSRF League', teamNames: ['Red', 'Blue'], tracksStats: true })
    });
    leagueId = (await leagueRes.json()).league.id;

    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Part 8 Season' })
    });
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2026-12-13' })
    });
    eventId = (await eventRes.json()).event.id;
    const contactRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'CSRF Test Player' })
    });
    playerId = (await contactRes.json()).contact.player_id;
  });

  it('POST /leagues/create with a genuinely valid session but NO CSRF header is rejected (403), not treated as authenticated-and-fine', async () => {
    const res = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' }, // no x-csrf-token at all
      body: JSON.stringify({ name: 'Should Never Exist League', teamNames: ['A', 'B'], tracksStats: true })
    });
    expect(res.status).toBe(403);
    const row = await env.DB.prepare('SELECT id FROM leagues WHERE name = ?').bind('Should Never Exist League').first();
    expect(row).toBeNull();
  });

  it('a wrong/garbage CSRF token is rejected, not silently accepted', async () => {
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': 'totally-made-up-token' },
      body: JSON.stringify({ name: 'Rejected Player' })
    });
    expect(res.status).toBe(403);
  });

  it.each([
    ['POST /league/contacts', () => SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'No Csrf Player' })
    })],
    ['POST /league/events', () => SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-20' })
    })],
    ['POST /league/season/publish', () => SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ season_name: 'No Csrf Season' })
    })],
  ])('%s with no CSRF header is rejected (403)', async (_name, makeRequest) => {
    const res = await makeRequest();
    expect(res.status).toBe(403);
  });

  it('POST /league/rsvp/admin and POST /league/events/invite-subs with no CSRF header are rejected (403)', async () => {
    const rsvpRes = await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: eventId, player_id: playerId, status: 'in' })
    });
    expect(rsvpRes.status).toBe(403);

    const inviteRes = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: eventId, team: 'Red', need: 'skater' })
    });
    expect(inviteRes.status).toBe(403);
  });

  it('with the real token, the same routes work correctly (the check is enforced, not just permanently broken)', async () => {
    const res = await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: playerId, status: 'in' })
    });
    expect(res.status).toBe(200);
  });

  it("a CSRF token from a DIFFERENT session cannot be used to bypass this session's check", async () => {
    const otherSignup = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.472' },
      body: JSON.stringify({ email: 'part8.other@example.com', password: 'a-strong-password-1' })
    });
    const otherCsrfToken = extractCsrfToken(otherSignup);
    expect(otherCsrfToken).not.toBe(csrfToken);

    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': otherCsrfToken },
      body: JSON.stringify({ name: 'Cross Session Player' })
    });
    expect(res.status).toBe(403);
  });

  it('resetting the password (which bumps session_epoch) invalidates the old CSRF token along with the old session', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.473' },
      body: JSON.stringify({ email: 'part8.epoch@example.com', password: 'original-password-1' })
    });
    const oldCookie = extractCookie(signupRes);
    const oldCsrfToken = extractCsrfToken(signupRes);

    await env.DB.prepare('UPDATE users SET session_epoch = session_epoch + 1 WHERE email = ?').bind('part8.epoch@example.com').run();

    const res = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST',
      headers: { cookie: oldCookie, 'content-type': 'application/json', 'x-csrf-token': oldCsrfToken },
      body: JSON.stringify({ name: 'Stale Epoch League', teamNames: ['A', 'B'], tracksStats: true })
    });
    // The session itself is already dead post-epoch-bump (checkUserSession
    // fails first), so this is unauthenticated, not specifically a CSRF
    // failure -- but either way, the stale token grants nothing.
    expect(res.status).toBe(401);
  });

  it("SMBHL's legacy ADMIN_KEY-gated write routes are completely unaffected -- no CSRF check applies to that auth model", async () => {
    const res = await SELF.fetch('http://example.com/admin/subs/reassign', {
      method: 'POST',
      headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: 'whatever', player_id: 'P0001', team: 'Red' })
    });
    // Never a CSRF-shaped 403 -- ADMIN_KEY routes reject on their own terms
    // (a nonexistent event here), proving this request reached real
    // ADMIN_KEY-gated logic, not a CSRF gate that doesn't exist for it.
    expect(res.status).not.toBe(403);
  });
});

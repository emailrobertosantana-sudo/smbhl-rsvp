// Part 9: multi-admin invite flow. An existing admin invites a second
// person to their league via a signed, time-limited invite token (same
// shape as email verification/password reset, its own message prefix so
// none of the three can be replayed as each other); the invited person
// either creates an account (if they don't have one -- password only,
// email comes from the token) or gets linked to an existing one (must be
// logged in as that exact email; CSRF-protected, since a real session is
// being used). Real email-sending infrastructure throughout.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part9-invite-secret';

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

function extractInviteToken(sentMail) {
  const raw = JSON.stringify(sentMail);
  const m = /\/league\/admins\/accept\?token=([^\s"'<\\]+)/.exec(raw);
  if (!m) throw new Error('No invite link found in mail body: ' + raw);
  return decodeURIComponent(m[1]);
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

describe('Part 9: multi-admin invite flow', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RESEND_API_KEY = 're_test_key_part9';
    await applyRealSchema(env);
  });

  it('the co-admins list and invite form are on the Settings page (live-testing task, batch 5, Part 7 -- moved from the dashboard)', async () => {
    const a = await signupAndCreateLeague('part9.dash@example.com', '203.0.113.481', 'Part 9 Dashboard League', ['Red', 'Blue']);
    const res = await SELF.fetch('http://example.com/league/settings', { headers: { cookie: a.cookie } });
    const html = await res.text();
    expect(html).toContain('part9.dash@example.com');
    expect(html).toContain('id="invite_email"');
    expect(html).toContain('id="invite_submit"');
  });

  it('a brand-new invited email creates its own account on accept, and gets linked as admin', async () => {
    const a = await signupAndCreateLeague('part9.inviter1@example.com', '203.0.113.482', 'Part 9 League New Account', ['Otters', 'Falcons']);

    const { sentMails, result: inviteRes } = await withMailMock(async () =>
      SELF.fetch('http://example.com/league/admins/invite', {
        method: 'POST',
        headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
        body: JSON.stringify({ email: 'part9.newadmin@example.com' })
      })
    );
    expect(inviteRes.status).toBe(200);
    const inviteJson = await inviteRes.json();
    expect(inviteJson.hasExistingAccount).toBe(false);
    expect(sentMails.length).toBe(1);
    expect(sentMails[0].to).toEqual(['part9.newadmin@example.com']);

    const token = extractInviteToken(sentMails[0]);

    // GET the accept page shows a real signup-style form (not a login
    // prompt), since this email has no account yet.
    const pageRes = await SELF.fetch(`http://example.com/league/admins/accept?token=${encodeURIComponent(token)}`);
    expect(pageRes.status).toBe(200);
    const pageHtml = await pageRes.text();
    expect(pageHtml).toContain('id="accept_password"');
    expect(pageHtml).toContain('part9.newadmin@example.com');

    const acceptRes = await SELF.fetch('http://example.com/league/admins/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password: 'brand-new-admin-password' })
    });
    expect(acceptRes.status).toBe(200);
    const acceptJson = await acceptRes.json();
    expect(acceptJson.ok).toBe(true);
    expect(acceptJson.accountCreated).toBe(true);
    expect(acceptRes.headers.get('set-cookie') || '').toContain('user_session='); // immediately logged in

    const userRow = await env.DB.prepare('SELECT id, email_verified_at FROM users WHERE email = ?').bind('part9.newadmin@example.com').first();
    expect(userRow).toBeTruthy();
    expect(userRow.email_verified_at).toBeTruthy(); // clicking the real emailed link is proof of ownership

    const adminRow = await env.DB.prepare('SELECT role FROM league_admins WHERE user_id = ? AND league_id = ?').bind(userRow.id, a.leagueId).first();
    expect(adminRow.role).toBe('admin');

    // The new admin can immediately use the league (real session, real access).
    const dashRes = await SELF.fetch('http://example.com/dashboard', { headers: { cookie: extractCookie(acceptRes) } });
    const dashHtml = await dashRes.text();
    expect(dashHtml).toContain('Part 9 League New Account');
  });

  it('an email that already has an account gets linked once logged in (no password re-entry, no new account created)', async () => {
    const a = await signupAndCreateLeague('part9.inviter2@example.com', '203.0.113.483', 'Part 9 League Existing Account', ['Sharks', 'Wolves']);
    const existing = await signupAndCreateLeague('part9.existingadmin@example.com', '203.0.113.484', 'Part 9 Existing Admin Own League', ['Gold', 'Silver']);

    const { sentMails } = await withMailMock(async () =>
      SELF.fetch('http://example.com/league/admins/invite', {
        method: 'POST',
        headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
        body: JSON.stringify({ email: 'part9.existingadmin@example.com' })
      })
    );
    expect(sentMails.length).toBe(1);
    const token = extractInviteToken(sentMails[0]);

    // Not logged in as that email at all: the accept page shows a login
    // prompt, not a form; and the POST is rejected with requiresLogin.
    const anonAcceptRes = await SELF.fetch('http://example.com/league/admins/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token })
    });
    expect(anonAcceptRes.status).toBe(401);
    expect((await anonAcceptRes.json()).requiresLogin).toBe(true);

    const pageRes = await SELF.fetch(`http://example.com/league/admins/accept?token=${encodeURIComponent(token)}`, {
      headers: { cookie: existing.cookie }
    });
    const pageHtml = await pageRes.text();
    expect(pageHtml).toContain('id="accept_submit"');
    expect(pageHtml).not.toContain('id="accept_password"'); // no password field -- already has an account

    const acceptRes = await SELF.fetch('http://example.com/league/admins/accept', {
      method: 'POST',
      headers: { cookie: existing.cookie, 'content-type': 'application/json', 'x-csrf-token': existing.csrfToken },
      body: JSON.stringify({ token })
    });
    expect(acceptRes.status).toBe(200);
    const acceptJson = await acceptRes.json();
    expect(acceptJson.accountCreated).toBe(false);

    // Still exactly one user row for that email -- no duplicate account.
    const userCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').bind('part9.existingadmin@example.com').first();
    expect(userCount.n).toBe(1);

    const adminRow = await env.DB.prepare('SELECT role FROM league_admins WHERE user_id = ? AND league_id = ?').bind(existing.userId, a.leagueId).first();
    expect(adminRow.role).toBe('admin');
  });

  it('inviting an email that is already an admin of this league is rejected with a clear error', async () => {
    const a = await signupAndCreateLeague('part9.inviter3@example.com', '203.0.113.485', 'Part 9 League Dup Invite', ['A', 'B']);
    const res = await SELF.fetch('http://example.com/league/admins/invite', {
      method: 'POST',
      headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ email: 'part9.inviter3@example.com' }) // themselves
    });
    expect(res.status).toBe(409);
  });

  it('a garbage or expired token is rejected cleanly on both GET and POST', async () => {
    const pageRes = await SELF.fetch('http://example.com/league/admins/accept?token=not-a-real-token');
    expect([400, 410]).toContain(pageRes.status);

    const postRes = await SELF.fetch('http://example.com/league/admins/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-token' })
    });
    expect([400, 410]).toContain(postRes.status);
  });

  it('inviting requires a valid session and CSRF token, matching every other league-admin write route', async () => {
    const unauthRes = await SELF.fetch('http://example.com/league/admins/invite', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'whoever@example.com' })
    });
    expect(unauthRes.status).toBe(401);

    const a = await signupAndCreateLeague('part9.inviter4@example.com', '203.0.113.486', 'Part 9 League CSRF', ['A', 'B']);
    const noCsrfRes = await SELF.fetch('http://example.com/league/admins/invite', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'whoever@example.com' })
    });
    expect(noCsrfRes.status).toBe(403);
  });
});

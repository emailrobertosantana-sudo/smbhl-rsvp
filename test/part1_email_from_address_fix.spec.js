// Part 1 (overnight follow-up task): diagnosed and fixed why a live
// demo signup never received its verification email.
//
// Root cause found live (confirmed via `npx wrangler secret list --env
// demo` showing no secret literally named RESEND_API_KEY -- only one
// whose NAME is itself a Resend API key value, `re_...`, apparently
// set with the wrong CLI argument -- and independently reconfirmed via
// `npx wrangler tail --env demo` during a real test signup, which
// logged `[auth] Failed to send verification email to ...:
// RESEND_API_KEY not set`) is an infrastructure/secrets misconfiguration
// on env.demo, not a code bug -- src/index.js's sendMail() already
// throws a clear, specific Error when the secret is missing, and
// auth.js's sendVerificationEmail already logs that error via
// console.error rather than swallowing it silently. Fixing the secret
// itself requires a `wrangler secret put` WRITE, outside today's
// read-only secrets authorization, so it is NOT done here -- flagged
// in the task report as a decision needed.
//
// A second, genuine CODE bug WAS found and IS fixed here: every
// auth-flow email that runs before any league exists (so has no
// leagueCfg to derive a from-address from -- signup verification,
// password-reset request) unconditionally fell back to SMBHL's own
// hardcoded FROM/REPLY_TO constants, regardless of which
// domain/deployment actually sent it. A notreligue.ca signup got an
// email whose sender said "SMBHL - Hockey". Fixed via
// defaultMailIdentity(env), derived from env.PUBLIC_URL the same way
// Part 0's root-redirect fix derives behavior from the request's own
// domain -- SMBHL's own deployment is provably unchanged.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part1-email-from-fix-secret';

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

describe('Part 1: verification/reset email FROM address is domain-aware, and a missing RESEND_API_KEY is surfaced loudly', () => {
  let originalPublicUrl, originalResendKey;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  afterEach(() => {
    if (originalPublicUrl !== undefined) env.PUBLIC_URL = originalPublicUrl;
    if (originalResendKey !== undefined) env.RESEND_API_KEY = originalResendKey;
    vi.restoreAllMocks();
  });

  it("SMBHL's own deployment (PUBLIC_URL contains smbhl.com) sends the verification email under its exact original SMBHL identity -- unchanged", async () => {
    originalPublicUrl = env.PUBLIC_URL;
    originalResendKey = env.RESEND_API_KEY;
    env.PUBLIC_URL = 'https://rsvp.smbhl.com';
    env.RESEND_API_KEY = 're_test_key_part1_smbhl';

    const { sentMails } = await withMailMock(async () =>
      SELF.fetch('http://example.com/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.601' },
        body: JSON.stringify({ email: 'part1.smbhl.signup@example.com', password: 'a-strong-password-1' })
      })
    );
    expect(sentMails.length).toBe(1);
    expect(sentMails[0].from).toBe('SMBHL - Hockey <joueur@smbhl.com>');
    expect(sentMails[0].reply_to).toBe('info@smbhl.com');
  });

  it("a non-SMBHL deployment (e.g. notreligue.ca's PUBLIC_URL) sends the verification email under ITS OWN identity, never SMBHL's -- this is the bug that was found live", async () => {
    originalPublicUrl = env.PUBLIC_URL;
    originalResendKey = env.RESEND_API_KEY;
    env.PUBLIC_URL = 'https://rsvp.notreligue.ca';
    env.RESEND_API_KEY = 're_test_key_part1_notreligue';

    const { sentMails } = await withMailMock(async () =>
      SELF.fetch('http://example.com/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.602' },
        body: JSON.stringify({ email: 'part1.notreligue.signup@example.com', password: 'a-strong-password-1' })
      })
    );
    expect(sentMails.length).toBe(1);
    expect(sentMails[0].from).not.toContain('smbhl.com');
    expect(sentMails[0].from).not.toContain('SMBHL');
    expect(sentMails[0].from).toContain('notreligue.ca');
  });

  it("a password-reset request on a non-SMBHL deployment also uses that deployment's own identity, not SMBHL's", async () => {
    originalPublicUrl = env.PUBLIC_URL;
    originalResendKey = env.RESEND_API_KEY;
    env.PUBLIC_URL = 'https://rsvp.notreligue.ca';
    env.RESEND_API_KEY = 're_test_key_part1_reset';

    await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.603' },
      body: JSON.stringify({ email: 'part1.notreligue.reset@example.com', password: 'a-strong-password-1' })
    });

    const { sentMails } = await withMailMock(async () =>
      SELF.fetch('http://example.com/auth/request-password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'part1.notreligue.reset@example.com' })
      })
    );
    expect(sentMails.length).toBe(1);
    expect(sentMails[0].from).not.toContain('smbhl.com');
    expect(sentMails[0].from).toContain('notreligue.ca');
  });

  it("an admin-invite email uses THAT LEAGUE's own real identity (the inviting admin's own signup email), not the generic deployment default", async () => {
    originalPublicUrl = env.PUBLIC_URL;
    originalResendKey = env.RESEND_API_KEY;
    env.PUBLIC_URL = 'https://rsvp.notreligue.ca';
    env.RESEND_API_KEY = 're_test_key_part1_invite';

    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.604' },
      body: JSON.stringify({ email: 'part1.inviter@example.com', password: 'a-strong-password-1' })
    });
    const cookie = extractCookie(signupRes);
    const csrfToken = extractCsrfToken(signupRes);
    await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Part 1 Invite League', teamNames: ['A', 'B'], tracksStats: true })
    });

    const { sentMails } = await withMailMock(async () =>
      SELF.fetch('http://example.com/league/admins/invite', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ email: 'part1.invitee@example.com' })
      })
    );
    expect(sentMails.length).toBe(1);
    // Bug 1 fix (live-testing): a league's real fromEmail is now
    // "<league name> <slug@mail.notreligue.ca>" (getLeagueSeasonConfig,
    // leagues.js) -- the admin's own raw signup email is never a domain
    // verified in the Resend account, so using it as From caused every
    // league's email to be rejected with a 403 in production. The
    // admin's real email is still the Reply-To, so a player's reply
    // reaches them directly.
    expect(sentMails[0].from).toContain('mail.notreligue.ca');
    expect(sentMails[0].from).not.toContain('part1.inviter@example.com');
    expect(sentMails[0].reply_to).toBe('part1.inviter@example.com');
  });

  it('a missing RESEND_API_KEY is surfaced loudly (a specific, greppable console.error), never silently discarded without a trace -- this is what let the live bug be diagnosed via wrangler tail', async () => {
    originalPublicUrl = env.PUBLIC_URL;
    originalResendKey = env.RESEND_API_KEY;
    env.PUBLIC_URL = 'https://rsvp.notreligue.ca';
    delete env.RESEND_API_KEY; // the exact live misconfiguration

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.605' },
      body: JSON.stringify({ email: 'part1.missingkey@example.com', password: 'a-strong-password-1' })
    });

    // Signup itself still succeeds (best-effort email, by design) --
    // but the failure must be loudly, specifically logged.
    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalled();
    const loggedMessages = errorSpy.mock.calls.map(args => args.join(' ')).join('\n');
    expect(loggedMessages).toContain('Failed to send verification email');
    expect(loggedMessages).toContain('RESEND_API_KEY not set');
  });
});

// Real user accounts and sessions — a separate system from the legacy
// ADMIN_KEY (admin_auth.js) and the legacy RSVP/review magic links (built on
// crypto_utils.js's hmac()/same()). This module is purely additive: nothing
// existing calls into it yet, and nothing here touches ADMIN_KEY, RSVP_SECRET,
// or any Fall 2026 data path. It signs its own tokens (sessions, email
// verification) with a dedicated env.AUTH_SECRET, kept separate from the
// legacy secrets so a leak in one domain doesn't cascade into another.
//
// Deployment note: env.AUTH_SECRET must be provisioned as a Workers secret
// (`wrangler secret put AUTH_SECRET`) before any of this is deployed — that
// command was not run as part of this task (see the final report).

import { hmac, same } from './crypto_utils.js';

/* ---------- password hashing ---------- */
//
// bcrypt is a native C addon — cannot run in a V8-isolate Workers runtime at
// all. Argon2/scrypt exist as pure-JS or WASM ports, but they're
// intentionally memory- and CPU-hard, which risks exceeding a Worker's CPU
// time limit on a single request (tight on the free tier, and untested in
// this project either way) and would add a new external dependency with no
// existing track record in this codebase. PBKDF2-HMAC-SHA256 via the
// platform's own Web Crypto API (crypto.subtle) has none of those problems:
// it's natively implemented (fast, no WASM/JS interpretation overhead), has
// zero new dependencies, and is Cloudflare's own documented recommendation
// for password hashing in Workers. That combination — actually reliable in
// this exact runtime — outweighs Argon2's stronger theoretical resistance to
// GPU cracking for this use case.
//
// Iteration count: OWASP's 2023 guidance for PBKDF2-HMAC-SHA256 is 600,000
// iterations, calibrated for general server hardware. This project's Workers
// plan/CPU-time budget isn't confirmed, so 100,000 is chosen as a safer
// starting point that stays well inside typical Workers CPU limits while
// still far exceeding older minimums (NIST/OWASP have both cited 10,000 as a
// floor). The iteration count is stored in the hash string itself
// (pbkdf2$<iterations>$<salt>$<hash>), so it can be raised later for new
// hashes without invalidating existing ones or requiring a migration.

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_HASH = 'SHA-256';
const PBKDF2_KEY_LENGTH_BITS = 256;
const SALT_BYTES = 16;

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pbkdf2(password, saltBytes, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: PBKDF2_HASH },
    keyMaterial,
    PBKDF2_KEY_LENGTH_BITS
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(derived)}`;
}

export async function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  if (!iterations || iterations < 1) return false;
  let salt, expected;
  try {
    salt = base64ToBytes(parts[2]);
    expected = parts[3];
  } catch (_) {
    return false;
  }
  const derived = await pbkdf2(password, salt, iterations);
  return same(bytesToBase64(derived), expected);
}

/* ---------- sessions ---------- */
//
// A session cookie is a signed, self-contained token — no per-request DB
// lookup to just *validate the signature*, unlike the ADMIN_KEY's exact
// string comparison. But "log out" has to actually revoke something, and a
// purely stateless signed cookie can't do that (there's nothing to delete).
// The fix is a tiny bit of server state: users.session_epoch. The signed
// cookie embeds the epoch it was issued under; checkUserSession additionally
// confirms that epoch still matches the user's current one (one indexed D1
// read). Logging out bumps the epoch, which instantly invalidates every
// outstanding session for that user (all devices) — a common, acceptable
// simplification, and the only way to make "destroy session" actually mean
// something with a signed-cookie design.
//
// Expiry: 30 days. This is a distinct decision from the 48h scoped
// review-token expiry (admin_auth.js) — that token exists to let one
// specific, time-boxed task (verifying one scoresheet) happen without a
// login, so it should die with the review. A user session is the opposite:
// an admin logging into their own league dashboard expects to stay logged in
// across a normal week-to-week cadence, not re-enter a password every visit.
// 30 days also matches this app's existing admin_key cookie lifetime
// (admin_auth.js's adminPageHeaders), so the two systems feel consistent
// while they coexist during migration.

const SESSION_COOKIE = 'user_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

const sessionMsg = (userId, epoch, exp) => `session:${userId}:${epoch}:${exp}`;

export async function createSessionCookie(env, userId, epoch) {
  const exp = Date.now() + SESSION_TTL_MS;
  const sig = await hmac(env.AUTH_SECRET, sessionMsg(userId, epoch, exp));
  const value = `${userId}.${epoch}.${exp}.${sig}`;
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Lax; Secure`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`;
}

// Analogous to admin_auth.js's checkAdminAuth, but for real user accounts —
// named distinctly on purpose. The two systems coexist during migration and
// must never be confused: an ADMIN_KEY grants legacy SMBHL-admin access to
// everything under /admin/*; a user session (once wired into future league
// routes) will only ever grant access to leagues that user actually admins.
// Returns { userId } on success, or null — never throws.
export async function checkUserSession(req, env) {
  try {
    const cookie = req.headers.get('cookie') || '';
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
    if (!m) return null;
    const raw = decodeURIComponent(m[1]);
    const parts = raw.split('.');
    if (parts.length !== 4) return null;
    const [userId, epochStr, expStr, sig] = parts;
    const epoch = Number(epochStr);
    const exp = Number(expStr);
    if (!userId || !Number.isFinite(epoch) || !Number.isFinite(exp)) return null;
    if (Date.now() > exp) return null;

    const want = await hmac(env.AUTH_SECRET, sessionMsg(userId, epoch, exp));
    if (!same(want, sig)) return null;

    const row = await env.DB.prepare('SELECT session_epoch FROM users WHERE id = ?').bind(userId).first();
    if (!row || Number(row.session_epoch) !== epoch) return null;

    return { userId };
  } catch (_) {
    return null;
  }
}

// Bumps the user's session_epoch, which invalidates every outstanding signed
// session cookie for them (all devices) — the actual "destroy" behind
// POST /auth/logout.
export async function invalidateAllSessions(env, userId) {
  await env.DB.prepare('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?').bind(userId).run();
}

/* ---------- email verification ----------
 * Same signed-token shape as sessions, but single-purpose and shorter-lived:
 * 24 hours, long enough that a verification email isn't a fire drill to act
 * on, short enough to limit how long a leaked/forwarded link stays useful.
 * Verifying is idempotent by design — a second click on the same valid
 * (unexpired) token just re-sets email_verified_at and reports success again,
 * rather than erroring on "already verified". That needed no extra
 * single-use-token tracking table, and re-verifying an already-verified
 * address is harmless.
 *
 * Not wired up: no email is actually sent anywhere in this task. handleSignup
 * generates the token/link and logs + returns it in the signup response, so
 * the mechanism is real and end-to-end testable; a future task would swap
 * that console.log + response field for a real send (see the final report).
 */

const VERIFY_TOKEN_TTL_MS = 24 * 3600 * 1000;

const verifyMsg = (userId, exp) => `verify:${userId}:${exp}`;

export async function generateVerificationToken(env, userId, ttlMs = VERIFY_TOKEN_TTL_MS) {
  const exp = Date.now() + ttlMs;
  const sig = await hmac(env.AUTH_SECRET, verifyMsg(userId, exp));
  const token = `${userId}.${exp}.${sig}`;
  return { token, exp };
}

// Returns { ok: true, userId } or { ok: false, error }. Never throws.
export async function verifyEmailToken(env, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, error: 'malformed' };
  const [userId, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!userId || !Number.isFinite(exp)) return { ok: false, error: 'malformed' };
  if (Date.now() > exp) return { ok: false, error: 'expired' };

  let want;
  try {
    want = await hmac(env.AUTH_SECRET, verifyMsg(userId, exp));
  } catch (_) {
    return { ok: false, error: 'malformed' };
  }
  if (!same(want, sig)) return { ok: false, error: 'invalid' };

  await env.DB.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').bind(new Date().toISOString(), userId).run();
  return { ok: true, userId };
}

// Checkable helpers for anything that later wants to gate player-facing email
// sending. Not wired into any existing send path in this task — see the
// final report for why, and what wiring them in would look like.
export async function isUserEmailVerified(env, userId) {
  const row = await env.DB.prepare('SELECT email_verified_at FROM users WHERE id = ?').bind(userId).first();
  return !!(row && row.email_verified_at);
}

// True if ANY admin linked to this league (via league_admins) has a verified
// email. Deliberately derived via a join rather than a stored boolean column
// on leagues: a cached column would need to be kept in sync by hand every
// time an admin verifies (or a new admin is added), which is exactly the
// kind of denormalization bug that quietly rots. users.email_verified_at
// stays the single source of truth.
export async function isLeagueEmailVerified(env, leagueId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM league_admins la
       JOIN users u ON u.id = la.user_id
      WHERE la.league_id = ? AND u.email_verified_at IS NOT NULL`
  ).bind(leagueId).first();
  return !!(row && row.c > 0);
}

/* ---------- signup rate limiting ----------
 * Considered: a Durable Object (per-IP counter) — not used anywhere in this
 * project, would need a new binding + migration, and is more machinery than
 * this scale needs. Cloudflare's built-in Rate Limiting binding — also not
 * currently bound, has to be provisioned outside Worker code (dashboard/API),
 * and isn't something this project's existing vitest-pool-workers test setup
 * can exercise without that provisioning existing first. A D1-backed counter
 * uses infrastructure already proven reliable in this exact project (D1 is
 * already the system of record for everything else here), needs no new
 * bindings, and is trivially testable the same way the rest of this suite
 * already tests D1-backed behavior. Simplest option that's actually correct
 * at this scale, per the brief.
 *
 * Fixed window: 5 signups per IP per hour. Loose enough that a shared
 * office/NAT IP can onboard a couple of real admins without friction, tight
 * enough to blunt an automated burst. A starting point, easy to tune later.
 */

const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_LIMIT_PER_WINDOW = 5;

// Returns 'ok' (and records the attempt) or 'rate_limited' (and does not).
export async function checkSignupRateLimit(env, ip) {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT window_start, count FROM signup_attempts WHERE ip = ?').bind(ip).first();

  if (!row) {
    await env.DB.prepare('INSERT INTO signup_attempts (ip, window_start, count) VALUES (?, ?, 1)').bind(ip, String(now)).run();
    return 'ok';
  }

  const windowStart = Number(row.window_start) || 0;
  if (now - windowStart > SIGNUP_WINDOW_MS) {
    await env.DB.prepare('UPDATE signup_attempts SET window_start = ?, count = 1 WHERE ip = ?').bind(String(now), ip).run();
    return 'ok';
  }

  if (Number(row.count) >= SIGNUP_LIMIT_PER_WINDOW) {
    return 'rate_limited';
  }

  await env.DB.prepare('UPDATE signup_attempts SET count = count + 1 WHERE ip = ?').bind(ip).run();
  return 'ok';
}

/* ---------- validation ---------- */

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 8;
}

/* ---------- HTTP handlers ---------- */

export async function handleSignup(req, env) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!isValidEmail(email)) {
      return Response.json({ ok: false, error: 'Please enter a valid email address.' }, { status: 400 });
    }
    if (!isValidPassword(password)) {
      return Response.json({ ok: false, error: 'Password must be at least 8 characters.' }, { status: 400 });
    }

    const ip = req.headers.get('cf-connecting-ip') || '127.0.0.1';
    const rateLimitStatus = await checkSignupRateLimit(env, ip);
    if (rateLimitStatus === 'rate_limited') {
      return Response.json({ ok: false, error: 'Too many signup attempts from this network. Please try again later.' }, { status: 429 });
    }

    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existing) {
      return Response.json({ ok: false, error: 'An account with this email already exists.' }, { status: 409 });
    }

    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(password);

    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, created_at, email_verified_at, last_login_at, session_epoch)
       VALUES (?, ?, ?, ?, NULL, ?, 0)`
    ).bind(userId, email, passwordHash, now, now).run();

    // Verification email is NOT actually sent anywhere in this task — see the
    // final report. The token/link are generated (so the mechanism is real
    // and testable end-to-end) and logged + returned in the response so a
    // future task can wire them into real sending without touching this
    // generation logic.
    const { token, exp } = await generateVerificationToken(env, userId);
    const publicUrl = env.PUBLIC_URL || 'https://rsvp.smbhl.com';
    const verificationLink = `${publicUrl}/auth/verify?token=${encodeURIComponent(token)}`;
    console.log(`[auth] Email verification link for ${email} (not sent — no email infra wired up yet): ${verificationLink}`);

    const cookie = await createSessionCookie(env, userId, 0);
    return new Response(JSON.stringify({
      ok: true,
      userId,
      email,
      verification: { token, exp, link: verificationLink }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': cookie }
    });
  } catch (err) {
    return Response.json({ ok: false, error: 'Signup failed: ' + err.message }, { status: 500 });
  }
}

export async function handleLogin(req, env) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const genericFailure = () => Response.json({ ok: false, error: 'Invalid email or password.' }, { status: 401 });

    if (!email || !password) return genericFailure();

    const user = await env.DB.prepare('SELECT id, password_hash, session_epoch FROM users WHERE email = ?').bind(email).first();
    if (!user) return genericFailure(); // same generic error whether the email exists or not

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) return genericFailure();

    await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(new Date().toISOString(), user.id).run();

    const cookie = await createSessionCookie(env, user.id, user.session_epoch);
    return new Response(JSON.stringify({ ok: true, userId: user.id }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': cookie }
    });
  } catch (err) {
    return Response.json({ ok: false, error: 'Login failed: ' + err.message }, { status: 500 });
  }
}

export async function handleLogout(req, env) {
  const session = await checkUserSession(req, env);
  if (session) {
    await invalidateAllSessions(env, session.userId);
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': clearSessionCookie() }
  });
}

export async function handleVerifyEmail(req, env, url) {
  const token = url.searchParams.get('token');
  if (!token) return Response.json({ ok: false, error: 'Missing token' }, { status: 400 });

  const result = await verifyEmailToken(env, token);
  if (!result.ok) {
    const status = result.error === 'expired' ? 410 : 400;
    return Response.json({ ok: false, error: result.error }, { status });
  }
  return Response.json({ ok: true, userId: result.userId });
}

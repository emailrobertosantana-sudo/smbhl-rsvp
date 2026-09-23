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
import { nlEmailWrap, nlEmailButton, nlDocument } from './design_system.js';
import { ERROR_I18N } from './error_i18n.js';

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

    return { userId, epoch };
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

/* ---------- CSRF protection (Part 8) ----------
 * Double-submit-cookie pattern: a `csrf_token` cookie, deliberately NOT
 * HttpOnly (client JS must be able to read it), set on the same response as
 * every session cookie (login/signup/reset-password). Every session-
 * authenticated state-changing POST route this session built must echo that
 * value back as an X-CSRF-Token request header; checkCsrfToken compares it
 * against a value derived from the session's own (userId, epoch) under
 * env.AUTH_SECRET. A cross-site attacker's page can trigger a request that
 * carries the cookie (browsers do that automatically), but has no way to
 * read this origin's cookie value to also put it in a header -- that's the
 * whole defense.
 *
 * The token is deterministic from (userId, epoch) rather than a separately
 * stored random value -- no new table/column, and it gets a free, useful
 * side effect: bumping session_epoch (logout, password reset) invalidates
 * every outstanding CSRF token right along with every session, with zero
 * extra code.
 *
 * SameSite=Lax on the session cookie already blocks the classic cross-site
 * form-POST CSRF vector in modern browsers on its own; this is deliberate
 * defense in depth on top of that, not a replacement for it, per the task.
 */

const CSRF_COOKIE = 'csrf_token';
const CSRF_HEADER = 'x-csrf-token';

const csrfMsg = (userId, epoch) => `csrf:${userId}:${epoch}`;

async function csrfTokenFor(env, userId, epoch) {
  return hmac(env.AUTH_SECRET, csrfMsg(userId, epoch));
}

// Set on the same response as every session cookie (see createSessionCookie
// call sites). Same Path/SameSite/Secure as the session cookie, minus
// HttpOnly -- client JS needs to read it to attach the header.
export async function createCsrfCookie(env, userId, epoch) {
  const token = await csrfTokenFor(env, userId, epoch);
  return `${CSRF_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax; Secure`;
}

export function clearCsrfCookie() {
  return `${CSRF_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
}

// Builds the response headers for every route that issues a fresh session
// (login, signup, reset-password): JSON content-type plus BOTH cookies. A
// plain object literal can't hold two 'set-cookie' entries (object keys are
// unique) and Set-Cookie values must never be comma-joined onto one header
// line (a value can itself legally contain a comma, e.g. in an Expires
// date) -- a Headers object with two real .append() calls is the only
// correct way to send two cookies in one response.
export async function sessionResponseHeaders(env, userId, epoch) {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', await createSessionCookie(env, userId, epoch));
  headers.append('set-cookie', await createCsrfCookie(env, userId, epoch));
  return headers;
}

// Verifies the X-CSRF-Token request header against `session` (the object
// checkUserSession already returned for this same request -- never re-derives
// it from the cookie, so a request can't pass CSRF by presenting a header
// that merely matches its OWN cookie; it must match the session actually
// validated for this request). Returns true/false, never throws.
export async function checkCsrfToken(req, env, session) {
  try {
    const header = req.headers.get(CSRF_HEADER);
    if (!header) return false;
    const want = await csrfTokenFor(env, session.userId, session.epoch);
    return same(want, header);
  } catch (_) {
    return false;
  }
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
 * Sending: handleSignup and handleResendVerification both accept an injected
 * sendMailFunc (same dependency-injection shape review.js already uses for
 * handleScoresheetEmail/handleReviewPublish) rather than importing index.js's
 * sendMail() directly — index.js imports this module, so a direct import
 * back would be circular. The real sendMail is passed in at the route
 * dispatch in index.js; tests pass their own mock/stub instead, so no test
 * needs a real RESEND_API_KEY to exercise this path.
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

// Design system Part 5: rebuilt on the real Notre Ligue design system
// (nlEmailWrap/nlEmailButton, guidelines/30-emails.md's build rules --
// 560px table, inline styles, Archivo/Arial/Helvetica, one bulletproof
// button). This account-level email (sent before any league exists)
// has no league color to brand with, so it uses Notre Ligue's own
// product black (#16181d) for the bar/button, same as the marketing
// site's own primary color token. Deliberately safe to touch: this
// email builder belongs exclusively to the new user-account system
// (auth.js) -- SMBHL has no user accounts and never sends this email
// (see this module's own top-of-file comment).
//
// Live-testing bug fix: this used to always send BOTH languages
// stacked in one email regardless of which language the person
// actually signed up in. Fixed to send only the one language the
// signup was completed in -- `lang` comes from the signup form's own
// active language (see handleSignup) and defaults to 'fr' to match
// every other lang fallback in this app (nlAuthScript etc). Kept as a
// small pure function so tests can assert on subject/link content
// without going through an HTTP round trip.
function buildVerificationEmail(verificationLink, lang = 'fr') {
  const isEn = lang === 'en';
  const subject = isEn ? 'Confirm your email' : 'Confirme ton courriel';
  const text = isEn
    ? `Welcome! Confirm your email by clicking this link:
${verificationLink}

This link expires in 24 hours. If you didn't create an account, you can ignore this email.`
    : `Bienvenue ! Confirme ton courriel en cliquant sur ce lien :
${verificationLink}

Ce lien expire dans 24 heures. Si tu n'as pas créé de compte, ignore ce courriel.`;
  const bodyHtml = isEn
    ? `
    <h1 style="margin:0 0 12px;font:700 28px/34px Archivo,Arial,Helvetica,sans-serif;font-stretch:118%;color:#16181d;">Confirm your email</h1>
    <p style="margin:0 0 24px;font-size:16px;line-height:25px;">Welcome! Click the button below to activate your account.</p>
    ${nlEmailButton(verificationLink, 'Confirm my email')}
    <p style="margin:20px 0 0;font-size:13px;line-height:19px;color:#55585f;">This link expires in 24 hours. If you didn't create an account, you can ignore this email.</p>`
    : `
    <h1 style="margin:0 0 12px;font:700 28px/34px Archivo,Arial,Helvetica,sans-serif;font-stretch:118%;color:#16181d;">Confirme ton courriel</h1>
    <p style="margin:0 0 24px;font-size:16px;line-height:25px;">Bienvenue ! Clique sur le bouton ci-dessous pour activer ton compte.</p>
    ${nlEmailButton(verificationLink, 'Confirmer mon courriel')}
    <p style="margin:20px 0 0;font-size:13px;line-height:19px;color:#55585f;">Ce lien expire dans 24 heures. Si tu n'as pas créé de compte, ignore ce courriel.</p>`;
  const html = nlEmailWrap({
    brandName: 'Notre Ligue',
    barColor: '#16181d',
    bodyHtml,
    footerHtml: isEn ? 'Sent by Notre Ligue' : 'Envoyé par Notre Ligue'
  });
  return { subject, text, html };
}

// Generates a fresh token/link for userId and sends it via the injected
// sendMailFunc. Never throws — a send failure (including a missing
// RESEND_API_KEY, e.g. on an environment where that secret hasn't been
// provisioned yet) is logged clearly and swallowed, exactly like every other
// best-effort notification email in this codebase (see handleScoresheetEmail
// / handleReviewPublish in review.js). It must never take down the request
// that triggered it (signup, or an explicit resend).
async function sendVerificationEmail(env, sendMailFunc, email, userId, lang = 'fr') {
  const { token, exp } = await generateVerificationToken(env, userId);
  const publicUrl = env.PUBLIC_URL || 'https://rsvp.smbhl.com';
  const verificationLink = `${publicUrl}/auth/verify?token=${encodeURIComponent(token)}`;

  if (typeof sendMailFunc === 'function') {
    try {
      const { subject, text, html } = buildVerificationEmail(verificationLink, lang);
      await sendMailFunc(env, email, subject, text, html);
      console.log(`[auth] Verification email sent to ${email}`);
    } catch (err) {
      console.error(`[auth] Failed to send verification email to ${email}: ${err.message}`);
    }
  } else {
    console.log(`[auth] No sendMailFunc provided — verification link for ${email} not sent: ${verificationLink}`);
  }

  return { token, exp, verificationLink };
}

/* ---------- password reset (Part 6) ----------
 * Same signed-HMAC-token shape as email verification above (userId.exp.sig,
 * env.AUTH_SECRET), with its own message prefix ('reset' vs 'verify') so a
 * verification token can never be replayed as a reset token or vice versa.
 * Deliberately does NOT reuse VERIFY_TOKEN_TTL_MS's 24h window — a reset
 * token grants control of the account (a new password), a meaningfully
 * higher-stakes action than confirming an address already controls, so it
 * gets a much shorter 1h window instead.
 */

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const resetMsg = (userId, exp) => `reset:${userId}:${exp}`;

async function generatePasswordResetToken(env, userId, ttlMs = RESET_TOKEN_TTL_MS) {
  const exp = Date.now() + ttlMs;
  const sig = await hmac(env.AUTH_SECRET, resetMsg(userId, exp));
  const token = `${userId}.${exp}.${sig}`;
  return { token, exp };
}

// Returns { ok: true, userId } or { ok: false, error } — never throws, and
// unlike verifyEmailToken has NO side effect (it doesn't change any account
// state on its own); the actual password change happens separately in
// handleResetPassword once a new password is also supplied.
async function verifyPasswordResetToken(env, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, error: 'malformed' };
  const [userId, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!userId || !Number.isFinite(exp)) return { ok: false, error: 'malformed' };
  if (Date.now() > exp) return { ok: false, error: 'expired' };

  let want;
  try {
    want = await hmac(env.AUTH_SECRET, resetMsg(userId, exp));
  } catch (_) {
    return { ok: false, error: 'malformed' };
  }
  if (!same(want, sig)) return { ok: false, error: 'invalid' };
  return { ok: true, userId };
}

// Design system Part 5: same rebuild as buildVerificationEmail above
// (real design system, black product bar/button, bilingual single
// send) -- see that function's own comment for why this is safe to
// touch (exclusively the new account system, never SMBHL).
function buildPasswordResetEmail(resetLink) {
  const subject = 'Réinitialise ton mot de passe / Reset your password';
  const text =
`Tu as demandé à réinitialiser ton mot de passe. Clique sur ce lien pour en choisir un nouveau :
${resetLink}

Ce lien expire dans 1 heure. Si tu n'as pas demandé ceci, ignore ce courriel -- ton mot de passe actuel reste inchangé.

---

You requested a password reset. Click this link to choose a new password:
${resetLink}

This link expires in 1 hour. If you didn't request this, you can ignore this email -- your current password stays unchanged.`;
  const bodyHtml = `
    <h1 style="margin:0 0 12px;font:700 28px/34px Archivo,Arial,Helvetica,sans-serif;font-stretch:118%;color:#16181d;">Réinitialise ton mot de passe</h1>
    <p style="margin:0 0 24px;font-size:16px;line-height:25px;">Tu as demandé à réinitialiser ton mot de passe. Clique sur le bouton ci-dessous pour en choisir un nouveau.</p>
    ${nlEmailButton(resetLink, 'Choisir un nouveau mot de passe')}
    <p style="margin:20px 0 0;font-size:13px;line-height:19px;color:#55585f;">Ce lien expire dans 1 heure. Si tu n'as pas demandé ceci, ignore ce courriel -- ton mot de passe actuel reste inchangé.</p>
    <hr style="border:none;border-top:1px solid #e3e3e0;margin:28px 0;">
    <h1 style="margin:0 0 12px;font:700 28px/34px Archivo,Arial,Helvetica,sans-serif;font-stretch:118%;color:#16181d;">Reset your password</h1>
    <p style="margin:0 0 24px;font-size:16px;line-height:25px;">You requested a password reset. Click the button below to choose a new one.</p>
    ${nlEmailButton(resetLink, 'Choose a new password')}
    <p style="margin:20px 0 0;font-size:13px;line-height:19px;color:#55585f;">This link expires in 1 hour. If you didn't request this, you can ignore this email -- your current password stays unchanged.</p>`;
  const html = nlEmailWrap({
    brandName: 'Notre Ligue',
    barColor: '#16181d',
    bodyHtml,
    footerHtml: 'Envoyé par Notre Ligue'
  });
  return { subject, text, html };
}

// Fixed window, same shape as checkSignupRateLimit (and deliberately reuses
// the same signup_attempts table rather than a new migration/table for one
// more IP-keyed counter — a 'reset:' key prefix keeps the two counters from
// ever colliding or cross-throttling each other's normal usage).
const RESET_REQUEST_WINDOW_MS = 60 * 60 * 1000;
const RESET_REQUEST_LIMIT_PER_WINDOW = 5;

async function checkPasswordResetRateLimit(env, ip) {
  const key = `reset:${ip}`;
  const now = Date.now();
  const row = await env.DB.prepare('SELECT window_start, count FROM signup_attempts WHERE ip = ?').bind(key).first();

  if (!row) {
    await env.DB.prepare('INSERT INTO signup_attempts (ip, window_start, count) VALUES (?, ?, 1)').bind(key, String(now)).run();
    return 'ok';
  }

  const windowStart = Number(row.window_start) || 0;
  if (now - windowStart > RESET_REQUEST_WINDOW_MS) {
    await env.DB.prepare('UPDATE signup_attempts SET window_start = ?, count = 1 WHERE ip = ?').bind(String(now), key).run();
    return 'ok';
  }

  if (Number(row.count) >= RESET_REQUEST_LIMIT_PER_WINDOW) {
    return 'rate_limited';
  }

  await env.DB.prepare('UPDATE signup_attempts SET count = count + 1 WHERE ip = ?').bind(key).run();
  return 'ok';
}

// POST /auth/request-password-reset — body: { email }. Always responds
// { ok: true } regardless of whether that email actually has an account
// (a deliberate anti-enumeration measure: an attacker probing for which
// emails have accounts here learns nothing from the response either way).
// An email is only actually sent when a matching account genuinely exists.
export async function handleRequestPasswordReset(req, env, sendMailFunc = null) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    return Response.json({ ok: false, error: 'Please enter a valid email address.', errorKey: 'INVALID_EMAIL' }, { status: 400 });
  }

  const ip = req.headers.get('cf-connecting-ip') || '127.0.0.1';
  const rateLimitStatus = await checkPasswordResetRateLimit(env, ip);
  if (rateLimitStatus === 'rate_limited') {
    return Response.json({ ok: false, error: 'Too many reset attempts from this network. Please try again later.', errorKey: 'RATE_LIMITED_RESET' }, { status: 429 });
  }

  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (user) {
    const { token } = await generatePasswordResetToken(env, user.id);
    const publicUrl = env.PUBLIC_URL || 'https://rsvp.smbhl.com';
    const resetLink = `${publicUrl}/reset-password?token=${encodeURIComponent(token)}`;
    if (typeof sendMailFunc === 'function') {
      try {
        const { subject, text, html } = buildPasswordResetEmail(resetLink);
        await sendMailFunc(env, email, subject, text, html);
      } catch (err) {
        console.error(`[auth] Failed to send password reset email to ${email}: ${err.message}`);
      }
    }
  }

  return Response.json({ ok: true });
}

// POST /auth/reset-password — body: { token, password }. Verifies the
// signed, time-limited token, sets the new password, and -- per the task
// requirement -- bumps session_epoch (invalidateAllSessions) so every
// session issued under the OLD password is instantly revoked everywhere,
// exactly like an explicit logout. Then issues a fresh session cookie under
// the new epoch, matching handleSignup's own "immediately logged in"
// convention, since a successful reset is itself a strong proof of email
// ownership.
export async function handleResetPassword(req, env) {
  const body = await req.json().catch(() => ({}));
  const token = String(body.token || '');
  const password = String(body.password || '');

  if (!isValidPassword(password)) {
    return Response.json({ ok: false, error: 'Password must be at least 8 characters.', errorKey: 'WEAK_PASSWORD' }, { status: 400 });
  }

  const result = await verifyPasswordResetToken(env, token);
  if (!result.ok) {
    const status = result.error === 'expired' ? 410 : 400;
    const errorKey = result.error === 'expired' ? 'LINK_EXPIRED' : result.error === 'malformed' ? 'LINK_MALFORMED' : 'LINK_INVALID';
    return Response.json({ ok: false, error: result.error, errorKey }, { status });
  }

  const passwordHash = await hashPassword(password);
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(passwordHash, result.userId).run();
  await invalidateAllSessions(env, result.userId);

  const user = await env.DB.prepare('SELECT session_epoch FROM users WHERE id = ?').bind(result.userId).first();

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: await sessionResponseHeaders(env, result.userId, user.session_epoch)
  });
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

/* ---------- login rate limiting (Part 7) ----------
 * Same fixed-window-counter shape and same reused signup_attempts table as
 * checkSignupRateLimit/checkPasswordResetRateLimit, under its own 'login:'
 * key prefix so none of the three ever cross-throttle each other. Tighter
 * window than signup's (15 min, not 1h) and a higher raw count (10, not 5)
 * -- login brute-forcing is a faster, higher-frequency attack than signup
 * spam, so it needs a shorter window to actually blunt it, while still
 * being generous enough that a legitimate user who mistypes their password
 * a few times in a row is never the one who gets blocked. Counts every
 * attempt (success or failure), matching checkSignupRateLimit's own
 * behavior, not just failures -- simpler, and consistent with the rest of
 * this file's rate limiters.
 */

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT_PER_WINDOW = 10;

async function checkLoginRateLimit(env, ip) {
  const key = `login:${ip}`;
  const now = Date.now();
  const row = await env.DB.prepare('SELECT window_start, count FROM signup_attempts WHERE ip = ?').bind(key).first();

  if (!row) {
    await env.DB.prepare('INSERT INTO signup_attempts (ip, window_start, count) VALUES (?, ?, 1)').bind(key, String(now)).run();
    return 'ok';
  }

  const windowStart = Number(row.window_start) || 0;
  if (now - windowStart > LOGIN_WINDOW_MS) {
    await env.DB.prepare('UPDATE signup_attempts SET window_start = ?, count = 1 WHERE ip = ?').bind(String(now), key).run();
    return 'ok';
  }

  if (Number(row.count) >= LOGIN_LIMIT_PER_WINDOW) {
    return 'rate_limited';
  }

  await env.DB.prepare('UPDATE signup_attempts SET count = count + 1 WHERE ip = ?').bind(key).run();
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

export async function handleSignup(req, env, sendMailFunc = null) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const lang = body.lang === 'en' ? 'en' : 'fr';

    if (!isValidEmail(email)) {
      return Response.json({ ok: false, error: 'Please enter a valid email address.', errorKey: 'INVALID_EMAIL' }, { status: 400 });
    }
    if (!isValidPassword(password)) {
      return Response.json({ ok: false, error: 'Password must be at least 8 characters.', errorKey: 'WEAK_PASSWORD' }, { status: 400 });
    }

    const ip = req.headers.get('cf-connecting-ip') || '127.0.0.1';
    const rateLimitStatus = await checkSignupRateLimit(env, ip);
    if (rateLimitStatus === 'rate_limited') {
      return Response.json({ ok: false, error: 'Too many signup attempts from this network. Please try again later.', errorKey: 'RATE_LIMITED_SIGNUP' }, { status: 429 });
    }

    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existing) {
      return Response.json({ ok: false, error: 'An account with this email already exists.', errorKey: 'EMAIL_EXISTS' }, { status: 409 });
    }

    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(password);

    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, created_at, email_verified_at, last_login_at, session_epoch, signup_lang)
       VALUES (?, ?, ?, ?, NULL, ?, 0, ?)`
    ).bind(userId, email, passwordHash, now, now, lang).run();

    const { token, exp, verificationLink } = await sendVerificationEmail(env, sendMailFunc, email, userId, lang);

    return new Response(JSON.stringify({
      ok: true,
      userId,
      email,
      verification: { token, exp, link: verificationLink }
    }), {
      status: 200,
      headers: await sessionResponseHeaders(env, userId, 0)
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
    const genericFailure = () => Response.json({ ok: false, error: 'Invalid email or password.', errorKey: 'INVALID_CREDENTIALS' }, { status: 401 });

    const ip = req.headers.get('cf-connecting-ip') || '127.0.0.1';
    const rateLimitStatus = await checkLoginRateLimit(env, ip);
    if (rateLimitStatus === 'rate_limited') {
      return Response.json({ ok: false, error: 'Too many login attempts from this network. Please try again later.', errorKey: 'RATE_LIMITED_LOGIN' }, { status: 429 });
    }

    if (!email || !password) return genericFailure();

    const user = await env.DB.prepare('SELECT id, password_hash, session_epoch FROM users WHERE email = ?').bind(email).first();
    if (!user) return genericFailure(); // same generic error whether the email exists or not

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) return genericFailure();

    await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(new Date().toISOString(), user.id).run();

    return new Response(JSON.stringify({ ok: true, userId: user.id }), {
      status: 200,
      headers: await sessionResponseHeaders(env, user.id, user.session_epoch)
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
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', clearSessionCookie());
  headers.append('set-cookie', clearCsrfCookie());
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

// Live-testing bug fix (design system follow-up task, Bug 1): a real
// person clicking this link from their email inbox is a normal
// top-level browser navigation, which was landing on raw JSON --
// `{"ok":true,"userId":"..."}` -- with no confirmation, no next step,
// nothing styled. Content-negotiated on the Accept header: a real
// browser navigation sends `Accept: text/html,...` and gets a real
// styled nlDocument confirmation page; anything else (a bare fetch()
// with no Accept header at all -- every existing test, curl, or a
// genuine programmatic API consumer) keeps getting the exact same
// JSON shape as before, so nothing that already depends on it breaks.
export async function handleVerifyEmail(req, env, url) {
  const wantsHtml = (req.headers.get('accept') || '').includes('text/html');
  const token = url.searchParams.get('token');
  if (!token) {
    if (wantsHtml) return renderVerifyEmailPage({ ok: false, errorKey: 'MISSING_TOKEN' }, 400);
    return Response.json({ ok: false, error: 'Missing token', errorKey: 'MISSING_TOKEN' }, { status: 400 });
  }

  const result = await verifyEmailToken(env, token);
  if (!result.ok) {
    const status = result.error === 'expired' ? 410 : 400;
    const errorKey = result.error === 'expired' ? 'LINK_EXPIRED' : result.error === 'malformed' ? 'LINK_MALFORMED' : 'LINK_INVALID';
    if (wantsHtml) return renderVerifyEmailPage({ ok: false, errorKey }, status);
    return Response.json({ ok: false, error: result.error, errorKey }, { status });
  }
  if (wantsHtml) return renderVerifyEmailPage({ ok: true }, 200);
  return Response.json({ ok: true, userId: result.userId });
}

// Bilingual single render (FR then EN together), same convention as
// every other standalone confirmation/error page this app builds on
// nlDocument (e.g. leagueRsvpNotice, src/index.js) -- no FR/EN toggle
// script needed for a one-shot confirmation the visitor reads once.
function renderVerifyEmailPage({ ok, errorKey }, status) {
  const fr = ok
    ? { title: 'Courriel confirmé', body: 'Ton compte est activé.', cta: 'Aller à mon tableau de bord', href: '/dashboard' }
    : { title: (ERROR_I18N[errorKey] && ERROR_I18N[errorKey].fr) || 'Ce lien est invalide.', body: 'Connecte-toi, puis renvoie un courriel de confirmation depuis ton tableau de bord.', cta: 'Se connecter', href: '/login' };
  const en = ok
    ? { title: 'Email confirmed', body: 'Your account is active.', cta: 'Go to my dashboard', href: '/dashboard' }
    : { title: (ERROR_I18N[errorKey] && ERROR_I18N[errorKey].en) || 'This link is invalid.', body: 'Log in, then resend a confirmation email from your dashboard.', cta: 'Log in', href: '/login' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const bodyHtml = `<style>.nl{display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:var(--space-5)}</style>
<div style="max-width:420px">
  <h1 style="font:700 26px/32px var(--font-display);font-stretch:118%;margin:0 0 8px;">${esc(fr.title)}</h1>
  <p class="nl-help" style="margin:0 0 24px;">${esc(fr.body)}</p>
  <a href="${esc(fr.href)}" class="nl-btn nl-btn--primary">${esc(fr.cta)}</a>
  <hr style="border:none;border-top:1px solid var(--line);margin:28px 0;">
  <h1 style="font:700 26px/32px var(--font-display);font-stretch:118%;margin:0 0 8px;">${esc(en.title)}</h1>
  <p class="nl-help" style="margin:0 0 24px;">${esc(en.body)}</p>
  <a href="${esc(en.href)}" class="nl-btn nl-btn--secondary">${esc(en.cta)}</a>
</div>`;
  return new Response(nlDocument({ title: fr.title, description: '', bodyHtml }), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  });
}

// Requires an existing logged-in session (the same one handleSignup already
// sets on the signup response) — this is a "my original verification email
// didn't arrive/got lost" recovery path for the account you're already in,
// not a way to trigger email to an address you don't otherwise control.
// Idempotent-ish: calling it again after already verifying just reports
// alreadyVerified rather than sending another email.
export async function handleResendVerification(req, env, sendMailFunc = null) {
  const session = await checkUserSession(req, env);
  if (!session) {
    return Response.json({ ok: false, error: 'Authentication required.', errorKey: 'AUTH_REQUIRED' }, { status: 401 });
  }
  if (!(await checkCsrfToken(req, env, session))) {
    return Response.json({ ok: false, error: 'Invalid or missing CSRF token.', errorKey: 'CSRF_INVALID' }, { status: 403 });
  }

  const user = await env.DB.prepare('SELECT email, email_verified_at, signup_lang FROM users WHERE id = ?').bind(session.userId).first();
  if (!user) {
    return Response.json({ ok: false, error: 'Account not found.', errorKey: 'ACCOUNT_NOT_FOUND' }, { status: 404 });
  }
  if (user.email_verified_at) {
    return Response.json({ ok: true, alreadyVerified: true });
  }

  await sendVerificationEmail(env, sendMailFunc, user.email, session.userId, user.signup_lang || 'fr');
  return Response.json({ ok: true, alreadyVerified: false });
}

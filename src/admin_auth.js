// Shared admin authentication for every /admin/* route in this app. Both
// index.js and review.js authenticate through this module (rather than each
// keeping their own copy) so the failed-attempt lockout is tracked
// consistently across the whole admin surface, not just part of it.

import { hmac, same } from './crypto_utils.js';

const FAILED_ADMIN_ATTEMPTS = new Map();

export function checkAdminAuth(req, env) {
  if (!env?.ADMIN_KEY) return 'no_key';
  const expected = String(env.ADMIN_KEY).trim();
  let candidate = (req.headers.get('x-admin') || '').trim();
  if (!candidate) {
    try {
      const url = new URL(req.url);
      candidate = (url.searchParams.get('key') || url.searchParams.get('k') || url.searchParams.get('t') || '').trim();
    } catch (_) {}
  }
  if (!candidate) {
    try {
      const cookie = req.headers.get('cookie') || '';
      const m = cookie.match(/(?:^|;\s*)admin_key=([^;]+)/);
      if (m) candidate = decodeURIComponent(m[1]).trim();
    } catch (_) {}
  }

  const ip = req.headers.get('cf-connecting-ip') || '127.0.0.1';
  const now = Date.now();
  const rec = FAILED_ADMIN_ATTEMPTS.get(ip);

  // If candidate matches expected key, immediately clear any lockout and allow access
  if (candidate && candidate === expected) {
    if (rec) FAILED_ADMIN_ATTEMPTS.delete(ip);
    return 'ok';
  }

  // If key is wrong and IP is locked out
  if (rec && rec.count >= 10 && (now - rec.lastAttempt) < 15 * 60 * 1000) {
    return 'locked';
  }

  // Only record failed attempt if an actual candidate was sent and was incorrect!
  if (candidate) {
    if (!rec || (now - rec.lastAttempt) > 15 * 60 * 1000) {
      FAILED_ADMIN_ATTEMPTS.set(ip, { count: 1, lastAttempt: now });
    } else {
      rec.count++;
      rec.lastAttempt = now;
    }
  }

  return 'unauthorized';
}

export function adminAuthResponse(status) {
  if (status === 'locked') {
    return new Response('Trop de tentatives infructueuses. Réessaie dans 15 minutes / Too many failed attempts. Locked out for 15 minutes.', { status: 429 });
  }
  return new Response('nope', { status: 403 });
}

export function adminPageHeaders(authOk, env) {
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  };
  if (authOk && env?.ADMIN_KEY) {
    headers['set-cookie'] = `admin_key=${encodeURIComponent(env.ADMIN_KEY)}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`;
  }
  return headers;
}

/* ---------- scoped, single-review access tokens ----------
 * The scoresheet-verification email (handleScoresheetEmail) links straight
 * into /admin/review?id=... for someone who has never entered the shared
 * ADMIN_KEY. Rather than either requiring them to log in elsewhere first or
 * leaking the full admin key into that email, the link carries a signed,
 * narrowly-scoped token — same HMAC mechanism (hmac() + a constant-time
 * same() compare) already used for the player/team/poll RSVP links, just
 * with its own message format and an expiry baked into what's signed.
 *
 * The token proves nothing more than "the holder was emailed this one
 * review". It is checked ONLY by checkReviewAuth, and ONLY once the caller
 * has already resolved which review_id the request targets — it is never
 * accepted as a substitute for the ADMIN_KEY on any other /admin/* route.
 *
 * Expiry: 48 hours. This matches two lifecycle facts already established
 * elsewhere in this codebase rather than picking an arbitrary number:
 * cleanupOldReviews() (review.js) auto-expires any still-draft review after
 * 48h and deletes its photos, and the scoresheet image KV entries are
 * written with expirationTtl: 172800 (= 48h in seconds). A review token
 * that outlived the review's own photos would be pointless; one that dies
 * sooner would make the email link unreliable for a normal same-weekend
 * back-and-forth while an admin cross-checks a scoresheet.
 */
export const REVIEW_TOKEN_TTL_MS = 48 * 3600 * 1000;

const reviewTokenMsg = (reviewId, exp) => `review:${reviewId}:${exp}`;

// Signs a fresh { rt, exp } pair for one review. `exp` is a Unix-ms
// timestamp and is itself part of what's signed, so it can't be tampered
// with independently of the signature.
export async function generateReviewToken(env, reviewId, ttlMs = REVIEW_TOKEN_TTL_MS) {
  const exp = Date.now() + ttlMs;
  const rt = await hmac(env.RSVP_SECRET, reviewTokenMsg(reviewId, exp));
  return { rt, exp };
}

// Pulls a candidate { rt, exp } pair from wherever the caller put it: a
// header (fetch()-driven POSTs from the review page's own script), the URL
// query string (plain navigation and <img src> loads, which can't set
// headers), or parsed form fields (the add-sheet multipart form).
export function extractScopedReviewToken(req, url, formData) {
  const rt = req.headers.get('x-review-token')
    || url.searchParams.get('rt')
    || (formData && formData.get('rt'))
    || '';
  const exp = req.headers.get('x-review-exp')
    || url.searchParams.get('exp')
    || (formData && formData.get('exp'))
    || '';
  return { rt: String(rt || ''), exp: String(exp || '') };
}

// Authorizes a request against ONE specific review. Accepts either the full
// ADMIN_KEY (checkAdminAuth, unchanged) or a valid, unexpired scoped token
// for that exact reviewId. Falls back to checkAdminAuth's own status
// ('unauthorized' / 'no_key' / 'locked') when neither applies, so callers
// that don't pass a reviewId/scopedToken behave exactly like checkAdminAuth.
export async function checkReviewAuth(req, env, reviewId, scopedToken) {
  const adminResult = checkAdminAuth(req, env);
  if (adminResult === 'ok') return 'ok';
  if (!reviewId || !scopedToken) return adminResult;

  const { rt, exp } = scopedToken;
  if (!rt || !exp) return adminResult;

  const expNum = Number(exp);
  if (!expNum || !isFinite(expNum) || Date.now() > expNum) return adminResult;

  try {
    const want = await hmac(env.RSVP_SECRET, reviewTokenMsg(String(reviewId), expNum));
    if (same(want, rt)) return 'ok';
  } catch (_) {}

  return adminResult;
}

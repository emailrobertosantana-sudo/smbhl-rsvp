// Shared admin authentication for every /admin/* route in this app. Both
// index.js and review.js authenticate through this module (rather than each
// keeping their own copy) so the failed-attempt lockout is tracked
// consistently across the whole admin surface, not just part of it.

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

// Where to go after signing in.
//
// A league page opened without a session sends the visitor to
// /login?next=<the page they asked for>, and every step of signing in
// carries that value to the end: the login form, "forgot password", the
// reset link in the email (so it survives being opened in another browser
// or app), and the reset form. Without it, an admin who tapped "View the
// game" in an email landed on the dashboard after signing in.
//
// The value comes from a URL, so it is never trusted: safeNextPath accepts
// only a path of this site, and only the signed-in league pages. Anything
// else is dropped and the visitor lands on the dashboard as before. That
// is what keeps it from being used as an open redirect:
//   - it must start with one "/" (no scheme, no "//host", no "/\host");
//   - no backslash and no control character anywhere (browsers treat "\"
//     as "/" and drop tabs and newlines, which is how "/\evil" and
//     "/\t/evil" become another site);
//   - it is parsed against a placeholder origin and must stay on it, which
//     also resolves "%2e%2e" and ".." segments before the path is checked;
//   - the parsed path must be a league page (NEXT_PREFIXES). An encoded
//     "//" ("/%2F%2Fevil") is just an unknown path and is refused.
// The value returned is rebuilt from the parsed URL, never the text given.
const PLACEHOLDER = 'https://next.invalid';
const NEXT_EXACT = ['/dashboard', '/onboarding/season'];
const NEXT_PREFIXES = ['/league/'];

export function safeNextPath(raw) {
  if (typeof raw !== 'string' || raw.length < 2 || raw.length > 600) return null;
  if (raw[0] !== '/' || raw[1] === '/') return null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 92 || c < 32 || c === 127) return null; // backslash, control characters
  }
  let u;
  try { u = new URL(raw, PLACEHOLDER); } catch (_) { return null; }
  if (u.origin !== PLACEHOLDER) return null;
  const p = u.pathname;
  if (p.includes('//')) return null;
  if (!NEXT_EXACT.includes(p) && !NEXT_PREFIXES.some(x => p.startsWith(x))) return null;
  return p + u.search;
}

// The login URL for a page that needs a session: the page asked for rides
// along when it is one safeNextPath accepts.
export function loginUrlFor(url) {
  const next = safeNextPath(url.pathname + url.search);
  return url.origin + '/login' + (next ? '?next=' + encodeURIComponent(next) : '');
}

// "?next=..." to append to another sign-in step's link, or ''.
export function nextQuery(next, sep = '?') {
  const safe = safeNextPath(next);
  return safe ? sep + 'next=' + encodeURIComponent(safe) : '';
}

// A value safe to write inside an inline script.
export function nextForScript(next) {
  return JSON.stringify(safeNextPath(next) || '').split('<').join('\\u003c');
}

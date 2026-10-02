// Server-side write refusal, one place for every mode that makes a
// request read-only. The router asks writeRefusal() before any route runs:
// a request in a read-only mode that would write is answered here, so no
// write route can forget the check.
//
// A mode is data: the error it answers with, and the paths it still lets
// through (prefixes). Stage 2 has one, support mode (src/support_mode.js):
// the super-admin viewing a league's admin pages. Stage 3 (billing
// enforcement, read-only leagues) adds its own entry here with its own
// exceptions (players' answers, the billing page) and the same check.
//
// What counts as a write: any method but GET, HEAD and OPTIONS. A GET that
// writes is covered separately in support mode (its database and storage
// are read-only, src/support_mode.js supportEnv).
export const WRITE_MODES = {
  support: {
    status: 403,
    errorKey: 'SUPPORT_READ_ONLY',
    error: 'Support mode is read-only.',
    // The super-admin's own routes (they check the admin key, and leaving
    // support mode is one of them), and the pages' script-error reports.
    allow: ['/super-admin/', '/health/client-error']
  }
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export function isWriteRequest(req) {
  return !READ_METHODS.has(String(req.method || 'GET').toUpperCase());
}

// The refusal for this request in this mode, or null when it may go on.
export function writeRefusal(req, url, modeKey) {
  const mode = WRITE_MODES[modeKey];
  if (!mode || !isWriteRequest(req)) return null;
  if (mode.allow.some(p => url.pathname === p || url.pathname.startsWith(p))) return null;
  return Response.json({ ok: false, error: mode.error, errorKey: mode.errorKey }, { status: mode.status, headers: { 'cache-control': 'no-store' } });
}

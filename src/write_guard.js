// Server-side write refusal, one place for every mode that makes a
// request read-only. The router asks writeRefusal() before any route runs:
// a request in a read-only mode that would write is answered here, so no
// write route can forget the check.
//
// A mode is data: the error it answers with, and the paths it still lets
// through: `allow` (prefixes) and `exact` (whole paths only, where a prefix
// would let more through: '/league/rsvp' must not let '/league/rsvp/admin'
// by). Two modes:
//   support  the super-admin viewing a league's admin pages
//            (src/support_mode.js);
//   billing  a read-only league (billing batch 3, src/billing.js
//            classifyLeague): its trial ended unpaid, its subscription is
//            paused, or a payment failed. index.js asks it for a request
//            whose session acts on such a league.
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
    allow: ['/super-admin/', '/health/client-error'],
    exact: []
  },
  billing: {
    status: 403,
    errorKey: 'LEAGUE_READ_ONLY',
    error: 'This league is read-only. Go to the Subscription page (/league/billing) to reactivate it.',
    // The billing page and Stripe (subscribing unlocks the league), the
    // account itself (log in and out, password, terms), the super-admin,
    // the pages' script-error reports.
    allow: ['/league/billing/', '/billing/', '/auth/', '/super-admin/', '/health/client-error'],
    // Players answering through the links they already have (Roberto,
    // 2026-10-01): game answers, sub calls, polls, absences. Also what is
    // not a change to this league: creating another league, accepting an
    // invitation to one, and leaving it (deactivate, then delete).
    exact: [
      '/rsvp', '/rsvp/confirm', '/rsvp/absences', '/team-rsvp',
      '/league/rsvp', '/league/rsvp/confirm', '/league/rsvp/game', '/avail',
      '/api/poll/vote', '/api/player-position',
      '/leagues/create', '/league/admins/accept', '/league/deactivate', '/league/hard-delete'
    ]
  }
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export function isWriteRequest(req) {
  return !READ_METHODS.has(String(req.method || 'GET').toUpperCase());
}

// Whether the mode lets this path through.
export function writeAllowed(url, modeKey) {
  const mode = WRITE_MODES[modeKey];
  if (!mode) return true;
  const p = url.pathname;
  return (mode.exact || []).includes(p) || mode.allow.some(a => p === a || p.startsWith(a));
}

// The refusal for this request in this mode, or null when it may go on.
export function writeRefusal(req, url, modeKey) {
  const mode = WRITE_MODES[modeKey];
  if (!mode || !isWriteRequest(req)) return null;
  if (writeAllowed(url, modeKey)) return null;
  const extra = modeKey === 'billing' ? { billingUrl: '/league/billing' } : {};
  return Response.json({ ok: false, error: mode.error, errorKey: mode.errorKey, ...extra }, { status: mode.status, headers: { 'cache-control': 'no-store' } });
}

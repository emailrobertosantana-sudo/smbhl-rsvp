// Collision-safe ID generation for the two tables whose primary key was, up
// to this point, a bare app-derived string with no league scoping at all:
// events.id (a literal calendar date, e.g. '2026-09-20') and
// contacts.player_id (a sequential 'P####' counter). Adding a league_id
// *column* (migrate-020.sql) doesn't fix either of these on its own — the
// id itself is still the PRIMARY KEY, so two leagues creating a game on the
// same calendar date would still collide, and existing code does
// `INSERT ... ON CONFLICT(id) DO UPDATE`, which would silently merge one
// league's game into another's row instead of erroring.
//
// Composite primary keys (league_id, id) were considered and rejected here:
// event_id/player_id are threaded through ~500+ call sites in index.js
// alone (every RSVP/team/poll HMAC message, every magic-link URL, every
// foreign key in rsvp/sheet_reviews/team_messages/outbox/jobs/
// availability), all as a single opaque string. Making the key composite
// would mean touching every one of those call sites to carry a second
// value around. Prefixing the id itself with the owning league's id keeps
// it a single opaque string, so none of that code needs to change — the
// only code that ever needs to *understand* the id's shape is (a) whatever
// generates a new one, and (b) index.js's eventStart(), which parses
// events.id as a literal date to compute actual game start times (see
// eventDateFromId below).
//
// Every EXISTING id (all of SMBHL's real historical events/contacts, and
// every magic link already sent to a real player) is completely untouched.
// Only ids generated from this point forward — for any league, including
// SMBHL — use this scheme.

// SMBHL's own league_id. Fixed to match the sentinel row migrate-020.sql
// creates in `leagues` (id='smbhl'), not a random UUID, because today's
// event/contact-creation routes are still the legacy ADMIN_KEY-gated ones
// (single-tenant, no session/league_id threaded through them yet) — they
// need a stable, hardcoded value to tag their own new rows with until
// they're migrated to real per-league routing.
export const SMBHL_LEAGUE_ID = 'smbhl';

const DATE_SUFFIX = /(\d{4}-\d{2}-\d{2})$/;

// events.id for a NEW event: `${leagueId}:${date}`, e.g. 'smbhl:2026-10-04'.
// Two leagues calling this for the same calendar date always get different
// strings, because no two leagues share a league_id.
export function makeEventId(leagueId, date) {
  return `${leagueId}:${date}`;
}

// Recovers the literal ISO date (YYYY-MM-DD) from an events.id value,
// whether it's an old unprefixed id (every one of SMBHL's real existing
// events — the whole string IS the date, so this matches and returns it
// unchanged) or a new league-prefixed one (matches the trailing date
// portion). Falls back to returning the id as-is if no date-shaped suffix
// is found (e.g. the 'week-N' fallback id used when a fixture's date can't
// be parsed at all — same as today's behavior for that case).
export function eventDateFromId(id) {
  const m = String(id || '').match(DATE_SUFFIX);
  return m ? m[1] : id;
}

// contacts.player_id for a NEW contact: `${leagueId}:${suffix}`, where
// suffix is whatever this codebase already generates today ('P0500',
// 'P9001', ...). Old bare 'P####' ids are untouched; this only applies
// going forward.
export function makeContactId(leagueId, suffix) {
  return `${leagueId}:${suffix}`;
}

// SQL LIKE pattern for finding the highest-numbered id already issued in
// one league's own contact-id namespace, so each league's counter is
// independent (and so the old, unprefixed ids are never matched — they
// have no ':' at all, so they can't match a `${leagueId}:...%` pattern).
export function contactIdLikePattern(leagueId, subPrefix = 'P') {
  return `${leagueId}:${subPrefix}%`;
}

// Extracts the trailing run of digits from an id string (works the same
// whether that id is old-style 'P0298' or new-style 'smbhl:P0500').
export function extractTrailingNumber(id) {
  const m = String(id || '').match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

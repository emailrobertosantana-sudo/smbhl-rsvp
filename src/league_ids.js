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

// Team-structure task: a 'headcount' league (no team concept at all)
// still stores real team-shaped data underneath -- a single implicit
// team every one of its rsvp rows gets tagged with -- so the existing
// teamState/openSpots/expected shortage-detection machinery (built for
// 'fixed' mode) works completely unchanged for it. Never shown in any
// headcount UI surface (roster, event status, RSVP, public page all
// hide team display entirely for this mode); it exists purely so the
// data model underneath stays uniform across all three team-structure
// modes instead of forking the shortage-detection logic itself.
export const HEADCOUNT_TEAM_NAME = 'Tous';

const DATE_SUFFIX = /(\d{4}-\d{2}-\d{2})$/;

// events.id for a NEW event: `${leagueId}:${date}`, e.g. 'smbhl:2026-10-04'.
// Two leagues calling this for the same calendar date always get different
// strings, because no two leagues share a league_id.
//
// Fixed-teams scheduling task (Part 2): a league can genuinely play more
// than one game on the same date (SMBHL's own real example -- Letendre
// Gym 1 and Gym 2, same day, distinguished by venue, not folded into one
// event). The FIRST event on a date keeps this exact same id shape,
// completely unchanged -- every id ever issued before this task, and the
// common one-event-per-date case going forward, are untouched. A second
// (or later) event sharing that date gets an optional disambiguator
// inserted BEFORE the date, not after, so the date stays the string's
// trailing segment and eventDateFromId's own end-anchored match below
// keeps working unchanged for every id shape, old or new.
export function makeEventId(leagueId, date, disambiguator) {
  return disambiguator && disambiguator > 1
    ? `${leagueId}:${disambiguator}:${date}`
    : `${leagueId}:${date}`;
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

// The KV key for one league's data_json-equivalent blob (seasons,
// standings, rosters, fixtures — everything the site's public /data.json
// mirrors). SMBHL's own key is the literal, unprefixed 'data_json' — the
// exact string every one of this codebase's ~47 existing
// SHEETS_KV.get/put('data_json') call sites already hardcodes, so none of
// them need to change or know this function exists. Any OTHER league's key
// is namespaced under the same 'data_json' prefix (easy to recognize/audit
// in the KV namespace) but can never collide with SMBHL's bare key, since
// no league_id ever equals the empty string that would be needed to
// reduce `data_json:${leagueId}` back down to plain 'data_json'.
//
// This exists ONLY for new, explicitly league-aware code (checkLeagueAccess-
// gated routes) to resolve which key belongs to a given league — see
// leagues.js's getLeagueDataJson.
export function dataJsonKeyFor(leagueId) {
  return leagueId === SMBHL_LEAGUE_ID ? 'data_json' : `data_json:${leagueId}`;
}

/* ---------- league URL slugs (Part 2, overnight follow-up task) ----------
 * Short, human-readable public URLs (e.g. notreligue.ca/dmbhl) instead of
 * the raw UUID (notreligue.ca/league/public?league=<uuid>). Pure, DB-free
 * helpers live here; the DB-aware uniqueness check (generateUniqueSlug)
 * lives in leagues.js, matching this file's existing pure/impure split.
 */

// Lowercase, alphanumeric + hyphens only, no leading/trailing/doubled
// hyphens, capped at a sane length. Same rule client-side (the signup
// form's live preview) and server-side (validation on submit) --
// duplicated intentionally (client can't import a Worker module), kept
// trivially short so drift is easy to notice/fix.
export function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents (é -> e)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

export function isValidSlugFormat(slug) {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length >= 2 && slug.length <= 40;
}

// Every existing top-level route this Worker handles (see index.js's
// route dispatch) -- a league slug matching one of these would never
// actually be reachable at its own bare path (fixed routes are checked
// first), so it's rejected at creation time with a clear error instead
// of silently producing an unreachable public URL.
export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'auth', 'avail', 'dashboard', 'forgot-password', 'health',
  'img', 'league', 'leagues', 'login', 'logout', 'poll', 'reset-password',
  'rsvp', 'signup', 'team-rsvp', 'verify', 'robots.txt', 'favicon.ico',
  'well-known', 'static', 'assets', 'public'
]);

/* ---------- time, in the league's timezone ----------
 * Moved here from index.js (reminder-window-skip-on-create/reschedule
 * bug fix task): leagues.js needs eventStart() too -- to compute an
 * event's real hoursUntil at the moment it's created, for the same
 * reason index.js's cron already needs it -- but leagues.js can't
 * import from index.js (index.js imports FROM leagues.js; the reverse
 * would be a cycle). league_ids.js was already the natural shared home
 * -- this file's own top-of-file comment already named eventStart() as
 * the other piece of code (besides id generation) that has to
 * understand events.id's date-suffix shape. localParts/TZ moved
 * alongside it since eventStart depends on it; index.js now imports
 * both from here instead of defining them locally -- every existing
 * call site in index.js (localParts has several beyond eventStart)
 * keeps working unchanged, just via import instead of a local
 * definition.
 */
export const TZ = 'America/Toronto';
export function localParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit',
    year: 'numeric', month: '2-digit', day: '2-digit', hour12: false
  }).formatToParts(d);
  const g = t => (f.find(p => p.type === t) || {}).value;
  return {
    weekday: g('weekday'),
    hour: parseInt(g('hour'), 10),
    minute: parseInt(g('minute'), 10),
    date: `${g('year')}-${g('month')}-${g('day')}`
  };
}

// Real UTC instant an event actually starts, given its own id (date
// suffix) and start_time -- guesses the UTC offset (EST=5h/EDT=4h) by
// checking which one, once applied, actually lands back on the same
// local date/time America/Toronto would report; falls back to a fixed
// -05:00 offset if neither guess round-trips (should not happen for a
// real date, kept only as a last resort rather than returning null).
export function eventStart(ev) {
  if (!ev.start_time) return null;
  // ev.id is the literal date for every one of SMBHL's existing events
  // ('2026-09-20'). Since migrate-020.sql / league_ids.js, a NEW event's id
  // may instead be league-prefixed ('smbhl:2026-10-04') — eventDateFromId()
  // recovers the trailing date either way, so this keeps working unchanged
  // for old ids and correctly for new ones.
  const dateStr = eventDateFromId(ev.id);
  const [hh, mm] = ev.start_time.split(':').map(Number);
  for (const off of [4, 5]) {
    const guess = new Date(`${dateStr}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00Z`);
    if (isNaN(guess.getTime())) return null;
    const utc = new Date(guess.getTime() + off * 3600000);
    const p = localParts(utc);
    if (p.date === dateStr && p.hour === hh && p.minute === mm) return utc;
  }
  const fallback = new Date(`${dateStr}T${ev.start_time}:00-05:00`);
  return isNaN(fallback.getTime()) ? null : fallback;
}

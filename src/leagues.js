// League provisioning for real user accounts (auth.js), plus (see below)
// league-scoped authorization and KV access for the routes being migrated
// off the legacy single-tenant ADMIN_KEY.
//
// ARCHITECTURE DECISION — read this before extending anything here:
// Actually creating a new physical D1 database or KV namespace per league
// requires the Cloudflare account-level API (what `wrangler d1 create` /
// `wrangler kv namespace create` do) — a Worker's own request handler cannot
// provision new account-level resources like that from inside a fetch event;
// there is no "create me a new database" call available at runtime. So
// leagues in this file are ROWS in the one shared D1 database this Worker
// already has (env.DB), scoped by league_id, not separate physical
// databases; a second league's data_json-equivalent (getLeagueDataJson
// below) is likewise a differently-keyed entry in the one shared KV
// namespace (env.SHEETS_KV), not a separate namespace. Route-by-route
// migration to this pattern is ongoing — see the task reports for exactly
// which routes have been migrated so far and which remain.

import { checkUserSession, checkCsrfToken, hashPassword, sessionResponseHeaders } from './auth.js';
import { sanitizeAndValidateEmail } from './validation.js';
import { SMBHL_LEAGUE_ID, dataJsonKeyFor, makeContactId, makeEventId, contactIdLikePattern, extractTrailingNumber } from './league_ids.js';
import { getSeasonConfig, DEFAULT_SEASON_CONFIG, getTeamNames } from './season_config.js';
import { hmac, same } from './crypto_utils.js';

/* ---------- league-scoped authorization ----------
 * Bridges auth.js's session concept to "which league(s) can this user act
 * on" via league_admins. Mirrors admin_auth.js's checkAdminAuth in shape on
 * purpose: a string status the caller inspects ('ok' | 'unauthenticated' |
 * 'forbidden') rather than a thrown error, plus a matching *Response()
 * helper — the same pattern already used for every /admin/* route, so
 * whoever wires up the real ~500+ contacts/events/rsvp call sites later is
 * extending a pattern they've already seen, not learning a new one.
 *
 * NOT wired into any existing route in this task — see the task report for
 * the rollout plan. The only thing that calls this today is the
 * proof-of-concept handleLeagueContacts below.
 */

// Confirms the session on `req` belongs to a user linked to `leagueId` via
// league_admins. Never throws.
export async function checkLeagueAccess(req, env, leagueId) {
  if (!leagueId) return 'forbidden';
  const session = await checkUserSession(req, env);
  if (!session) return 'unauthenticated';

  const link = await env.DB.prepare(
    'SELECT 1 FROM league_admins WHERE user_id = ? AND league_id = ?'
  ).bind(session.userId, leagueId).first();
  if (!link) return 'forbidden';

  // Part 10: a deactivated (soft-deleted) league blocks EVERY session-
  // gated write/read route that already goes through this one check --
  // including its own admin -- without needing a separate check bolted
  // onto each route individually. The data itself is untouched (no row
  // is deleted), matching the task's "soft-delete, not destructive"
  // requirement; this is purely an access gate.
  const league = await env.DB.prepare('SELECT deactivated_at FROM leagues WHERE id = ?').bind(leagueId).first();
  if (league && league.deactivated_at) return 'deactivated';

  return 'ok';
}

export function leagueAccessResponse(status) {
  if (status === 'unauthenticated') {
    return Response.json({ ok: false, error: 'Authentication required.' }, { status: 401 });
  }
  if (status === 'deactivated') {
    return Response.json({ ok: false, error: 'This league has been deactivated.' }, { status: 410 });
  }
  return Response.json({ ok: false, error: 'You do not have access to this league.' }, { status: 403 });
}

// League-context convention, shared by every session-scoped route (the
// /league/contacts proof of concept below, and the two read-only routes
// migrated in index.js — see the task report): an explicit `?league_id=`
// query param if given (checkLeagueAccess still verifies the session user
// actually administers it — this is never trusted on its own), else the
// same "most recently created league this user administers" lookup
// handleDashboardPage (index.js) already uses today. There is no league_id
// anywhere in this app's URLs yet, so a request with no explicit league_id
// acts on "your league", matching the current one-league-per-user
// dashboard flow instead of inventing a new convention on top of it.
// Returns null if there's no session, or the session's user administers no
// league yet — callers treat that as "no session-based access available",
// not an error on its own.
export async function resolveSessionLeagueId(req, env, url) {
  const explicit = url.searchParams.get('league_id');
  if (explicit) return explicit;

  const session = await checkUserSession(req, env);
  if (!session) return null;

  const row = await env.DB.prepare(
    `SELECT la.league_id FROM league_admins la JOIN leagues l ON l.id = la.league_id
      WHERE la.user_id = ? ORDER BY l.created_at DESC LIMIT 1`
  ).bind(session.userId).first();
  return row ? row.league_id : null;
}

// Shape returned for a league that has never published a season yet (its
// KV key genuinely doesn't exist — see getLeagueDataJson). Deliberately
// minimal rather than borrowing anything from SMBHL's real data: a brand
// new league starts with nothing, not a copy or a merge.
const EMPTY_LEAGUE_DATA_JSON = Object.freeze({ current_season: null, seasons: [], players: [] });

// Reads leagueId's own data_json-equivalent blob (seasons, standings,
// rosters, fixtures) from the shared KV namespace, under the key
// league_ids.js's dataJsonKeyFor resolves for it. For SMBHL that key is
// the plain, unprefixed 'data_json' — the exact same key/value every
// existing SHEETS_KV.get('data_json') call site already reads, so SMBHL's
// result here is identical to theirs. For any other league, the key is
// namespaced ('data_json:<leagueId>') and, until that league publishes its
// first season, simply doesn't exist yet: this returns
// EMPTY_LEAGUE_DATA_JSON in that case — a genuinely separate, empty
// starting point, never a fallback to SMBHL's data. Never throws.
export async function getLeagueDataJson(env, leagueId) {
  if (!env.SHEETS_KV) return { ...EMPTY_LEAGUE_DATA_JSON };
  try {
    const raw = await env.SHEETS_KV.get(dataJsonKeyFor(leagueId));
    if (!raw) return { ...EMPTY_LEAGUE_DATA_JSON };
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { ...EMPTY_LEAGUE_DATA_JSON };
  } catch (_) {
    return { ...EMPTY_LEAGUE_DATA_JSON };
  }
}

// Write counterpart to getLeagueDataJson — the FIRST write path this
// codebase has for a second league's own data_json-equivalent. Defense in
// depth, on top of every caller already being required to go through
// checkLeagueAccess for a specific leagueId first: this function itself
// hard-refuses to ever write to SMBHL_LEAGUE_ID ('smbhl', whose
// dataJsonKeyFor resolves to the literal, real 'data_json' key). No code
// path in this app can legitimately reach this leagueId from a real user
// session today (no league_admins row links any signed-up user to the
// 'smbhl' league row migrate-020.sql created), but this makes that a hard
// guarantee at the write boundary itself, not just an emergent property of
// how sessions happen to resolve today.
export async function putLeagueDataJson(env, leagueId, dataJson) {
  if (leagueId === SMBHL_LEAGUE_ID) {
    throw new Error('putLeagueDataJson refuses to write to SMBHL\'s own data_json key.');
  }
  if (!env.SHEETS_KV) {
    throw new Error('KV binding SHEETS_KV is missing.');
  }
  await env.SHEETS_KV.put(dataJsonKeyFor(leagueId), JSON.stringify(dataJson));
}

// Resolves the effective season config for leagueId: its own data_json-
// equivalent (getLeagueDataJson) run through season_config.js's
// getSeasonConfig, with two additions when that league has no season
// config anywhere (the common case for a brand new league that hasn't
// published a season yet) — the fallback uses THAT league's own:
//   - signup-provided team names (leagues.team_names in D1), not
//     DEFAULT_SEASON_CONFIG's SMBHL-specific Red/Blue/White/Black.
//   - branding/email identity: name (leagues.name) and a from/reply-to
//     address built from the signup admin's own real, already-verified-
//     or-not account email (users.email via leagues.created_by) — NOT
//     DEFAULT_SEASON_CONFIG's "SMBHL - Hockey <joueur@smbhl.com>". This
//     is what keeps a second league's RSVP pages and outbound emails
//     (Part P's sub-invites) from presenting as SMBHL by accident. There
//     is no per-league custom domain/sender in this app, so the admin's
//     own account address is the only real, owned-by-that-league address
//     available — a deliberate, honest choice over inventing one.
//   - siteUrl uses env.PUBLIC_URL (this Worker deployment's own real
//     public URL, serving every league under it) instead of
//     DEFAULT_SEASON_CONFIG's hardcoded 'https://smbhl.com'. tagline/
//     faviconUrl are left to fall through to the generic default — purely
//     cosmetic footer text, not an identity/safety concern the way
//     fromEmail or siteUrl are.
// SMBHL itself never reaches this fallback (it already has real season
// configs), so this is a no-op for SMBHL either way.
//
// Edge case, documented per the task: if leagueId's own `leagues` row (or
// its creator's `users` row) is missing, leagueTeamNames/leagueBranding
// stay null and this legitimately falls all the way through to
// DEFAULT_SEASON_CONFIG — the same last-resort default as before this
// fix, for a case this function genuinely has nothing better to offer for.
export async function getLeagueSeasonConfig(env, leagueId, seasonName = null) {
  const leagueData = await getLeagueDataJson(env, leagueId);

  let leagueTeamNames = null;
  let leagueBranding = null;
  const leagueRow = await env.DB.prepare(
    `SELECT l.name, l.team_names, u.email AS admin_email
       FROM leagues l JOIN users u ON u.id = l.created_by
      WHERE l.id = ?`
  ).bind(leagueId).first();
  if (leagueRow) {
    if (leagueRow.team_names) {
      try {
        const parsed = JSON.parse(leagueRow.team_names);
        if (Array.isArray(parsed) && parsed.length > 0) leagueTeamNames = parsed;
      } catch (_) {}
    }
    if (leagueRow.admin_email) {
      leagueBranding = {
        name: leagueRow.name,
        fromEmail: `${leagueRow.name} <${leagueRow.admin_email}>`,
        replyToEmail: leagueRow.admin_email,
        siteUrl: env.PUBLIC_URL || DEFAULT_SEASON_CONFIG.league.siteUrl
      };
    }
  }

  return getSeasonConfig(leagueData, seasonName, leagueTeamNames, leagueBranding);
}

/* ---------- proof of concept: GET /league/contacts ----------
 * The one new (not migrated-from-ADMIN_KEY) route from the prior task, to
 * prove the whole chain works end-to-end (session -> league lookup ->
 * league_id-filtered query -> isolated result). See index.js for the
 * read-only ADMIN_KEY routes now ALSO migrated to this same pattern.
 */
export async function handleLeagueContacts(req, env, url) {
  const session = await checkUserSession(req, env);
  if (!session) return leagueAccessResponse('unauthenticated');

  const leagueId = await resolveSessionLeagueId(req, env, url);
  if (!leagueId) {
    return Response.json({ ok: false, error: 'No league found for this account.' }, { status: 404 });
  }

  const access = await checkLeagueAccess(req, env, leagueId);
  if (access !== 'ok') return leagueAccessResponse(access);

  const contacts = (await env.DB.prepare(
    'SELECT player_id, name, email, phone, role FROM contacts WHERE league_id = ? ORDER BY name'
  ).bind(leagueId).all()).results || [];

  return Response.json({ ok: true, league_id: leagueId, contacts });
}

/* ---------- GET /league/events (Part L) ----------
 * The events-read counterpart to GET /league/contacts above, built to
 * close the loop for Part K's POST /league/events — same shape, same
 * convention, so the two together give a league admin one consistent
 * read/write pair per resource (/league/contacts, /league/events)
 * instead of only being able to see their own events through the
 * ADMIN_KEY-legacy-named /admin/schedule/data dual-auth route from Part G.
 */
export async function handleLeagueEvents(req, env, url) {
  const session = await checkUserSession(req, env);
  if (!session) return leagueAccessResponse('unauthenticated');

  const leagueId = await resolveSessionLeagueId(req, env, url);
  if (!leagueId) {
    return Response.json({ ok: false, error: 'No league found for this account.' }, { status: 404 });
  }

  const access = await checkLeagueAccess(req, env, leagueId);
  if (access !== 'ok') return leagueAccessResponse(access);

  const events = (await env.DB.prepare(
    'SELECT id, season, week, date, venue, state, start_time, end_time FROM events WHERE league_id = ? ORDER BY date DESC, week DESC'
  ).bind(leagueId).all()).results || [];

  return Response.json({ ok: true, league_id: leagueId, events });
}

/* ---------- POST /league/contacts (Part J) ----------
 * League-scoped contact creation. Session+checkLeagueAccess-gated only —
 * same "no ADMIN_KEY door" discipline as season/publish. Matches the
 * existing ADMIN_KEY contact-creation data shape (contacts columns: name,
 * email, phone, role, is_goalie, position, token_salt) rather than
 * inventing a parallel model — see peopleAction's 'new' action and
 * handleTeamsAdd in index.js for the shape this mirrors.
 *
 * role: 'roster' | 'sub_skater' | 'sub_goalie' — the same three values the
 * contacts table itself already uses everywhere else in this app (a
 * generic "roster/sub" the task suggested would be a 4th, inconsistent
 * vocabulary layered on top of the real one).
 *
 * Validation decisions:
 *   - name: required, at least first+last (2 words), <=60 chars — same
 *     rule peopleAction's 'new' action already enforces.
 *   - email: optional. If given, validated with the same
 *     sanitizeAndValidateEmail() every other email path in this app uses.
 *     Duplicate check is EMAIL-based (case-insensitive exact match),
 *     scoped to league_id — the task asked for this specifically; note
 *     it's a different key than the legacy ADMIN_KEY path's NAME-based
 *     dedup (peopleAction checks lower(name)=lower(?) with no league
 *     scope at all, since only one league's contacts existed when that
 *     was written). Two contacts with no email on file are never treated
 *     as duplicates of each other.
 *   - phone: optional, same non-digit-stripping as the existing path.
 *   - id numbering: ONE counter per league starting at 'P0001'
 *     (league_ids.js's contactIdLikePattern/extractTrailingNumber,
 *     scoped to this leagueId), not the historical SMBHL-specific split
 *     between a P0500+ roster range and a P9001+ sub range — that split
 *     is a legacy artifact of SMBHL's own numbering history, not a rule
 *     worth replicating for a league that has no such history.
 */
export async function handleLeagueContactCreate(req, env) {
  const session = await checkUserSession(req, env);
  if (!session) return leagueAccessResponse('unauthenticated');
  if (!(await checkCsrfToken(req, env, session))) {
    return Response.json({ ok: false, error: 'Invalid or missing CSRF token.' }, { status: 403 });
  }

  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));

  const leagueId = await resolveSessionLeagueId(req, env, url);
  if (!leagueId) {
    return Response.json({ ok: false, error: 'No league found for this account.' }, { status: 404 });
  }

  const access = await checkLeagueAccess(req, env, leagueId);
  if (access !== 'ok') return leagueAccessResponse(access);

  // Defense in depth (see putLeagueDataJson's own comment): this route
  // must never be able to write a row tagged as SMBHL's, even in principle.
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot create contacts for SMBHL.' }, { status: 403 });
  }

  const name = String(body.name || '').trim().split(/\s+/).filter(Boolean).join(' ');
  if (!name || name.split(' ').length < 2) {
    return Response.json({ ok: false, error: 'Full name (first and last) is required.' }, { status: 400 });
  }
  if (name.length > 60) {
    return Response.json({ ok: false, error: 'Name is too long.' }, { status: 400 });
  }

  const role = String(body.role || 'roster').trim();
  if (!['roster', 'sub_skater', 'sub_goalie'].includes(role)) {
    return Response.json({ ok: false, error: 'role must be roster, sub_skater, or sub_goalie.' }, { status: 400 });
  }

  let email = String(body.email || '').trim();
  if (email) {
    const check = sanitizeAndValidateEmail(email);
    if (!check.valid) {
      return Response.json({ ok: false, error: check.error }, { status: 400 });
    }
    email = check.email;

    const dupe = await env.DB.prepare(
      'SELECT player_id FROM contacts WHERE league_id = ? AND lower(email) = lower(?)'
    ).bind(leagueId, email).first();
    if (dupe) {
      return Response.json({ ok: false, error: 'A contact with this email already exists in your league.' }, { status: 409 });
    }
  } else {
    email = null;
  }

  let phone = String(body.phone || '').trim();
  phone = phone ? (phone.replace(/[^\d+().\s-]/g, '').trim() || null) : null;

  const position = String(body.position || '').toUpperCase().trim() || null;
  const isGoalie = (role === 'sub_goalie' || position === 'G') ? 1 : 0;

  // Part 1 fix: the roster had no team assignment at all, so shortage
  // detection could never see real per-team roster sizes. `team` is
  // optional (an admin may add a player before deciding their team, or a
  // sub genuinely has no fixed team) but when given, it must be one of
  // this league's own real team names -- validated the same way
  // getLeagueSeasonConfig already resolves a league's teams everywhere
  // else (signup-provided names before a season is published, the
  // published season's own config after), so this works identically
  // whether or not a season has been published yet.
  let team = String(body.team || '').trim() || null;
  if (team) {
    const cfg = await getLeagueSeasonConfig(env, leagueId);
    const validTeams = getTeamNames(cfg);
    if (!validTeams.includes(team)) {
      return Response.json({ ok: false, error: `team must be one of: ${validTeams.join(', ')}` }, { status: 400 });
    }
  }

  const maxP = await env.DB.prepare(
    'SELECT player_id FROM contacts WHERE player_id LIKE ? ORDER BY player_id DESC LIMIT 1'
  ).bind(contactIdLikePattern(leagueId, 'P')).first();
  let nextNum = 1;
  if (maxP && maxP.player_id) {
    const n = extractTrailingNumber(maxP.player_id);
    if (n !== null) nextNum = n + 1;
  }
  const playerId = makeContactId(leagueId, 'P' + String(nextNum).padStart(4, '0'));
  const salt = crypto.randomUUID().replace(/-/g, '');

  await env.DB.prepare(
    `INSERT INTO contacts (player_id, name, email, phone, role, is_goalie, position, preferred_team, token_salt, league_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(playerId, name, email, phone, role, isGoalie, position, team, salt, leagueId).run();

  return Response.json({
    ok: true,
    league_id: leagueId,
    contact: { player_id: playerId, name, email, phone, role, is_goalie: isGoalie, position, team }
  });
}

/* ---------- POST /league/events (Part K) ----------
 * League-scoped event creation. Session+checkLeagueAccess-gated only, same
 * discipline as contacts/season-publish above. Matches the existing
 * ADMIN_KEY manual event-creation shape (events columns: season, week,
 * date, venue, state, start_time, end_time) — see handleScheduleSave's
 * `is_new` branch in index.js, which this mirrors. One event at a time,
 * admin-entered; no fixture/schedule-generation engine here (that stays a
 * separate, later task, same as Season Hub was for season/publish).
 *
 * id generation uses league_ids.js's makeEventId(leagueId, date) — exactly
 * the mechanism built specifically to make this safe: two leagues
 * creating a game on the same calendar date can never collide, because
 * the id carries the owning league's id.
 *
 * Field decisions:
 *   - date: required, must already be YYYY-MM-DD — the same shape
 *     eventStart() (index.js) and makeEventId/eventDateFromId
 *     (league_ids.js) all assume.
 *   - season: optional; defaults to the league's own current_season
 *     (getLeagueDataJson) if not given, since a league will normally have
 *     already published one via /league/season/publish first. If neither
 *     is available, this is a real error (400) — there's nothing
 *     reasonable to default a season NAME to.
 *   - week: optional; defaults to (that league's existing event count for
 *     this season) + 1, a simple auto-increment rather than requiring the
 *     admin to track week numbers by hand for a one-at-a-time flow.
 *   - venue/start_time/end_time: optional. start_time/end_time, if given,
 *     must be HH:MM (the same format eventStart() parses).
 *   - state: always starts 'open' — this route doesn't expose creating a
 *     pre-cancelled or pre-closed event; that's an edit capability this
 *     task isn't building.
 *   - duplicate date within the SAME league: rejected (409) — matches the
 *     existing ADMIN_KEY path's own "an event with this id already
 *     exists" behavior, just with a proper status code instead of 400.
 */
export async function handleLeagueEventCreate(req, env) {
  const session = await checkUserSession(req, env);
  if (!session) return leagueAccessResponse('unauthenticated');
  if (!(await checkCsrfToken(req, env, session))) {
    return Response.json({ ok: false, error: 'Invalid or missing CSRF token.' }, { status: 403 });
  }

  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));

  const leagueId = await resolveSessionLeagueId(req, env, url);
  if (!leagueId) {
    return Response.json({ ok: false, error: 'No league found for this account.' }, { status: 404 });
  }

  const access = await checkLeagueAccess(req, env, leagueId);
  if (access !== 'ok') return leagueAccessResponse(access);

  // Defense in depth (see putLeagueDataJson's own comment): this route
  // must never be able to write a row tagged as SMBHL's, even in principle.
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot create events for SMBHL.' }, { status: 403 });
  }

  const date = String(body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ ok: false, error: 'date is required, in YYYY-MM-DD format.' }, { status: 400 });
  }

  const timePattern = /^\d{2}:\d{2}$/;
  const startTime = String(body.start_time || '').trim();
  if (startTime && !timePattern.test(startTime)) {
    return Response.json({ ok: false, error: 'start_time must be in HH:MM format.' }, { status: 400 });
  }
  const endTime = String(body.end_time || '').trim();
  if (endTime && !timePattern.test(endTime)) {
    return Response.json({ ok: false, error: 'end_time must be in HH:MM format.' }, { status: 400 });
  }

  const venue = String(body.venue || '').trim() || null;

  const leagueData = await getLeagueDataJson(env, leagueId);
  const season = String(body.season || '').trim() || leagueData.current_season;
  if (!season) {
    return Response.json({ ok: false, error: 'season is required (publish a season first via /league/season/publish, or pass one explicitly).' }, { status: 400 });
  }

  let week = Number(body.week);
  if (!Number.isFinite(week) || week < 1) {
    const countRow = await env.DB.prepare(
      'SELECT COUNT(*) c FROM events WHERE league_id = ? AND season = ?'
    ).bind(leagueId, season).first();
    week = (countRow?.c || 0) + 1;
  }

  const eventId = makeEventId(leagueId, date);
  const existing = await env.DB.prepare('SELECT 1 FROM events WHERE id = ?').bind(eventId).first();
  if (existing) {
    return Response.json({ ok: false, error: 'An event already exists for this date in your league.' }, { status: 409 });
  }

  await env.DB.prepare(
    `INSERT INTO events (id, season, week, date, venue, state, start_time, end_time, league_id)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`
  ).bind(eventId, season, week, date, venue, startTime || null, endTime || null, leagueId).run();

  return Response.json({
    ok: true,
    league_id: leagueId,
    event: { id: eventId, season, week, date, venue, state: 'open', start_time: startTime || null, end_time: endTime || null }
  });
}

/* ---------- POST /league/season/publish ----------
 * The first WRITE path for a second league's own data_json-equivalent.
 * Deliberately minimal — a genuine starting point (current_season set, one
 * seasons[] entry using the league's own signup team names, empty
 * standings/players), NOT a Season Hub launch equivalent (rosters,
 * fixtures, draft engine — that stays a separate, later task).
 *
 * Session+checkLeagueAccess-gated ONLY. This never checks checkAdminAuth
 * at all — there is no ADMIN_KEY path into this route, by design (see the
 * task report): it must not become a new door into SMBHL's data for
 * whoever holds ADMIN_KEY without also being a real logged-in league
 * admin.
 *
 * Overwrite semantics: calling this again with the SAME season name
 * replaces that season's entry (and re-sets current_season to it) rather
 * than rejecting or versioning. Simplicity was favored per the task's own
 * guidance, and it matches how a league admin would actually expect
 * "publish my season" to behave — correcting a mistake shouldn't require
 * a separate "edit" capability this task isn't building. A DIFFERENT
 * season name is added as a new entry alongside any existing ones, not a
 * replacement, so calling this for "Season 2" doesn't erase "Season 1"'s
 * history.
 */
export async function handleLeagueSeasonPublish(req, env) {
  const session = await checkUserSession(req, env);
  if (!session) return leagueAccessResponse('unauthenticated');
  if (!(await checkCsrfToken(req, env, session))) {
    return Response.json({ ok: false, error: 'Invalid or missing CSRF token.' }, { status: 403 });
  }

  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));
  const seasonName = String(body.season_name || '').trim();
  if (!seasonName) {
    return Response.json({ ok: false, error: 'season_name is required.' }, { status: 400 });
  }

  const leagueId = await resolveSessionLeagueId(req, env, url);
  if (!leagueId) {
    return Response.json({ ok: false, error: 'No league found for this account.' }, { status: 404 });
  }

  const access = await checkLeagueAccess(req, env, leagueId);
  if (access !== 'ok') return leagueAccessResponse(access);

  // Defense in depth (see putLeagueDataJson's own comment): this route
  // must never be able to write SMBHL's real data, even in principle.
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot publish to SMBHL\'s data.' }, { status: 403 });
  }

  const leagueRow = await env.DB.prepare('SELECT team_names FROM leagues WHERE id = ?').bind(leagueId).first();
  let teamNames = [];
  if (leagueRow && leagueRow.team_names) {
    try {
      const parsed = JSON.parse(leagueRow.team_names);
      if (Array.isArray(parsed)) teamNames = parsed.filter(Boolean);
    } catch (_) {}
  }
  if (teamNames.length < 2) {
    return Response.json({ ok: false, error: 'This league has no team names on file yet.' }, { status: 400 });
  }

  const existing = await getLeagueDataJson(env, leagueId);
  const seasons = (Array.isArray(existing.seasons) ? existing.seasons : []).filter(Boolean);

  // Roster-size config (Part O): optional. When given, this is what
  // shortage detection (teamState/expected/openSpots in index.js) uses for
  // THIS league via getLeagueSeasonConfig instead of the generic
  // DEFAULT_SEASON_CONFIG numbers (1 goalie/8 skaters/5-skater minimum) —
  // those generic defaults are a reasonable last resort when a league
  // hasn't set its own (same "last resort, not SMBHL's live data" pattern
  // as leagueTeamNames/leagueBranding), not a requirement to configure
  // this before publishing a season at all.
  const config = { teams: teamNames };
  for (const [bodyKey, cfgKey] of [['goalies_per_team', 'goaliesPerTeam'], ['skaters_per_team', 'skatersPerTeam'], ['min_skaters', 'minSkaters']]) {
    const n = Number(body[bodyKey]);
    if (Number.isFinite(n) && n > 0) config[cfgKey] = n;
  }

  const newSeasonEntry = {
    name: seasonName,
    config,
    standings: teamNames.map(team => ({ team, gp: 0, w: 0, l: 0, t: 0, pts: 0, gf: 0, ga: 0 })),
    games: 0
  };

  const idx = seasons.findIndex(s => s && s.name === seasonName);
  const overwritten = idx >= 0;
  if (overwritten) {
    seasons[idx] = newSeasonEntry;
  } else {
    seasons.unshift(newSeasonEntry);
  }

  const updated = {
    current_season: seasonName,
    seasons,
    players: Array.isArray(existing.players) ? existing.players : []
  };

  await putLeagueDataJson(env, leagueId, updated);

  return Response.json({ ok: true, league_id: leagueId, current_season: seasonName, teams: teamNames, overwritten });
}

export async function handleLeagueCreate(req, env) {
  try {
    const session = await checkUserSession(req, env);
    if (!session) {
      return Response.json({ ok: false, error: 'Authentication required.' }, { status: 401 });
    }
    if (!(await checkCsrfToken(req, env, session))) {
      return Response.json({ ok: false, error: 'Invalid or missing CSRF token.' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    const teamNames = Array.isArray(body.teamNames)
      ? body.teamNames.map(t => String(t || '').trim()).filter(Boolean)
      : [];
    const tracksStats = body.tracksStats !== false; // defaults to true, matching season_config.js's own default
    const divisionLabel = body.divisionLabel ? String(body.divisionLabel).trim() : null;

    if (!name) {
      return Response.json({ ok: false, error: 'League name is required.' }, { status: 400 });
    }
    if (teamNames.length < 2) {
      return Response.json({ ok: false, error: 'At least 2 team names are required.' }, { status: 400 });
    }

    const leagueId = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO leagues (id, name, division_label, tracks_stats, team_count, team_names, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(leagueId, name, divisionLabel, tracksStats ? 1 : 0, teamNames.length, JSON.stringify(teamNames), session.userId, now).run();

    await env.DB.prepare(
      `INSERT INTO league_admins (user_id, league_id, role, created_at) VALUES (?, ?, 'admin', ?)`
    ).bind(session.userId, leagueId, now).run();

    return Response.json({
      ok: true,
      league: {
        id: leagueId,
        name,
        divisionLabel,
        tracksStats,
        teamCount: teamNames.length,
        teamNames
      }
    });
  } catch (err) {
    return Response.json({ ok: false, error: 'League creation failed: ' + err.message }, { status: 500 });
  }
}

/* ---------- multi-admin invite flow (Part 9) ----------
 * Same signed-HMAC-token shape as email verification/password reset
 * (auth.js), with its own message prefix so none of the three token
 * kinds can be replayed as each other. 48h expiry -- long enough that a
 * co-admin who isn't checking email daily still has a real window,
 * short enough that a leaked/forwarded invite link doesn't stay useful
 * indefinitely.
 *
 * Handles both cases the task asks for in one flow: if the invited
 * email has no account yet, accepting creates one (password only --
 * email comes from the token, never re-typed) and immediately links it;
 * if an account already exists, accepting just requires being logged in
 * as that same email and links the existing account. Either way,
 * clicking the real emailed link is treated as proof of owning that
 * inbox, the same trust decision handleVerifyEmail already makes for
 * email verification -- so an invite-created account starts already
 * email_verified.
 */

const INVITE_TOKEN_TTL_MS = 48 * 3600 * 1000;

const inviteMsg = (leagueId, email, exp) => `invite:${leagueId}:${email}:${exp}`;

// Real email addresses routinely contain '.' (e.g. user@example.com), so
// encodeURIComponent alone is NOT safe to embed as one '.'-delimited
// token segment -- it leaves '.' unescaped, which silently breaks the
// token.split('.') parsing below for almost any real address (caught by
// this file's own test, not a hypothetical). Base64url-encoding the
// email first (same technique JWTs use for exactly this reason) removes
// '.' from the encoded segment entirely, so it's always safe to join.
function base64UrlEncode(str) {
  const b64 = btoa(unescape(encodeURIComponent(str)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  return decodeURIComponent(escape(atob(b64)));
}

async function generateInviteToken(env, leagueId, email, ttlMs = INVITE_TOKEN_TTL_MS) {
  const exp = Date.now() + ttlMs;
  const sig = await hmac(env.AUTH_SECRET, inviteMsg(leagueId, email, exp));
  const token = `${leagueId}.${base64UrlEncode(email)}.${exp}.${sig}`;
  return { token, exp };
}

// Returns { ok: true, leagueId, email } or { ok: false, error } -- never
// throws, no side effect (mirrors verifyPasswordResetToken, not
// verifyEmailToken -- accepting is a separate, explicit step).
export async function verifyInviteToken(env, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4) return { ok: false, error: 'malformed' };
  const [leagueId, encodedEmail, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!leagueId || !encodedEmail || !Number.isFinite(exp)) return { ok: false, error: 'malformed' };
  if (Date.now() > exp) return { ok: false, error: 'expired' };

  let email;
  try {
    email = base64UrlDecode(encodedEmail);
  } catch (_) {
    return { ok: false, error: 'malformed' };
  }

  let want;
  try {
    want = await hmac(env.AUTH_SECRET, inviteMsg(leagueId, email, exp));
  } catch (_) {
    return { ok: false, error: 'malformed' };
  }
  if (!same(want, sig)) return { ok: false, error: 'invalid' };
  return { ok: true, leagueId, email };
}

function buildInviteEmail(leagueName, inviteLink) {
  const subject = `Invitation à co-administrer ${leagueName} / Invitation to co-admin ${leagueName}`;
  const text =
`Vous avez été invité(e) à devenir co-administrateur(-trice) de la ligue ${leagueName}. Cliquez sur ce lien pour accepter :
${inviteLink}

Ce lien expire dans 48 heures. Si vous ne connaissez pas cette ligue, ignorez ce courriel.

---

You've been invited to become a co-admin of the ${leagueName} league. Click this link to accept:
${inviteLink}

This link expires in 48 hours. If you don't recognize this league, you can ignore this email.`;
  const html =
`<p>Vous avez été invité(e) à devenir co-administrateur(-trice) de la ligue <b>${leagueName}</b>. Cliquez sur le lien ci-dessous pour accepter&nbsp;:</p>
<p><a href="${inviteLink}">${inviteLink}</a></p>
<p>Ce lien expire dans 48 heures. Si vous ne connaissez pas cette ligue, ignorez ce courriel.</p>
<hr>
<p>You've been invited to become a co-admin of the <b>${leagueName}</b> league. Click the link below to accept:</p>
<p><a href="${inviteLink}">${inviteLink}</a></p>
<p>This link expires in 48 hours. If you don't recognize this league, you can ignore this email.</p>`;
  return { subject, text, html };
}

// POST /league/admins/invite -- session+CSRF-gated, same discipline as
// every other league-admin write route. Body: { email }.
export async function handleLeagueAdminInvite(req, env, url, sendMailFunc = null) {
  const session = await checkUserSession(req, env);
  if (!session) return leagueAccessResponse('unauthenticated');
  if (!(await checkCsrfToken(req, env, session))) {
    return Response.json({ ok: false, error: 'Invalid or missing CSRF token.' }, { status: 403 });
  }

  const leagueId = await resolveSessionLeagueId(req, env, url);
  if (!leagueId) {
    return Response.json({ ok: false, error: 'No league found for this account.' }, { status: 404 });
  }
  const access = await checkLeagueAccess(req, env, leagueId);
  if (access !== 'ok') return leagueAccessResponse(access);

  const body = await req.json().catch(() => ({}));
  let email = String(body.email || '').trim().toLowerCase();
  const check = sanitizeAndValidateEmail(email);
  if (!check.valid) {
    return Response.json({ ok: false, error: check.error }, { status: 400 });
  }
  email = check.email;

  const leagueRow = await env.DB.prepare('SELECT name FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!leagueRow) return Response.json({ ok: false, error: 'League not found.' }, { status: 404 });

  // Already an admin of this league? Nothing to invite -- a clear,
  // specific error beats silently sending a redundant invite email.
  const existingUser = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existingUser) {
    const alreadyAdmin = await env.DB.prepare(
      'SELECT 1 FROM league_admins WHERE user_id = ? AND league_id = ?'
    ).bind(existingUser.id, leagueId).first();
    if (alreadyAdmin) {
      return Response.json({ ok: false, error: 'This person is already an admin of this league.' }, { status: 409 });
    }
  }

  const { token } = await generateInviteToken(env, leagueId, email);
  const publicUrl = env.PUBLIC_URL || 'https://rsvp.smbhl.com';
  const inviteLink = `${publicUrl}/league/admins/accept?token=${encodeURIComponent(token)}`;

  if (typeof sendMailFunc === 'function') {
    try {
      const { subject, text, html } = buildInviteEmail(leagueRow.name, inviteLink);
      // Bug fix (Part 1, this task): this league already exists by this
      // point (leagueRow was just fetched above) -- pass its own real
      // branding (getLeagueSeasonConfig's leagueBranding, the same
      // admin's-own-email fromEmail every other league-scoped email in
      // this app already uses) instead of falling through to sendMail's
      // generic default identity, which this call previously did.
      const cfg = await getLeagueSeasonConfig(env, leagueId);
      await sendMailFunc(env, email, subject, text, html, null, cfg.league);
    } catch (err) {
      console.error(`[leagues] Failed to send admin invite to ${email}: ${err.message}`);
    }
  }

  return Response.json({ ok: true, email, hasExistingAccount: !!existingUser });
}

// POST /league/admins/accept -- body: { token, password? }. Deliberately
// NOT session-required as a precondition (unlike every other write route
// here) -- the whole point is this may be someone's very first contact
// with this app. Two paths, both guarded by the same verified token:
//   - no account for that email yet: password is required, creates one
//     (email_verified immediately -- see this section's header comment).
//   - an account already exists: the CALLER must already be logged in
//     as that exact email (no password re-entry, no way to hijack a
//     different real account via a guessed/leaked invite link alone).
export async function handleLeagueAdminAccept(req, env) {
  const body = await req.json().catch(() => ({}));
  const result = await verifyInviteToken(env, body.token);
  if (!result.ok) {
    const status = result.error === 'expired' ? 410 : 400;
    return Response.json({ ok: false, error: result.error }, { status });
  }
  const { leagueId, email } = result;

  const leagueRow = await env.DB.prepare('SELECT id FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!leagueRow) return Response.json({ ok: false, error: 'League no longer exists.' }, { status: 404 });

  const existingUser = await env.DB.prepare('SELECT id, session_epoch FROM users WHERE email = ?').bind(email).first();
  const now = new Date().toISOString();

  if (existingUser) {
    const session = await checkUserSession(req, env);
    if (!session || session.userId !== existingUser.id) {
      return Response.json({ ok: false, error: 'Please log in as ' + email + ' to accept this invite.', requiresLogin: true, email }, { status: 401 });
    }
    // A real session is being used here (unlike the fresh-account branch
    // below, which has no session yet) -- CSRF-protect it like every
    // other route that acts on an existing session.
    if (!(await checkCsrfToken(req, env, session))) {
      return Response.json({ ok: false, error: 'Invalid or missing CSRF token.' }, { status: 403 });
    }
    const already = await env.DB.prepare(
      'SELECT 1 FROM league_admins WHERE user_id = ? AND league_id = ?'
    ).bind(existingUser.id, leagueId).first();
    if (!already) {
      await env.DB.prepare(
        `INSERT INTO league_admins (user_id, league_id, role, created_at) VALUES (?, ?, 'admin', ?)`
      ).bind(existingUser.id, leagueId, now).run();
    }
    return Response.json({ ok: true, leagueId, accountCreated: false });
  }

  // No account yet -- create one, same validation as real signup.
  const password = String(body.password || '');
  if (password.length < 8) {
    return Response.json({ ok: false, error: 'Password must be at least 8 characters.' }, { status: 400 });
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, created_at, email_verified_at, last_login_at, session_epoch)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).bind(userId, email, passwordHash, now, now, now).run();
  await env.DB.prepare(
    `INSERT INTO league_admins (user_id, league_id, role, created_at) VALUES (?, ?, 'admin', ?)`
  ).bind(userId, leagueId, now).run();

  return new Response(JSON.stringify({ ok: true, leagueId, accountCreated: true }), {
    status: 200,
    headers: await sessionResponseHeaders(env, userId, 0)
  });
}

/* ---------- deactivate a league (Part 10) ----------
 * Soft-delete: sets leagues.deactivated_at, never deletes a row. Once
 * set, checkLeagueAccess blocks every session-gated route for this
 * league -- including its own admins -- so there's no separate
 * "is this league deactivated" check needed anywhere else. Requires the
 * caller to type the league's own exact current name as `confirmName`
 * -- the task's explicit "clear confirmation step" requirement,
 * enforced server-side (not just a client-side dialog an API caller
 * could skip), matching the "type the name to confirm" pattern this
 * kind of consequential-but-reversible-in-the-database action usually
 * gets.
 */
export async function handleLeagueDeactivate(req, env, url) {
  const session = await checkUserSession(req, env);
  if (!session) return leagueAccessResponse('unauthenticated');
  if (!(await checkCsrfToken(req, env, session))) {
    return Response.json({ ok: false, error: 'Invalid or missing CSRF token.' }, { status: 403 });
  }

  const leagueId = await resolveSessionLeagueId(req, env, url);
  if (!leagueId) {
    return Response.json({ ok: false, error: 'No league found for this account.' }, { status: 404 });
  }
  const access = await checkLeagueAccess(req, env, leagueId);
  if (access !== 'ok') return leagueAccessResponse(access);

  const leagueRow = await env.DB.prepare('SELECT name FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!leagueRow) return Response.json({ ok: false, error: 'League not found.' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const confirmName = String(body.confirmName || '').trim();
  if (confirmName !== leagueRow.name) {
    return Response.json({ ok: false, error: 'Confirmation text does not match the league name.' }, { status: 400 });
  }

  await env.DB.prepare('UPDATE leagues SET deactivated_at = ? WHERE id = ?').bind(new Date().toISOString(), leagueId).run();
  return Response.json({ ok: true, leagueId });
}

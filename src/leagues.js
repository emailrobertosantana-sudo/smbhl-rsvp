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

import { checkUserSession } from './auth.js';
import { sanitizeAndValidateEmail } from './validation.js';
import { SMBHL_LEAGUE_ID, dataJsonKeyFor, makeContactId, makeEventId, contactIdLikePattern, extractTrailingNumber } from './league_ids.js';
import { getSeasonConfig } from './season_config.js';

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

  return link ? 'ok' : 'forbidden';
}

export function leagueAccessResponse(status) {
  if (status === 'unauthenticated') {
    return Response.json({ ok: false, error: 'Authentication required.' }, { status: 401 });
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
// getSeasonConfig, with one addition — if that league has no season
// config anywhere (the common case for a brand new league that hasn't
// published a season yet), the fallback is THAT league's own signup-
// provided team names (leagues.team_names in D1), not
// DEFAULT_SEASON_CONFIG's SMBHL-specific Red/Blue/White/Black. SMBHL
// itself never reaches that fallback (it already has real season
// configs), so this is a no-op for SMBHL either way.
//
// Edge case, documented per the task: if leagueId's own `leagues` row is
// missing or its team_names can't be parsed, leagueTeamNames stays null
// and this legitimately falls all the way through to DEFAULT_SEASON_CONFIG
// — the same last-resort default as before this fix, for a case this
// function genuinely has nothing better to offer for.
export async function getLeagueSeasonConfig(env, leagueId, seasonName = null) {
  const leagueData = await getLeagueDataJson(env, leagueId);

  let leagueTeamNames = null;
  const leagueRow = await env.DB.prepare('SELECT team_names FROM leagues WHERE id = ?').bind(leagueId).first();
  if (leagueRow && leagueRow.team_names) {
    try {
      const parsed = JSON.parse(leagueRow.team_names);
      if (Array.isArray(parsed) && parsed.length > 0) leagueTeamNames = parsed;
    } catch (_) {}
  }

  return getSeasonConfig(leagueData, seasonName, leagueTeamNames);
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
    `INSERT INTO contacts (player_id, name, email, phone, role, is_goalie, position, token_salt, league_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(playerId, name, email, phone, role, isGoalie, position, salt, leagueId).run();

  return Response.json({
    ok: true,
    league_id: leagueId,
    contact: { player_id: playerId, name, email, phone, role, is_goalie: isGoalie, position }
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

  const newSeasonEntry = {
    name: seasonName,
    config: { teams: teamNames },
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

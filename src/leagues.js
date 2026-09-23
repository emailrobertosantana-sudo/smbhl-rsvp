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
import { SMBHL_LEAGUE_ID, HEADCOUNT_TEAM_NAME, dataJsonKeyFor, makeContactId, makeEventId, contactIdLikePattern, extractTrailingNumber, slugify, isValidSlugFormat, RESERVED_SLUGS } from './league_ids.js';
import { getSeasonConfig, DEFAULT_SEASON_CONFIG, getTeamNames, sportHasGoalie } from './season_config.js';
import { hmac, same } from './crypto_utils.js';
import { nlEmailWrap, nlEmailButton, leagueFillColor } from './design_system.js';

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
    return Response.json({ ok: false, error: 'Authentication required.', errorKey: 'AUTH_REQUIRED' }, { status: 401 });
  }
  if (status === 'deactivated') {
    return Response.json({ ok: false, error: 'This league has been deactivated.', errorKey: 'LEAGUE_DEACTIVATED' }, { status: 410 });
  }
  return Response.json({ ok: false, error: 'You do not have access to this league.', errorKey: 'LEAGUE_NO_ACCESS' }, { status: 403 });
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
  let leagueRosterLimits = null;
  let leagueTeamStructure = null;
  let leagueSportType = null;
  const leagueRow = await env.DB.prepare(
    `SELECT l.id, l.name, l.slug, l.team_names, l.language_mode, l.color, l.team_structure, l.min_players, l.max_players, l.min_goalies, l.sport_type, u.email AS admin_email
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
      // Bug 1 fix (live-testing): every league used to send FROM the
      // admin's own raw signup email ("{name} <{admin_email}>") --
      // Resend rejects that outright (403) since it's never a domain
      // verified in this account, so EVERY league's email (reminders,
      // sub-invites, logistics, co-admin invites) silently failed to
      // send for every league except SMBHL. Now sends from the
      // league's own slug under mail.notreligue.ca -- the domain
      // already verified in this Resend account (see
      // DEFAULT_FROM_NON_SMBHL's own pre-existing identity, which
      // already relied on this same verified domain as a fallback that
      // was never actually reached, since fromEmail was always set
      // before this fix). Reply-To stays the admin's own real email
      // (unchanged) so a player's reply still reaches the admin
      // directly -- Reply-To doesn't require the From address's domain
      // to be a real receiving mailbox, so this needs no new domain
      // verification or wildcard mail routing.
      const leagueSlug = await getOrCreateLeagueSlug(env, leagueRow);
      leagueBranding = {
        name: leagueRow.name,
        fromEmail: `${leagueRow.name} <${leagueSlug}@mail.notreligue.ca>`,
        replyToEmail: leagueRow.admin_email,
        siteUrl: env.PUBLIC_URL || DEFAULT_SEASON_CONFIG.league.siteUrl,
        // Part 4 foundation: no UI to set this away from 'both' yet --
        // see migrate-023.sql. Every league today reads 'both' here.
        languageMode: leagueRow.language_mode || 'both',
        // Design system (migrate-025.sql): no signup step lets an admin
        // pick their own color yet -- every league reads the sample
        // default until a future task adds that editor.
        color: leagueRow.color || '#b3122e'
      };
    }
    // Team-structure task: migrate-027.sql, default 'fixed' for every
    // existing row.
    leagueTeamStructure = leagueRow.team_structure || 'fixed';
    if (leagueRow.min_players != null && leagueRow.max_players != null) {
      // Part 5: min_goalies (migrate-029.sql, DEFAULT 0) rides along
      // with minPlayers/maxPlayers -- only meaningful for headcount,
      // and 0 ("no goalie requirement") is real, intentional data, not
      // an absence to special-case around.
      leagueRosterLimits = { minPlayers: leagueRow.min_players, maxPlayers: leagueRow.max_players, minGoalies: leagueRow.min_goalies };
    }
    // Part 5 foundation: migrate-028.sql, default 'hockey' for every
    // existing row.
    leagueSportType = leagueRow.sport_type || 'hockey';
  }

  return getSeasonConfig(leagueData, seasonName, leagueTeamNames, leagueBranding, leagueRosterLimits, leagueTeamStructure, leagueSportType);
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
    return Response.json({ ok: false, error: 'No league found for this account.', errorKey: 'NO_LEAGUE_FOUND' }, { status: 404 });
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
    return Response.json({ ok: false, error: 'No league found for this account.', errorKey: 'NO_LEAGUE_FOUND' }, { status: 404 });
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
    return Response.json({ ok: false, error: 'Invalid or missing CSRF token.', errorKey: 'CSRF_INVALID' }, { status: 403 });
  }

  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));

  const leagueId = await resolveSessionLeagueId(req, env, url);
  if (!leagueId) {
    return Response.json({ ok: false, error: 'No league found for this account.', errorKey: 'NO_LEAGUE_FOUND' }, { status: 404 });
  }

  const access = await checkLeagueAccess(req, env, leagueId);
  if (access !== 'ok') return leagueAccessResponse(access);

  // Defense in depth (see putLeagueDataJson's own comment): this route
  // must never be able to write a row tagged as SMBHL's, even in principle.
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot create contacts for SMBHL.', errorKey: 'ROUTE_BLOCKED_CONTACTS' }, { status: 403 });
  }

  const name = String(body.name || '').trim().split(/\s+/).filter(Boolean).join(' ');
  if (!name || name.split(' ').length < 2) {
    return Response.json({ ok: false, error: 'Full name (first and last) is required.', errorKey: 'FULL_NAME_REQUIRED' }, { status: 400 });
  }
  if (name.length > 60) {
    return Response.json({ ok: false, error: 'Name is too long.', errorKey: 'NAME_TOO_LONG' }, { status: 400 });
  }

  const role = String(body.role || 'roster').trim();
  if (!['roster', 'sub_skater', 'sub_goalie'].includes(role)) {
    return Response.json({ ok: false, error: 'role must be roster, sub_skater, or sub_goalie.', errorKey: 'INVALID_ROLE' }, { status: 400 });
  }

  let email = String(body.email || '').trim();
  if (email) {
    const check = sanitizeAndValidateEmail(email);
    if (!check.valid) {
      // Live-testing bug fix (Bug 6 sweep): no errorKey here left the
      // roster page's admin-facing "add a player" form showing raw
      // English validation text even in French mode. Reuses the same
      // INVALID_EMAIL key every other email field's client-side check
      // already displays -- check.error's exact wording varies by
      // failure reason, but "enter a valid email" covers all of them
      // accurately enough for a translated summary.
      return Response.json({ ok: false, error: check.error, errorKey: 'INVALID_EMAIL' }, { status: 400 });
    }
    email = check.email;

    const dupe = await env.DB.prepare(
      'SELECT player_id FROM contacts WHERE league_id = ? AND lower(email) = lower(?)'
    ).bind(leagueId, email).first();
    if (dupe) {
      return Response.json({ ok: false, error: 'A contact with this email already exists in your league.', errorKey: 'CONTACT_EMAIL_EXISTS' }, { status: 409 });
    }
  } else {
    email = null;
  }

  let phone = String(body.phone || '').trim();
  phone = phone ? (phone.replace(/[^\d+().\s-]/g, '').trim() || null) : null;

  const position = String(body.position || '').toUpperCase().trim() || null;
  let isGoalie = (role === 'sub_goalie' || position === 'G') ? 1 : 0;

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
  // Part 5: resolved unconditionally (not just when `team` is given)
  // now, since headcount+hockey needs it below for the independent
  // Goalie/Player axis.
  const cfg = await getLeagueSeasonConfig(env, leagueId);
  if (team) {
    const validTeams = getTeamNames(cfg);
    if (!validTeams.includes(team)) {
      return Response.json({ ok: false, error: `team must be one of: ${validTeams.join(', ')}`, errorKey: 'TEAM_UNKNOWN' }, { status: 400 });
    }
  }
  // Part 5: for a headcount league whose sport has a goalie role,
  // Regular/Sub (role) and Goalie/Player (is_goalie) are two
  // INDEPENDENT axes -- role alone (roster/sub_skater, never
  // sub_goalie for this mode -- see the roster page's own 2-option
  // picker) can no longer imply is_goalie, so an explicit
  // body.is_goalie boolean is accepted instead.
  //
  // Live-testing task, Part 5 follow-up: generalized from
  // headcount-only to any team structure whose sport has the goalie
  // capability (sportHasGoalie, not a hardcoded team_structure/sport
  // name check) -- the roster page now also renders this control for
  // 'fixed'/'weekly_draw' regulars (see its own comment on
  // goalieAxisRoleGated), and only sends an explicit body.is_goalie
  // when that control is actually visible. When it's omitted (every
  // pre-existing caller, and fixed/weekly_draw subs whose goalie-ness
  // is already the role choice itself), isGoalie keeps its
  // role/position-derived default from above, completely unchanged.
  if (sportHasGoalie(cfg.sportType) && body.is_goalie !== undefined) {
    isGoalie = body.is_goalie === true ? 1 : 0;
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
    return Response.json({ ok: false, error: 'Invalid or missing CSRF token.', errorKey: 'CSRF_INVALID' }, { status: 403 });
  }

  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));

  const leagueId = await resolveSessionLeagueId(req, env, url);
  if (!leagueId) {
    return Response.json({ ok: false, error: 'No league found for this account.', errorKey: 'NO_LEAGUE_FOUND' }, { status: 404 });
  }

  const access = await checkLeagueAccess(req, env, leagueId);
  if (access !== 'ok') return leagueAccessResponse(access);

  // Defense in depth (see putLeagueDataJson's own comment): this route
  // must never be able to write a row tagged as SMBHL's, even in principle.
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot create events for SMBHL.', errorKey: 'ROUTE_BLOCKED_EVENTS' }, { status: 403 });
  }

  const date = String(body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ ok: false, error: 'date is required, in YYYY-MM-DD format.', errorKey: 'DATE_REQUIRED' }, { status: 400 });
  }

  const timePattern = /^\d{2}:\d{2}$/;
  const startTime = String(body.start_time || '').trim();
  if (startTime && !timePattern.test(startTime)) {
    return Response.json({ ok: false, error: 'start_time must be in HH:MM format.', errorKey: 'START_TIME_FORMAT' }, { status: 400 });
  }
  const endTime = String(body.end_time || '').trim();
  if (endTime && !timePattern.test(endTime)) {
    return Response.json({ ok: false, error: 'end_time must be in HH:MM format.', errorKey: 'END_TIME_FORMAT' }, { status: 400 });
  }

  const venue = String(body.venue || '').trim() || null;

  const leagueData = await getLeagueDataJson(env, leagueId);
  const season = String(body.season || '').trim() || leagueData.current_season;
  if (!season) {
    return Response.json({ ok: false, error: 'season is required (publish a season first via /league/season/publish, or pass one explicitly).', errorKey: 'SEASON_REQUIRED' }, { status: 400 });
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
    return Response.json({ ok: false, error: 'An event already exists for this date in your league.', errorKey: 'EVENT_DATE_EXISTS' }, { status: 409 });
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
    return Response.json({ ok: false, error: 'Invalid or missing CSRF token.', errorKey: 'CSRF_INVALID' }, { status: 403 });
  }

  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));
  const seasonName = String(body.season_name || '').trim();
  if (!seasonName) {
    return Response.json({ ok: false, error: 'season_name is required.', errorKey: 'SEASON_NAME_REQUIRED' }, { status: 400 });
  }

  const leagueId = await resolveSessionLeagueId(req, env, url);
  if (!leagueId) {
    return Response.json({ ok: false, error: 'No league found for this account.', errorKey: 'NO_LEAGUE_FOUND' }, { status: 404 });
  }

  const access = await checkLeagueAccess(req, env, leagueId);
  if (access !== 'ok') return leagueAccessResponse(access);

  // Defense in depth (see putLeagueDataJson's own comment): this route
  // must never be able to write SMBHL's real data, even in principle.
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot publish to SMBHL\'s data.' }, { status: 403 });
  }

  const leagueRow = await env.DB.prepare('SELECT team_names, team_structure, min_players, max_players, min_goalies FROM leagues WHERE id = ?').bind(leagueId).first();
  let teamNames = [];
  if (leagueRow && leagueRow.team_names) {
    try {
      const parsed = JSON.parse(leagueRow.team_names);
      if (Array.isArray(parsed)) teamNames = parsed.filter(Boolean);
    } catch (_) {}
  }

  // Season-level team-structure override task: a season can override the
  // league's own default team_structure for just itself (e.g. a
  // fixed-teams league running one headcount pickup season, without
  // changing its permanent signup-time default). body.team_structure is
  // OPTIONAL and absent from every pre-existing caller (the dashboard's
  // "start your first season" form, every test written before this
  // task) -- when it's not given, seasonTeamStructure stays null,
  // config.teamStructure is never set below, and getSeasonConfig's own
  // resolution (withLeagueBrandingDefault, season_config.js) falls
  // through to the league's own leagues.team_structure exactly as it
  // already did before this feature existed. That's what keeps every
  // pre-existing league/season completely unaffected -- this whole
  // block is purely additive on top of the untouched original path.
  let seasonTeamStructure = null;
  if (body.team_structure !== undefined && body.team_structure !== null && String(body.team_structure).trim() !== '') {
    const val = String(body.team_structure).trim();
    if (!['fixed', 'headcount', 'weekly_draw'].includes(val)) {
      return Response.json({ ok: false, error: "team_structure must be 'fixed', 'headcount', or 'weekly_draw'.", errorKey: 'INVALID_TEAM_STRUCTURE' }, { status: 400 });
    }
    seasonTeamStructure = val;
  }
  const effectiveStructure = seasonTeamStructure || (leagueRow && leagueRow.team_structure) || 'fixed';

  // A 'headcount' season (whether via the league's own default or an
  // explicit override) only ever stores exactly one team name (the
  // HEADCOUNT_TEAM_NAME sentinel -- see league_ids.js): that's correct
  // and expected for that mode, not a sign teams are missing. A season
  // overridden TO headcount on a league whose own real team_names are
  // something else (Otters/Falcons, say) must NOT carry those into this
  // season's config -- teamState/writeLeagueRsvpStatus/the event-status
  // page all key off the sentinel for this mode (see their own
  // comments), so this season's own team list has to be the sentinel
  // too, regardless of what the league's stored team_names say.
  const seasonTeamNames = effectiveStructure === 'headcount' ? [HEADCOUNT_TEAM_NAME] : teamNames;
  const minTeamNames = effectiveStructure === 'headcount' ? 1 : 2;
  if (seasonTeamNames.length < minTeamNames) {
    // Most common real case: overriding a headcount-default league's
    // season TO 'fixed'/'weekly_draw' when the league itself only ever
    // has the single sentinel team name on file (it never collected
    // real team names at signup) -- there's no reasonable team list to
    // fall back to, so this is a real, clear rejection rather than a
    // silent guess at team names the admin never chose.
    return Response.json({ ok: false, error: 'This league has no team names on file yet.', errorKey: 'NO_TEAM_NAMES' }, { status: 400 });
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
  const config = { teams: seasonTeamNames };
  for (const [bodyKey, cfgKey] of [['goalies_per_team', 'goaliesPerTeam'], ['skaters_per_team', 'skatersPerTeam'], ['min_skaters', 'minSkaters']]) {
    const n = Number(body[bodyKey]);
    if (Number.isFinite(n) && n > 0) config[cfgKey] = n;
  }

  // Season-level min/max (headcount only). Bug 3 fix (live-testing):
  // this used to only run when THIS call explicitly overrode
  // team_structure to 'headcount', so the far more common case -- a
  // headcount-DEFAULT league's plain first-season-publish, sending only
  // {season_name} -- never attached skatersPerTeam/minSkaters to the
  // season's own config at all. Once any real season config exists,
  // season_config.js's own resolution never falls back to the league's
  // leagues.min_players/max_players again (that fallback is only for
  // "no season published yet" -- see fallbackSeasonConfig's own
  // comment), so shortage math and the public page's "X/Y" figure
  // silently used SMBHL's generic defaults (8/5) instead of the
  // league's real signup-chosen numbers, for every headcount league
  // that never explicitly re-published with an override. Confirmed
  // live: a real league's public page showed "2/8" instead of the
  // correct "2/10".
  //
  // Fix: whenever THIS season's effective structure is headcount --
  // whether via an explicit override (seasonTeamStructure === headcount,
  // which still requires real values in the body, same as before) or
  // simply inherited from an already-headcount league's own default
  // (no override in this request at all) -- min/max is resolved as
  // body.min_players/max_players if explicitly given, else the
  // league's own real leagues.min_players/max_players (always set for
  // a headcount league at signup). Every pre-existing NON-headcount
  // call (SMBHL, every 'fixed'/'weekly_draw' league) is completely
  // unaffected -- this block still only runs when effectiveStructure
  // is 'headcount', exactly as narrowly scoped as before.
  //
  // Not backfilled: an already-published season from before this fix
  // (config.skatersPerTeam/minSkaters missing) is NOT retroactively
  // rewritten here -- this route only ever touches data when actually
  // called. A league already affected self-heals the next time its
  // admin re-publishes (edits) its current season, e.g. via the
  // dashboard's own "Saisons" section -- see this task's final report
  // for the explicit decision not to perform a live KV backfill.
  if (effectiveStructure === 'headcount') {
    const minP = body.min_players !== undefined ? Number(body.min_players) : (leagueRow && leagueRow.min_players);
    const maxP = body.max_players !== undefined ? Number(body.max_players) : (leagueRow && leagueRow.max_players);
    if (seasonTeamStructure === 'headcount') {
      // An explicit override TO headcount has no league-level default
      // to silently fall back to if the body omits min/max (a
      // fixed/weekly_draw-default league has no min_players/max_players
      // of its own at all) -- still required, same as before.
      if (!Number.isFinite(minP) || !Number.isFinite(maxP) || minP < 1) {
        return Response.json({ ok: false, error: 'A minimum and maximum player count are required.', errorKey: 'HEADCOUNT_LIMITS_REQUIRED' }, { status: 400 });
      }
      if (maxP < minP) {
        return Response.json({ ok: false, error: 'The maximum must be at least the minimum.', errorKey: 'HEADCOUNT_MAX_TOO_LOW' }, { status: 400 });
      }
    }
    if (Number.isFinite(minP) && Number.isFinite(maxP)) {
      config.skatersPerTeam = maxP;
      config.minSkaters = minP;
    }
    // Part 5 (headcount goalie minimum): body.min_goalies if this call
    // explicitly overrides it, else the league's own real min_goalies
    // (always a real 0-or-more integer -- migrate-029.sql's own
    // DEFAULT 0). Always set explicitly (even when 0) -- normalizeSeasonConfig
    // (season_config.js) now correctly distinguishes an explicit 0 from
    // "not provided", so this deliberately does NOT fall through to
    // that function's own DEFAULT_SEASON_CONFIG.goaliesPerTeam (1),
    // which would silently impose a goalie requirement no one asked
    // for. Reuses config.goaliesPerTeam -- the exact same field
    // fixed-mode teams already use -- so teamState/expected/openSpots
    // need zero adaptation to enforce it pool-wide for headcount.
    const minG = body.min_goalies !== undefined ? Number(body.min_goalies) : (leagueRow && leagueRow.min_goalies) || 0;
    if (Number.isFinite(minG) && minG >= 0) {
      config.goaliesPerTeam = minG;
    }
  }

  if (seasonTeamStructure) {
    config.teamStructure = seasonTeamStructure;
  }

  const newSeasonEntry = {
    name: seasonName,
    config,
    standings: seasonTeamNames.map(team => ({ team, gp: 0, w: 0, l: 0, t: 0, pts: 0, gf: 0, ga: 0 })),
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

  return Response.json({ ok: true, league_id: leagueId, current_season: seasonName, teams: seasonTeamNames, team_structure: effectiveStructure, overwritten });
}

/* ---------- league URL slugs (Part 2, overnight follow-up task) ----------
 * Short, human-readable public URLs (notreligue.ca/dmbhl) instead of the
 * raw UUID (notreligue.ca/league/public?league=<uuid>). Decision: NOT
 * changeable after creation (see handleLeagueUpdateSlug's absence --
 * deliberately not built). A league's public URL, once shared, is exactly
 * the kind of link that ends up bookmarked, posted in a group chat, or
 * embedded in an already-sent invite/magic-link email; changing the slug
 * later would silently break every one of those without any way for this
 * app to know who to notify. Not changeable-after-creation is the simpler,
 * safer choice for now. A real "change it, with a redirect from the old
 * slug" follow-up is a reasonable future feature IF this ever becomes a
 * real pain point (e.g. a league renaming itself) -- redirects would need
 * their own small table (old_slug -> league_id, checked before the 404
 * fallback) to avoid losing the old URL entirely, which is why it's not
 * just "let them edit the column" even as a fast-follow.
 */

// Collision-safe: tries the bare slugified name first, then -2, -3, ...
// `excludeLeagueId` lets a future "check availability without this being
// a collision against itself" caller reuse this (not used by
// handleLeagueCreate today, since a league never already has a slug at
// creation time, but kept general rather than duplicated for the lazy
// backfill path below, which DOES need to exclude nothing since the
// league in question has no slug yet either).
export async function generateUniqueSlug(env, baseName, excludeLeagueId = null) {
  const base = slugify(baseName) || 'ligue';
  let candidate = base;
  let suffix = 1;
  for (;;) {
    if (!RESERVED_SLUGS.has(candidate)) {
      const existing = await env.DB.prepare(
        excludeLeagueId
          ? 'SELECT id FROM leagues WHERE slug = ? AND id != ?'
          : 'SELECT id FROM leagues WHERE slug = ?'
      ).bind(...(excludeLeagueId ? [candidate, excludeLeagueId] : [candidate])).first();
      if (!existing) return candidate;
    }
    suffix += 1;
    candidate = `${base}-${suffix}`.slice(0, 40);
  }
}

// Self-healing backfill: any league created before migrate-024.sql (slug
// column didn't exist yet) simply has slug = NULL. Rather than a separate
// one-time migration script, the first time anything needs that league's
// real slug (today: the dashboard, rendering its shareable public URL),
// this generates and persists a real one using the exact same
// collision-avoiding logic new leagues get at creation time.
export async function getOrCreateLeagueSlug(env, leagueRow) {
  if (leagueRow.slug) return leagueRow.slug;
  const slug = await generateUniqueSlug(env, leagueRow.name, leagueRow.id);
  await env.DB.prepare('UPDATE leagues SET slug = ? WHERE id = ? AND slug IS NULL')
    .bind(slug, leagueRow.id).run();
  return slug;
}

// Resolves a bare top-level path segment to a league id, for index.js's
// last-resort GET route (checked only after every fixed route has
// already failed to match -- see that route's own comment for why this
// can never shadow a real route). Never matches SMBHL (no league_admins
// row exists for it, and it's never given a slug), and never matches a
// deactivated league (its public page is already gone via the existing
// deactivated_at check in handleLeaguePublicPage -- this just resolves
// the id, the deactivated check still happens the normal way).
export async function resolveLeagueIdBySlug(env, slug) {
  if (!slug || !isValidSlugFormat(slug)) return null;
  const row = await env.DB.prepare('SELECT id FROM leagues WHERE slug = ?').bind(slug).first();
  return row ? row.id : null;
}

export async function handleLeagueCreate(req, env) {
  try {
    const session = await checkUserSession(req, env);
    if (!session) {
      return Response.json({ ok: false, error: 'Authentication required.', errorKey: 'AUTH_REQUIRED' }, { status: 401 });
    }
    if (!(await checkCsrfToken(req, env, session))) {
      return Response.json({ ok: false, error: 'Invalid or missing CSRF token.', errorKey: 'CSRF_INVALID' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    const tracksStats = body.tracksStats !== false; // defaults to true, matching season_config.js's own default
    const divisionLabel = body.divisionLabel ? String(body.divisionLabel).trim() : null;

    // Team-structure task: chosen once at signup, never changed after
    // (same posture as the slug -- see migrate-027.sql's own comment).
    // Defaults to 'fixed' so every existing caller (every test/client
    // that doesn't send this field) gets byte-for-byte the same
    // behavior as before this task.
    const teamStructure = ['fixed', 'headcount', 'weekly_draw'].includes(body.teamStructure) ? body.teamStructure : 'fixed';

    if (!name) {
      return Response.json({ ok: false, error: 'League name is required.', errorKey: 'LEAGUE_NAME_REQUIRED' }, { status: 400 });
    }

    let teamNames = [];
    let minPlayers = null;
    let maxPlayers = null;
    let minGoalies = 0;
    if (teamStructure === 'headcount') {
      // No team concept at all -- a single minimum/maximum player
      // count instead (reuses the exact same min/max PATTERN fixed-mode
      // teams already use -- see getSeasonConfig's own comment).
      minPlayers = Number(body.minPlayers);
      maxPlayers = Number(body.maxPlayers);
      if (!Number.isFinite(minPlayers) || !Number.isFinite(maxPlayers) || minPlayers < 1) {
        return Response.json({ ok: false, error: 'A minimum and maximum player count are required.', errorKey: 'HEADCOUNT_LIMITS_REQUIRED' }, { status: 400 });
      }
      if (maxPlayers < minPlayers) {
        return Response.json({ ok: false, error: 'The maximum must be at least the minimum.', errorKey: 'HEADCOUNT_MAX_TOO_LOW' }, { status: 400 });
      }
      // Part 5 (headcount goalie minimum): optional, unlike min/max
      // players -- 0 (no goalie requirement at all) is a real,
      // intentional, common choice for a pickup league that doesn't
      // care about goalie coverage specifically, not a placeholder for
      // "not decided yet". Only meaningful while sport_type is
      // 'hockey' (every league today -- see migrate-028.sql).
      if (body.minGoalies !== undefined && body.minGoalies !== null && String(body.minGoalies).trim() !== '') {
        minGoalies = Number(body.minGoalies);
        if (!Number.isFinite(minGoalies) || minGoalies < 0) {
          return Response.json({ ok: false, error: 'Minimum goalies must be zero or more.', errorKey: 'HEADCOUNT_MIN_GOALIES_INVALID' }, { status: 400 });
        }
        if (minGoalies > maxPlayers) {
          return Response.json({ ok: false, error: "Minimum goalies can't be more than the maximum player count.", errorKey: 'HEADCOUNT_MIN_GOALIES_TOO_HIGH' }, { status: 400 });
        }
      }
      // The single implicit "team" every headcount league's rsvp rows
      // get tagged with -- never shown in any headcount UI surface
      // (see writeLeagueRsvpStatus's own comment), but real team-shaped
      // data underneath so teamState/openSpots/expected (fixed mode's
      // own shortage-detection machinery) work completely unchanged.
      teamNames = [HEADCOUNT_TEAM_NAME];
    } else {
      // 'fixed' and 'weekly_draw' both need real named teams -- fixed
      // assigns players to them permanently at roster time,
      // weekly_draw assigns per event instead, but both need the
      // names to assign FROM.
      teamNames = Array.isArray(body.teamNames)
        ? body.teamNames.map(t => String(t || '').trim()).filter(Boolean)
        : [];
      if (teamNames.length < 2) {
        return Response.json({ ok: false, error: 'At least 2 team names are required.', errorKey: 'MIN_TEAM_NAMES' }, { status: 400 });
      }
    }

    // Part 2: a short, human-readable public URL slug -- auto-suggested
    // client-side from the league name, editable before submitting. An
    // explicit slug in the body (the signup form always sends one, even
    // if the user never touched it) is validated; omitting it entirely
    // (e.g. a direct API call) falls back to auto-generating one from
    // the league name, same as an existing league's lazy backfill does.
    let slug = body.slug != null ? String(body.slug).trim().toLowerCase() : '';
    if (slug) {
      if (!isValidSlugFormat(slug)) {
        return Response.json({ ok: false, error: 'The URL must contain only lowercase letters, numbers, and hyphens.', errorKey: 'SLUG_INVALID_FORMAT' }, { status: 400 });
      }
      if (RESERVED_SLUGS.has(slug)) {
        return Response.json({ ok: false, error: 'This URL is reserved. Please choose another one.', errorKey: 'SLUG_RESERVED' }, { status: 409 });
      }
      const taken = await env.DB.prepare('SELECT id FROM leagues WHERE slug = ?').bind(slug).first();
      if (taken) {
        return Response.json({ ok: false, error: 'This URL is already used by another league.', errorKey: 'SLUG_TAKEN' }, { status: 409 });
      }
    } else {
      slug = await generateUniqueSlug(env, name);
    }

    const leagueId = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO leagues (id, name, division_label, tracks_stats, team_count, team_names, created_by, created_at, slug, team_structure, min_players, max_players, min_goalies)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(leagueId, name, divisionLabel, tracksStats ? 1 : 0, teamNames.length, JSON.stringify(teamNames), session.userId, now, slug, teamStructure, minPlayers, maxPlayers, minGoalies).run();

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
        teamNames,
        slug,
        teamStructure,
        minPlayers,
        maxPlayers,
        minGoalies
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

// Design system Part 5: rebuilt on the real design system
// (nlEmailWrap/nlEmailButton, guidelines/30-emails.md's build rules).
// Safe to touch: co-admin invites are Part 9's own multi-admin system,
// exclusive to the new league product -- SMBHL has no multi-admin
// invite flow and never sends this email. Unlike the account-level
// verification/reset emails, a real league (and its own stored color)
// exists by this point, so the header bar/button use the league's own
// contrast-safe color (leagueFillColor()), same rule as the RSVP/
// public pages. Bilingual single send (FR then EN), matching every
// other transactional email in this app.
function buildInviteEmail(leagueName, inviteLink, leagueColor = '#b3122e') {
  const barColor = leagueFillColor(leagueColor || '#b3122e');
  const subject = `Invitation à co-administrer ${leagueName} / Invitation to co-admin ${leagueName}`;
  const text =
`Tu as été invité(e) à devenir co-administrateur(-trice) de la ligue ${leagueName}. Clique sur ce lien pour accepter :
${inviteLink}

Ce lien expire dans 48 heures. Si tu ne connais pas cette ligue, ignore ce courriel.

---

You've been invited to become a co-admin of the ${leagueName} league. Click this link to accept:
${inviteLink}

This link expires in 48 hours. If you don't recognize this league, you can ignore this email.`;
  const bodyHtml = `
    <h1 style="margin:0 0 12px;font:700 28px/34px Archivo,Arial,Helvetica,sans-serif;font-stretch:118%;color:#16181d;">Invitation à co-administrer</h1>
    <p style="margin:0 0 24px;font-size:16px;line-height:25px;">Tu as été invité(e) à devenir co-administrateur(-trice) de <b>${nlEmailWrapEsc(leagueName)}</b>.</p>
    ${nlEmailButton(inviteLink, 'Accepter l’invitation', barColor)}
    <p style="margin:20px 0 0;font-size:13px;line-height:19px;color:#55585f;">Ce lien expire dans 48 heures. Si tu ne connais pas cette ligue, ignore ce courriel.</p>
    <hr style="border:none;border-top:1px solid #e3e3e0;margin:28px 0;">
    <h1 style="margin:0 0 12px;font:700 28px/34px Archivo,Arial,Helvetica,sans-serif;font-stretch:118%;color:#16181d;">Co-admin invitation</h1>
    <p style="margin:0 0 24px;font-size:16px;line-height:25px;">You've been invited to become a co-admin of <b>${nlEmailWrapEsc(leagueName)}</b>.</p>
    ${nlEmailButton(inviteLink, 'Accept the invitation', barColor)}
    <p style="margin:20px 0 0;font-size:13px;line-height:19px;color:#55585f;">This link expires in 48 hours. If you don't recognize this league, you can ignore this email.</p>`;
  const html = nlEmailWrap({
    brandName: leagueName,
    barColor,
    bodyHtml,
    footerHtml: `Envoyé par Notre Ligue pour ${nlEmailWrapEsc(leagueName)}`
  });
  return { subject, text, html };
}
function nlEmailWrapEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// POST /league/admins/invite -- session+CSRF-gated, same discipline as
// every other league-admin write route. Body: { email }.
export async function handleLeagueAdminInvite(req, env, url, sendMailFunc = null) {
  const session = await checkUserSession(req, env);
  if (!session) return leagueAccessResponse('unauthenticated');
  if (!(await checkCsrfToken(req, env, session))) {
    return Response.json({ ok: false, error: 'Invalid or missing CSRF token.', errorKey: 'CSRF_INVALID' }, { status: 403 });
  }

  const leagueId = await resolveSessionLeagueId(req, env, url);
  if (!leagueId) {
    return Response.json({ ok: false, error: 'No league found for this account.', errorKey: 'NO_LEAGUE_FOUND' }, { status: 404 });
  }
  const access = await checkLeagueAccess(req, env, leagueId);
  if (access !== 'ok') return leagueAccessResponse(access);

  const body = await req.json().catch(() => ({}));
  let email = String(body.email || '').trim().toLowerCase();
  const check = sanitizeAndValidateEmail(email);
  if (!check.valid) {
    // Live-testing bug fix (Bug 6 sweep): same fix as
    // handleLeagueContactCreate's own identical check above.
    return Response.json({ ok: false, error: check.error, errorKey: 'INVALID_EMAIL' }, { status: 400 });
  }
  email = check.email;

  const leagueRow = await env.DB.prepare('SELECT name FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!leagueRow) return Response.json({ ok: false, error: 'League not found.', errorKey: 'LEAGUE_NOT_FOUND' }, { status: 404 });

  // Already an admin of this league? Nothing to invite -- a clear,
  // specific error beats silently sending a redundant invite email.
  const existingUser = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existingUser) {
    const alreadyAdmin = await env.DB.prepare(
      'SELECT 1 FROM league_admins WHERE user_id = ? AND league_id = ?'
    ).bind(existingUser.id, leagueId).first();
    if (alreadyAdmin) {
      return Response.json({ ok: false, error: 'This person is already an admin of this league.', errorKey: 'ALREADY_ADMIN' }, { status: 409 });
    }
  }

  const { token } = await generateInviteToken(env, leagueId, email);
  const publicUrl = env.PUBLIC_URL || 'https://rsvp.smbhl.com';
  const inviteLink = `${publicUrl}/league/admins/accept?token=${encodeURIComponent(token)}`;

  if (typeof sendMailFunc === 'function') {
    try {
      // Bug fix (Part 1, an earlier task this session): this league
      // already exists by this point (leagueRow was just fetched
      // above) -- pass its own real branding (getLeagueSeasonConfig's
      // leagueBranding, the same admin's-own-email fromEmail every
      // other league-scoped email in this app already uses) instead of
      // falling through to sendMail's generic default identity, which
      // this call previously did. cfg.league.color (design system
      // Part 1) is also the email's own header bar/button color.
      const cfg = await getLeagueSeasonConfig(env, leagueId);
      const { subject, text, html } = buildInviteEmail(leagueRow.name, inviteLink, cfg.league.color);
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
    const errorKey = result.error === 'expired' ? 'LINK_EXPIRED' : result.error === 'malformed' ? 'LINK_MALFORMED' : 'LINK_INVALID';
    return Response.json({ ok: false, error: result.error, errorKey }, { status });
  }
  const { leagueId, email } = result;

  const leagueRow = await env.DB.prepare('SELECT id FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!leagueRow) return Response.json({ ok: false, error: 'League no longer exists.', errorKey: 'LEAGUE_GONE' }, { status: 404 });

  const existingUser = await env.DB.prepare('SELECT id, session_epoch FROM users WHERE email = ?').bind(email).first();
  const now = new Date().toISOString();

  if (existingUser) {
    const session = await checkUserSession(req, env);
    if (!session || session.userId !== existingUser.id) {
      return Response.json({ ok: false, error: 'Please log in as ' + email + ' to accept this invite.', errorKey: 'LOGIN_AS_EMAIL', errorVars: { email }, requiresLogin: true, email }, { status: 401 });
    }
    // A real session is being used here (unlike the fresh-account branch
    // below, which has no session yet) -- CSRF-protect it like every
    // other route that acts on an existing session.
    if (!(await checkCsrfToken(req, env, session))) {
      return Response.json({ ok: false, error: 'Invalid or missing CSRF token.', errorKey: 'CSRF_INVALID' }, { status: 403 });
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
    return Response.json({ ok: false, error: 'Password must be at least 8 characters.', errorKey: 'WEAK_PASSWORD' }, { status: 400 });
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
    return Response.json({ ok: false, error: 'Invalid or missing CSRF token.', errorKey: 'CSRF_INVALID' }, { status: 403 });
  }

  const leagueId = await resolveSessionLeagueId(req, env, url);
  if (!leagueId) {
    return Response.json({ ok: false, error: 'No league found for this account.', errorKey: 'NO_LEAGUE_FOUND' }, { status: 404 });
  }
  const access = await checkLeagueAccess(req, env, leagueId);
  if (access !== 'ok') return leagueAccessResponse(access);

  const leagueRow = await env.DB.prepare('SELECT name FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!leagueRow) return Response.json({ ok: false, error: 'League not found.', errorKey: 'LEAGUE_NOT_FOUND' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const confirmName = String(body.confirmName || '').trim();
  if (confirmName !== leagueRow.name) {
    return Response.json({ ok: false, error: 'Confirmation text does not match the league name.', errorKey: 'CONFIRM_NAME_MISMATCH' }, { status: 400 });
  }

  await env.DB.prepare('UPDATE leagues SET deactivated_at = ? WHERE id = ?').bind(new Date().toISOString(), leagueId).run();
  return Response.json({ ok: true, leagueId });
}

/* ---------- language exposure setting (Part 4 foundation + editor) ----------
 * migrate-023.sql's language_mode column, default 'both'. This is the
 * FIRST and only write path for it -- the field previously existed with
 * no way for an admin to change it at all.
 */
const VALID_LANGUAGE_MODES = new Set(['both', 'fr', 'en']);

export async function handleLeagueUpdateLanguageMode(req, env, url) {
  const session = await checkUserSession(req, env);
  if (!session) return leagueAccessResponse('unauthenticated');
  if (!(await checkCsrfToken(req, env, session))) {
    return Response.json({ ok: false, error: 'Invalid or missing CSRF token.', errorKey: 'CSRF_INVALID' }, { status: 403 });
  }

  const leagueId = await resolveSessionLeagueId(req, env, url);
  if (!leagueId) {
    return Response.json({ ok: false, error: 'No league found for this account.', errorKey: 'NO_LEAGUE_FOUND' }, { status: 404 });
  }
  const access = await checkLeagueAccess(req, env, leagueId);
  if (access !== 'ok') return leagueAccessResponse(access);

  const body = await req.json().catch(() => ({}));
  const languageMode = String(body.languageMode || '').trim();
  if (!VALID_LANGUAGE_MODES.has(languageMode)) {
    return Response.json({ ok: false, error: "Language must be 'both', 'fr', or 'en'.", errorKey: 'INVALID_LANGUAGE_MODE' }, { status: 400 });
  }

  await env.DB.prepare('UPDATE leagues SET language_mode = ? WHERE id = ?').bind(languageMode, leagueId).run();
  return Response.json({ ok: true, languageMode });
}

/* ---------- per-league automated reminder settings ----------
 * Session+CSRF+checkLeagueAccess-gated, same discipline as every other
 * league-admin write route (handleLeagueUpdateLanguageMode just
 * above). Three independent toggles (migrate-026.sql), each
 * PATCH-style optional in the body -- only the keys actually present
 * are updated, so the dashboard's 3 separate switches can each POST
 * on their own without needing to know the other two's current state.
 */
export async function handleLeagueUpdateReminderSettings(req, env, url) {
  const session = await checkUserSession(req, env);
  if (!session) return leagueAccessResponse('unauthenticated');
  if (!(await checkCsrfToken(req, env, session))) {
    return Response.json({ ok: false, error: 'Invalid or missing CSRF token.', errorKey: 'CSRF_INVALID' }, { status: 403 });
  }

  const leagueId = await resolveSessionLeagueId(req, env, url);
  if (!leagueId) {
    return Response.json({ ok: false, error: 'No league found for this account.', errorKey: 'NO_LEAGUE_FOUND' }, { status: 404 });
  }
  const access = await checkLeagueAccess(req, env, leagueId);
  if (access !== 'ok') return leagueAccessResponse(access);

  const body = await req.json().catch(() => ({}));
  const updates = [];
  const params = [];
  for (const [bodyKey, col] of [
    ['reminder72h', 'reminder_72h_enabled'],
    ['reminder24h', 'reminder_24h_enabled'],
    ['reminder12h', 'reminder_12h_enabled']
  ]) {
    if (typeof body[bodyKey] === 'boolean') { updates.push(`${col} = ?`); params.push(body[bodyKey] ? 1 : 0); }
  }
  if (!updates.length) {
    return Response.json({ ok: false, error: 'No settings provided.', errorKey: 'NO_SETTINGS_PROVIDED' }, { status: 400 });
  }
  params.push(leagueId);
  await env.DB.prepare(`UPDATE leagues SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();

  const row = await env.DB.prepare(
    'SELECT reminder_72h_enabled, reminder_24h_enabled, reminder_12h_enabled FROM leagues WHERE id = ?'
  ).bind(leagueId).first();
  return Response.json({
    ok: true,
    settings: {
      reminder72h: !!row.reminder_72h_enabled,
      reminder24h: !!row.reminder_24h_enabled,
      reminder12h: !!row.reminder_12h_enabled
    }
  });
}

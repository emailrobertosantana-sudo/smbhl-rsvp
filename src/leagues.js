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
import { getSeasonConfig, DEFAULT_SEASON_CONFIG, getTeamNames, sportHasGoalie, generateRoundRobinRounds } from './season_config.js';
import { hmac, same } from './crypto_utils.js';
import { nlEmailWrap, nlEmailButton, leagueFillColor, assembleBilingualEmail } from './design_system.js';
import { hasCapability } from './super_admin.js';
import { applyReminderWindowSkipRule } from './reminder_scheduling.js';

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
    `SELECT l.id, l.name, l.slug, l.team_names, l.language_mode, l.color, l.team_structure, l.min_players, l.max_players, l.min_goalies, l.max_goalies, l.sport_type, u.email AS admin_email
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
      // with minPlayers/maxPlayers -- 0 ("no goalie requirement") is
      // real, intentional data, not an absence to special-case around.
      // Live-testing task, Part 5: these columns are no longer
      // headcount-only -- 'fixed'/'weekly_draw' can now set them too
      // (settings page), so this fallback (used only before a real
      // season config exists) applies identically to every structure.
      // max_goalies (migrate-036.sql) is nullable and only included
      // when actually set -- normalizeSeasonConfig's own maxGoalies
      // resolution defaults it to goaliesPerTeam otherwise.
      leagueRosterLimits = {
        minPlayers: leagueRow.min_players, maxPlayers: leagueRow.max_players,
        minGoalies: leagueRow.min_goalies,
        ...(leagueRow.max_goalies != null ? { maxGoalies: leagueRow.max_goalies } : {})
      };
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
    'SELECT player_id, name, email, phone, role, is_active FROM contacts WHERE league_id = ? ORDER BY name'
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
 * role: 'roster' | 'sub_skater' — exactly two values. Used to also
 * accept 'sub_goalie' (mirroring SMBHL's own legacy 3-value scheme,
 * which this route can never reach or affect -- see the SMBHL block
 * below), but that duplicated the independent Goalie/Player axis
 * (is_goalie) for this product specifically: a sub's goalie-ness ended
 * up askable in two places (this 3rd role value, and the roster page's
 * own separate goalie toggle) that could disagree. Live-testing task,
 * Part 2 (bug fix): retired 'sub_goalie' as a role value for this
 * route entirely -- is_goalie alone carries goalie-ness now, for a
 * regular OR a sub, independently of role, matching the product's own
 * intended two-axis design. migrate-035.sql backfills any existing
 * non-SMBHL contact that had role='sub_goalie' to role='sub_skater' +
 * is_goalie=1 (the exact status quo that role value already implied),
 * so no existing league's real goalie coverage changes.
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
// Live-testing task, Part 6: the actual per-row validation/creation
// logic used to live inline in handleLeagueContactCreate -- pulled out
// here (same leagueId+body shape, no session/CSRF/access handling of
// its own, since those are per-REQUEST concerns, not per-ROW) so the
// new bulk-import route (handleLeagueContactsBulkCreate below) can run
// the exact same validation and dedup check per pasted row instead of
// reimplementing or bypassing any of it. Returns a plain result object
// ({ ok, error, errorKey, contact } | { ok: false, ... }), not an HTTP
// Response -- handleLeagueContactCreate wraps it in one for the single-
// add route; the bulk route collects one per row instead.
async function createLeagueContactRow(env, leagueId, body) {
  const name = String(body.name || '').trim().split(/\s+/).filter(Boolean).join(' ');
  if (!name || name.split(' ').length < 2) {
    return { ok: false, error: 'Full name (first and last) is required.', errorKey: 'FULL_NAME_REQUIRED' };
  }
  if (name.length > 60) {
    return { ok: false, error: 'Name is too long.', errorKey: 'NAME_TOO_LONG' };
  }

  const role = String(body.role || 'roster').trim();
  if (!['roster', 'sub_skater'].includes(role)) {
    return { ok: false, error: 'role must be roster or sub_skater.', errorKey: 'INVALID_ROLE' };
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
      return { ok: false, error: check.error, errorKey: 'INVALID_EMAIL' };
    }
    email = check.email;

    const dupe = await env.DB.prepare(
      'SELECT player_id FROM contacts WHERE league_id = ? AND lower(email) = lower(?)'
    ).bind(leagueId, email).first();
    if (dupe) {
      return { ok: false, error: 'A contact with this email already exists in your league.', errorKey: 'CONTACT_EMAIL_EXISTS' };
    }
  } else {
    email = null;
  }

  let phone = String(body.phone || '').trim();
  phone = phone ? (phone.replace(/[^\d+().\s-]/g, '').trim() || null) : null;

  const position = String(body.position || '').toUpperCase().trim() || null;
  // Live-testing task, Part 2 (bug fix): used to default from
  // role === 'sub_goalie' or position === 'G' -- both retired as
  // goalie signals for this route (role can never be 'sub_goalie'
  // anymore, and position was never sent by the roster page's own
  // form to begin with). is_goalie is now set ONLY from the explicit
  // body.is_goalie boolean below, defaulting to 0 (not a goalie) when
  // absent or when this sport has no goalie capability at all.
  let isGoalie = 0;

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
      return { ok: false, error: `team must be one of: ${validTeams.join(', ')}`, errorKey: 'TEAM_UNKNOWN' };
    }
  }
  // Part 5/Part 2: Regular/Sub (role) and Goalie/Player (is_goalie) are
  // two INDEPENDENT axes, for every team structure, for a regular or a
  // sub alike -- gated on the sport's own capability (sportHasGoalie),
  // not a hardcoded team_structure/sport name check, so this stays
  // inert the moment a non-goalie sport exists. When is_goalie is
  // omitted from the request (a caller not using the roster page's own
  // form, or a sport with no goalie capability), it stays the default
  // 0 set above -- never a goalie, not an error.
  if (sportHasGoalie(cfg.sportType) && body.is_goalie !== undefined) {
    isGoalie = body.is_goalie === true ? 1 : 0;
  }
  // E2 (players polish task): "can also play goalie" -- a Player who
  // can cover the goalie spot if the primary is out. Reuses the SAME
  // contacts.is_backup_goalie column SMBHL's own admin already writes
  // (teamState/expected, index.js, already fall back to it
  // automatically for shortage detection and coverage -- this is only
  // the league product's first WRITE path for it). Never true for an
  // actual goalie (isGoalie === 1) regardless of what's sent -- the
  // two are mutually exclusive by definition, same as the form's own
  // client-side hide-on-Goalie behaviour.
  let isBackupGoalie = 0;
  if (sportHasGoalie(cfg.sportType) && !isGoalie && body.is_backup_goalie === true) {
    isBackupGoalie = 1;
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
    `INSERT INTO contacts (player_id, name, email, phone, role, is_goalie, is_backup_goalie, position, preferred_team, token_salt, league_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(playerId, name, email, phone, role, isGoalie, isBackupGoalie, position, team, salt, leagueId).run();

  return {
    ok: true,
    contact: { player_id: playerId, name, email, phone, role, is_goalie: isGoalie, is_backup_goalie: isBackupGoalie, position, team }
  };
}

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

  const result = await createLeagueContactRow(env, leagueId, body);
  if (!result.ok) {
    const status = result.errorKey === 'CONTACT_EMAIL_EXISTS' ? 409 : 400;
    return Response.json(result, { status });
  }
  return Response.json({ ok: true, league_id: leagueId, contact: result.contact });
}

/* ---------- POST /league/contacts/update (live-testing task, batch 6,
 * Part 5) ----------
 * The roster list showed Role and Goalie columns but offered no way to
 * change either after creation -- especially painful right after a
 * bulk import, where every row lands as 'roster'/not-a-goalie by
 * construction (parseBulkText, roster page's own script, has no
 * column for either), with no path forward except deleting and
 * re-adding. Same two INDEPENDENT axes as the "add a player" form
 * already uses (createLeagueContactRow's own comment) -- role
 * (roster/sub_skater) and is_goalie (gated on sportHasGoalie), each
 * settable on its own, for every team structure. Partial update: only
 * the fields actually present in the body are touched, so the
 * roster page's own two separate inline controls (Part 5's own build)
 * can each fire independently without one clobbering the other.
 */
export async function handleLeagueContactUpdate(req, env, url) {
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
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot update contacts for SMBHL.', errorKey: 'ROUTE_BLOCKED_CONTACTS' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const playerId = String(body.player_id || '').trim();
  if (!playerId) {
    return Response.json({ ok: false, error: 'player_id is required.', errorKey: 'PLAYER_ID_REQUIRED' }, { status: 400 });
  }
  // Scoped by league_id in the same WHERE clause as the UPDATE below --
  // never trust player_id alone (it's globally unique by construction,
  // league_ids.js, but a belt-and-suspenders league_id check here
  // matches every other league-scoped write in this file).
  const existing = await env.DB.prepare('SELECT player_id FROM contacts WHERE player_id = ? AND league_id = ?').bind(playerId, leagueId).first();
  if (!existing) {
    return Response.json({ ok: false, error: 'Player not found.', errorKey: 'PLAYER_NOT_FOUND' }, { status: 404 });
  }

  const updates = [];
  const params = [];
  // Item 2 (player-editing polish task): name/email/phone were create-
  // only until now -- the only way to fix a typo or add an email after
  // the fact was delete-and-re-add, which also loses history (rsvp
  // rows, past-season stats) a real edit doesn't need to touch. Same
  // validation as createLeagueContactRow (full name required, email
  // format + in-league dedup, phone sanitized), just against an
  // existing row instead of a new one.
  if (body.name !== undefined) {
    const name = String(body.name || '').trim().split(/\s+/).filter(Boolean).join(' ');
    if (!name || name.split(' ').length < 2) {
      return Response.json({ ok: false, error: 'Full name (first and last) is required.', errorKey: 'FULL_NAME_REQUIRED' }, { status: 400 });
    }
    if (name.length > 60) {
      return Response.json({ ok: false, error: 'Name is too long.', errorKey: 'NAME_TOO_LONG' }, { status: 400 });
    }
    updates.push('name = ?'); params.push(name);
  }
  if (body.email !== undefined) {
    let email = String(body.email || '').trim();
    if (email) {
      const check = sanitizeAndValidateEmail(email);
      if (!check.valid) {
        return Response.json({ ok: false, error: check.error, errorKey: 'INVALID_EMAIL' }, { status: 400 });
      }
      email = check.email;
      const dupe = await env.DB.prepare(
        'SELECT player_id FROM contacts WHERE league_id = ? AND lower(email) = lower(?) AND player_id != ?'
      ).bind(leagueId, email, playerId).first();
      if (dupe) {
        return Response.json({ ok: false, error: 'A contact with this email already exists in your league.', errorKey: 'CONTACT_EMAIL_EXISTS' }, { status: 400 });
      }
    } else {
      email = null;
    }
    updates.push('email = ?'); params.push(email);
  }
  if (body.phone !== undefined) {
    let phone = String(body.phone || '').trim();
    phone = phone ? (phone.replace(/[^\d+().\s-]/g, '').trim() || null) : null;
    updates.push('phone = ?'); params.push(phone);
  }
  if (body.role !== undefined) {
    const role = String(body.role || '').trim();
    if (!['roster', 'sub_skater'].includes(role)) {
      return Response.json({ ok: false, error: 'role must be roster or sub_skater.', errorKey: 'INVALID_ROLE' }, { status: 400 });
    }
    updates.push('role = ?'); params.push(role);
  }
  if (body.is_goalie !== undefined) {
    const cfg = await getLeagueSeasonConfig(env, leagueId);
    if (!sportHasGoalie(cfg.sportType)) {
      return Response.json({ ok: false, error: 'This league has no goalie position.', errorKey: 'NO_GOALIE_POSITION' }, { status: 400 });
    }
    updates.push('is_goalie = ?'); params.push(body.is_goalie === true ? 1 : 0);
    // E2 (players polish task): switching TO Goalie clears any stale
    // "can also play goalie" flag in the same write -- the two are
    // mutually exclusive, same as the add-player form's own behaviour.
    if (body.is_goalie === true) { updates.push('is_backup_goalie = 0'); }
  }
  if (body.is_backup_goalie !== undefined) {
    const cfg = await getLeagueSeasonConfig(env, leagueId);
    if (!sportHasGoalie(cfg.sportType)) {
      return Response.json({ ok: false, error: 'This league has no goalie position.', errorKey: 'NO_GOALIE_POSITION' }, { status: 400 });
    }
    updates.push('is_backup_goalie = ?'); params.push(body.is_backup_goalie === true ? 1 : 0);
  }
  if (!updates.length) {
    return Response.json({ ok: false, error: 'No settings provided.', errorKey: 'NO_SETTINGS_PROVIDED' }, { status: 400 });
  }

  params.push(playerId, leagueId);
  await env.DB.prepare(`UPDATE contacts SET ${updates.join(', ')} WHERE player_id = ? AND league_id = ?`).bind(...params).run();

  const row = await env.DB.prepare('SELECT name, email, phone, role, is_goalie, is_backup_goalie FROM contacts WHERE player_id = ?').bind(playerId).first();
  return Response.json({ ok: true, player_id: playerId, name: row.name, email: row.email, phone: row.phone, role: row.role, is_goalie: !!row.is_goalie, is_backup_goalie: !!row.is_backup_goalie });
}

/* ---------- Item 3 (players polish task): inactive players ----------
 * SMBHL has its own version of this (role='archived', with
 * previous_role/archive_reason/dormant alongside it) -- not reused here
 * because the league product's role column is a hard invariant elsewhere
 * in this codebase (exactly 'roster'/'sub_skater', see
 * createLeagueContactRow's own comment). This is the equivalent CONCEPT
 * -- keeps history, hidden from active rosters/counts/pools, reactivatable
 * -- as a new, orthogonal is_active flag instead, matching how is_goalie/
 * is_backup_goalie already work on this same table.
 *
 * setContactActiveState is the ONE mechanism both the manual toggle route
 * below and Item 4's season-rollover import call -- per this task's own
 * "one path, not two implementations" instruction for reactivation.
 */
export async function setContactActiveState(env, leagueId, playerId, isActive) {
  await env.DB.prepare(
    'UPDATE contacts SET is_active = ? WHERE player_id = ? AND league_id = ?'
  ).bind(isActive ? 1 : 0, playerId, leagueId).run();

  // Going inactive: pull this player out of any upcoming event's
  // confirmed/pending count -- the same effect a self-service "out"
  // click has, going through the exact same rsvp write shape
  // (status/status_by/updated_at) every other admin-driven status
  // change in this file uses, so teamState/eventWeekStatus/openSpots
  // (all rsvp-row-driven, not a fresh contacts pull) correctly stop
  // counting them without needing any changes themselves. Only touches
  // events that haven't happened yet (date >= today) -- past events are
  // real history and are never rewritten by this.
  if (!isActive) {
    const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      `UPDATE rsvp SET status = 'out', status_by = 'manager', updated_at = ?
        WHERE player_id = ? AND status != 'out'
          AND event_id IN (SELECT id FROM events WHERE league_id = ? AND date >= ? AND state != 'cancelled')`
    ).bind(new Date().toISOString(), playerId, leagueId, today).run();
  }
}

export async function handleLeagueContactSetActive(req, env, url) {
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
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot update contacts for SMBHL.', errorKey: 'ROUTE_BLOCKED_CONTACTS' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const playerId = String(body.player_id || '').trim();
  if (!playerId) {
    return Response.json({ ok: false, error: 'player_id is required.', errorKey: 'PLAYER_ID_REQUIRED' }, { status: 400 });
  }
  if (typeof body.is_active !== 'boolean') {
    return Response.json({ ok: false, error: 'is_active must be true or false.', errorKey: 'IS_ACTIVE_REQUIRED' }, { status: 400 });
  }
  const existing = await env.DB.prepare('SELECT player_id FROM contacts WHERE player_id = ? AND league_id = ?').bind(playerId, leagueId).first();
  if (!existing) {
    return Response.json({ ok: false, error: 'Player not found.', errorKey: 'PLAYER_NOT_FOUND' }, { status: 404 });
  }

  await setContactActiveState(env, leagueId, playerId, body.is_active);

  return Response.json({ ok: true, player_id: playerId, is_active: body.is_active });
}

/* ---------- Item 4 (season-rollover polish task): import players ----------
 * Players are league-wide, not season-scoped (Item 3's own note), so
 * there's no separate per-season roster to copy from -- "importing" is
 * really the admin confirming, at the moment a new season starts, who
 * stays active. Every current contact NOT in player_ids becomes
 * inactive; every one IN it becomes/stays active -- through
 * setContactActiveState, the SAME mechanism Item 3's own manual
 * toggle uses (this task's own "one path, not two implementations").
 * Entirely skippable: an admin who never calls this route changes
 * nothing.
 */
export async function handleLeagueSeasonRolloverImport(req, env, url) {
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
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot update contacts for SMBHL.', errorKey: 'ROUTE_BLOCKED_CONTACTS' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  if (!Array.isArray(body.player_ids)) {
    return Response.json({ ok: false, error: 'player_ids must be an array.', errorKey: 'PLAYER_IDS_REQUIRED' }, { status: 400 });
  }
  const keepActive = new Set(body.player_ids.map(id => String(id)));

  const existing = (await env.DB.prepare(
    'SELECT player_id, is_active FROM contacts WHERE league_id = ?'
  ).bind(leagueId).all()).results || [];

  let activated = 0, deactivated = 0;
  for (const c of existing) {
    const shouldBeActive = keepActive.has(c.player_id);
    const isCurrentlyActive = c.is_active !== 0;
    if (shouldBeActive === isCurrentlyActive) continue;
    await setContactActiveState(env, leagueId, c.player_id, shouldBeActive);
    if (shouldBeActive) activated++; else deactivated++;
  }

  return Response.json({ ok: true, activated, deactivated });
}

/* ---------- POST /league/contacts/bulk (Part 6, live-testing task) ----------
 * Bulk roster import: an admin pastes a block of text (from a
 * spreadsheet) into the roster page, which parses it CLIENT-SIDE into
 * rows and shows a preview before committing (see the roster page's own
 * script for the parser -- kept client-side since it's pure text
 * transformation with no need for a server round trip, and lets the
 * preview update instantly as the admin edits the pasted text). This
 * route only runs once the admin confirms the preview: it takes the
 * already-parsed rows and creates each one through the EXACT SAME
 * createLeagueContactRow validation/dedup path the single-add route
 * uses -- never a second, looser copy of that logic.
 *
 * Decision (documented): a bad row (missing name, invalid email, a
 * duplicate against an existing roster entry OR another row earlier in
 * this same pasted block) is skipped with a per-row reason in the
 * response, not a hard failure of the whole batch -- a realistic paste
 * of 20 players shouldn't be all-or-nothing over one typo. Within-batch
 * duplicate emails are detected here (case-insensitive) before each
 * row hits createLeagueContactRow, since that function's own dedup
 * check only sees rows already committed to the DB, not earlier rows
 * in the same in-flight batch.
 */
export async function handleLeagueContactsBulkCreate(req, env) {
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

  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot create contacts for SMBHL.', errorKey: 'ROUTE_BLOCKED_CONTACTS' }, { status: 403 });
  }

  const rows = Array.isArray(body.contacts) ? body.contacts.slice(0, 200) : [];
  if (!rows.length) {
    return Response.json({ ok: false, error: 'No contacts provided.', errorKey: 'BULK_CONTACTS_REQUIRED' }, { status: 400 });
  }

  const results = [];
  const seenEmails = new Set();
  for (const row of rows) {
    const rowEmail = String(row.email || '').trim().toLowerCase();
    if (rowEmail && seenEmails.has(rowEmail)) {
      results.push({ status: 'skipped', name: row.name || '', reason: 'duplicate_in_batch', errorKey: 'CONTACT_EMAIL_EXISTS' });
      continue;
    }
    const created = await createLeagueContactRow(env, leagueId, row);
    if (created.ok) {
      if (rowEmail) seenEmails.add(rowEmail);
      results.push({ status: 'created', contact: created.contact });
    } else {
      results.push({ status: 'skipped', name: row.name || '', reason: created.errorKey === 'CONTACT_EMAIL_EXISTS' ? 'duplicate_existing' : 'invalid', error: created.error, errorKey: created.errorKey });
    }
  }

  return Response.json({
    ok: true,
    league_id: leagueId,
    createdCount: results.filter(r => r.status === 'created').length,
    skippedCount: results.filter(r => r.status === 'skipped').length,
    results
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
 *     eventStart() and makeEventId/eventDateFromId (both league_ids.js)
 *     all assume.
 *
 * Reminder-window-skip-on-create bug fix: after the INSERT below,
 * applyReminderWindowSkipRule (reminder_scheduling.js) marks any
 * cadence step whose send window has already elapsed as of THIS
 * moment as skipped, rather than leaving it to fire in one backlogged
 * burst on the next cron tick -- see that function's own comment for
 * the full root cause. Skipped only when auto_reminders_enabled is
 * actually on for this event; when it's off, runLeagueReminders never
 * looks at this event at all (its own query filters on that column),
 * so there is nothing to mark.
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
// Live-testing task, Part 7: the actual per-event validation/creation
// logic used to live inline in handleLeagueEventCreate -- pulled out
// here (same shape as Part 6's createLeagueContactRow) so bulk event
// creation and event duplication (both below) run through the exact
// same validation and collision-safe ID generation as the single-event
// route, never a second copy of that logic. `leagueData` is passed in
// (rather than fetched here) so a caller creating many events in one
// request only fetches it once.
async function createLeagueEventRow(env, leagueId, body, leagueData) {
  const date = String(body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: 'date is required, in YYYY-MM-DD format.', errorKey: 'DATE_REQUIRED' };
  }

  const timePattern = /^\d{2}:\d{2}$/;
  const startTime = String(body.start_time || '').trim();
  if (startTime && !timePattern.test(startTime)) {
    return { ok: false, error: 'start_time must be in HH:MM format.', errorKey: 'START_TIME_FORMAT' };
  }
  const endTime = String(body.end_time || '').trim();
  if (endTime && !timePattern.test(endTime)) {
    return { ok: false, error: 'end_time must be in HH:MM format.', errorKey: 'END_TIME_FORMAT' };
  }

  let venue = String(body.venue || '').trim() || null;
  // Live-testing task (batch 6), Part 9: reusable venues. venue_id is
  // optional -- when given, it must be one of THIS league's own saved
  // venues (never another league's, never SMBHL's -- venues.league_id
  // is checked explicitly, the same scoping every other league-owned
  // row uses). The venue's own name is copied into events.venue as a
  // denormalized snapshot, so every existing read site (schedule,
  // public page, comms, reminder/confirmation emails -- ~90 of them,
  // none touched by this task) keeps working unchanged, whether or not
  // it knows venue_id exists. A caller that still sends only free-text
  // `venue` (no venue_id) behaves byte-for-byte as before this task.
  let venueId = null;
  if (body.venue_id) {
    const venueRow = await env.DB.prepare(
      'SELECT id, name FROM venues WHERE id = ? AND league_id = ?'
    ).bind(String(body.venue_id).trim(), leagueId).first();
    if (!venueRow) {
      return { ok: false, error: "venue_id must be one of this league's own saved venues.", errorKey: 'VENUE_UNKNOWN' };
    }
    venueId = venueRow.id;
    venue = venueRow.name;
  }

  const season = String(body.season || '').trim() || (leagueData && leagueData.current_season);
  if (!season) {
    return { ok: false, error: 'season is required (publish a season first via /league/season/publish, or pass one explicitly).', errorKey: 'SEASON_REQUIRED' };
  }

  let week = Number(body.week);
  if (!Number.isFinite(week) || week < 1) {
    const countRow = await env.DB.prepare(
      'SELECT COUNT(*) c FROM events WHERE league_id = ? AND season = ?'
    ).bind(leagueId, season).first();
    week = (countRow?.c || 0) + 1;
  }

  // Fixed-teams scheduling task (Part 2): "one event is one game between
  // two teams, not a night containing several" -- a league playing more
  // than one game in the same timeslot creates SEPARATE events for them,
  // distinguished by VENUE (SMBHL's own real example: Letendre Gym 1 and
  // Gym 2, both at 10:30). What's still rejected is a genuine double-
  // booking: this league, same date, same venue, same start_time as an
  // event that already exists. NULL venue/time is its own "nothing
  // recorded" slot -- two such blank events on the same date still
  // collide, exactly as every event always has (this is the same
  // rejection the one-event-per-date rule used to give unconditionally,
  // just narrowed to when it's still a real conflict).
  const slotConflict = await env.DB.prepare(
    `SELECT 1 FROM events WHERE league_id = ? AND date = ?
       AND COALESCE(venue, '') = COALESCE(?, '') AND COALESCE(start_time, '') = COALESCE(?, '')`
  ).bind(leagueId, date, venue, startTime || null).first();
  if (slotConflict) {
    return { ok: false, error: 'An event already exists for this date, venue, and time in your league.', errorKey: 'EVENT_SLOT_EXISTS' };
  }

  // events.id still must be unique -- the first event on a date keeps
  // the exact same id shape as before this task; only a second (or
  // later) one sharing that date gets makeEventId's own disambiguator
  // (league_ids.js -- inserted before the date, so eventDateFromId's
  // parsing is unaffected).
  let eventId = makeEventId(leagueId, date);
  let disambiguator = 2;
  while (await env.DB.prepare('SELECT 1 FROM events WHERE id = ?').bind(eventId).first()) {
    eventId = makeEventId(leagueId, date, disambiguator);
    disambiguator++;
  }

  // Fixed-teams scheduling task (Part 2): "Red vs Blue on Sunday" --
  // home_team/away_team (migrate-045.sql) are only ever meaningful for a
  // 'fixed' league; a weekly_draw league draws teams per event and a
  // headcount league has no team concept at all, so both are completely
  // unaffected -- body.home_team/away_team are simply never looked at
  // for either, exactly as if this task had never happened. Optional
  // even for 'fixed': an admin creating events ahead of a schedule
  // (bulk-create, this route with no matchup yet) can still leave it
  // unset -- handleLeagueEventDetailPage's own Part 1 fix renders a
  // "no matchup set" state for a >2-team fixed league until it's set,
  // rather than requiring it up front.
  const cfg = await getLeagueSeasonConfig(env, leagueId, season);
  const isFixed = (cfg.teamStructure || 'fixed') === 'fixed';
  let homeTeam = null, awayTeam = null;
  if (isFixed && (body.home_team || body.away_team)) {
    homeTeam = String(body.home_team || '').trim();
    awayTeam = String(body.away_team || '').trim();
    if (!homeTeam || !awayTeam) {
      return { ok: false, error: 'Both home_team and away_team are required to set a matchup.', errorKey: 'MATCHUP_TEAMS_REQUIRED' };
    }
    if (homeTeam === awayTeam) {
      return { ok: false, error: 'home_team and away_team must be different.', errorKey: 'MATCHUP_TEAMS_SAME' };
    }
    const validTeams = getTeamNames(cfg);
    if (!validTeams.includes(homeTeam) || !validTeams.includes(awayTeam)) {
      return { ok: false, error: 'home_team and away_team must be real teams in this season.', errorKey: 'MATCHUP_TEAM_UNKNOWN' };
    }
  }

  // Live-testing task (batch 6), Part 10: per-event opt-out of the
  // automated 72h/24h/12h reminder waves (runLeagueReminders, index.js
  // -- checks this same column before sending). Defaults to armed (1),
  // exactly the behavior every event already had before this column
  // existed -- a caller has to explicitly opt out, never the reverse.
  const autoRemindersEnabled = body.auto_reminders_enabled === false ? 0 : 1;

  // Playoff extension: a playoff placeholder (fixture generator's own
  // playoff proposal, never the single-event/bulk/duplicate routes --
  // none of them ever send these) is created with home_team/away_team
  // left null (seeding can't be resolved at generation time -- no
  // score-entry feature exists in this product) and a structured,
  // language-agnostic playoff_meta blob (migrate-046.sql) instead --
  // the event detail page (Part 1 of the original fixed-teams batch)
  // reads is_playoff to show "awaiting seeding," not a misconfigured
  // regular-season game.
  const isPlayoff = !!body.is_playoff;
  const playoffMeta = body.playoff_meta ? JSON.stringify(body.playoff_meta) : null;

  await env.DB.prepare(
    `INSERT INTO events (id, season, week, date, venue, venue_id, state, start_time, end_time, league_id, auto_reminders_enabled, home_team, away_team, is_playoff, playoff_meta)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(eventId, season, week, date, venue, venueId, startTime || null, endTime || null, leagueId, autoRemindersEnabled, homeTeam, awayTeam, isPlayoff ? 1 : 0, playoffMeta).run();

  if (autoRemindersEnabled) {
    await applyReminderWindowSkipRule(env, leagueId, { id: eventId, start_time: startTime || null });
  }

  return {
    ok: true,
    event: { id: eventId, season, week, date, venue, venue_id: venueId, state: 'open', start_time: startTime || null, end_time: endTime || null, auto_reminders_enabled: !!autoRemindersEnabled, home_team: homeTeam, away_team: awayTeam, is_playoff: isPlayoff, playoff_meta: body.playoff_meta || null }
  };
}

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

  const leagueData = await getLeagueDataJson(env, leagueId);
  const result = await createLeagueEventRow(env, leagueId, body, leagueData);
  if (!result.ok) {
    const status = result.errorKey === 'EVENT_SLOT_EXISTS' ? 409 : 400;
    return Response.json(result, { status });
  }
  return Response.json({ ok: true, league_id: leagueId, event: result.event });
}

function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/* ---------- POST /league/events/bulk (Part 7, live-testing task) ----------
 * Creates a whole season's worth of events at once: a start date plus
 * EITHER an occurrence count OR an end date (occurrences wins if both
 * are given -- documented decision, simpler than reconciling a
 * mismatch between them), reusing the same venue/time/season for every
 * one. Weekly only (every 7 days) -- the task's own scope explicitly
 * calls a more complex recurrence pattern unnecessary ("we play every
 * Sunday at the same venue all season" is the target case). Capped at
 * 52 occurrences (a full year of weekly games) as a sane upper bound
 * against a typo'd occurrence count, not a real product constraint.
 * Each date is created through the exact same createLeagueEventRow
 * used by the single-event route and by duplicate below -- a date that
 * already has an event (e.g. the admin re-runs this after already
 * creating a few by hand) is skipped with a note, not a hard failure
 * of the whole batch, matching Part 6's bulk-import posture.
 */
export async function handleLeagueEventsBulkCreate(req, env) {
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

  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot create events for SMBHL.', errorKey: 'ROUTE_BLOCKED_EVENTS' }, { status: 403 });
  }

  const startDate = String(body.startDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return Response.json({ ok: false, error: 'date is required, in YYYY-MM-DD format.', errorKey: 'DATE_REQUIRED' }, { status: 400 });
  }

  const INTERVAL_DAYS = 7;
  let occurrences = Number(body.occurrences);
  if (!Number.isFinite(occurrences) || occurrences < 1) {
    const endDate = String(body.endDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      const spanMs = Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`);
      occurrences = spanMs >= 0 ? Math.floor(spanMs / (INTERVAL_DAYS * 86400000)) + 1 : 0;
    }
  }
  if (!Number.isFinite(occurrences) || occurrences < 1) {
    return Response.json({ ok: false, error: 'Provide an occurrence count or an end date after the start date.', errorKey: 'BULK_EVENTS_RECURRENCE_REQUIRED' }, { status: 400 });
  }
  occurrences = Math.min(Math.floor(occurrences), 52);

  const leagueData = await getLeagueDataJson(env, leagueId);
  const results = [];
  let date = startDate;
  for (let i = 0; i < occurrences; i++) {
    const created = await createLeagueEventRow(env, leagueId, { date, venue: body.venue, venue_id: body.venue_id, start_time: body.start_time, end_time: body.end_time, season: body.season, auto_reminders_enabled: body.auto_reminders_enabled }, leagueData);
    if (created.ok) {
      results.push({ status: 'created', event: created.event });
    } else {
      results.push({ status: 'skipped', date, reason: created.errorKey === 'EVENT_SLOT_EXISTS' ? 'duplicate_slot' : 'invalid', error: created.error, errorKey: created.errorKey });
    }
    date = addDaysToDateStr(date, INTERVAL_DAYS);
  }

  return Response.json({
    ok: true,
    league_id: leagueId,
    createdCount: results.filter(r => r.status === 'created').length,
    skippedCount: results.filter(r => r.status === 'skipped').length,
    results
  });
}

/* ---------- POST /league/events/duplicate (Part 7, live-testing task) ----------
 * A quicker one-off version of the same underlying capability as bulk
 * create above: copies an existing event's venue/start_time/end_time/
 * season to a new date, through the same createLeagueEventRow path.
 * The source event must belong to this league (never lets one league
 * duplicate another's event by guessing an id).
 */
export async function handleLeagueEventDuplicate(req, env) {
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

  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot create events for SMBHL.', errorKey: 'ROUTE_BLOCKED_EVENTS' }, { status: 403 });
  }

  const sourceEventId = String(body.event_id || '').trim();
  if (!sourceEventId) {
    return Response.json({ ok: false, error: 'event_id is required.', errorKey: 'EVENT_ID_REQUIRED' }, { status: 400 });
  }
  const source = await env.DB.prepare('SELECT * FROM events WHERE id = ? AND league_id = ?').bind(sourceEventId, leagueId).first();
  if (!source) {
    return Response.json({ ok: false, error: 'Event not found.', errorKey: 'EVENT_NOT_FOUND' }, { status: 404 });
  }

  const leagueData = await getLeagueDataJson(env, leagueId);
  const result = await createLeagueEventRow(env, leagueId, {
    date: body.date, venue: source.venue, venue_id: source.venue_id, start_time: source.start_time, end_time: source.end_time, season: source.season,
    auto_reminders_enabled: source.auto_reminders_enabled === 0 ? false : true
  }, leagueData);
  if (!result.ok) {
    const status = result.errorKey === 'EVENT_SLOT_EXISTS' ? 409 : 400;
    return Response.json(result, { status });
  }
  return Response.json({ ok: true, league_id: leagueId, event: result.event });
}

/* ---------- POST /league/events/reminders (Part 10, batch 6, live-testing
 * task) ----------
 * Changes a SINGLE event's own automated-reminder opt-out after the fact
 * -- the event detail page's own toggle (created-with-warning is the
 * OTHER half of this, in createLeagueEventRow above; this is "visible/
 * changeable afterward" from the task's own wording). Session+
 * checkLeagueAccess-gated, SMBHL-blocked, scoped to this league's own
 * event only, same shape as every other single-field update route.
 */
export async function handleLeagueEventUpdateReminders(req, env) {
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

  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot update events for SMBHL.', errorKey: 'ROUTE_BLOCKED_EVENTS' }, { status: 403 });
  }

  const eventId = String(body.event_id || '').trim();
  if (!eventId) {
    return Response.json({ ok: false, error: 'event_id is required.', errorKey: 'EVENT_ID_REQUIRED' }, { status: 400 });
  }
  const existing = await env.DB.prepare('SELECT id FROM events WHERE id = ? AND league_id = ?').bind(eventId, leagueId).first();
  if (!existing) {
    return Response.json({ ok: false, error: 'Event not found.', errorKey: 'EVENT_NOT_FOUND' }, { status: 404 });
  }

  const enabled = body.auto_reminders_enabled !== false;
  await env.DB.prepare('UPDATE events SET auto_reminders_enabled = ? WHERE id = ? AND league_id = ?')
    .bind(enabled ? 1 : 0, eventId, leagueId).run();

  return Response.json({ ok: true, league_id: leagueId, event_id: eventId, auto_reminders_enabled: enabled });
}

/* ---------- C2 (schedule/events polish task): event editing ----------
 * Everything about an existing event EXCEPT its date: start_time,
 * end_time, venue (a saved venue's id, or free text), all reusing the
 * exact same validation/resolution createLeagueEventRow already uses
 * for creation, not a second copy. Deliberately does NOT accept id,
 * date, season, week, or state -- the id encodes the date (league_ids.js),
 * and SMBHL's own existing date-edit path (handleScheduleSave) renames
 * the id when the date changes, which would silently break every
 * already-issued RSVP link (HMAC'd against the old id) for this event.
 * Editable date support is a separate, later task -- see this route's
 * own frontend (handleLeagueEventDetailPage) for the read-only date note.
 */
export async function handleLeagueEventUpdate(req, env) {
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

  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot update events for SMBHL.', errorKey: 'ROUTE_BLOCKED_EVENTS' }, { status: 403 });
  }

  const eventId = String(body.event_id || '').trim();
  if (!eventId) {
    return Response.json({ ok: false, error: 'event_id is required.', errorKey: 'EVENT_ID_REQUIRED' }, { status: 400 });
  }
  const existing = await env.DB.prepare('SELECT * FROM events WHERE id = ? AND league_id = ?').bind(eventId, leagueId).first();
  if (!existing) {
    return Response.json({ ok: false, error: 'Event not found.', errorKey: 'EVENT_NOT_FOUND' }, { status: 404 });
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

  // Same venue_id resolution as createLeagueEventRow: optional, must be
  // one of THIS league's own saved venues, and its name is copied into
  // events.venue as a denormalized snapshot so every existing read site
  // keeps working unchanged. A caller sending only free-text `venue`
  // (no venue_id) clears any previously-saved venue link.
  let venue = String(body.venue || '').trim() || null;
  let venueId = null;
  if (body.venue_id) {
    const venueRow = await env.DB.prepare(
      'SELECT id, name FROM venues WHERE id = ? AND league_id = ?'
    ).bind(String(body.venue_id).trim(), leagueId).first();
    if (!venueRow) {
      return Response.json({ ok: false, error: "venue_id must be one of this league's own saved venues.", errorKey: 'VENUE_UNKNOWN' }, { status: 400 });
    }
    venueId = venueRow.id;
    venue = venueRow.name;
  }

  // Fixed-teams scheduling task (Part 2): the matchup Part 1's "no
  // matchup set" state points at getting fixed. Only touched when the
  // caller actually sends one of these two keys -- omitting both
  // entirely leaves whatever's already stored unchanged, same partial-
  // update posture as every other field on this route. Sending both as
  // blank explicitly CLEARS a matchup (e.g. correcting a mistake) --
  // sending only one of the two is rejected, same "both or neither"
  // rule createLeagueEventRow enforces at creation time.
  let homeTeam = existing.home_team ?? null, awayTeam = existing.away_team ?? null;
  const cfgForStructure = await getLeagueSeasonConfig(env, leagueId, existing.season);
  const isFixedEvent = (cfgForStructure.teamStructure || 'fixed') === 'fixed';
  if (isFixedEvent && (body.home_team !== undefined || body.away_team !== undefined)) {
    const newHome = String(body.home_team || '').trim();
    const newAway = String(body.away_team || '').trim();
    if (!newHome && !newAway) {
      homeTeam = null; awayTeam = null;
    } else if (!newHome || !newAway) {
      return Response.json({ ok: false, error: 'Both home_team and away_team are required to set a matchup.', errorKey: 'MATCHUP_TEAMS_REQUIRED' }, { status: 400 });
    } else if (newHome === newAway) {
      return Response.json({ ok: false, error: 'home_team and away_team must be different.', errorKey: 'MATCHUP_TEAMS_SAME' }, { status: 400 });
    } else {
      const validTeams = getTeamNames(cfgForStructure);
      if (!validTeams.includes(newHome) || !validTeams.includes(newAway)) {
        return Response.json({ ok: false, error: 'home_team and away_team must be real teams in this season.', errorKey: 'MATCHUP_TEAM_UNKNOWN' }, { status: 400 });
      }
      homeTeam = newHome; awayTeam = newAway;
    }
  }

  await env.DB.prepare(
    `UPDATE events SET start_time = ?, end_time = ?, venue = ?, venue_id = ?, home_team = ?, away_team = ? WHERE id = ? AND league_id = ?`
  ).bind(startTime || null, endTime || null, venue, venueId, homeTeam, awayTeam, eventId, leagueId).run();

  // Reminder-safety (see this route's own top comment, and the CAUTION
  // in this task): start_time is one of the two inputs
  // applyReminderWindowSkipRule's hoursUntil math depends on (the other
  // is the event's own id, unchanged by this route). Re-running it here
  // is exactly Rule 2 from the reminder-window-skip-on-create/reschedule
  // fix (commit 6ed0ee8, reminder_scheduling.js's own comment) --
  // re-evaluate every cadence step from scratch against the event's
  // current effective time: newly-passed steps get marked skipped, a
  // stale skip whose window is legitimately back in the future gets
  // cleared, and a step that already genuinely sent is never touched.
  // Only relevant when reminders are armed for this event at all.
  if (existing.auto_reminders_enabled) {
    await applyReminderWindowSkipRule(env, leagueId, { id: eventId, start_time: startTime || null });
  }

  return Response.json({
    ok: true,
    event: { id: eventId, venue, venue_id: venueId, start_time: startTime || null, end_time: endTime || null, home_team: homeTeam, away_team: awayTeam }
  });
}

/* ---------- Reusable venues (Part 9, batch 6, live-testing task) ----------
 * A league defines a venue ONCE (name, optional address, optional map
 * link) in Settings, then selects it at event-creation time instead of
 * retyping the same free-text venue for every game -- createLeagueEventRow
 * above (venue_id resolution) is the write side; getLeagueVenues/
 * getVenueMapLinksById below are the shared read side, used by both
 * Settings (the management list) and the schedule/public/event-detail
 * pages (the select-or-freetext dropdown, and the map-link lookup for
 * events that used it). Deliberately create+list+delete only, no edit
 * route -- a wrong venue is fixed by deleting and re-adding (its name
 * still gets denormalized into any event already created against it, so
 * nothing breaks), a smaller surface than a full edit form for this
 * first version.
 */
async function createLeagueVenueRow(env, leagueId, body) {
  const name = String(body.name || '').trim();
  if (!name) return { ok: false, error: 'name is required.', errorKey: 'VENUE_NAME_REQUIRED' };
  if (name.length > 120) return { ok: false, error: 'Name is too long.', errorKey: 'VENUE_NAME_TOO_LONG' };
  const address = String(body.address || '').trim() || null;
  const mapLink = String(body.map_link || '').trim() || null;
  if (mapLink && !/^https?:\/\//i.test(mapLink)) {
    return { ok: false, error: 'map_link must be a valid http(s) link.', errorKey: 'VENUE_MAP_LINK_INVALID' };
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO venues (id, league_id, name, address, map_link, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, leagueId, name, address, mapLink, new Date().toISOString()).run();
  return { ok: true, venue: { id, name, address, map_link: mapLink } };
}

export async function handleLeagueVenueCreate(req, env) {
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

  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot create venues for SMBHL.', errorKey: 'ROUTE_BLOCKED_VENUES' }, { status: 403 });
  }

  const result = await createLeagueVenueRow(env, leagueId, body);
  if (!result.ok) return Response.json(result, { status: 400 });
  return Response.json({ ok: true, league_id: leagueId, venue: result.venue });
}

export async function handleLeagueVenueDelete(req, env) {
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

  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot delete venues for SMBHL.', errorKey: 'ROUTE_BLOCKED_VENUES' }, { status: 403 });
  }

  const venueId = String(body.id || '').trim();
  if (!venueId) return Response.json({ ok: false, error: 'id is required.', errorKey: 'VENUE_ID_REQUIRED' }, { status: 400 });
  const existing = await env.DB.prepare('SELECT id FROM venues WHERE id = ? AND league_id = ?').bind(venueId, leagueId).first();
  if (!existing) return Response.json({ ok: false, error: 'Venue not found.', errorKey: 'VENUE_NOT_FOUND' }, { status: 404 });

  // Deleting a venue never touches any event that already referenced it
  // -- that event's own events.venue text snapshot (its real source of
  // truth for display, see createLeagueEventRow's own comment) is
  // untouched, and its events.venue_id simply stops resolving to a real
  // row -- the map-link lookup below just won't find one, same as any
  // other free-text event that never had a venue_id to begin with.
  await env.DB.prepare('DELETE FROM venues WHERE id = ? AND league_id = ?').bind(venueId, leagueId).run();
  return Response.json({ ok: true, league_id: leagueId, id: venueId });
}

export async function getLeagueVenues(env, leagueId) {
  return (await env.DB.prepare(
    'SELECT id, name, address, map_link FROM venues WHERE league_id = ? ORDER BY name'
  ).bind(leagueId).all()).results || [];
}

// Batch-resolves a set of events.venue_id values to their venue's
// map_link, one query -- used wherever a page renders several events at
// once (schedule list, public page's upcoming list) so showing a map
// link never costs one query per event. Returns a Map(venue_id ->
// map_link); an id with no row, or a row with no map_link, is simply
// absent from the map (caller falls back to no link, same as any
// free-text event).
export async function getVenueMapLinksById(env, leagueId, venueIds) {
  const ids = [...new Set((venueIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = (await env.DB.prepare(
    `SELECT id, map_link FROM venues WHERE league_id = ? AND id IN (${placeholders})`
  ).bind(leagueId, ...ids).all()).results || [];
  const map = new Map();
  for (const r of rows) if (r.map_link) map.set(r.id, r.map_link);
  return map;
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

  // E3 (season-model polish task): this route used to let ANY
  // season_name become current_season unconditionally -- including an
  // OLD, already-closed season's own name, which would silently
  // REOPEN it (and overwrite its frozen config with whatever this
  // request's body happens to contain). DECIDED: seasons stay
  // sequential, and a closed season is read-only -- the only season
  // this route may ever "edit in place" is the CURRENT one. A brand
  // new name (not in `seasons` at all) still creates a genuinely new
  // season and correctly becomes current, exactly as before. Enforced
  // here, at the route itself, not only by the UI never offering a
  // way to type an old name in (the settings page's own season picker
  // renders read-only precisely because this guard exists server-side
  // too, not only client-side).
  const existingForGuard = await getLeagueDataJson(env, leagueId);
  const targetIsExistingClosedSeason = existingForGuard.current_season
    && seasonName !== existingForGuard.current_season
    && Array.isArray(existingForGuard.seasons) && existingForGuard.seasons.some(s => s && s.name === seasonName);
  if (targetIsExistingClosedSeason) {
    return Response.json({ ok: false, error: 'This season is closed and read-only. Start a new season instead of republishing a closed one.', errorKey: 'SEASON_CLOSED' }, { status: 409 });
  }

  const leagueRow = await env.DB.prepare('SELECT team_names, team_structure, min_players, max_players, min_goalies, max_goalies FROM leagues WHERE id = ?').bind(leagueId).first();
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
  // task).
  //
  // Live-testing task (settings page, Part 1) fix: config.teamStructure
  // used to only be written when THIS request explicitly overrode it,
  // which meant a plain publish left it unset -- and getSeasonConfig's
  // own resolution (withLeagueBrandingDefault, season_config.js) then
  // fell through to the league's CURRENT leagues.team_structure at every
  // read, not the value that was actually true when this season was
  // published. That was a real, dormant retroactive-alteration bug:
  // once the new settings page made leagues.team_structure editable
  // after the fact, an unrelated later edit to the league's default
  // would silently reach back and change how an already-published
  // season resolves. Now config.teamStructure is ALWAYS set below to
  // this season's real effective value (whatever it resolves to right
  // now, override or inherited) -- a true snapshot at publish time, so
  // no future league-level change can ever retroactively alter it
  // again. This changes stored shape going forward only; it does not
  // rewrite any season already published before this fix (see
  // handleLeagueUpdateStructure's own backfill for those).
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

  // Reused from the SEASON_CLOSED guard above -- avoids a second KV
  // read of the same data_json blob for this one request.
  const existing = existingForGuard;
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
    // Live-testing task, Part 5: max_goalies, same "body override, else
    // the league's own stored value" pattern as min_goalies just above.
    // Left unset (falls through to season_config.js's own
    // maxGoalies-defaults-to-goaliesPerTeam resolution) when neither is
    // a real number -- so a headcount league that has never set a
    // distinct max keeps min===max, unchanged from before this task.
    const maxG = body.max_goalies !== undefined ? Number(body.max_goalies) : (leagueRow && leagueRow.max_goalies);
    if (Number.isFinite(maxG) && maxG >= 0) {
      config.maxGoalies = maxG;
    }
  }

  // Live-testing task, Part 5: 'fixed' and 'weekly_draw' roster limits.
  // Unlike headcount's block above, this is entirely OPTIONAL -- when
  // neither this request nor the league's own row has a real value,
  // config simply doesn't set these fields, so normalizeSeasonConfig's
  // own DEFAULT_SEASON_CONFIG numbers (8 skaters/5 min skaters/1 goalie)
  // apply exactly as they silently have for every fixed/weekly_draw
  // league before this task. That's what makes the safety guarantee
  // true here: no existing league's effective numbers change unless its
  // admin explicitly sets a real value via the settings page.
  //
  // Shape, per the task's own explicit requirement: 'fixed' numbers are
  // already real PER-TEAM values -- teamState/expected/openSpots already
  // call this engine once per real named team for fixed leagues, so
  // these are used directly, no translation needed. 'weekly_draw' is
  // collected as a PER-EVENT POOL total instead (the admin sets "how
  // many total for the whole game", not per-team) -- but shortage
  // detection itself still runs per REAL ASSIGNED team once this
  // event's draw has happened (unchanged machinery), so the pool total
  // is divided down to a per-team equivalent here. ceil() for minimums
  // (every team must individually clear its own floor, so the real
  // total actually reached across all teams is always >= the admin's
  // stated pool minimum, never less -- erring toward calling a sub
  // rather than silently under-covering) and floor() for maximums (so
  // teams' combined maximums never exceed the admin's stated pool cap).
  if (effectiveStructure === 'fixed' || effectiveStructure === 'weekly_draw') {
    const numTeams = effectiveStructure === 'weekly_draw' ? Math.max(1, seasonTeamNames.length) : 1;
    const toPerTeam = (poolVal, roundUp) => (numTeams <= 1
      ? poolVal
      : (roundUp ? Math.ceil(poolVal / numTeams) : Math.floor(poolVal / numTeams)));

    const minP = body.min_players !== undefined ? Number(body.min_players) : (leagueRow && leagueRow.min_players);
    const maxP = body.max_players !== undefined ? Number(body.max_players) : (leagueRow && leagueRow.max_players);
    if (Number.isFinite(minP) && Number.isFinite(maxP) && minP >= 1 && maxP >= minP) {
      config.minSkaters = toPerTeam(minP, true);
      config.skatersPerTeam = toPerTeam(maxP, false);
    }

    // leagueRow.min_goalies is only trusted as a fallback once this
    // league's row ALREADY has real, stored min/max-player limits
    // (priorPlayerLimitsExist -- note: the STORED row, not just this
    // request's resolved minP/maxP above, which could be the very
    // first time this league ever sets them). leagues.min_goalies
    // defaults to 0 for EVERY league regardless of structure
    // (handleLeagueCreate), and that 0 is only a real, intentional
    // choice once handleLeagueUpdateStructure's own fixed/weekly_draw
    // block has explicitly stamped it -- which it always does, exactly
    // once, the first time it writes real min/max-player limits (see
    // that function's own comment). Before that has ever happened, a
    // stored min_goalies=0 is just the column's inert creation-time
    // default, not a real "no goalie requirement" decision -- trusting
    // it here would silently flip such a league's goalie requirement
    // from DEFAULT_SEASON_CONFIG's 1 to 0 the moment it republishes for
    // any unrelated reason, with nothing in this request ever having
    // asked for that.
    const priorPlayerLimitsExist = !!(leagueRow && leagueRow.min_players != null && leagueRow.max_players != null);
    const minG = body.min_goalies !== undefined ? Number(body.min_goalies)
      : (priorPlayerLimitsExist ? leagueRow.min_goalies : undefined);
    if (Number.isFinite(minG) && minG >= 0) {
      config.goaliesPerTeam = toPerTeam(minG, true);
      const maxG = body.max_goalies !== undefined ? Number(body.max_goalies)
        : (priorPlayerLimitsExist && leagueRow.max_goalies != null ? leagueRow.max_goalies : undefined);
      if (Number.isFinite(maxG) && maxG >= minG) {
        config.maxGoalies = toPerTeam(maxG, false);
      }
    }
  }

  config.teamStructure = effectiveStructure;

  // E1 (season-model polish task): "Enregistrer la saison" (the
  // Settings "Cette saison" card) is now a genuine rename-in-place,
  // not indistinguishable from creating a new season -- before this,
  // ANY name change here (even just fixing a typo) silently created a
  // SEPARATE new entry (unshift below) and abandoned the old one under
  // its stale name, still sitting in `seasons`, no longer current --
  // the exact "ambiguous, easy to do by accident" behaviour this task
  // was asked to fix. body.rename_current (sent only by that one
  // button, never by "Démarrer une nouvelle saison") means: keep this
  // season's own real standings/games, just give the SAME entry a new
  // name (and, as before, still update its config from this request).
  // Genuinely creating a new season (rename_current absent/false) is
  // completely unaffected -- still a fresh entry, standings/games
  // reset to zero, exactly as before this task.
  const renameCurrent = !!body.rename_current && existing.current_season && seasonName !== existing.current_season;
  let overwritten;
  if (renameCurrent) {
    const currentIdx = seasons.findIndex(s => s && s.name === existing.current_season);
    if (currentIdx < 0) {
      return Response.json({ ok: false, error: 'Current season not found to rename.', errorKey: 'SEASON_NOT_FOUND' }, { status: 404 });
    }
    seasons[currentIdx] = { ...seasons[currentIdx], name: seasonName, config };
    overwritten = true;
    // Every event already stamped with the OLD season name must follow
    // the rename -- otherwise they'd silently stop resolving against
    // this (renamed) season's own config (getLeagueSeasonConfig looks
    // events up by their own ev.season string), the exact kind of
    // "everywhere except the schedule rows" mismatch E4 fixed the
    // other direction of.
    await env.DB.prepare('UPDATE events SET season = ? WHERE league_id = ? AND season = ?')
      .bind(seasonName, leagueId, existing.current_season).run();
  } else {
    const newSeasonEntry = {
      name: seasonName,
      config,
      standings: seasonTeamNames.map(team => ({ team, gp: 0, w: 0, l: 0, t: 0, pts: 0, gf: 0, ga: 0 })),
      games: 0
    };
    const idx = seasons.findIndex(s => s && s.name === seasonName);
    overwritten = idx >= 0;
    if (overwritten) {
      seasons[idx] = newSeasonEntry;
    } else {
      seasons.unshift(newSeasonEntry);
    }
  }

  const updated = {
    current_season: seasonName,
    seasons,
    players: Array.isArray(existing.players) ? existing.players : []
  };

  await putLeagueDataJson(env, leagueId, updated);

  return Response.json({ ok: true, league_id: leagueId, current_season: seasonName, teams: seasonTeamNames, team_structure: effectiveStructure, overwritten });
}

/* ---------- POST /league/season/move-events (E2, season-model polish
 * task) ----------
 * Part of the rollover confirmation flow: when a closing season still
 * has upcoming, unplayed events, the admin can move them to the new
 * season instead of leaving them stranded on a now-read-only season
 * (which the dashboard, built around "the current season," has no way
 * to manage). Moving an event is just re-pointing its own `season`
 * column -- RSVPs (rsvp.event_id), reminder logs
 * (league_reminder_log, PK (event_id, kind)), team-assigned-email logs
 * and the outbox are ALL keyed by event_id, never by season, so
 * nothing is orphaned or needs its own update; this is genuinely safe
 * by construction, not something this route has to work to preserve.
 * `week` is recomputed (same "count already in the target season + 1"
 * logic createLeagueEventRow itself uses) since the old season's week
 * numbering means nothing in the new season's own sequence.
 *
 * Moves every upcoming (date >= today), non-cancelled event still on
 * `from_season` -- the task's own UI is a single yes/no checkbox
 * ("move them?"), not a per-event picker, so this matches that
 * one all-or-nothing action rather than accepting an event_id list
 * the UI never actually offers.
 */
export async function handleLeagueSeasonMoveEvents(req, env) {
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
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot move events for SMBHL.', errorKey: 'ROUTE_BLOCKED_EVENTS' }, { status: 403 });
  }

  const fromSeason = String(body.from_season || '').trim();
  const toSeason = String(body.to_season || '').trim();
  if (!fromSeason || !toSeason) {
    return Response.json({ ok: false, error: 'from_season and to_season are required.', errorKey: 'SEASON_NAME_REQUIRED' }, { status: 400 });
  }
  if (fromSeason === toSeason) {
    return Response.json({ ok: false, error: 'from_season and to_season must be different.', errorKey: 'SEASON_MOVE_SAME' }, { status: 400 });
  }

  // to_season must be the league's own CURRENT season -- this route
  // exists to support the rollover flow (move a closing season's
  // future events onto the new current one), not a general-purpose
  // season reassignment tool. Same read-only-history posture as the
  // SEASON_CLOSED guard in handleLeagueSeasonPublish above: an event
  // can be moved ONTO the current season, never onto (or off of, via
  // some other target) a closed one.
  const leagueData = await getLeagueDataJson(env, leagueId);
  if (leagueData.current_season !== toSeason) {
    return Response.json({ ok: false, error: 'to_season must be this league\'s current season.', errorKey: 'SEASON_MOVE_TARGET_NOT_CURRENT' }, { status: 409 });
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const rows = (await env.DB.prepare(
    `SELECT id FROM events WHERE league_id = ? AND season = ? AND date >= ? AND state != 'cancelled'`
  ).bind(leagueId, fromSeason, todayStr).all()).results || [];

  const countRow = await env.DB.prepare(
    'SELECT COUNT(*) c FROM events WHERE league_id = ? AND season = ?'
  ).bind(leagueId, toSeason).first();
  let nextWeek = (countRow?.c || 0) + 1;

  let moved = 0;
  for (const r of rows) {
    await env.DB.prepare('UPDATE events SET season = ?, week = ? WHERE id = ? AND league_id = ?')
      .bind(toSeason, nextWeek, r.id, leagueId).run();
    nextWeek++;
    moved++;
  }

  return Response.json({ ok: true, league_id: leagueId, from_season: fromSeason, to_season: toSeason, moved });
}

/* ---------- fixture generator (Part 3, fixed-teams scheduling task) ----------
 * A real schedule generator for a 'fixed' league -- distinct from
 * /league/events/bulk (a pure date-repeater, no matchups) -- built on
 * generateRoundRobinRounds (season_config.js, shared with SMBHL's own
 * season_hub.js, never a second copy of the pairing math).
 *
 * DECIDED (task spec): a PROPOSAL the admin reviews and approves,
 * never writing events directly -- same posture as SMBHL's own
 * season_hub.js preview-then-launch flow (handleSeasonGenerateSchedule
 * / handleSeasonLaunch). buildFixtureProposal is the single source of
 * truth both routes below call -- preview and approve are always
 * byte-identical for the same input, and approve NEVER trusts a
 * client-echoed fixture list back (a tampering vector -- this
 * regenerates server-side from the same real season team list instead).
 *
 * The admin form only collects ONE time and ONE venue (a real
 * simplification: this does not ask for a second venue for the case
 * where a round has more than one simultaneous game -- N=4 or 5 teams,
 * 2 games per round). DECIDED here: those extra simultaneous games in
 * the same round stay on the same date and venue, staggered by ONE
 * HOUR increments from the configured time -- avoids a real
 * date+venue+time collision (Part 2's own slot-conflict rule) without
 * requiring the admin to configure multiple venues up front. A league
 * that genuinely plays parallel games in different gyms already has
 * that covered manually (the schedule page's own create form, Part 2)
 * -- this generator's job is to get a season on the board fast, not to
 * replace manual editing.
 *
 * `rounds` can exceed one full round-robin cycle (e.g. a 4-team league
 * wants a 6-round season, longer than that cycle's own 3 rounds) --
 * the cycle simply repeats (wraps via modulo), not a "true" double
 * round-robin with a deliberate home/away swap on the second pass.
 * Simpler, and still a genuinely balanced schedule when `rounds` is a
 * multiple of the cycle length.
 */
/* ---------- playoffs (Part of the fixed-teams playoff extension) ----------
 * Extends the fixture generator above with playoffs, reusing its own
 * buildFixtureProposal/generateRoundRobinRounds for the regular season
 * -- no second copy of the pairing math. THE MODEL (task spec): a
 * league has a FIXED NUMBER OF SLOTS (gym time already paid for).
 * Playoffs consume some of those slots; the regular season is whatever
 * remains. Fixed-teams only -- weekly_draw/headcount never see any of
 * this (checked the same way the fixture generator itself already is,
 * resolveFixtureLeagueTeams).
 *
 * computePlayoffSlots is the single source of truth for the arithmetic
 * -- exactly what the preview response's own "arithmetic" block shows
 * the admin, and exactly what buildPlayoffPlaceholders below generates
 * placeholders for. They can never disagree.
 *
 * Formula:
 *   single_elimination: (numTeams - 1) + thirdPlace(1) + bye(1 if odd)
 *   best_of_n:          ((numTeams - 1) + thirdPlace(1)) * seriesLength + bye(1 if odd)
 *   reserved_slots:     reservedSlots (the admin's own direct number)
 * The bye slot is a flat +1, never multiplied by seriesLength -- it
 * isn't a real game/series, just a reserved scheduling buffer for the
 * round an odd team count leaves one team sitting out (DECIDED here,
 * flagged in the final report: a fully "correct" bracket needs no
 * extra slot for a bye at all -- each real game still eliminates
 * exactly one team, N-1 total, bye or not -- but the task's own
 * example counts it as consuming one anyway, so this reserves an
 * honestly-labelled buffer slot for it rather than silently absorbing
 * it into the real bracket math). A third-place game needs two real
 * semifinal LOSERS to exist, so it's only ever added for numTeams >= 4
 * -- structurally meaningless below that (see buildPlayoffPlaceholders'
 * own matching guard, which must never disagree with this count).
 */
export function computePlayoffSlots({ format, numTeams, thirdPlace, bestOf, reservedSlots }) {
  if (format === 'reserved_slots') {
    const slots = Math.max(0, Math.floor(reservedSlots || 0));
    return { playoffSlots: slots, hasBye: false, breakdown: { format, reservedSlots: slots } };
  }
  const baseMatches = Math.max(0, numTeams - 1);
  const hasBye = numTeams % 2 === 1 && numTeams > 1;
  const thirdPlaceMatches = (thirdPlace && numTeams >= 4) ? 1 : 0;
  const seriesLength = format === 'best_of_n' ? Math.max(1, Math.floor(bestOf || 1)) : 1;
  const gameSlots = (baseMatches + thirdPlaceMatches) * seriesLength;
  const byeSlots = hasBye ? 1 : 0;
  return {
    playoffSlots: gameSlots + byeSlots,
    hasBye,
    breakdown: { format, numTeams, baseMatches, thirdPlaceMatches, seriesLength, gameSlots, byeSlots }
  };
}

// Standard bracket-seeding: pads to the next power of two (B) and
// places byes using the real, recursive "mirror" order every seeded
// tournament bracket uses (B=4: 1,4,2,3; B=8: 1,8,4,5,2,7,3,6 --
// matches the task's own worked example, "Semi-final 1 -- seed 1 vs
// seed 4," exactly), so every bye lands in ROUND 1 only, spread across
// different first-round matchups rather than several. This matters:
// an earlier, simpler version paired seeds sequentially and re-halved
// the survivors every round, which could leave a bye stranded in a
// LATER round too (5 teams: round 1 has one bye, but then round 2's
// own 3 survivors needed a second bye) -- that made the "semifinal"
// round have only one real matchup instead of two, so a third-place
// game (which needs two real semifinal LOSERS) could never be built
// for 5 teams even though it obviously should be. Padding to a clean
// power of two up front means every round from the second one on has
// an exact power-of-two participant count -- no further byes, ever.
// Total real games is still always numTeams-1 regardless (byes are
// free, mathematically) -- computePlayoffSlots' own separate "+1 flat
// bye slot" is an intentionally different, simplified thing (a
// reserved scheduling buffer, per the task's own instruction), not a
// second copy of this cost.
export function buildEliminationBracket(numTeams) {
  let bracketSize = 1;
  while (bracketSize < numTeams) bracketSize *= 2;
  let order = [1];
  while (order.length < bracketSize) {
    const mirror = order.length * 2 + 1;
    const next = [];
    for (const seed of order) next.push(seed, mirror - seed);
    order = next;
  }

  const rounds = [];
  let participants = order;
  while (participants.length > 1) {
    const matchups = [];
    const nextParticipants = [];
    for (let i = 0; i < participants.length; i += 2) {
      const a = participants[i], b = participants[i + 1];
      const aReal = a <= numTeams, bReal = b <= numTeams;
      if (aReal && bReal) {
        matchups.push({ seedA: a, seedB: b });
        nextParticipants.push(a); // placeholder advance -- no real result exists yet
      } else if (aReal) {
        nextParticipants.push(a); // b is a bye
      } else if (bReal) {
        nextParticipants.push(b); // a is a bye
      }
    }
    if (matchups.length) rounds.push(matchups);
    participants = nextParticipants;
  }
  return rounds;
}

// Part 5 (stats tracking task): buildEliminationBracket's own `rounds`
// says WHERE each matchup is (seedA/seedB) but not where its WINNER
// goes next -- the seeding resolver below needs that to fill in later
// rounds. Walks the exact same recursive structure a second time,
// this time tracking each matchup's advancesToRound/
// advancesToMatchupIndexInRound/advancesToSide ('A' or 'B', i.e.
// which of the next round's two slots the winner lands in), plus a
// separate `byes` list for a seed that skips round 1 entirely (advances
// with no game at all -- buildEliminationBracket's own comment notes
// byes only ever happen in round 1, since every round after the first
// has an exact power-of-two participant count). Must never disagree
// with buildEliminationBracket's own seedA/seedB output for the same
// numTeams -- locked by a test that diffs the two.
export function buildBracketAdvancement(numTeams) {
  let bracketSize = 1;
  while (bracketSize < numTeams) bracketSize *= 2;
  let order = [1];
  while (order.length < bracketSize) {
    const mirror = order.length * 2 + 1;
    const next = [];
    for (const seed of order) next.push(seed, mirror - seed);
    order = next;
  }

  const rounds = [];
  const byes = [];
  let participants = order;
  let roundIndex = 0;
  while (participants.length > 1) {
    const matchups = [];
    const nextParticipants = [];
    let realMatchupCount = 0;
    for (let i = 0, loopIdx = 0; i < participants.length; i += 2, loopIdx++) {
      const a = participants[i], b = participants[i + 1];
      const aReal = a <= numTeams, bReal = b <= numTeams;
      const advancesToMatchupIndexInRound = Math.floor(loopIdx / 2) + 1;
      const advancesToSide = loopIdx % 2 === 0 ? 'A' : 'B';
      if (aReal && bReal) {
        realMatchupCount++;
        matchups.push({
          matchupIndexInRound: realMatchupCount, seedA: a, seedB: b,
          advancesToRound: roundIndex + 1, advancesToMatchupIndexInRound, advancesToSide
        });
        nextParticipants.push(a);
      } else if (aReal) {
        byes.push({ seed: a, advancesToRound: roundIndex + 1, advancesToMatchupIndexInRound, advancesToSide });
        nextParticipants.push(a);
      } else if (bReal) {
        byes.push({ seed: b, advancesToRound: roundIndex + 1, advancesToMatchupIndexInRound, advancesToSide });
        nextParticipants.push(b);
      }
    }
    if (matchups.length) { rounds.push(matchups); roundIndex++; }
    participants = nextParticipants;
  }
  // The final round's own winner is the champion -- nowhere further to
  // advance to.
  if (rounds.length) {
    for (const m of rounds[rounds.length - 1]) {
      m.advancesToRound = null; m.advancesToMatchupIndexInRound = null; m.advancesToSide = null;
    }
  }
  return { rounds, byes };
}

// Ordered list of DATE GROUPS of playoff slot descriptors (each group
// shares one calendar date, same "one date, possibly several games"
// shape buildRegularSeasonForSlots' own rounds use) -- flattening every
// group gives exactly computePlayoffSlots({...}).playoffSlots
// descriptors, always (the arithmetic and the generated placeholders
// can never disagree, since nothing else computes this count
// independently). Each descriptor is language-agnostic (see
// playoffRoleLabel for the bilingual text) --
// role/matchupIndexInRound/seedA/seedB/gameNumber/seriesLength, stored
// verbatim into events.playoff_meta as JSON.
//
// Grouping: a single-elimination bracket round's real matchups (and a
// reserved-slots batch) genuinely happen the same day in practice, so
// they're grouped onto one date, exactly like the regular season's own
// simultaneous-game handling. A best-of-N SERIES cannot: game 2 of a
// series is played on a LATER date than game 1 by definition, so
// best-of-N flattens to one placeholder per date instead -- grouping
// same-round DIFFERENT series onto one date while also spanning each
// series across dates is real bracket-scheduling complexity this
// generator's job (get a season on the board fast) doesn't need to
// solve; flagged in the final report as a known simplification.
export function buildPlayoffPlaceholders({ format, numTeams, thirdPlace, bestOf, reservedSlots }) {
  if (format === 'reserved_slots') {
    const slots = Math.max(0, Math.floor(reservedSlots || 0));
    return Array.from({ length: slots }, (_, i) => [{
      role: 'reserved', matchupIndexInRound: i + 1, seedA: null, seedB: null, gameNumber: null, seriesLength: 1
    }]);
  }
  const seriesLength = format === 'best_of_n' ? Math.max(1, Math.floor(bestOf || 1)) : 1;
  const bracketRounds = buildEliminationBracket(numTeams);
  const hasBye = numTeams % 2 === 1 && numTeams > 1;
  const groups = [];
  if (hasBye) {
    groups.push([{ role: 'bye', matchupIndexInRound: 1, seedA: null, seedB: null, gameNumber: null, seriesLength: 1 }]);
  }
  bracketRounds.forEach((round, roundIndex) => {
    const roundsFromFinal = bracketRounds.length - 1 - roundIndex;
    const role = roundsFromFinal === 0 ? 'final' : roundsFromFinal === 1 ? 'semifinal' : roundsFromFinal === 2 ? 'quarterfinal' : 'bracket';
    const roundPlaceholders = [];
    round.forEach((m, mIdx) => {
      for (let g = 1; g <= seriesLength; g++) {
        roundPlaceholders.push({ role, matchupIndexInRound: mIdx + 1, seedA: m.seedA, seedB: m.seedB, gameNumber: seriesLength > 1 ? g : null, seriesLength });
      }
    });
    if (seriesLength > 1) {
      // Flatten -- each game of each series gets its own date.
      roundPlaceholders.forEach(p => groups.push([p]));
    } else {
      groups.push(roundPlaceholders);
    }
    // Third-place: needs two real semifinal LOSERS to exist, i.e. a
    // semifinal round with >=2 real matchups -- same numTeams >= 4
    // guard as computePlayoffSlots' own thirdPlaceMatches, so the two
    // never disagree on whether this slot exists at all.
    if (roundsFromFinal === 1 && round.length >= 2 && thirdPlace) {
      const tp = [];
      for (let g = 1; g <= seriesLength; g++) tp.push({ role: 'third_place', matchupIndexInRound: 1, seedA: null, seedB: null, gameNumber: seriesLength > 1 ? g : null, seriesLength });
      if (seriesLength > 1) tp.forEach(p => groups.push([p]));
      else groups.push(tp);
    }
  });
  return groups;
}

// Bilingual, derived at render time from the language-agnostic
// descriptor above -- never baked into storage (this codebase's own
// established i18n convention). Matches the task's own examples
// exactly: "Semi-final 1 -- seed 1 vs seed 4", "Final", "Third-place
// game", "Playoff game 1" (reserved).
export function playoffRoleLabel(meta, lang) {
  const en = lang === 'en';
  const vsWord = en ? 'vs' : 'contre';
  const seed = n => en ? `seed ${n}` : `tête de série ${n}`;
  let base;
  if (meta.role === 'final') base = en ? 'Final' : 'Finale';
  else if (meta.role === 'third_place') base = en ? 'Third-place game' : 'Match pour la 3e place';
  else if (meta.role === 'semifinal') base = (en ? 'Semi-final ' : 'Demi-finale ') + meta.matchupIndexInRound;
  else if (meta.role === 'quarterfinal') base = (en ? 'Quarterfinal ' : 'Quart de finale ') + meta.matchupIndexInRound;
  else if (meta.role === 'bracket') base = (en ? 'Playoff round 1, game ' : 'Ronde 1 des séries, match ') + meta.matchupIndexInRound;
  else if (meta.role === 'bye') base = en ? 'Playoff bye round (reserved slot)' : 'Ronde de repos des séries (créneau réservé)';
  else if (meta.role === 'reserved') base = (en ? 'Playoff game ' : 'Match de séries ') + meta.matchupIndexInRound;
  else base = en ? 'Playoff game' : 'Match de séries';
  if (meta.seedA && meta.seedB) base += ` -- ${seed(meta.seedA)} ${vsWord} ${seed(meta.seedB)}`;
  if (meta.gameNumber && meta.seriesLength > 1) base += ` (${en ? `Game ${meta.gameNumber} of ${meta.seriesLength}` : `Match ${meta.gameNumber} de ${meta.seriesLength}`})`;
  return base;
}

// Hour-stagger for N simultaneous games on the same date/venue --
// shared by the regular season and playoff builders below (same
// Part-2 slot-conflict-avoidance decision either way).
function staggeredTime(time, gameIndex) {
  if (!time) return null;
  const [hh, mm] = time.split(':').map(Number);
  const staggeredHour = (hh + gameIndex) % 24;
  return `${String(staggeredHour).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// THE MODEL (task spec): a league has a FIXED NUMBER OF SLOTS (gym
// time already paid for) -- this fills exactly `slotBudget` regular-
// season GAMES (not dates/rounds) from generateRoundRobinRounds'
// endlessly-repeating pairing cycle, rather than asking for a round
// count. DECIDED: when the budget runs out partway through a date's
// own pairing list, PLAY that partial date rather than leaving paid-
// for slots empty -- an unused gym slot is money already spent. Each
// returned round is flagged isPartial so the proposal can show the
// admin exactly which fixtures made the cut, not just a game count.
function buildRegularSeasonForSlots({ teams, slotBudget, startDate, intervalDays, time, venue }) {
  const cycle = generateRoundRobinRounds(teams);
  const rounds = [];
  let remaining = Math.max(0, slotBudget);
  let dateIndex = 0;
  while (remaining > 0 && cycle.length && cycle[dateIndex % cycle.length].length > 0) {
    const pairings = cycle[dateIndex % cycle.length];
    const takeCount = Math.min(pairings.length, remaining);
    const isPartial = takeCount < pairings.length;
    const date = addDaysToDateStr(startDate, dateIndex * intervalDays);
    const games = pairings.slice(0, takeCount).map((p, gameIndex) => ({
      home: p.home, away: p.away, date, start_time: staggeredTime(time, gameIndex), venue: venue || null
    }));
    rounds.push({ round: dateIndex + 1, date, games, isPartial });
    remaining -= takeCount;
    dateIndex++;
  }
  return { rounds, nextDateIndex: dateIndex, slotsUsed: slotBudget - remaining };
}

// Playoff groups (buildPlayoffPlaceholders) onto real dates, continuing
// the SAME date sequence the regular season left off at (startDateIndex
// -- so playoffs are scheduled right after the last regular-season
// slot, never overlapping it).
function scheduleFixtureGroups(groups, { startDate, startDateIndex, intervalDays, time, venue }) {
  return groups.map((placeholders, i) => {
    const dateIndex = startDateIndex + i;
    const date = addDaysToDateStr(startDate, dateIndex * intervalDays);
    return {
      round: dateIndex + 1, date,
      games: placeholders.map((meta, gameIndex) => ({ meta, date, start_time: staggeredTime(time, gameIndex), venue: venue || null }))
    };
  });
}

function validateFixtureInput(env, body) {
  const totalSlots = Number(body.total_slots);
  if (!Number.isFinite(totalSlots) || totalSlots < 1) {
    return { error: { ok: false, error: 'total_slots (how much gym time you have) must be at least 1.', errorKey: 'FIXTURE_TOTAL_SLOTS_REQUIRED' } };
  }
  const startDate = String(body.start_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return { error: { ok: false, error: 'start_date is required, in YYYY-MM-DD format.', errorKey: 'DATE_REQUIRED' } };
  }
  let intervalDays = Number(body.interval_days);
  if (!Number.isFinite(intervalDays) || intervalDays < 1) intervalDays = 7;
  const time = String(body.time || '').trim();
  if (time && !/^\d{2}:\d{2}$/.test(time)) {
    return { error: { ok: false, error: 'time must be in HH:MM format.', errorKey: 'START_TIME_FORMAT' } };
  }
  const venue = String(body.venue || '').trim() || null;
  return { value: { totalSlots: Math.min(Math.floor(totalSlots), 500), startDate, intervalDays: Math.floor(intervalDays), time: time || null, venue } };
}

// The league's own stored playoff preferences (asked once at
// onboarding, editable later in Settings -- migrate-046.sql). Returns
// a computePlayoffSlots-shaped input, or null when playoffs are off
// (every slot goes to the regular season, exactly the pre-playoffs
// behaviour).
function resolveLeaguePlayoffConfig(leagueRow) {
  if (!leagueRow.playoffs_enabled) return null;
  return {
    format: leagueRow.playoff_format, numTeams: leagueRow.playoff_teams,
    thirdPlace: !!leagueRow.playoff_third_place, bestOf: leagueRow.playoff_best_of,
    reservedSlots: leagueRow.playoff_reserved_slots
  };
}

// Shared by both routes below: confirms this is a real, currently-
// published 'fixed' season with at least 2 real teams -- the fixture
// generator is meaningless for weekly_draw (teams are drawn per event,
// not fixed) and headcount (no team concept at all), so both are
// rejected here rather than silently producing nonsense pairings.
async function resolveFixtureLeagueTeams(env, leagueId) {
  const leagueData = await getLeagueDataJson(env, leagueId);
  if (!leagueData.current_season) {
    return { error: { ok: false, error: 'Publish a season before generating a schedule.', errorKey: 'SEASON_REQUIRED' } };
  }
  const cfg = await getLeagueSeasonConfig(env, leagueId, leagueData.current_season);
  if ((cfg.teamStructure || 'fixed') !== 'fixed') {
    return { error: { ok: false, error: 'The fixture generator is only offered for fixed-teams leagues.', errorKey: 'FIXTURE_REQUIRES_FIXED_TEAMS' } };
  }
  const teams = getTeamNames(cfg);
  if (teams.length < 2) {
    return { error: { ok: false, error: 'This league needs at least 2 teams to generate a schedule.', errorKey: 'FIXTURE_NEEDS_TWO_TEAMS' } };
  }
  const leagueRow = await env.DB.prepare(
    'SELECT playoffs_enabled, playoff_format, playoff_teams, playoff_best_of, playoff_third_place, playoff_reserved_slots FROM leagues WHERE id = ?'
  ).bind(leagueId).first();
  return { value: { season: leagueData.current_season, teams, playoffConfig: resolveLeaguePlayoffConfig(leagueRow || {}) } };
}

// Shared by preview and approve: THE MODEL (task spec) -- total slots
// (gym time already paid for) minus whatever playoffs consume (0 when
// this league has none configured) leaves the regular season's own
// budget. Computes and returns BOTH the arithmetic (for display) and
// the actual dated proposal (regular season + playoffs, playoffs
// scheduled right after the regular season's own last date) -- preview
// and approve call this SAME function, so they can never disagree.
function buildFixtureAndPlayoffProposal({ teams, playoffConfig, totalSlots, startDate, intervalDays, time, venue }) {
  const playoff = playoffConfig ? computePlayoffSlots({ ...playoffConfig, numTeams: playoffConfig.numTeams || teams.length }) : null;
  const playoffSlots = playoff ? playoff.playoffSlots : 0;
  const regularSeasonSlots = totalSlots - playoffSlots;
  if (regularSeasonSlots < 0) {
    return { error: { ok: false, error: `This league's playoffs alone need ${playoffSlots} slots -- total_slots must be at least that many.`, errorKey: 'FIXTURE_TOTAL_SLOTS_TOO_LOW' } };
  }

  const regular = buildRegularSeasonForSlots({ teams, slotBudget: regularSeasonSlots, startDate, intervalDays, time, venue });
  const playoffGroups = playoffConfig ? buildPlayoffPlaceholders({ ...playoffConfig, numTeams: playoffConfig.numTeams || teams.length }) : [];
  const playoffRounds = scheduleFixtureGroups(playoffGroups, { startDate, startDateIndex: regular.nextDateIndex, intervalDays, time, venue });

  return {
    value: {
      arithmetic: {
        totalSlots, playoffSlots, regularSeasonSlots,
        regularSeasonSlotsUsed: regular.slotsUsed, regularSeasonSlotsUnused: regularSeasonSlots - regular.slotsUsed,
        playoffBreakdown: playoff ? playoff.breakdown : null
      },
      regularSeason: regular.rounds,
      playoffs: playoffRounds
    }
  };
}

export async function handleLeagueFixturePreview(req, env) {
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
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot generate a schedule for SMBHL.', errorKey: 'ROUTE_BLOCKED_EVENTS' }, { status: 403 });
  }

  const teamsResult = await resolveFixtureLeagueTeams(env, leagueId);
  if (teamsResult.error) return Response.json(teamsResult.error, { status: 409 });
  const inputResult = validateFixtureInput(env, body);
  if (inputResult.error) return Response.json(inputResult.error, { status: 400 });

  const { teams, playoffConfig } = teamsResult.value;
  const proposal = buildFixtureAndPlayoffProposal({ teams, playoffConfig, ...inputResult.value });
  if (proposal.error) return Response.json(proposal.error, { status: 409 });
  return Response.json({ ok: true, league_id: leagueId, teams, ...proposal.value });
}

export async function handleLeagueFixtureApprove(req, env) {
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
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot generate a schedule for SMBHL.', errorKey: 'ROUTE_BLOCKED_EVENTS' }, { status: 403 });
  }

  const teamsResult = await resolveFixtureLeagueTeams(env, leagueId);
  if (teamsResult.error) return Response.json(teamsResult.error, { status: 409 });
  const inputResult = validateFixtureInput(env, body);
  if (inputResult.error) return Response.json(inputResult.error, { status: 400 });

  // Never trusts a client-supplied fixture list -- regenerated here,
  // server-side, from the same real season team list AND the same
  // league-stored playoff config the preview route itself used. A
  // client can only ever approve exactly what preview would have
  // shown it, never something it fabricated.
  const { season, teams, playoffConfig } = teamsResult.value;
  const proposal = buildFixtureAndPlayoffProposal({ teams, playoffConfig, ...inputResult.value });
  if (proposal.error) return Response.json(proposal.error, { status: 409 });

  const leagueData = await getLeagueDataJson(env, leagueId);
  const created = [];
  const skipped = [];
  for (const round of proposal.value.regularSeason) {
    for (const game of round.games) {
      const result = await createLeagueEventRow(env, leagueId, {
        date: game.date, start_time: game.start_time || undefined, venue: game.venue || undefined,
        season, home_team: game.home, away_team: game.away
      }, leagueData);
      if (result.ok) created.push(result.event);
      else skipped.push({ round: round.round, home: game.home, away: game.away, date: game.date, errorKey: result.errorKey });
    }
  }
  for (const round of proposal.value.playoffs) {
    for (const game of round.games) {
      const result = await createLeagueEventRow(env, leagueId, {
        date: game.date, start_time: game.start_time || undefined, venue: game.venue || undefined,
        season, is_playoff: true, playoff_meta: game.meta
      }, leagueData);
      if (result.ok) created.push(result.event);
      else skipped.push({ round: round.round, playoff: true, meta: game.meta, date: game.date, errorKey: result.errorKey });
    }
  }

  return Response.json({ ok: true, league_id: leagueId, createdCount: created.length, skippedCount: skipped.length, created, skipped });
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
    // Live-testing task (batch 5), Part 2: this used to default to true
    // when the field was omitted, matching SMBHL's own legacy
    // DEFAULT_SEASON_CONFIG.tracksStats -- but SMBHL is one mature,
    // stats-tracking league, not a template for what a brand-new
    // pickup/weekly_draw league wants. The signup wizard's own toggle
    // already asks explicitly (visible label + description on step 2);
    // this is just the fallback for a caller that omits the field
    // entirely. Flipped to default OFF, matching the wizard's own new
    // default -- most pickup and weekly_draw leagues don't want stats
    // overhead, and it stays one settings toggle away either way.
    // Existing leagues' stored tracks_stats values are untouched -- this
    // only affects the INSERT below, at league creation.
    const tracksStats = body.tracksStats === true;
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

    // F1 bug fix (reminders/email-safety polish task): automated
    // reminders (reminder_72h_enabled/24h/12h) used to default ON
    // (migrate-026.sql's own column DEFAULT 1) -- so adding players to
    // a brand-new league with an imminent event already started
    // emailing them mid-setup, before the admin had made any real
    // choice about it. Explicitly OFF at creation now, overriding that
    // schema-level default (SQLite can't ALTER a column's own DEFAULT
    // without a full table rebuild, so this is done at the one place
    // new rows are ever created instead -- the schema default itself
    // stays DEFAULT 1, now dead/unreachable code for any path that
    // still doesn't specify these columns explicitly, harmless).
    // "Turn on reminders" is the new final Getting Started checklist
    // step (buildDashI18n/handleDashboardPage, index.js) -- a real,
    // deliberate admin choice, not a silent default.
    // D2 (settings polish task): migrate-025.sql's own schema DEFAULT
    // for this column (#b3122e) fails the >=3:1 legibility bar the new
    // colour-preset picker holds every option to (2.57:1 against the
    // Arène theme's dark surface-hero -- see LEAGUE_COLOR_PRESETS' own
    // comment, index.js). Same fix as F1's reminder-columns precedent
    // just above: SQLite can't ALTER a column's own DEFAULT without a
    // full table rebuild, so a new league gets an explicit, legible
    // preset (the first of the 8, closest in hue to the old default)
    // written here instead -- the schema default stays #b3122e,
    // now dead/unreachable code for this path, harmless. An existing
    // league already stored with the old default is untouched (its
    // Settings page shows it as the extra "current" swatch, per this
    // task's own "do not break it" instruction).
    // Stats tracking task (Part 1): the legacy single tracksStats
    // field is still accepted here (nothing calls this route with the
    // two new independent ones at creation time -- both the signup
    // wizard and onboarding's own real 'stats' question happen
    // AFTER a league exists) -- same "migrate anyone with the old
    // switch on to having BOTH new ones on" rule migrate-047.sql
    // applies to existing rows, applied prospectively here so the old
    // field keeps meaning exactly what it always has for any caller
    // still using it. tracksResults is never forced on for a
    // headcount league (no sides to attach a score to) even if the
    // legacy tracksStats was sent true -- same guard
    // handleLeagueUpdateIdentity enforces.
    const tracksResultsAtCreate = tracksStats && teamStructure !== 'headcount';
    await env.DB.prepare(
      `INSERT INTO leagues (id, name, division_label, tracks_stats, tracks_results, tracks_player_stats, team_count, team_names, created_by, created_at, slug, team_structure, min_players, max_players, min_goalies, reminder_72h_enabled, reminder_24h_enabled, reminder_12h_enabled, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`
    ).bind(leagueId, name, divisionLabel, tracksStats ? 1 : 0, tracksResultsAtCreate ? 1 : 0, tracksStats ? 1 : 0, teamNames.length, JSON.stringify(teamNames), session.userId, now, slug, teamStructure, minPlayers, maxPlayers, minGoalies, '#c0392b').run();

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
        tracksResults: tracksResultsAtCreate,
        tracksPlayerStats: tracksStats,
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
// Live-testing task (batch 3), Part 1: languageMode ('fr' | 'en' |
// 'both', default 'both') -- the confirmed-broken bug report for this
// task ("most emails currently render BOTH languages stacked ...
// regardless of any setting ... confirmed live on the co-admin
// invitation email"). Uses the one shared assembler every bilingual
// email in this app now goes through (design_system.js).
function buildInviteEmail(leagueName, inviteLink, leagueColor = '#b3122e', languageMode = 'both') {
  const barColor = leagueFillColor(leagueColor || '#b3122e');
  const fr = {
    subject: `Invitation à co-administrer ${leagueName}`,
    text: `Tu as été invité(e) à devenir co-administrateur(-trice) de la ligue ${leagueName}. Clique sur ce lien pour accepter :
${inviteLink}

Ce lien expire dans 48 heures. Si tu ne connais pas cette ligue, ignore ce courriel.`,
    html: `
    <h1 style="margin:0 0 12px;font:700 28px/34px Archivo,Arial,Helvetica,sans-serif;font-stretch:118%;color:#16181d;">Invitation à co-administrer</h1>
    <p style="margin:0 0 24px;font-size:16px;line-height:25px;">Tu as été invité(e) à devenir co-administrateur(-trice) de <b>${nlEmailWrapEsc(leagueName)}</b>.</p>
    ${nlEmailButton(inviteLink, 'Accepter l’invitation', barColor)}
    <p style="margin:20px 0 0;font-size:13px;line-height:19px;color:#55585f;">Ce lien expire dans 48 heures. Si tu ne connais pas cette ligue, ignore ce courriel.</p>`
  };
  const en = {
    subject: `Invitation to co-admin ${leagueName}`,
    text: `You've been invited to become a co-admin of the ${leagueName} league. Click this link to accept:
${inviteLink}

This link expires in 48 hours. If you don't recognize this league, you can ignore this email.`,
    html: `
    <h1 style="margin:0 0 12px;font:700 28px/34px Archivo,Arial,Helvetica,sans-serif;font-stretch:118%;color:#16181d;">Co-admin invitation</h1>
    <p style="margin:0 0 24px;font-size:16px;line-height:25px;">You've been invited to become a co-admin of <b>${nlEmailWrapEsc(leagueName)}</b>.</p>
    ${nlEmailButton(inviteLink, 'Accept the invitation', barColor)}
    <p style="margin:20px 0 0;font-size:13px;line-height:19px;color:#55585f;">This link expires in 48 hours. If you don't recognize this league, you can ignore this email.</p>`
  };
  const assembled = assembleBilingualEmail(languageMode, { fr, en });
  const footerHtml = languageMode === 'en'
    ? `Sent by Notre Ligue for ${nlEmailWrapEsc(leagueName)}`
    : `Envoyé par Notre Ligue pour ${nlEmailWrapEsc(leagueName)}`;
  const html = nlEmailWrap({ brandName: leagueName, barColor, bodyHtml: assembled.html, footerHtml });
  return { subject: assembled.subject, text: assembled.text, html };
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

  // Part 11 capability flag: a league already at 1+ admin needs
  // 'multi_admin' enabled to invite another. Missing row = enabled (see
  // super_admin.js), so this is a no-op for every league until a
  // super-admin explicitly disables it for one.
  const { count: adminCount } = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM league_admins WHERE league_id = ?'
  ).bind(leagueId).first();
  if (adminCount >= 1 && !(await hasCapability(env, leagueId, 'multi_admin'))) {
    return Response.json({ ok: false, error: 'This league is limited to a single admin.', errorKey: 'MULTI_ADMIN_DISABLED' }, { status: 403 });
  }

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
      const { subject, text, html } = buildInviteEmail(leagueRow.name, inviteLink, cfg.league.color, cfg.league.languageMode);
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
  // Live-testing task, Part 9: same PATCH-style optional pair for the
  // scheduled auto-draw toggle (migrate-031.sql) -- off by default,
  // only meaningful for a weekly_draw league (silently inert
  // otherwise, same posture as reminder_12h_enabled being harmless on
  // a league that never publishes a start_time). Hours-before is
  // clamped to 1-72 -- the cron's own scan window (runLeagueReminders)
  // never looks further than 72h out, so a larger value would silently
  // never fire rather than erroring, which is worse than just clamping
  // it to the window that actually gets scanned.
  if (typeof body.autoDrawEnabled === 'boolean') {
    updates.push('auto_draw_enabled = ?'); params.push(body.autoDrawEnabled ? 1 : 0);
  }
  if (body.autoDrawHoursBefore !== undefined && body.autoDrawHoursBefore !== null && String(body.autoDrawHoursBefore).trim() !== '') {
    const hours = Number(body.autoDrawHoursBefore);
    if (!Number.isFinite(hours) || hours < 1) {
      return Response.json({ ok: false, error: 'Auto-draw hours-before must be at least 1.', errorKey: 'AUTO_DRAW_HOURS_INVALID' }, { status: 400 });
    }
    updates.push('auto_draw_hours_before = ?'); params.push(Math.min(Math.floor(hours), 72));
  }
  if (!updates.length) {
    return Response.json({ ok: false, error: 'No settings provided.', errorKey: 'NO_SETTINGS_PROVIDED' }, { status: 400 });
  }
  params.push(leagueId);
  await env.DB.prepare(`UPDATE leagues SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();

  const row = await env.DB.prepare(
    'SELECT reminder_72h_enabled, reminder_24h_enabled, reminder_12h_enabled, auto_draw_enabled, auto_draw_hours_before FROM leagues WHERE id = ?'
  ).bind(leagueId).first();
  return Response.json({
    ok: true,
    settings: {
      reminder72h: !!row.reminder_72h_enabled,
      reminder24h: !!row.reminder_24h_enabled,
      reminder12h: !!row.reminder_12h_enabled,
      autoDrawEnabled: !!row.auto_draw_enabled,
      autoDrawHoursBefore: row.auto_draw_hours_before
    }
  });
}

/* ---------- consolidated settings page routes (live-testing task, Part 1) ---------- */

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Freezes every season that doesn't already carry its own
// config.teamStructure to `currentTeamStructure` -- the value they've
// actually been resolving to all along (see getSeasonConfig's own
// fallback-to-league-default behavior). Called BEFORE leagues.team_structure
// is actually changed, with the OLD value, so every existing season keeps
// resolving exactly as it did before the edit -- only a season published
// AFTER this edit (which always freezes its own real value now, per the
// handleLeagueSeasonPublish fix above) picks up the new default. A no-op
// (and cheap) for a league with no seasons yet, or where every season
// already has an explicit value of its own.
async function freezeExistingSeasonsTeamStructure(env, leagueId, currentTeamStructure) {
  const data = await getLeagueDataJson(env, leagueId);
  const seasons = Array.isArray(data.seasons) ? data.seasons : [];
  let changed = false;
  for (const season of seasons) {
    if (season && season.config && season.config.teamStructure === undefined) {
      season.config.teamStructure = currentTeamStructure;
      changed = true;
    }
  }
  if (changed) {
    await putLeagueDataJson(env, leagueId, data);
  }
}

// League identity: name, colour, stats tracking. Slug is deliberately
// NOT editable here (or anywhere) -- immutable post-creation, per
// migrate-027's own posture (see resolveLeagueIdBySlug's comment) --
// the settings page shows it read-only with an explanation instead.
export async function handleLeagueUpdateIdentity(req, env, url) {
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
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot update SMBHL.', errorKey: 'ROUTE_BLOCKED_SETTINGS' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const updates = [];
  const params = [];
  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) {
      return Response.json({ ok: false, error: 'League name is required.', errorKey: 'LEAGUE_NAME_REQUIRED' }, { status: 400 });
    }
    updates.push('name = ?'); params.push(name);
  }
  if (body.color !== undefined) {
    const color = String(body.color || '').trim();
    if (!HEX_COLOR_RE.test(color)) {
      return Response.json({ ok: false, error: 'Colour must be a hex value like #b3122e.', errorKey: 'INVALID_COLOR' }, { status: 400 });
    }
    updates.push('color = ?'); params.push(color);
  }
  if (typeof body.tracksStats === 'boolean') {
    updates.push('tracks_stats = ?'); params.push(body.tracksStats ? 1 : 0);
  }
  // Stats tracking task (Part 1): the single "Track stats?" question
  // replaced by two independent ones -- game results and player
  // stats. NO TEAMS (headcount) has no sides to attach a score to, so
  // game results is never offered to it -- rejected here at the
  // route, not only hidden by the UI, same posture as every other
  // structure-gated setting in this file.
  if (typeof body.tracksResults === 'boolean' || typeof body.tracksPlayerStats === 'boolean') {
    const structRow = await env.DB.prepare('SELECT team_structure FROM leagues WHERE id = ?').bind(leagueId).first();
    const structure = (structRow && structRow.team_structure) || 'fixed';
    if (typeof body.tracksResults === 'boolean') {
      if (body.tracksResults && structure === 'headcount') {
        return Response.json({ ok: false, error: 'Game results need two sides to attach a score to -- not offered for a no-teams league.', errorKey: 'RESULTS_REQUIRE_TEAMS' }, { status: 409 });
      }
      updates.push('tracks_results = ?'); params.push(body.tracksResults ? 1 : 0);
    }
    if (typeof body.tracksPlayerStats === 'boolean') {
      updates.push('tracks_player_stats = ?'); params.push(body.tracksPlayerStats ? 1 : 0);
    }
  }
  // Live-testing task, Part 2: public site theme. Only 'arene' and
  // 'clean' actually render (see PUBLIC_THEME_ARENE_CSS's own comment
  // in index.js for why Classique/Quartier were deliberately deferred
  // rather than shipped half-built) -- anything else is rejected here
  // rather than silently stored and never rendering the way the admin
  // expects.
  if (body.publicTheme !== undefined) {
    const themeVal = String(body.publicTheme || '').trim();
    if (!['arene', 'clean'].includes(themeVal)) {
      return Response.json({ ok: false, error: "Theme must be 'arene' or 'clean'.", errorKey: 'INVALID_PUBLIC_THEME' }, { status: 400 });
    }
    updates.push('public_theme = ?'); params.push(themeVal);
  }
  // Live-testing task (batch 2), Part 10: per-league public-page
  // visibility (migrate-037.sql, DEFAULT 1 -- every existing league
  // stays enabled unless its admin explicitly flips this).
  if (typeof body.publicPageEnabled === 'boolean') {
    updates.push('public_page_enabled = ?'); params.push(body.publicPageEnabled ? 1 : 0);
  }
  // Public-page themes task (Part 1): a STANDING blurb, not a weekly
  // notice -- set once, always shown, no expiry/scheduling. Empty
  // string clears it (stored as NULL, matching every other unset
  // free-text field in this table) rather than being rejected --
  // that's how an admin turns it back off.
  if (body.organizerNote !== undefined) {
    const note = String(body.organizerNote || '').trim();
    if (note.length > 500) {
      return Response.json({ ok: false, error: 'The organizer note must be 500 characters or fewer.', errorKey: 'ORGANIZER_NOTE_TOO_LONG' }, { status: 400 });
    }
    updates.push('organizer_note = ?'); params.push(note || null);
  }
  if (!updates.length) {
    return Response.json({ ok: false, error: 'No settings provided.', errorKey: 'NO_SETTINGS_PROVIDED' }, { status: 400 });
  }
  params.push(leagueId);
  await env.DB.prepare(`UPDATE leagues SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();

  const row = await env.DB.prepare('SELECT name, color, tracks_stats, tracks_results, tracks_player_stats, public_theme, public_page_enabled, organizer_note FROM leagues WHERE id = ?').bind(leagueId).first();
  return Response.json({
    ok: true,
    settings: {
      name: row.name, color: row.color, tracksStats: !!row.tracks_stats, publicTheme: row.public_theme,
      publicPageEnabled: !!row.public_page_enabled,
      tracksResults: !!row.tracks_results, tracksPlayerStats: !!row.tracks_player_stats,
      organizerNote: row.organizer_note || null
    }
  });
}

// Team names and colours -- the missing post-signup editing surface
// (flagged as a gap in the prior task). Only meaningful for 'fixed' and
// 'weekly_draw' (headcount has no real team names, only the internal
// HEADCOUNT_TEAM_NAME sentinel -- see that constant's own comment).
// Renaming a team here updates leagues.team_names (the league's own
// default, read by the dashboard tile and by any FUTURE season
// published after this edit) -- it does NOT retroactively change any
// ALREADY-PUBLISHED season's own team list, since handleLeagueSeasonPublish
// always snapshots seasonTeamNames into that season's own config.teams
// at publish time (unconditionally, unrelated to this task). A rename
// takes visible effect on player-facing pages (roster, events, public
// page) once the current season is republished -- same "league default
// vs season override" posture the dashboard's own season-management
// section already uses for team_structure, not a new paradigm.
export async function handleLeagueUpdateTeams(req, env, url) {
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
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot update SMBHL.', errorKey: 'ROUTE_BLOCKED_SETTINGS' }, { status: 403 });
  }

  const leagueRow = await env.DB.prepare('SELECT team_structure FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!leagueRow || leagueRow.team_structure === 'headcount') {
    return Response.json({ ok: false, error: 'This league has no team names to edit.', errorKey: 'NO_TEAMS_TO_EDIT' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const teamNames = Array.isArray(body.teamNames)
    ? body.teamNames.map(t => String(t || '').trim()).filter(Boolean)
    : [];
  if (teamNames.length < 2) {
    return Response.json({ ok: false, error: 'At least 2 team names are required.', errorKey: 'MIN_TEAM_NAMES' }, { status: 400 });
  }

  let teamColors = null;
  if (Array.isArray(body.teamColors)) {
    teamColors = teamNames.map((_, i) => {
      const c = String(body.teamColors[i] || '').trim();
      return HEX_COLOR_RE.test(c) ? c : null;
    });
    if (teamColors.every(c => c === null)) teamColors = null;
  }

  await env.DB.prepare('UPDATE leagues SET team_names = ?, team_colors = ? WHERE id = ?')
    .bind(JSON.stringify(teamNames), teamColors ? JSON.stringify(teamColors) : null, leagueId).run();

  return Response.json({ ok: true, teamNames, teamColors });
}

/* ---------- add/remove teams on a PUBLISHED season (Part 15, live-
 * testing task batch 2) ----------
 * handleLeagueUpdateTeams (above) only ever writes leagues.team_names --
 * the league-level DEFAULT a FUTURE season publish reads from
 * (handleLeagueSeasonPublish snapshots it into that season's own
 * config.teams at publish time, by design, so a later league-level edit
 * never retroactively alters a season already published -- see that
 * function's own comment). There was no route that touched an already-
 * published season's own frozen config.teams/standings at all, which is
 * the actual gap this task reported: an admin partway through a season
 * who needs to add a late-joining team, or drop one that never fielded
 * players, had no way to do either without republishing the whole
 * season under the same name (which would also reset every other
 * team's accumulated standings back to 0 -- not what "add a team"
 * should ever do).
 *
 * DECISION -- removing a team with real data is REFUSED, not silently
 * cascaded: a team with any rsvp row (a player ever put on it for an
 * event in THIS season) or any recorded games (standings.gp > 0) is
 * blocked, naming exactly why, rather than either orphaning those rsvp
 * rows (they'd reference a team name no longer in config.teams) or
 * silently deleting real standings history. This matches the app's
 * existing conservative pattern elsewhere (deactivate/hard-delete both
 * require an explicit confirm step rather than inferring intent) --
 * "remove a team" should mean "this team turned out to be unnecessary",
 * not "erase what already happened on it". An admin who genuinely wants
 * to remove a team that already played games can still do so once its
 * players are reassigned and its games are otherwise accounted for
 * (the same standings edit tools already used for correcting scores).
 *
 * Adding a team is unconditional (append to config.teams, a fresh
 * zeroed standings row) -- there's no data to lose by adding one.
 * Every OTHER season (past or future) is untouched: this only ever
 * rewrites the ONE seasons[] entry matching seasonName.
 */
export async function handleLeagueUpdateSeasonTeams(req, env, url) {
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
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot update SMBHL.', errorKey: 'ROUTE_BLOCKED_SETTINGS' }, { status: 403 });
  }

  const leagueRow = await env.DB.prepare('SELECT team_structure FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!leagueRow || leagueRow.team_structure === 'headcount') {
    return Response.json({ ok: false, error: 'This league has no team names to edit.', errorKey: 'NO_TEAMS_TO_EDIT' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const existing = await getLeagueDataJson(env, leagueId);
  const seasons = (Array.isArray(existing.seasons) ? existing.seasons : []).filter(Boolean);
  const seasonName = String(body.season_name || existing.current_season || '').trim();
  if (!seasonName) {
    return Response.json({ ok: false, error: 'season_name is required.', errorKey: 'SEASON_NAME_REQUIRED' }, { status: 400 });
  }
  const idx = seasons.findIndex(s => s && s.name === seasonName);
  if (idx < 0) {
    return Response.json({ ok: false, error: 'No published season with that name.', errorKey: 'SEASON_NOT_FOUND' }, { status: 404 });
  }

  const season = seasons[idx];
  const oldTeams = Array.isArray(season.config?.teams) ? season.config.teams : [];
  const newTeams = Array.isArray(body.teamNames)
    ? [...new Set(body.teamNames.map(t => String(t || '').trim()).filter(Boolean))]
    : [];
  if (newTeams.length < 2) {
    return Response.json({ ok: false, error: 'At least 2 team names are required.', errorKey: 'MIN_TEAM_NAMES' }, { status: 400 });
  }

  const removedTeams = oldTeams.filter(t => !newTeams.includes(t));
  const standings = Array.isArray(season.standings) ? season.standings : [];
  for (const team of removedTeams) {
    const stRow = standings.find(s => s && s.team === team);
    if (stRow && Number(stRow.gp) > 0) {
      return Response.json({ ok: false, error: `The team "${team}" has recorded games and cannot be removed.`, errorKey: 'TEAM_HAS_GAMES', team }, { status: 409 });
    }
    const assignedRow = await env.DB.prepare(
      `SELECT 1 FROM rsvp r JOIN events e ON e.id = r.event_id
        WHERE e.league_id = ? AND e.season = ? AND r.team = ? LIMIT 1`
    ).bind(leagueId, seasonName, team).first();
    if (assignedRow) {
      return Response.json({ ok: false, error: `The team "${team}" still has players assigned to it and cannot be removed.`, errorKey: 'TEAM_HAS_PLAYERS', team }, { status: 409 });
    }
  }

  const newStandings = newTeams.map(team => standings.find(s => s && s.team === team) || { team, gp: 0, w: 0, l: 0, t: 0, pts: 0, gf: 0, ga: 0 });

  seasons[idx] = { ...season, config: { ...season.config, teams: newTeams }, standings: newStandings };
  await putLeagueDataJson(env, leagueId, { ...existing, seasons });

  return Response.json({ ok: true, league_id: leagueId, season_name: seasonName, teamNames: newTeams, added: newTeams.filter(t => !oldTeams.includes(t)), removed: removedTeams });
}

// League-level team structure default + roster limits (Live-testing
// task, Part 5: min/max players AND min/max goalies, for every
// structure -- originally headcount-only).
// CRITICAL safety property (the task's own explicit requirement):
// changing this must NOT retroactively alter any already-published
// season's resolved config -- freezeExistingSeasonsTeamStructure (above)
// is called with the OLD value BEFORE the league row is updated, so
// every existing season keeps resolving exactly as before. Roster
// limits (min/max players, min/max goalies) don't need the same
// freeze: handleLeagueSeasonPublish already unconditionally snapshots
// them into every published season's own config at publish time (Bug 3
// fix for headcount; Part 5 generalizes the same snapshot to
// fixed/weekly_draw) -- so they're never dynamically re-read from the
// league row once a season exists, unlike team_structure was.
export async function handleLeagueUpdateStructure(req, env, url) {
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
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot update SMBHL.', errorKey: 'ROUTE_BLOCKED_SETTINGS' }, { status: 403 });
  }

  const leagueRow = await env.DB.prepare('SELECT team_structure, team_names, min_players, max_players, min_goalies, max_goalies FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!leagueRow) {
    return Response.json({ ok: false, error: 'League not found.', errorKey: 'LEAGUE_NOT_FOUND' }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const updates = [];
  const params = [];
  let newStructure = leagueRow.team_structure;

  if (body.team_structure !== undefined) {
    const val = String(body.team_structure || '').trim();
    if (!['fixed', 'headcount', 'weekly_draw'].includes(val)) {
      return Response.json({ ok: false, error: "team_structure must be 'fixed', 'headcount', or 'weekly_draw'.", errorKey: 'INVALID_TEAM_STRUCTURE' }, { status: 400 });
    }
    // Switching TO 'fixed'/'weekly_draw' from 'headcount' needs real
    // team names on file -- the same minimum the signup wizard itself
    // already enforces -- since this league may never have collected
    // any (a headcount-since-signup league has only the sentinel).
    if (val !== 'headcount') {
      let existingNames = [];
      try { existingNames = JSON.parse(leagueRow.team_names || '[]'); } catch (_) {}
      if (!Array.isArray(existingNames) || existingNames.filter(Boolean).length < 2) {
        return Response.json({ ok: false, error: 'This league has no team names on file yet -- set them in the Teams section first.', errorKey: 'NO_TEAM_NAMES' }, { status: 400 });
      }
    }
    newStructure = val;
    updates.push('team_structure = ?'); params.push(val);
  }

  if (newStructure === 'headcount') {
    const minPlayers = body.min_players !== undefined ? Number(body.min_players) : leagueRow.min_players;
    const maxPlayers = body.max_players !== undefined ? Number(body.max_players) : leagueRow.max_players;
    if (body.min_players !== undefined || body.max_players !== undefined || body.team_structure !== undefined) {
      if (!Number.isFinite(minPlayers) || !Number.isFinite(maxPlayers) || minPlayers < 1) {
        return Response.json({ ok: false, error: 'A minimum and maximum player count are required.', errorKey: 'HEADCOUNT_LIMITS_REQUIRED' }, { status: 400 });
      }
      if (maxPlayers < minPlayers) {
        return Response.json({ ok: false, error: 'The maximum must be at least the minimum.', errorKey: 'HEADCOUNT_MAX_TOO_LOW' }, { status: 400 });
      }
      updates.push('min_players = ?', 'max_players = ?'); params.push(minPlayers, maxPlayers);
    }
    if (body.min_goalies !== undefined) {
      const minG = Number(body.min_goalies);
      if (!Number.isFinite(minG) || minG < 0) {
        return Response.json({ ok: false, error: 'Minimum goalies must be zero or more.', errorKey: 'HEADCOUNT_MIN_GOALIES_INVALID' }, { status: 400 });
      }
      const effectiveMax = body.max_players !== undefined ? Number(body.max_players) : leagueRow.max_players;
      if (Number.isFinite(effectiveMax) && minG > effectiveMax) {
        return Response.json({ ok: false, error: "Minimum goalies can't be more than the maximum player count.", errorKey: 'HEADCOUNT_MIN_GOALIES_TOO_HIGH' }, { status: 400 });
      }
      updates.push('min_goalies = ?'); params.push(minG);
    }
    // Live-testing task, Part 5: max_goalies, same optional posture as
    // min_goalies just above.
    if (body.max_goalies !== undefined) {
      const maxG = Number(body.max_goalies);
      if (!Number.isFinite(maxG) || maxG < 0) {
        return Response.json({ ok: false, error: 'Maximum goalies must be zero or more.', errorKey: 'HEADCOUNT_MAX_GOALIES_INVALID' }, { status: 400 });
      }
      const effectiveMinG = body.min_goalies !== undefined ? Number(body.min_goalies) : leagueRow.min_goalies;
      if (Number.isFinite(effectiveMinG) && maxG < effectiveMinG) {
        return Response.json({ ok: false, error: 'The maximum goalies must be at least the minimum.', errorKey: 'HEADCOUNT_MAX_GOALIES_TOO_LOW' }, { status: 400 });
      }
      updates.push('max_goalies = ?'); params.push(maxG);
    }
  } else if (newStructure === 'fixed' || newStructure === 'weekly_draw') {
    // Live-testing task, Part 5: the same 4 fields, but genuinely
    // optional here -- no "required together" rule like headcount's own
    // block above. A fixed/weekly_draw league that never sets these
    // keeps falling back to DEFAULT_SEASON_CONFIG's numbers exactly as
    // it always has (see handleLeagueSeasonPublish's own comment for
    // where these actually take effect -- per-team directly for
    // 'fixed', divided into a per-team equivalent for 'weekly_draw''s
    // per-event pool shape).
    if (body.min_players !== undefined || body.max_players !== undefined) {
      const minP = body.min_players !== undefined ? Number(body.min_players) : leagueRow.min_players;
      const maxP = body.max_players !== undefined ? Number(body.max_players) : leagueRow.max_players;
      if (!Number.isFinite(minP) || !Number.isFinite(maxP) || minP < 1) {
        return Response.json({ ok: false, error: 'A minimum and maximum player count are required together.', errorKey: 'ROSTER_LIMITS_REQUIRED' }, { status: 400 });
      }
      if (maxP < minP) {
        return Response.json({ ok: false, error: 'The maximum must be at least the minimum.', errorKey: 'ROSTER_MAX_TOO_LOW' }, { status: 400 });
      }
      updates.push('min_players = ?', 'max_players = ?'); params.push(minP, maxP);
      // Live-testing task, Part 5: leagues.min_goalies defaults to 0 for
      // EVERY league (handleLeagueCreate), including fixed/weekly_draw
      // ones that have never touched this feature -- that stored 0 is
      // just the column's inert default, not a real "no goalie
      // requirement" choice, unlike headcount's own 0 (always set
      // explicitly, required at signup there). The FIRST time real
      // min/max-player limits are set for a fixed/weekly_draw league
      // (this transition: leagueRow.min_players was NULL, now becoming
      // real) is exactly when that ambiguity has to be resolved one way
      // or the other -- if this same request doesn't also provide a
      // real min_goalies, stamp the column with DEFAULT_SEASON_CONFIG's
      // own goaliesPerTeam (1) rather than 0: the safest choice per the
      // task's own safety requirement is to make this league's CURRENT
      // effective behavior (it has always silently required 1
      // goalie/team, same as every fixed/weekly_draw league) its new
      // explicit stored value, not silently introduce a "no goalie
      // requirement" the admin never actually asked for just because
      // they set player limits without touching the goalie fields.
      // After this point, leagueRow.min_goalies is always genuinely
      // meaningful, so handleLeagueSeasonPublish can safely trust it as
      // a real league-level default (gated on hasPlayerLimits there,
      // matching this same "player limits exist" signal).
      if (body.min_goalies === undefined && leagueRow.min_players == null) {
        updates.push('min_goalies = ?'); params.push(DEFAULT_SEASON_CONFIG.goaliesPerTeam);
      }
    }
    if (body.min_goalies !== undefined) {
      const minG = Number(body.min_goalies);
      if (!Number.isFinite(minG) || minG < 0) {
        return Response.json({ ok: false, error: 'Minimum goalies must be zero or more.', errorKey: 'MIN_GOALIES_INVALID' }, { status: 400 });
      }
      updates.push('min_goalies = ?'); params.push(minG);
    }
    if (body.max_goalies !== undefined) {
      const maxG = Number(body.max_goalies);
      if (!Number.isFinite(maxG) || maxG < 0) {
        return Response.json({ ok: false, error: 'Maximum goalies must be zero or more.', errorKey: 'MAX_GOALIES_INVALID' }, { status: 400 });
      }
      const effectiveMinG = body.min_goalies !== undefined ? Number(body.min_goalies) : leagueRow.min_goalies;
      if (Number.isFinite(effectiveMinG) && maxG < effectiveMinG) {
        return Response.json({ ok: false, error: 'The maximum goalies must be at least the minimum.', errorKey: 'MAX_GOALIES_TOO_LOW' }, { status: 400 });
      }
      updates.push('max_goalies = ?'); params.push(maxG);
    }
  }

  if (!updates.length) {
    return Response.json({ ok: false, error: 'No settings provided.', errorKey: 'NO_SETTINGS_PROVIDED' }, { status: 400 });
  }

  // Freeze BEFORE writing the new team_structure -- see this function's
  // own comment. Only needed when team_structure is actually changing.
  if (body.team_structure !== undefined && newStructure !== leagueRow.team_structure) {
    await freezeExistingSeasonsTeamStructure(env, leagueId, leagueRow.team_structure || 'fixed');
  }

  params.push(leagueId);
  await env.DB.prepare(`UPDATE leagues SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();

  const row = await env.DB.prepare('SELECT team_structure, min_players, max_players, min_goalies, max_goalies FROM leagues WHERE id = ?').bind(leagueId).first();
  return Response.json({
    ok: true,
    settings: { teamStructure: row.team_structure, minPlayers: row.min_players, maxPlayers: row.max_players, minGoalies: row.min_goalies, maxGoalies: row.max_goalies }
  });
}

/* ---------- playoff settings (Part 1, playoff extension) ----------
 * The league's own stored playoff preferences (migrate-046.sql) --
 * asked once at the onboarding 'playoffs' step (fixed-teams leagues
 * only), and this SAME route makes them editable later, exactly like
 * every other onboarding-asked-once/Settings-edited-later field
 * (roster limits, team names, reminders). Fixed-teams only: rejected
 * for weekly_draw/headcount, same posture as the fixture generator
 * itself (playoffs are meaningless for either -- weekly_draw's teams
 * aren't fixed, headcount has no teams at all).
 */
export async function handleLeagueUpdatePlayoffs(req, env, url) {
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
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot update SMBHL.', errorKey: 'ROUTE_BLOCKED_SETTINGS' }, { status: 403 });
  }

  const leagueRow = await env.DB.prepare('SELECT team_structure, team_names FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!leagueRow) {
    return Response.json({ ok: false, error: 'League not found.', errorKey: 'LEAGUE_NOT_FOUND' }, { status: 404 });
  }
  if ((leagueRow.team_structure || 'fixed') !== 'fixed') {
    return Response.json({ ok: false, error: 'Playoffs are only offered for fixed-teams leagues.', errorKey: 'PLAYOFFS_REQUIRE_FIXED_TEAMS' }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const playoffsEnabled = !!body.playoffs_enabled;

  if (!playoffsEnabled) {
    // Question 1's "no" answer -- every slot is regular season, the
    // rest is skipped (and cleared, so a later re-enable never resurfaces
    // stale answers from a previous configuration).
    await env.DB.prepare(
      'UPDATE leagues SET playoffs_enabled = 0, playoff_format = NULL, playoff_teams = NULL, playoff_best_of = NULL, playoff_third_place = 0, playoff_reserved_slots = NULL WHERE id = ?'
    ).bind(leagueId).run();
    return Response.json({ ok: true, settings: { playoffsEnabled: false } });
  }

  const format = String(body.playoff_format || '').trim();
  if (!['single_elimination', 'best_of_n', 'reserved_slots'].includes(format)) {
    return Response.json({ ok: false, error: "playoff_format must be 'single_elimination', 'best_of_n', or 'reserved_slots'.", errorKey: 'INVALID_PLAYOFF_FORMAT' }, { status: 400 });
  }

  let teamNames = [];
  try { teamNames = JSON.parse(leagueRow.team_names || '[]'); } catch (_) {}
  const leagueTeamCount = Math.max(2, teamNames.filter(Boolean).length);

  let playoffTeams = null, bestOf = null, reservedSlots = null;
  const thirdPlace = !!body.playoff_third_place;

  if (format === 'reserved_slots') {
    reservedSlots = Number(body.playoff_reserved_slots);
    if (!Number.isFinite(reservedSlots) || reservedSlots < 1) {
      return Response.json({ ok: false, error: 'playoff_reserved_slots must be at least 1.', errorKey: 'PLAYOFF_RESERVED_SLOTS_REQUIRED' }, { status: 400 });
    }
    reservedSlots = Math.floor(reservedSlots);
  } else {
    playoffTeams = Number(body.playoff_teams);
    // Question 3: ASKED, never derived -- capped at how many teams this
    // league actually has (never more, per the task's own instruction).
    if (!Number.isFinite(playoffTeams) || playoffTeams < 2 || playoffTeams > leagueTeamCount) {
      return Response.json({ ok: false, error: `playoff_teams must be between 2 and ${leagueTeamCount}.`, errorKey: 'INVALID_PLAYOFF_TEAMS' }, { status: 400 });
    }
    playoffTeams = Math.floor(playoffTeams);
    if (format === 'best_of_n') {
      bestOf = Number(body.playoff_best_of);
      if (!Number.isFinite(bestOf) || bestOf < 1) {
        return Response.json({ ok: false, error: 'playoff_best_of must be at least 1.', errorKey: 'INVALID_PLAYOFF_BEST_OF' }, { status: 400 });
      }
      bestOf = Math.floor(bestOf);
    }
  }

  await env.DB.prepare(
    `UPDATE leagues SET playoffs_enabled = 1, playoff_format = ?, playoff_teams = ?, playoff_best_of = ?, playoff_third_place = ?, playoff_reserved_slots = ? WHERE id = ?`
  ).bind(format, playoffTeams, bestOf, thirdPlace ? 1 : 0, reservedSlots, leagueId).run();

  return Response.json({
    ok: true,
    settings: { playoffsEnabled: true, format, playoffTeams, bestOf, thirdPlace, reservedSlots }
  });
}

/* ---------- score entry (Part 2, stats tracking task) ----------
 * ADMIN ONLY -- standings and playoff seeding depend on this, so it
 * must be authoritative (the task's own explicit decision; no
 * player/captain entry route exists or is planned). An event can be
 * marked played with a result, and that result is editable afterward
 * (scoresheets get misread) -- this route is a plain upsert, calling
 * it again just overwrites the previous score.
 *
 * Resolving "the two sides" differs by structure:
 * - FIXED: events.home_team/away_team (migrate-045.sql) if the
 *   fixture generator (or a manual edit) already set them; otherwise,
 *   for a 2-team league, the matchup is already implied (both teams
 *   always play -- same reasoning Part 1 of the original fixed-teams
 *   batch used for the event detail page) -- resolved from the
 *   league's own real team list. A >2-team league with no matchup set
 *   yet has no sides to score against; rejected (NO_MATCHUP_SET),
 *   same state the event detail page already shows for it.
 * - PICKUP (weekly_draw): teams are drawn per event (rsvp.team), not
 *   fixed on the event row at creation -- resolved here from the
 *   DISTINCT team values actually drawn for this event's confirmed
 *   players. Needs exactly two for a score to mean anything; once
 *   resolved, persisted onto the event's own home_team/away_team so
 *   later reads (the event page, game history) don't need to re-
 *   derive it. Results are recorded as game history ONLY -- never
 *   folded into a standings table (Part 4's own computation only ever
 *   reads 'fixed' events), since the two sides are different real
 *   people every week.
 * - NO TEAMS (headcount): rejected outright -- Part 1's own decision,
 *   enforced here too, not only hidden by the UI.
 */
async function resolveScoreEventSides(env, leagueId, teamStructure, ev, body) {
  if (teamStructure === 'fixed') {
    if (ev.home_team && ev.away_team) {
      return { value: { homeTeam: ev.home_team, awayTeam: ev.away_team, persist: false } };
    }
    const leagueRow = await env.DB.prepare('SELECT team_names FROM leagues WHERE id = ?').bind(leagueId).first();
    let teamNames = [];
    try { teamNames = JSON.parse(leagueRow.team_names || '[]').filter(Boolean); } catch (_) {}
    if (teamNames.length === 2) {
      // Not yet on the event row (a 2-team league's matchup is
      // implied, so nothing ever needed to write it before) -- persist
      // it now. deriveGoalieRecord and Part 4/5's own standings/
      // seeding all read events.home_team/away_team directly, not this
      // resolver, so it has to actually be there once a score exists.
      return { value: { homeTeam: teamNames[0], awayTeam: teamNames[1], persist: true } };
    }
    return { error: { ok: false, error: 'No matchup is set for this event yet -- set one before entering a score.', errorKey: 'NO_MATCHUP_SET' } };
  }
  if (teamStructure === 'weekly_draw') {
    if (ev.home_team && ev.away_team) {
      return { value: { homeTeam: ev.home_team, awayTeam: ev.away_team, persist: false } };
    }
    const drawn = (await env.DB.prepare(
      `SELECT DISTINCT team FROM rsvp WHERE event_id = ? AND status = 'in' AND team IS NOT NULL ORDER BY team`
    ).bind(ev.id).all()).results || [];
    if (drawn.length !== 2) {
      return { error: { ok: false, error: `This event has ${drawn.length} team(s) drawn -- a score needs exactly two.`, errorKey: 'DRAW_NOT_TWO_TEAMS' } };
    }
    return { value: { homeTeam: drawn[0].team, awayTeam: drawn[1].team, persist: true } };
  }
  return { error: { ok: false, error: 'Game results need two sides to attach a score to -- not offered for a no-teams league.', errorKey: 'RESULTS_REQUIRE_TEAMS' } };
}

export async function handleLeagueEventScore(req, env) {
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
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot score events for SMBHL.', errorKey: 'ROUTE_BLOCKED_EVENTS' }, { status: 403 });
  }

  const eventId = String(body.event_id || '').trim();
  if (!eventId) {
    return Response.json({ ok: false, error: 'event_id is required.', errorKey: 'EVENT_ID_REQUIRED' }, { status: 400 });
  }
  const ev = await env.DB.prepare('SELECT * FROM events WHERE id = ? AND league_id = ?').bind(eventId, leagueId).first();
  if (!ev) return Response.json({ ok: false, error: 'Event not found.', errorKey: 'EVENT_NOT_FOUND' }, { status: 404 });

  const leagueRow = await env.DB.prepare('SELECT team_structure, tracks_results FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!leagueRow.tracks_results) {
    return Response.json({ ok: false, error: 'This league does not track game results.', errorKey: 'RESULTS_NOT_TRACKED' }, { status: 409 });
  }
  const teamStructure = leagueRow.team_structure || 'fixed';

  const homeScore = Number(body.home_score);
  const awayScore = Number(body.away_score);
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore) || homeScore < 0 || awayScore < 0 || !Number.isInteger(homeScore) || !Number.isInteger(awayScore)) {
    return Response.json({ ok: false, error: 'home_score and away_score must be whole numbers, zero or more.', errorKey: 'INVALID_SCORE' }, { status: 400 });
  }

  const sidesResult = await resolveScoreEventSides(env, leagueId, teamStructure, ev, body);
  if (sidesResult.error) return Response.json(sidesResult.error, { status: 409 });
  const { homeTeam, awayTeam, persist } = sidesResult.value;

  const enteredAt = new Date().toISOString();
  if (persist) {
    await env.DB.prepare('UPDATE events SET home_score = ?, away_score = ?, result_entered_at = ?, home_team = ?, away_team = ? WHERE id = ? AND league_id = ?')
      .bind(homeScore, awayScore, enteredAt, homeTeam, awayTeam, eventId, leagueId).run();
  } else {
    await env.DB.prepare('UPDATE events SET home_score = ?, away_score = ?, result_entered_at = ? WHERE id = ? AND league_id = ?')
      .bind(homeScore, awayScore, enteredAt, eventId, leagueId).run();
  }

  // Part 5: a completed regular season seeds round 1 from final
  // standings, and a decisive playoff result advances its winner into
  // the next round -- both fixed-teams only, both no-ops otherwise
  // (see resolvePlayoffSeeding's own guards).
  await resolvePlayoffSeeding(env, leagueId, ev.season);

  return Response.json({
    ok: true,
    event: { id: eventId, home_team: homeTeam, away_team: awayTeam, home_score: homeScore, away_score: awayScore, result_entered_at: enteredAt, is_playoff: !!ev.is_playoff }
  });
}

/* ---------- player stats entry (Part 3, stats tracking task) ----------
 * ADMIN ONLY, same authority reasoning as score entry. Goals and
 * assists per player, per game -- only for players CONFIRMED IN for
 * that event (never the whole roster; enforced here, not only left to
 * the UI to not offer).
 *
 * GOALIE STATS: a win/loss/tie follows mechanically from the event's
 * own score and which side the goalie was on -- asking the admin to
 * enter that a second time would just be a second, potentially
 * disagreeing, source of truth for the exact same fact. DERIVED, via
 * deriveGoalieRecord below, never stored. What IS asked for and
 * stored: goals_against, the one real per-game number this product
 * has no other way to know. GAA is then computed at read time from
 * goals_against summed across a goalie's own games (see
 * computeGoalieGaaStats, Part 4) -- a simple goals-against-per-game
 * average, not per-60-minutes (this product doesn't track precise ice
 * time). Goalie entries require the event to already track results
 * (Part 1's own decision -- "unavailable... unless game results are
 * enabled") -- enforced here too, not only by the UI greying the
 * option out.
 *
 * One row per (event_id, player_id) -- a player is one role per game,
 * but nothing stops them being a skater in one game and a goalie in
 * another within the same season (different event_id rows) -- the
 * task's own explicit requirement (a "can also play goalie" flag,
 * is_backup_goalie, already exists on contacts).
 */
export function deriveGoalieRecord(ev, team) {
  if (!ev.result_entered_at || ev.home_score == null || ev.away_score == null) return null;
  const isHome = team === ev.home_team;
  const isAway = team === ev.away_team;
  if (!isHome && !isAway) return null;
  const goalsFor = isHome ? ev.home_score : ev.away_score;
  const goalsAgainst = isHome ? ev.away_score : ev.home_score;
  if (goalsFor > goalsAgainst) return 'win';
  if (goalsFor < goalsAgainst) return 'loss';
  return 'tie';
}

export async function handleLeaguePlayerStatsUpsert(req, env) {
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
  if (leagueId === SMBHL_LEAGUE_ID) {
    return Response.json({ ok: false, error: 'This route cannot record stats for SMBHL.', errorKey: 'ROUTE_BLOCKED_EVENTS' }, { status: 403 });
  }

  const eventId = String(body.event_id || '').trim();
  if (!eventId) {
    return Response.json({ ok: false, error: 'event_id is required.', errorKey: 'EVENT_ID_REQUIRED' }, { status: 400 });
  }
  const ev = await env.DB.prepare('SELECT * FROM events WHERE id = ? AND league_id = ?').bind(eventId, leagueId).first();
  if (!ev) return Response.json({ ok: false, error: 'Event not found.', errorKey: 'EVENT_NOT_FOUND' }, { status: 404 });

  const leagueRow = await env.DB.prepare('SELECT tracks_player_stats, tracks_results FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!leagueRow.tracks_player_stats) {
    return Response.json({ ok: false, error: 'This league does not track player stats.', errorKey: 'PLAYER_STATS_NOT_TRACKED' }, { status: 409 });
  }

  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (!entries.length) {
    return Response.json({ ok: false, error: 'entries must be a non-empty array.', errorKey: 'ENTRIES_REQUIRED' }, { status: 400 });
  }

  // Only players CONFIRMED IN for this event -- never the whole
  // roster, and never trusting the client's own filtering.
  const confirmedRows = (await env.DB.prepare(
    `SELECT c.player_id, c.preferred_team, r.team AS event_team FROM rsvp r JOIN contacts c ON c.player_id = r.player_id
      WHERE r.event_id = ? AND r.status = 'in' AND c.league_id = ?`
  ).bind(eventId, leagueId).all()).results || [];
  const confirmedById = new Map(confirmedRows.map(r => [r.player_id, r]));

  const now = new Date().toISOString();
  const saved = [];
  for (const entry of entries) {
    const playerId = String(entry.player_id || '').trim();
    const confirmed = confirmedById.get(playerId);
    if (!confirmed) {
      return Response.json({ ok: false, error: `Player ${playerId} was not confirmed in for this event.`, errorKey: 'PLAYER_NOT_CONFIRMED' }, { status: 409 });
    }
    const role = entry.role === 'goalie' ? 'goalie' : 'skater';
    if (role === 'goalie' && !leagueRow.tracks_results) {
      return Response.json({ ok: false, error: 'Goalie stats need game results turned on for this league.', errorKey: 'GOALIE_STATS_REQUIRE_RESULTS' }, { status: 409 });
    }
    const goals = role === 'skater' ? Math.max(0, Math.floor(Number(entry.goals) || 0)) : 0;
    const assists = role === 'skater' ? Math.max(0, Math.floor(Number(entry.assists) || 0)) : 0;
    let goalsAgainst = null;
    if (role === 'goalie') {
      goalsAgainst = Number(entry.goals_against);
      if (!Number.isFinite(goalsAgainst) || goalsAgainst < 0) {
        return Response.json({ ok: false, error: `goals_against is required (zero or more) for a goalie entry (player ${playerId}).`, errorKey: 'INVALID_GOALS_AGAINST' }, { status: 400 });
      }
      goalsAgainst = Math.floor(goalsAgainst);
    }
    // Which side they were on -- the event's own per-event assignment
    // (weekly_draw's rsvp.team) if set, else the league's permanent
    // one (fixed's contacts.preferred_team). Needed to derive a
    // goalie's win/loss/tie later; harmless to record for a skater
    // too (never displayed as anything other than context).
    const team = confirmed.event_team || confirmed.preferred_team || null;

    await env.DB.prepare(
      `INSERT INTO player_game_stats (event_id, player_id, league_id, team, role, goals, assists, goals_against, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, player_id) DO UPDATE SET team = excluded.team, role = excluded.role, goals = excluded.goals, assists = excluded.assists, goals_against = excluded.goals_against, updated_at = excluded.updated_at`
    ).bind(eventId, playerId, leagueId, team, role, goals, assists, goalsAgainst, now).run();

    saved.push({
      player_id: playerId, role, goals, assists, goals_against: goalsAgainst, team,
      derivedResult: role === 'goalie' ? deriveGoalieRecord(ev, team) : null
    });
  }

  return Response.json({ ok: true, event_id: eventId, saved });
}

/* ---------- standings and leaderboards (Part 4, stats tracking task) ----------
 * Computed ON DEMAND, directly from events/player_game_stats, every
 * time -- not written to an incrementally-updated cache (the old
 * season.standings KV array this replaces). A score is editable
 * afterward (Part 2's own decision), and a derived-fresh read is
 * simply correct by construction after an edit, with no cache-
 * invalidation logic to get wrong -- the scale this product runs at
 * (a recreational league's own season, dozens of games) makes this
 * the right tradeoff over an incremental update.
 *
 * STANDINGS: fixed-teams leagues only -- meaningless for weekly_draw
 * (teams are redrawn every event) and headcount (no teams at all),
 * same reasoning the public page's own pre-existing standings gate
 * already used. Only ever built from REGULAR-SEASON games
 * (is_playoff = 0) -- playoff results feed the resolver (Part 5), not
 * the ranking playoffs are seeded FROM; folding them in would be
 * circular.
 *
 * POINTS: DECIDED here, flagged in the final report as a choice to
 * review -- win = 2, tie = 1, loss = 0 (standard recreational-hockey
 * scoring; the task's own spec names the columns but not the exact
 * formula).
 */
export async function computeStandings(env, leagueId, season) {
  const rows = (await env.DB.prepare(
    `SELECT home_team, away_team, home_score, away_score FROM events
      WHERE league_id = ? AND season = ? AND is_playoff = 0 AND result_entered_at IS NOT NULL
        AND home_team IS NOT NULL AND away_team IS NOT NULL`
  ).bind(leagueId, season).all()).results || [];

  const table = new Map();
  const ensure = team => {
    if (!table.has(team)) table.set(team, { team, gp: 0, w: 0, l: 0, t: 0, gf: 0, ga: 0, pts: 0 });
    return table.get(team);
  };
  for (const r of rows) {
    const home = ensure(r.home_team), away = ensure(r.away_team);
    home.gp++; away.gp++;
    home.gf += r.home_score; home.ga += r.away_score;
    away.gf += r.away_score; away.ga += r.home_score;
    if (r.home_score > r.away_score) { home.w++; home.pts += 2; away.l++; }
    else if (r.home_score < r.away_score) { away.w++; away.pts += 2; home.l++; }
    else { home.t++; away.t++; home.pts += 1; away.pts += 1; }
  }
  return [...table.values()];
}

// Standard tiebreak chain (DECIDED here, flagged as a decision to
// review): points, then wins, then goal differential, then goals for.
// Used both for public-page ranking display and Part 5's own playoff
// seeding -- one sort, everywhere a "final ranking" is needed.
export function rankStandings(standings) {
  return [...standings].sort((a, b) =>
    (b.pts - a.pts) || (b.w - a.w) || ((b.gf - b.ga) - (a.gf - a.ga)) || (b.gf - a.gf)
  );
}

// TOP SCORERS: any league with player stats enabled, regardless of
// team structure (goals/assists are tracked per player, independent
// of whether standings mean anything for this league). Every game in
// the season counts, playoffs included -- a player's season total is
// everything they played, not just the regular-season portion
// standings are scoped to.
export async function computeTopScorers(env, leagueId, season) {
  const rows = (await env.DB.prepare(
    `SELECT p.player_id, c.name, SUM(p.goals) AS goals, SUM(p.assists) AS assists
       FROM player_game_stats p
       JOIN events e ON e.id = p.event_id
       JOIN contacts c ON c.player_id = p.player_id
      WHERE p.league_id = ? AND e.season = ? AND p.role = 'skater'
      GROUP BY p.player_id, c.name`
  ).bind(leagueId, season).all()).results || [];
  return rows
    .map(r => ({ player_id: r.player_id, name: r.name, goals: r.goals || 0, assists: r.assists || 0, points: (r.goals || 0) + (r.assists || 0) }))
    .sort((a, b) => b.points - a.points || b.goals - a.goals);
}

// GAA: goals_against summed across a goalie's own games, divided by
// games played -- a plain per-game average (this product doesn't
// track precise ice time, so not a true per-60-minutes rate). Also
// returns win/loss/tie totals, DERIVED per game (deriveGoalieRecord)
// from each game's own event row, never a stored, second copy of the
// same fact.
export async function computeGoalieStats(env, leagueId, season) {
  const rows = (await env.DB.prepare(
    `SELECT p.player_id, c.name, p.team, p.goals_against, e.home_team, e.away_team, e.home_score, e.away_score, e.result_entered_at
       FROM player_game_stats p
       JOIN events e ON e.id = p.event_id
       JOIN contacts c ON c.player_id = p.player_id
      WHERE p.league_id = ? AND e.season = ? AND p.role = 'goalie'`
  ).bind(leagueId, season).all()).results || [];

  const byPlayer = new Map();
  for (const r of rows) {
    if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, { player_id: r.player_id, name: r.name, games: 0, goalsAgainst: 0, w: 0, l: 0, t: 0 });
    const g = byPlayer.get(r.player_id);
    g.games++;
    g.goalsAgainst += r.goals_against || 0;
    const record = deriveGoalieRecord(r, r.team);
    if (record === 'win') g.w++;
    else if (record === 'loss') g.l++;
    else if (record === 'tie') g.t++;
  }
  return [...byPlayer.values()].map(g => ({ ...g, gaa: g.games ? Math.round((g.goalsAgainst / g.games) * 100) / 100 : null }));
}

/* ---------- playoff seeding resolver (Part 5, stats tracking task) ----
 * Placeholders from buildPlayoffPlaceholders (commit fa52ad8) carry
 * round/matchup-index/seed numbers with home_team/away_team left
 * null. This fills them in, two triggers, both called from
 * handleLeagueEventScore right after a successful score write:
 *   1. The regular season completes (every non-playoff event for the
 *      season has a result) -> round 1 (and any bye's direct advance)
 *      seeded from final standings.
 *   2. A playoff game gets a decisive (non-tied) result -> its winner
 *      fills the next round's slot it feeds, using
 *      buildBracketAdvancement's own advancesToRound/
 *      advancesToMatchupIndexInRound/advancesToSide.
 * FIXED TEAMS ONLY (same as playoffs generally). No bracket exists for
 * the 'reserved_slots' format (no seeds were ever assigned to those
 * placeholders), so this is a no-op there.
 *
 * SEEDING TIEBREAK: reuses rankStandings' own chain (points, wins,
 * goal differential, goals for) -- DECIDED here, flagged for review,
 * same as rankStandings' own chain already is.
 *
 * A TIED regular-season standing has a real tiebreak (the chain
 * above); a TIED PLAYOFF GAME does not -- there is no points system to
 * fall back on for a single elimination game, and guessing who
 * "really" won would be exactly the kind of guess the task says not
 * to make. A tied playoff score is therefore left exactly as
 * unresolved as an unplayed one: nobody advances, and the next
 * round's placeholder stays empty until an admin corrects the score.
 *
 * BRACKET-ROUND IDENTIFICATION: an event only stores its role
 * ('final'/'semifinal'/'quarterfinal'/'bracket') and its
 * matchup-index WITHIN that role, never an absolute round number. For
 * up to 8 playoff teams (quarterfinal/semifinal/final) every role is
 * unique, so this is unambiguous. Past that, buildPlayoffPlaceholders
 * itself reuses the generic 'bracket' label for more than one early
 * round -- disambiguated here by chronological order (round 1's own
 * games are always scheduled earliest; see buildPlayoffPlaceholders'
 * own comment on generating groups in round order), matching each
 * role's Nth-earliest date-group to the bracket's Nth round using
 * that same role. Flagged in the final report as a real, if unlikely,
 * limitation for very large brackets rather than a fully general
 * solution.
 */
export async function resolvePlayoffSeeding(env, leagueId, season) {
  const leagueRow = await env.DB.prepare(
    `SELECT team_structure, playoffs_enabled, playoff_format, playoff_teams
       FROM leagues WHERE id = ?`
  ).bind(leagueId).first();
  if (!leagueRow || (leagueRow.team_structure || 'fixed') !== 'fixed' || !leagueRow.playoffs_enabled) return;
  if (leagueRow.playoff_format === 'reserved_slots') return;
  const numTeams = leagueRow.playoff_teams || 0;
  if (numTeams < 2) return;

  const { rounds, byes } = buildBracketAdvancement(numTeams);
  if (!rounds.length) return;

  const events = (await env.DB.prepare(
    `SELECT id, date, home_team, away_team, home_score, away_score, result_entered_at, playoff_meta
       FROM events WHERE league_id = ? AND season = ? AND is_playoff = 1 ORDER BY date ASC`
  ).bind(leagueId, season).all()).results || [];
  if (!events.length) return;
  const parsed = events.map(ev => {
    let meta = {};
    try { meta = JSON.parse(ev.playoff_meta || 'null') || {}; } catch (_) { meta = {}; }
    return { ...ev, meta };
  });

  const roleForRound = roundIdx => {
    const roundsFromFinal = rounds.length - 1 - roundIdx;
    if (roundsFromFinal === 0) return 'final';
    if (roundsFromFinal === 1) return 'semifinal';
    if (roundsFromFinal === 2) return 'quarterfinal';
    return 'bracket';
  };
  const roundIdxsByRole = new Map();
  rounds.forEach((_, roundIdx) => {
    const role = roleForRound(roundIdx);
    if (!roundIdxsByRole.has(role)) roundIdxsByRole.set(role, []);
    roundIdxsByRole.get(role).push(roundIdx);
  });
  const datesByRole = new Map();
  for (const ev of parsed) {
    if (!roundIdxsByRole.has(ev.meta.role)) continue; // bye/reserved/third_place -- not part of the seeded bracket
    if (!datesByRole.has(ev.meta.role)) datesByRole.set(ev.meta.role, new Set());
    datesByRole.get(ev.meta.role).add(ev.date);
  }
  const roundIdxForEvent = new Map();
  for (const [role, roundIdxs] of roundIdxsByRole) {
    const dates = [...(datesByRole.get(role) || [])].sort();
    for (const ev of parsed) {
      if (ev.meta.role !== role) continue;
      const pos = dates.indexOf(ev.date);
      if (pos >= 0 && pos < roundIdxs.length) roundIdxForEvent.set(ev.id, roundIdxs[pos]);
    }
  }
  const eventsByRoundMatchup = new Map();
  for (const ev of parsed) {
    const roundIdx = roundIdxForEvent.get(ev.id);
    if (roundIdx === undefined || !ev.meta.matchupIndexInRound) continue;
    const key = `${roundIdx}:${ev.meta.matchupIndexInRound}`;
    if (!eventsByRoundMatchup.has(key)) eventsByRoundMatchup.set(key, []);
    eventsByRoundMatchup.get(key).push(ev);
  }

  // 1. Seed round 1 (+ any bye's direct advance) from final standings,
  // once the regular season is fully played.
  const regular = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COUNT(result_entered_at) AS done FROM events
      WHERE league_id = ? AND season = ? AND is_playoff = 0`
  ).bind(leagueId, season).first();
  if (regular.total > 0 && regular.total === regular.done) {
    const table = await computeStandings(env, leagueId, season);
    // Every real team gets a seed, even one that somehow finished the
    // season with zero recorded games (never silently dropped from a
    // bracket it's entered) -- computeStandings only knows about teams
    // that appear in a played game row, so any of the league's own
    // teams missing from it are appended at the bottom, in their
    // original team-list order, as 0-game entries.
    const cfg = await getLeagueSeasonConfig(env, leagueId, season);
    const known = new Set(table.map(s => s.team));
    for (const team of getTeamNames(cfg)) {
      if (!known.has(team)) table.push({ team, gp: 0, w: 0, l: 0, t: 0, gf: 0, ga: 0, pts: 0 });
    }
    const ranked = rankStandings(table);
    const seedTeam = seed => (seed && ranked[seed - 1]) ? ranked[seed - 1].team : null;

    for (const m of rounds[0]) {
      const homeTeam = seedTeam(m.seedA), awayTeam = seedTeam(m.seedB);
      if (!homeTeam || !awayTeam) continue; // fewer real teams than the bracket expects -- left unresolved
      for (const ev of (eventsByRoundMatchup.get(`0:${m.matchupIndexInRound}`) || [])) {
        if (ev.home_team && ev.away_team) continue; // already seeded -- never clobber
        await env.DB.prepare('UPDATE events SET home_team = ?, away_team = ? WHERE id = ?').bind(homeTeam, awayTeam, ev.id).run();
      }
    }
    for (const bye of byes) {
      const team = seedTeam(bye.seed);
      if (!team || bye.advancesToRound == null) continue;
      const col = bye.advancesToSide === 'A' ? 'home_team' : 'away_team';
      for (const ev of (eventsByRoundMatchup.get(`${bye.advancesToRound}:${bye.advancesToMatchupIndexInRound}`) || [])) {
        if (ev[col]) continue;
        await env.DB.prepare(`UPDATE events SET ${col} = ? WHERE id = ?`).bind(team, ev.id).run();
      }
    }
  }

  // 2. Advance the winner of any played, DECISIVE playoff game into
  // the next round's slot it feeds.
  for (const [key, evs] of eventsByRoundMatchup) {
    const [roundIdxStr, matchupIdxStr] = key.split(':');
    const roundIdx = Number(roundIdxStr), matchupIdx = Number(matchupIdxStr);
    const m = (rounds[roundIdx] || []).find(x => x.matchupIndexInRound === matchupIdx);
    if (!m || m.advancesToRound == null) continue; // final round -- champion, nothing further to fill
    // A best-of-N series is still just individual game events here (no
    // real series-win tracking exists yet -- flagged as a known
    // simplification) -- the LATEST played, decisive game of the
    // matchup is used as the advancing result.
    const decided = evs
      .filter(ev => ev.result_entered_at && ev.home_team && ev.away_team && ev.home_score !== ev.away_score)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
    if (!decided) continue; // no decisive result yet (unplayed or tied) -- left unresolved
    const winner = decided.home_score > decided.away_score ? decided.home_team : decided.away_team;
    const col = m.advancesToSide === 'A' ? 'home_team' : 'away_team';
    for (const ev of (eventsByRoundMatchup.get(`${m.advancesToRound}:${m.advancesToMatchupIndexInRound}`) || [])) {
      if (ev[col]) continue;
      await env.DB.prepare(`UPDATE events SET ${col} = ? WHERE id = ?`).bind(winner, ev.id).run();
    }
  }
}

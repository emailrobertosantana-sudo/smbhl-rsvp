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
import { dataJsonKeyFor } from './league_ids.js';
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

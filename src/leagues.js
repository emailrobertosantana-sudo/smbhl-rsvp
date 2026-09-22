// League provisioning for real user accounts (auth.js). Purely additive:
// nothing existing reads from the leagues/league_admins tables, and this
// does not touch data_json, events, or any other Fall-2026 data path.
//
// ARCHITECTURE DECISION — read this before extending anything here:
// Actually creating a new physical D1 database or KV namespace per league
// requires the Cloudflare account-level API (what `wrangler d1 create` /
// `wrangler kv namespace create` do) — a Worker's own request handler cannot
// provision new account-level resources like that from inside a fetch event;
// there is no "create me a new database" call available at runtime. So
// leagues in this file are ROWS in the one shared D1 database this Worker
// already has (env.DB), scoped by league_id, not separate physical
// databases. This is a deliberate fork away from tonight's one-database-
// per-league demo setup (one manually wrangler-provisioned DB per league) —
// see the final report for the honest scope of what still needs to change
// before a second league's actual attendance/stats data is isolated by this
// league_id (short version: everything that currently reads a single shared
// data_json / unscoped events table would need to become league_id-aware;
// that is explicitly NOT done in this task).

import { checkUserSession } from './auth.js';

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

/* ---------- proof of concept: GET /league/contacts ----------
 * The one new route this task wires up, to prove the whole chain works
 * end-to-end (session -> league lookup -> league_id-filtered query ->
 * isolated result) without touching any of the existing ADMIN_KEY-gated
 * contacts/events/rsvp routes in index.js.
 *
 * League context convention: `?league_id=` is accepted explicitly (and
 * checkLeagueAccess always verifies the session user actually administers
 * it — passing a different league's id here is exactly what the isolation
 * test below proves gets rejected, not trusted). When omitted, this falls
 * back to the same "most recently created league this user administers"
 * lookup handleDashboardPage (index.js) already uses today — there is no
 * league_id anywhere in this app's URLs yet, so a request with no explicit
 * league_id acts on "your league", matching the current one-league-per-user
 * dashboard flow instead of inventing a new convention on top of it.
 */
export async function handleLeagueContacts(req, env, url) {
  const session = await checkUserSession(req, env);
  if (!session) return leagueAccessResponse('unauthenticated');

  let leagueId = url.searchParams.get('league_id');
  if (!leagueId) {
    const row = await env.DB.prepare(
      `SELECT la.league_id FROM league_admins la JOIN leagues l ON l.id = la.league_id
        WHERE la.user_id = ? ORDER BY l.created_at DESC LIMIT 1`
    ).bind(session.userId).first();
    leagueId = row ? row.league_id : null;
  }
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

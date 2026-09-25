// Live-testing task (batch 2), Part 12 (BIG): hard delete (privacy/Law
// 25). A genuinely irreversible, full row-level erasure -- distinct from
// handleLeagueDeactivate (leagues.js, Part 10's soft-delete access gate,
// which flips deactivated_at and touches nothing else).
//
// FLOW: deactivate first (already required to even reach this module --
// see checkHardDeleteEligibility) -> wait out a 15-day unlock delay,
// timed from deactivated_at itself (no separate "requested_at" needed:
// deactivating a league already *is* the unambiguous moment someone
// decided to get rid of it) -> type a strong confirmation phrase ->
// irreversible delete of every row this league (or its events/contacts)
// ever touched, across every table, plus its KV data_json blob, plus
// (see below) any admin user account left with no other league to
// administer. No soft-delete flag, no "recycle bin" table holding the
// real content -- migrate-039.sql's own log keeps ids/counts only, never
// the deleted league's actual data.
//
// AVAILABLE TO BOTH the league's own admin (handleLeagueHardDelete,
// session-gated) AND the super-admin (handleSuperAdminLeagueHardDelete,
// ADMIN_KEY-gated, leagues.js/super_admin.js's existing pattern) --
// both funnel into the same performLeagueHardDelete core so there is
// exactly one deletion implementation to keep correct.
//
// SMBHL IS STRUCTURALLY EXEMPT. checkHardDeleteEligibility refuses it
// unconditionally, before even checking deactivation -- it can never be
// deactivated by this flow either (handleLeagueDeactivate's own
// confirmName check makes that merely hard, not impossible, since SMBHL
// IS a real row in `leagues`; this module adds the actual guarantee).

import { checkUserSession, checkCsrfToken } from './auth.js';
import { leagueAccessResponse, resolveSessionLeagueId } from './leagues.js';
import { SMBHL_LEAGUE_ID, dataJsonKeyFor } from './league_ids.js';

export const HARD_DELETE_UNLOCK_DAYS = 15;

// Every league-scoped table with its own league_id column (see the task
// report's audit of schema.sql + migrate-*.sql for how this list was
// built). league_team_assigned_email_log has no league_id column of its
// own -- it's keyed by event_id, which performLeagueHardDelete captures
// for this league BEFORE deleting from `events`.
//
// Demo-cleanup-script task: re-derived this list from src/schema_manifest.js
// (the authoritative, migration-validated table inventory) cross-referenced
// against every migrate-*.sql through 044 -- 'venues' (migrate-041) and
// 'league_mail_failure_log' (migrate-040) both have their own real
// league_id column but were never added here, so hard delete silently
// left orphaned rows in both forever. Fixed by adding them; every other
// table in the manifest is accounted for: league_team_assigned_email_log
// (event_id-keyed, handled below), league_admins/leagues/users (deleted
// directly, not via this blanket loop), league_hard_delete_log (the audit
// trail itself -- deliberately NOT deleted, see this file's own top
// comment), signup_attempts (IP-rate-limiting only, no league_id at all).
export const LEAGUE_SCOPED_TABLES = [
  'rsvp', 'sheet_reviews', 'team_messages', 'outbox', 'jobs', 'availability',
  'season_costs', 'season_pricing', 'player_dues', 'planned_absences',
  'poll_votes', 'polls', 'events', 'contacts', 'settings',
  'league_reminder_log', 'league_auto_draw_log', 'league_capability_flags',
  'venues', 'league_mail_failure_log'
];

export async function checkHardDeleteEligibility(env, leagueId) {
  if (!leagueId) return { status: 'not_found' };
  if (leagueId === SMBHL_LEAGUE_ID) return { status: 'protected' };
  const league = await env.DB.prepare('SELECT id, name, deactivated_at FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!league) return { status: 'not_found' };
  if (!league.deactivated_at) return { status: 'not_deactivated', league };
  const unlockAtMs = Date.parse(league.deactivated_at) + HARD_DELETE_UNLOCK_DAYS * 24 * 3600 * 1000;
  if (Date.now() < unlockAtMs) return { status: 'locked', unlockAt: new Date(unlockAtMs).toISOString(), league };
  return { status: 'eligible', league };
}

// The two bilingual phrases a caller may type -- matches the app's own
// FR-primary/EN-secondary convention everywhere else (e.g. the public
// "not available" pages). Stronger than handleLeagueDeactivate's bare
// league-name check on purpose: hard delete is irreversible where
// deactivation is not.
export function validHardDeleteConfirmPhrases(leagueName) {
  return [`SUPPRIMER ${leagueName}`, `DELETE ${leagueName}`];
}

// Does the actual erasure. Not called directly by a route -- both
// handleLeagueHardDelete and handleSuperAdminLeagueHardDelete validate
// eligibility + confirmation first, then call this. Exported (demo-
// cleanup-script task) so a standalone maintenance script can reuse the
// exact same cascade -- see scripts/demo_league_cleanup.js's own top
// comment for why eligibility/confirmation-phrase enforcement, which
// exists to protect a live admin from fat-fingering their OWN league
// through the product UI, is deliberately bypassed there instead of
// reimplemented: that script has its own, different safeguards (a
// hard-coded demo-only database allowlist, an explicit target list,
// dry-run-by-default) appropriate to an operator tool, not a public UI.
export async function performLeagueHardDelete(env, leagueId, leagueName, deletedByUserId, deletedVia) {
  const eventIdRows = (await env.DB.prepare('SELECT id FROM events WHERE league_id = ?').bind(leagueId).all()).results || [];
  let rowsDeleted = 0;

  if (eventIdRows.length) {
    const placeholders = eventIdRows.map(() => '?').join(',');
    const res = await env.DB.prepare(
      `DELETE FROM league_team_assigned_email_log WHERE event_id IN (${placeholders})`
    ).bind(...eventIdRows.map(r => r.id)).run();
    rowsDeleted += res.meta?.changes || 0;
  }

  for (const table of LEAGUE_SCOPED_TABLES) {
    const res = await env.DB.prepare(`DELETE FROM ${table} WHERE league_id = ?`).bind(leagueId).run();
    rowsDeleted += res.meta?.changes || 0;
  }

  const adminUserIds = (await env.DB.prepare(
    'SELECT user_id FROM league_admins WHERE league_id = ?'
  ).bind(leagueId).all()).results.map(r => r.user_id) || [];

  const adminRes = await env.DB.prepare('DELETE FROM league_admins WHERE league_id = ?').bind(leagueId).run();
  rowsDeleted += adminRes.meta?.changes || 0;

  const leagueRes = await env.DB.prepare('DELETE FROM leagues WHERE id = ?').bind(leagueId).run();
  rowsDeleted += leagueRes.meta?.changes || 0;

  if (env.SHEETS_KV) {
    try { await env.SHEETS_KV.delete(dataJsonKeyFor(leagueId)); } catch (_) {}
  }

  // "No local retention" applies to the admin's own account too, but
  // ONLY when this was their last league -- a user who administers a
  // second, surviving league keeps their login (deleting it would be a
  // real, unrelated account-deletion side effect on a league untouched
  // by this request).
  let usersDeleted = 0;
  for (const userId of adminUserIds) {
    const remaining = await env.DB.prepare(
      'SELECT 1 FROM league_admins WHERE user_id = ?'
    ).bind(userId).first();
    if (!remaining) {
      const res = await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
      usersDeleted += res.meta?.changes || 0;
    }
  }

  await env.DB.prepare(
    `INSERT INTO league_hard_delete_log (league_id, league_name, deleted_by_user_id, deleted_via, deleted_at, rows_deleted, users_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(leagueId, leagueName, deletedByUserId || null, deletedVia, new Date().toISOString(), rowsDeleted, usersDeleted).run();

  return { rowsDeleted, usersDeleted, deletedUserIds: adminUserIds };
}

function eligibilityResponse(elig) {
  if (elig.status === 'not_found') return Response.json({ ok: false, error: 'League not found.', errorKey: 'LEAGUE_NOT_FOUND' }, { status: 404 });
  if (elig.status === 'protected') return Response.json({ ok: false, error: 'This league cannot be deleted.', errorKey: 'LEAGUE_PROTECTED' }, { status: 403 });
  if (elig.status === 'not_deactivated') return Response.json({ ok: false, error: 'The league must be deactivated first.', errorKey: 'NOT_DEACTIVATED' }, { status: 409 });
  if (elig.status === 'locked') return Response.json({ ok: false, error: 'Hard delete is not yet unlocked.', errorKey: 'HARD_DELETE_LOCKED', unlockAt: elig.unlockAt }, { status: 423 });
  return null;
}

// POST /league/hard-delete -- body: { confirmPhrase }. Session-gated,
// but deliberately NOT via leagues.js's checkLeagueAccess: that helper
// blocks every route once a league is deactivated (Part 10's own
// design), and hard delete can only ever be reached FOR a deactivated
// league. This checks the same underlying league_admins link directly
// instead, ignoring the deactivated block that would otherwise make
// hard delete unreachable by its own precondition.
export async function handleLeagueHardDelete(req, env, url) {
  const session = await checkUserSession(req, env);
  if (!session) return leagueAccessResponse('unauthenticated');
  if (!(await checkCsrfToken(req, env, session))) {
    return Response.json({ ok: false, error: 'Invalid or missing CSRF token.', errorKey: 'CSRF_INVALID' }, { status: 403 });
  }

  const leagueId = await resolveSessionLeagueId(req, env, url);
  if (!leagueId) {
    return Response.json({ ok: false, error: 'No league found for this account.', errorKey: 'NO_LEAGUE_FOUND' }, { status: 404 });
  }
  const link = await env.DB.prepare(
    'SELECT 1 FROM league_admins WHERE user_id = ? AND league_id = ?'
  ).bind(session.userId, leagueId).first();
  if (!link) return leagueAccessResponse('forbidden');

  const elig = await checkHardDeleteEligibility(env, leagueId);
  const eligErr = eligibilityResponse(elig);
  if (eligErr) return eligErr;

  const body = await req.json().catch(() => ({}));
  const confirmPhrase = String(body.confirmPhrase || '').trim();
  if (!validHardDeleteConfirmPhrases(elig.league.name).includes(confirmPhrase)) {
    return Response.json({ ok: false, error: 'Confirmation text does not match.', errorKey: 'CONFIRM_PHRASE_MISMATCH' }, { status: 400 });
  }

  const result = await performLeagueHardDelete(env, leagueId, elig.league.name, session.userId, 'league_admin');
  return Response.json({ ok: true, ...result });
}

// POST /super-admin/leagues/hard-delete -- body: { leagueId, confirmPhrase }.
// Caller (index.js route) has already run checkAdminAuth; this function
// assumes that's done, matching every other super-admin handler's shape.
export async function handleSuperAdminLeagueHardDelete(req, env) {
  const body = await req.json().catch(() => ({}));
  const leagueId = String(body.leagueId || '');
  if (!leagueId) return Response.json({ ok: false, error: 'leagueId is required.', errorKey: 'LEAGUE_ID_REQUIRED' }, { status: 400 });

  const elig = await checkHardDeleteEligibility(env, leagueId);
  const eligErr = eligibilityResponse(elig);
  if (eligErr) return eligErr;

  const confirmPhrase = String(body.confirmPhrase || '').trim();
  if (!validHardDeleteConfirmPhrases(elig.league.name).includes(confirmPhrase)) {
    return Response.json({ ok: false, error: 'Confirmation text does not match.', errorKey: 'CONFIRM_PHRASE_MISMATCH' }, { status: 400 });
  }

  const result = await performLeagueHardDelete(env, leagueId, elig.league.name, null, 'super_admin');
  return Response.json({ ok: true, ...result });
}

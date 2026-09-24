// Live-testing task (batch 2), Part 11: super-admin layer + capability
// flags.
//
// AUTH DESIGN DECISION -- reuses admin_auth.js's checkAdminAuth (the same
// ADMIN_KEY already documented there as "a SUPERUSER key that can act on
// ANY league", not scoped to SMBHL) rather than inventing a second secret
// or a whole new credential store. This satisfies "separate super-admin
// login" the way the task means it: a login flow entirely distinct from a
// league admin's own email+password session (auth.js/league_admins) --
// not a new secret for a trust level the app already has a key for. The
// /super-admin/* routes are a genuinely separate page/flow from SMBHL's
// own /admin/* operational tooling (board, subs, review), just gated by
// the same key, consistent with checkAdminAuth's own stated design.
//
// SCOPE -- explicitly NOT built here (per the task spec): no billing, no
// payment, no pricing page, no self-serve upgrade flow, no in-app
// feature-hinting ("upgrade to unlock X"). plan_tier is a plain stored
// LABEL a super-admin can set by hand; it does not automatically gate
// anything yet -- that wiring is explicit later-follow-up work the task
// itself defers ("tier names ... as later-follow-up presets").
//
// CAPABILITY-FLAG MECHANISM -- league_capability_flags (migrate-038.sql)
// is a (league_id, flag_key) -> enabled table. A MISSING row means "never
// explicitly overridden", and hasCapability() below treats that as
// enabled=true for every currently-defined flag. This is what makes
// "every league defaults unaffected" true without a backfill: introducing
// the table, and even introducing new flag keys later, changes nothing
// until a super-admin explicitly flips a specific league's row.

export const PLAN_TIERS = [
  { key: 'gratuit', label: 'Gratuit' },
  { key: 'solo', label: 'Solo' },
  { key: 'ligue_plus', label: 'Ligue+' }
];
const PLAN_TIER_KEYS = new Set(PLAN_TIERS.map(t => t.key));

// One real, functioning flag for this task: whether a league can have
// more than one admin. Every league defaults to enabled (unaffected --
// see mechanism note above); a super-admin can disable it for a specific
// league to cap it at its current single admin. Wired into
// handleLeagueAdminInvite (leagues.js).
export const CAPABILITY_FLAGS = [
  {
    key: 'multi_admin',
    label: 'Plusieurs admins / Multiple admins',
    description: "Permet d'inviter plus d'un administrateur pour cette ligue. / Allows inviting more than one admin for this league."
  }
];
const CAPABILITY_FLAG_KEYS = new Set(CAPABILITY_FLAGS.map(f => f.key));

// Never throws. Returns true (the safe, pre-existing-behavior default)
// for any flag key with no explicit row, including a key this function
// doesn't recognize -- callers that care about validity check
// CAPABILITY_FLAG_KEYS themselves before writing.
export async function hasCapability(env, leagueId, flagKey) {
  if (!env?.DB || !leagueId || !flagKey) return true;
  try {
    const row = await env.DB.prepare(
      'SELECT enabled FROM league_capability_flags WHERE league_id = ? AND flag_key = ?'
    ).bind(leagueId, flagKey).first();
    if (!row) return true;
    return !!row.enabled;
  } catch (_) {
    return true;
  }
}

export function isValidPlanTier(planTier) {
  return PLAN_TIER_KEYS.has(String(planTier || ''));
}

export function isValidCapabilityFlag(flagKey) {
  return CAPABILITY_FLAG_KEYS.has(String(flagKey || ''));
}

// Every league, newest first, with the metadata Part 11 asks for: id,
// name, slug, created_at, plan_tier, public_page_enabled, deactivated_at,
// how many admins it has, and this league's own capability-flag
// overrides (only the rows that exist -- an absent key means "enabled",
// per the mechanism note above; the caller fills defaults for display).
export async function listLeaguesWithMetadata(env) {
  const leagues = (await env.DB.prepare(
    `SELECT id, name, slug, created_at, plan_tier, public_page_enabled, deactivated_at
       FROM leagues ORDER BY created_at DESC`
  ).all()).results || [];

  const flagRows = (await env.DB.prepare(
    'SELECT league_id, flag_key, enabled FROM league_capability_flags'
  ).all()).results || [];
  const flagsByLeague = new Map();
  for (const row of flagRows) {
    if (!flagsByLeague.has(row.league_id)) flagsByLeague.set(row.league_id, {});
    flagsByLeague.get(row.league_id)[row.flag_key] = !!row.enabled;
  }

  const adminCountRows = (await env.DB.prepare(
    'SELECT league_id, COUNT(*) AS n FROM league_admins GROUP BY league_id'
  ).all()).results || [];
  const adminCountByLeague = new Map(adminCountRows.map(r => [r.league_id, r.n]));

  return leagues.map(l => {
    const overrides = flagsByLeague.get(l.id) || {};
    const flags = {};
    for (const f of CAPABILITY_FLAGS) {
      flags[f.key] = Object.prototype.hasOwnProperty.call(overrides, f.key) ? overrides[f.key] : true;
    }
    return {
      id: l.id,
      name: l.name,
      slug: l.slug,
      createdAt: l.created_at,
      planTier: l.plan_tier || 'gratuit',
      publicPageEnabled: !!l.public_page_enabled,
      deactivatedAt: l.deactivated_at || null,
      adminCount: adminCountByLeague.get(l.id) || 0,
      flags
    };
  });
}

export async function updateLeaguePlanTier(env, leagueId, planTier) {
  if (!isValidPlanTier(planTier)) return { ok: false, error: 'Invalid plan tier.', errorKey: 'INVALID_PLAN_TIER' };
  const league = await env.DB.prepare('SELECT id FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!league) return { ok: false, error: 'League not found.', errorKey: 'LEAGUE_NOT_FOUND' };
  await env.DB.prepare('UPDATE leagues SET plan_tier = ? WHERE id = ?').bind(planTier, leagueId).run();
  return { ok: true };
}

export async function updateLeagueCapabilityFlag(env, leagueId, flagKey, enabled) {
  if (!isValidCapabilityFlag(flagKey)) return { ok: false, error: 'Unknown capability flag.', errorKey: 'INVALID_FLAG' };
  const league = await env.DB.prepare('SELECT id FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!league) return { ok: false, error: 'League not found.', errorKey: 'LEAGUE_NOT_FOUND' };
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO league_capability_flags (league_id, flag_key, enabled, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(league_id, flag_key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
  ).bind(leagueId, flagKey, enabled ? 1 : 0, now).run();
  return { ok: true };
}

// Notre Ligue billing, batch 1 of 3: the foundation, invisible to admins.
//
// What this file does:
//   - the count billing is based on: regular players with an email
//     address (regularCount), and the tier it implies (tierForCount);
//   - keeps that count in league_billing (migrate-056), after the roster
//     write routes (refreshRegularCount) and once a day from the Notre
//     Ligue cron (refreshDailyRegularCounts);
//   - the state a super-admin sees (billingSummary): count, tier, status,
//     trial end, the free exception.
//
// BILLING_LAUNCH_AT (wrangler.jsonc env.demo vars, an ISO date) is the
// switch. Unset or not a date: billing is off. Nothing is gated, no notice
// is sent, Stripe is never called (src/stripe.js refuses), the webhook
// answers 404 (src/stripe_webhook.js). Only the count is kept, which no
// page outside the super-admin one shows. SMBHL is never counted or
// billed.
//
// Decided by Roberto (2026-10-01), for batches 2 and 3:
//   - a league that subscribes during its trial keeps the rest of the
//     trial and is first charged at its end; a card is required at
//     checkout unless the total is 0;
//   - players can still answer in a read-only league;
//   - when one owner has two small leagues, the oldest keeps the free slot
//     (freeSlotLeagueId below);
//   - payment and card notices go to the owner only; read-only and
//     deletion warnings go to every admin;
//   - the "Test interne" promotion code is deactivated at launch, and its
//     test subscriptions cancelled.
// Design: the billing report (batch 6), docs/billing.md.

export const SMBHL_ID = 'smbhl';
export const TRIAL_MONTHS = 2;
// Regular players with an email: under 15 free, 15 to 50 Standard, 51 to
// 100 Plus, over 100 a custom price.
export const TIER_LIMITS = { free: 14, standard: 50, plus: 100 };

export function tierForCount(n) {
  const c = Number(n) || 0;
  if (c <= TIER_LIMITS.free) return 'free';
  if (c <= TIER_LIMITS.standard) return 'standard';
  if (c <= TIER_LIMITS.plus) return 'plus';
  return 'custom';
}

// The launch date, or null when billing is off.
export function billingLaunchAt(env) {
  const raw = env && env.BILLING_LAUNCH_AT;
  if (!raw || typeof raw !== 'string') return null;
  const t = Date.parse(raw.trim());
  return Number.isFinite(t) ? new Date(t) : null;
}
export function billingEnabled(env) {
  return billingLaunchAt(env) !== null;
}

// Regular players (role 'roster', active, not opted out) with an email
// address, each address once (case and spaces ignored). Subs, inactive
// players and players with no email do not count.
export async function regularCount(db, leagueId) {
  const row = await db.prepare(
    `SELECT COUNT(DISTINCT lower(trim(email))) AS n
       FROM contacts
      WHERE league_id = ?
        AND role = 'roster'
        AND COALESCE(is_active, 1) = 1
        AND COALESCE(opted_out, 0) = 0
        AND email IS NOT NULL AND trim(email) != ''`
  ).bind(leagueId).first();
  return Number(row && row.n) || 0;
}

// Writes the count to the league's row (made on first use). Never for
// SMBHL. Returns the count, or null when nothing was written.
export async function refreshRegularCount(env, leagueId, now = new Date()) {
  if (!env || !env.DB || !leagueId || leagueId === SMBHL_ID) return null;
  const league = await env.DB.prepare('SELECT id, created_by FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!league) return null;
  const n = await regularCount(env.DB, leagueId);
  const at = now.toISOString();
  await env.DB.prepare(
    `INSERT INTO league_billing (league_id, owner_user_id, regular_count, regular_count_at, count_tier, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(league_id) DO UPDATE SET
       regular_count = excluded.regular_count, regular_count_at = excluded.regular_count_at,
       count_tier = excluded.count_tier, updated_at = excluded.updated_at,
       owner_user_id = COALESCE(league_billing.owner_user_id, excluded.owner_user_id)`
  ).bind(leagueId, league.created_by || null, n, at, tierForCount(n), at).run();
  return n;
}

// The Notre Ligue cron, once a day per league: every league (not SMBHL,
// not deactivated) whose count was not refreshed today (UTC). A few per
// pass, so a pass stays short. Silent: no log line unless it fails.
export const DAILY_COUNT_PER_PASS = 25;
export async function refreshDailyRegularCounts(env, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const rows = (await env.DB.prepare(
    `SELECT l.id FROM leagues l
       LEFT JOIN league_billing b ON b.league_id = l.id
      WHERE l.id != ? AND l.deactivated_at IS NULL
        AND (b.regular_count_at IS NULL OR b.regular_count_at < ?)
      ORDER BY l.created_at
      LIMIT ?`
  ).bind(SMBHL_ID, today, DAILY_COUNT_PER_PASS).all()).results || [];
  for (const r of rows) await refreshRegularCount(env, r.id, now);
  return rows.length;
}

// After a roster write route answered 200: the league's count again.
// Never turns the admin's successful write into an error.
export async function afterRosterCountChange(env, leagueId) {
  try { await refreshRegularCount(env, leagueId); }
  catch (e) { console.error(`[billing] count refresh failed for ${leagueId}: ${e.message}`); }
}

// UTC calendar months added (the trial is 2 months): Jan 31 + 1 month is
// the last day of February.
export function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

// The trial: from the league's creation or the launch, whichever is later,
// for TRIAL_MONTHS. A league's own row wins once it has dates. Null while
// billing is off.
export function trialWindow(env, league, row) {
  if (row && row.trial_started_at && row.trial_ends_at) return { start: row.trial_started_at, end: row.trial_ends_at };
  const launch = billingLaunchAt(env);
  if (!launch) return null;
  const created = Date.parse((league && league.created_at) || '');
  const start = new Date(Math.max(launch.getTime(), Number.isFinite(created) ? created : 0));
  return { start: start.toISOString(), end: addMonths(start, TRIAL_MONTHS).toISOString() };
}

// The oldest league keeps the free slot: among one owner's leagues whose
// count is in the free tier, the one created first. leagues: [{ id,
// created_at, count }].
export function freeSlotLeagueId(leagues) {
  const free = (leagues || []).filter(l => tierForCount(l.count) === 'free')
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id)));
  return free.length ? free[0].id : null;
}

// What the super-admin page shows for one league. Pure. status:
//   exempt   SMBHL, or a league marked never billed
//   off      billing is off (BILLING_LAUNCH_AT unset)
//   trial    inside its trial
//   free     free tier, and the owner's free slot (or the free exception)
//   active, past_due, paused, inactive   from its Stripe subscription
//   unpaid   past its trial with no subscription and not free (batch 3
//            gates it; batch 1 only shows it)
export function billingSummary(env, league, row, { freeSlot = null, now = new Date() } = {}) {
  const count = row && row.regular_count != null ? Number(row.regular_count) : null;
  const countTier = count == null ? null : tierForCount(count);
  const base = {
    count, countTier,
    countAt: (row && row.regular_count_at) || null,
    tier: (row && row.tier) || 'free',
    freeException: !!(row && row.free_exception),
    trialEndsAt: null
  };
  if (!league || league.id === SMBHL_ID) return { ...base, status: 'exempt' };
  if (row && row.billing_exempt) return { ...base, status: 'exempt' };
  if (!billingEnabled(env)) return { ...base, status: 'off' };
  const trial = trialWindow(env, league, row);
  const withTrial = { ...base, trialEndsAt: trial ? trial.end : null };
  if (row && row.stripe_subscription_id && ['active', 'past_due', 'paused', 'inactive'].includes(row.status)) return { ...withTrial, status: row.status };
  if (trial && now.getTime() < Date.parse(trial.end)) return { ...withTrial, status: 'trial' };
  if (countTier === 'free' && (base.freeException || freeSlot === league.id)) return { ...withTrial, status: 'free' };
  return { ...withTrial, status: 'unpaid' };
}

// Every league's billing row and summary, for the super-admin list. A
// database without migrate-056 (or any failure) gives an empty map: the
// page still lists the leagues.
export async function billingSummaries(env, leagues, now = new Date()) {
  const out = new Map();
  let rows = [];
  try { rows = (await env.DB.prepare('SELECT * FROM league_billing').all()).results || []; }
  catch (_) { return out; }
  const byId = new Map(rows.map(r => [r.league_id, r]));
  const byOwner = new Map();
  for (const l of leagues) {
    const r = byId.get(l.id);
    const owner = (r && r.owner_user_id) || l.created_by || null;
    if (!owner || l.id === SMBHL_ID) continue;
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push({ id: l.id, created_at: l.created_at, count: r ? r.regular_count : 0 });
  }
  const slotByOwner = new Map([...byOwner].map(([o, ls]) => [o, freeSlotLeagueId(ls)]));
  for (const l of leagues) {
    const r = byId.get(l.id) || null;
    const owner = (r && r.owner_user_id) || l.created_by || null;
    out.set(l.id, billingSummary(env, l, r, { freeSlot: owner ? slotByOwner.get(owner) : null, now }));
  }
  return out;
}

// Super-admin: the free exception (free even when the owner already has a
// free league). Never for SMBHL.
export async function setFreeException(env, leagueId, on) {
  if (!leagueId || leagueId === SMBHL_ID) return { ok: false, error: 'SMBHL is never billed.', errorKey: 'BILLING_SMBHL' };
  const league = await env.DB.prepare('SELECT id, created_by FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!league) return { ok: false, error: 'League not found.', errorKey: 'LEAGUE_NOT_FOUND' };
  const at = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO league_billing (league_id, owner_user_id, free_exception, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(league_id) DO UPDATE SET free_exception = excluded.free_exception, updated_at = excluded.updated_at`
  ).bind(leagueId, league.created_by || null, on ? 1 : 0, at).run();
  return { ok: true };
}

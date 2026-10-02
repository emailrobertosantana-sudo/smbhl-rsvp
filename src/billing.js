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
// only records Stripe's events (src/stripe_webhook.js; 404 without its
// signing secret) for processing at launch. Only the count is kept, which no
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
// Batch 3 added the state (classifyLeague, below): read-only, grace, the
// free slot, the 12-month clock; src/billing_enforcement.js acts on it.

import { montrealDate, montrealMidnight, addDays, addCalendarMonths } from './montreal_time.js';

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

// The paid plan a count needs: over 100 is Plus through Checkout until a
// custom price is agreed (Roberto, 2026-10-02). Free stays free.
export function planTierForCount(n) {
  const t = tierForCount(n);
  return t === 'custom' ? 'plus' : t;
}

// The launch date, or null when billing is off.
export function billingLaunchAt(env) {
  const raw = env && env.BILLING_LAUNCH_AT;
  if (!raw || typeof raw !== 'string') return null;
  // A bare date ('2026-10-02', as on demo) is that Montreal day's start.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return montrealMidnight(raw.trim());
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
// for TRIAL_MONTHS. A league's own row wins once it has dates (a
// subscription's trial, as Stripe keeps it). Null while billing is off.
//
// Montreal time (Roberto, 2026-10-02): the trial covers whole Montreal
// days. Its last day is the start's Montreal day plus TRIAL_MONTHS calendar
// months, and it ends at 00:00 Montreal the day after: a league created on
// October 5 (any hour, Montreal) has its last day on December 5 and is
// read-only (or first charged, the trial_end sent to Checkout) from 00:00 on
// December 6. Notices and pages show the last day as the day the trial
// ends, and that next day as the first payment.
export function trialWindow(env, league, row) {
  if (row && row.trial_started_at && row.trial_ends_at) return { start: row.trial_started_at, end: row.trial_ends_at };
  const launch = billingLaunchAt(env);
  if (!launch) return null;
  const created = Date.parse((league && league.created_at) || '');
  const start = new Date(Math.max(launch.getTime(), Number.isFinite(created) ? created : 0));
  const lastDay = addCalendarMonths(montrealDate(start), TRIAL_MONTHS);
  return { start: start.toISOString(), end: montrealMidnight(addDays(lastDay, 1)).toISOString() };
}

// The oldest league keeps the free slot: among one owner's leagues whose
// count is in the free tier, the one created first. leagues: [{ id,
// created_at, count }].
export function freeSlotLeagueId(leagues) {
  const free = (leagues || []).filter(l => tierForCount(l.count) === 'free')
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id)));
  return free.length ? free[0].id : null;
}

// Batch 3 (enforcement): one owner's free slot. Candidates: the owner's
// active leagues (not deactivated, not SMBHL) that are neither marked never
// billed nor given the free exception (those are free on their own and
// never take the slot). leagues: [{ id, created_at, created_by,
// deactivated_at }]; rowsById: Map of league_billing rows. Returns a Map
// owner -> the league holding the slot.
//
// The slot never swaps (Roberto, 2026-10-02): held (Map owner -> league id,
// loadHeldFreeSlots) is the league that holds it now; it keeps it while it
// still qualifies (under 15, active, no exception), even when an older
// league of the same owner drops back under 15. Only a vacant slot goes to
// the oldest qualifying league.
export function freeSlotsByOwner(leagues, rowsById, held = new Map()) {
  const byOwner = new Map();
  for (const l of leagues || []) {
    if (!l || l.id === SMBHL_ID || l.deactivated_at) continue;
    const r = rowsById.get(l.id) || null;
    if (r && (r.free_exception || r.billing_exempt)) continue;
    const owner = (r && r.owner_user_id) || l.created_by || null;
    if (!owner) continue;
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push({ id: l.id, created_at: l.created_at, count: r ? r.regular_count : 0 });
  }
  return new Map([...byOwner].map(([o, ls]) => {
    const keep = held && held.get(o);
    if (keep && ls.some(x => x.id === keep && tierForCount(x.count) === 'free')) return [o, keep];
    return [o, freeSlotLeagueId(ls)];
  }));
}

// Who holds each owner's free slot, kept in settings (no migration): key
// billing_free_slot:<owner>, value the league id, league_id the league (so
// deleting the league removes the row). Written only by the daily job
// (saveHeldFreeSlots); read by everything that classifies a league. A
// database without the row (or a failure) gives an empty map: the slot then
// goes to the oldest qualifying league, as before.
export const FREE_SLOT_KEY_PREFIX = 'billing_free_slot:';
export async function loadHeldFreeSlots(db, owner = null) {
  const out = new Map();
  try {
    const rows = owner
      ? (await db.prepare('SELECT key, value FROM settings WHERE key = ?').bind(FREE_SLOT_KEY_PREFIX + owner).all()).results || []
      : (await db.prepare('SELECT key, value FROM settings WHERE substr(key, 1, ?) = ?').bind(FREE_SLOT_KEY_PREFIX.length, FREE_SLOT_KEY_PREFIX).all()).results || [];
    for (const r of rows) if (r.value) out.set(r.key.slice(FREE_SLOT_KEY_PREFIX.length), r.value);
  } catch (_) {}
  return out;
}
export async function saveHeldFreeSlots(db, slots, held) {
  for (const [owner, leagueId] of slots) {
    if ((held.get(owner) || null) === (leagueId || null)) continue;
    if (leagueId) {
      await db.prepare(
        `INSERT INTO settings (key, value, league_id) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, league_id = excluded.league_id`
      ).bind(FREE_SLOT_KEY_PREFIX + owner, leagueId, leagueId).run();
    } else {
      await db.prepare('DELETE FROM settings WHERE key = ?').bind(FREE_SLOT_KEY_PREFIX + owner).run();
    }
  }
}

// Free: a count under 15 and either the free exception or the owner's free
// slot.
export function isFreeEligible(league, row, slotByOwner) {
  if (!league) return false;
  if (row && row.free_exception) return true;
  const owner = (row && row.owner_user_id) || league.created_by || null;
  return !!owner && slotByOwner.get(owner) === league.id;
}

export const GRACE_DAYS = 14;
export const INACTIVE_DELETE_MONTHS = 12;
const LIVE_STATUSES = ['active', 'past_due', 'paused'];

// Batch 3: where a league stands, and what that means. Pure.
//   status   exempt | off | trial | free | active | past_due | paused |
//            grace | unpaid
//   readOnly every change refused (src/write_guard.js mode 'billing'),
//            automatic emails stopped; players still answer
//   reason   trial_ended | trial_no_card | paused | payment_failed |
//            cancelled (when readOnly)
//   mailStopped  automatic emails stopped: read-only, or a free league
//            past its 14 days at 15 players or more
//   inactive the 12-month clock runs (trial ended unpaid, or cancelled)
// A free league that reaches 15 (row.status 'free', written by the daily
// job, src/billing_enforcement.js) is in its grace, never read-only.
// Above 100 players a league is treated like any other (trial, read-only,
// notices, the 12-month clock); it subscribes to Plus through Checkout until
// a custom price is agreed (Roberto, 2026-10-02).
// A live subscription decides before the trial: a league that subscribed
// inside its trial is active, paused or past due as Stripe says.
export function classifyLeague(env, league, row, { freeEligible = false, now = new Date() } = {}) {
  const count = row && row.regular_count != null ? Number(row.regular_count) : 0;
  const countTier = tierForCount(count);
  const base = { count, countTier, freeEligible: !!freeEligible, readOnly: false, reason: null, mailStopped: false, inactive: false, trialEnd: null, graceEndsAt: null };
  if (!league || league.id === SMBHL_ID || (row && row.billing_exempt)) return { ...base, status: 'exempt' };
  if (!billingEnabled(env)) return { ...base, status: 'off' };
  const trial = trialWindow(env, league, row);
  const s = { ...base, trialEnd: trial ? trial.end : null };
  const ro = reason => ({ ...s, readOnly: true, mailStopped: true, reason });
  const live = !!(row && row.stripe_subscription_id && LIVE_STATUSES.includes(row.status));
  if (live && row.status === 'active') return { ...s, status: 'active' };
  // Stripe's own pause (status 'paused'): the trial ended with no card.
  // That one is an unpaid trial: its 12-month clock runs. A pause the owner
  // chose (pause_collection) never does.
  if (live && row.status === 'paused') {
    const noCard = row.stripe_status === 'paused';
    return { ...ro(noCard ? 'trial_no_card' : 'paused'), status: 'paused', inactive: noCard };
  }
  if (live && row.status === 'past_due') return { ...ro('payment_failed'), status: 'past_due' };
  if (trial && now.getTime() < Date.parse(trial.end)) return { ...s, status: 'trial' };
  if (countTier === 'free' && freeEligible) return { ...s, status: 'free' };
  if (row && (row.grace_ends_at || row.status === 'free')) {
    const ended = !!(row.grace_ends_at && now.getTime() >= Date.parse(row.grace_ends_at));
    return { ...s, status: 'grace', graceEndsAt: row.grace_ends_at || null, mailStopped: ended };
  }
  // Cancelled after a paid period; otherwise the trial ended unpaid (a
  // subscription cancelled inside its trial included).
  const cancelled = !!(row && row.stripe_subscription_id && row.status === 'inactive' && row.last_paid_at);
  return { ...ro(cancelled ? 'cancelled' : 'trial_ended'), status: 'unpaid', inactive: true };
}

// A league's state, read now. Null when billing is off, on SMBHL, or for a
// league that does not exist. The free slot is looked up only when it can
// matter (a count under 15 with no exception).
export async function leagueStateFor(env, league, row, now = new Date()) {
  if (!league || league.id === SMBHL_ID || !billingEnabled(env)) return null;
  let freeEligible = !!(row && row.free_exception);
  if (!freeEligible && tierForCount(row && row.regular_count) === 'free') {
    const owner = (row && row.owner_user_id) || league.created_by || null;
    if (owner) {
      const sibs = (await env.DB.prepare(
        `SELECT l.id, l.created_at, l.created_by, l.deactivated_at, b.owner_user_id, b.regular_count, b.free_exception, b.billing_exempt
           FROM leagues l LEFT JOIN league_billing b ON b.league_id = l.id
          WHERE COALESCE(b.owner_user_id, l.created_by) = ? AND l.id != ?`
      ).bind(owner, SMBHL_ID).all()).results || [];
      const rows = new Map(sibs.map(x => [x.id, { ...x, league_id: x.id }]));
      freeEligible = isFreeEligible(league, row, freeSlotsByOwner(sibs, rows, await loadHeldFreeSlots(env.DB, owner)));
    }
  }
  return classifyLeague(env, league, row, { freeEligible, now });
}

export async function loadLeagueState(env, leagueId, now = new Date()) {
  if (!env || env.LEAGUE_PRODUCT !== 'true' || !billingEnabled(env) || !leagueId || leagueId === SMBHL_ID) return null;
  const league = await env.DB.prepare('SELECT id, name, created_at, created_by, deactivated_at FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!league) return null;
  const row = await env.DB.prepare('SELECT * FROM league_billing WHERE league_id = ?').bind(leagueId).first();
  return leagueStateFor(env, league, row, now);
}

// For the automatic emails (reminder waves, sub calls, admin alerts):
// stopped while the league is read-only or past its grace. False while
// billing is off (no query at all), on SMBHL, and when the check fails.
export async function leagueAutoMailStopped(env, leagueId, now = new Date()) {
  if (!env || env.LEAGUE_PRODUCT !== 'true' || !billingEnabled(env) || !leagueId || leagueId === SMBHL_ID) return false;
  try {
    const st = await loadLeagueState(env, leagueId, now);
    return !!(st && st.mailStopped);
  } catch (e) {
    console.error(`[billing] mail check for ${leagueId}: ${e.message}`);
    return false;
  }
}

// What the super-admin page (and the health and the daily digest, through
// src/league_health.js) shows for one league. Pure. The status is the
// league's real state, classifyLeague's, the one the billing page and the
// read-only gate use, never Stripe's raw subscription status: a
// subscription cancelled inside its trial leaves the league in its trial.
//   exempt   SMBHL, or a league marked never billed
//   off      billing is off (BILLING_LAUNCH_AT unset)
//   trial    inside its trial, with no live subscription
//   free     free tier, and the owner's free slot (or the free exception)
//   active, past_due, paused   a live Stripe subscription
//   grace    a free league that reached 15 regular players
//   inactive cancelled after a paid period, read-only
//   unpaid   past its trial with no subscription and not free, read-only
// freeSlot: the league holding its owner's free slot (freeSlotsByOwner).
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
  const freeEligible = !!(league && (base.freeException || freeSlot === league.id));
  const st = classifyLeague(env, league, row, { freeEligible, now });
  const status = st.status === 'unpaid' && st.reason === 'cancelled' ? 'inactive' : st.status;
  return { ...base, trialEndsAt: st.trialEnd, status, readOnly: st.readOnly };
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
  // The same free slot the enforcement uses (deactivated leagues and
  // exceptions never hold it).
  const slotByOwner = freeSlotsByOwner(leagues, byId, await loadHeldFreeSlots(env.DB));
  for (const l of leagues) {
    const r = byId.get(l.id) || null;
    const owner = (r && r.owner_user_id) || l.created_by || null;
    out.set(l.id, billingSummary(env, l, r, { freeSlot: owner ? slotByOwner.get(owner) : null, now }));
  }
  return out;
}

// Super-admin: the free exception (free even when the owner already has a
// free league; the count must still be under 15). Never for SMBHL.
export async function setFreeException(env, leagueId, on) {
  if (!leagueId || leagueId === SMBHL_ID) return { ok: false, error: 'SMBHL is never billed.', errorKey: 'BILLING_SMBHL' };
  const league = await env.DB.prepare('SELECT id, created_by FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!league) return { ok: false, error: 'League not found.', errorKey: 'LEAGUE_NOT_FOUND' };
  const at = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO league_billing (league_id, owner_user_id, free_exception, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(league_id) DO UPDATE SET free_exception = excluded.free_exception, updated_at = excluded.updated_at`
  ).bind(leagueId, league.created_by || null, on ? 1 : 0, at).run();
  // Batch 3: the exception unlocks at once (a free league is never read-only,
  // in grace or on the 12-month clock). The daily job does the same on its
  // next pass; this is so the super-admin does not wait for it.
  if (on) {
    await env.DB.prepare(
      `UPDATE league_billing SET read_only_since = NULL, emails_paused_since = NULL, grace_ends_at = NULL, inactive_since = NULL
        WHERE league_id = ? AND COALESCE(status, '') NOT IN ('active', 'past_due', 'paused') AND COALESCE(regular_count, 0) <= ?`
    ).bind(leagueId, TIER_LIMITS.free).run();
  }
  return { ok: true };
}

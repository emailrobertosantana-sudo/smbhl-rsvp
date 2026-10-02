// Notre Ligue billing, batch 3 of 3: enforcement, from the Notre Ligue cron
// (index.js runCronPass), every pass. Idempotent and safe to run twice:
// each notice is recorded once in billing_notices (INSERT, primary key)
// before it is queued, each flag is written only when it changes, and the
// deletion re-reads the league right before it.
//
// For each Notre Ligue league (not SMBHL, not deactivated, not marked never
// billed), from its state (src/billing.js classifyLeague):
//   - the flags kept in league_billing: read_only_since (read-only),
//     grace_ends_at and emails_paused_since (a free league at 15 players),
//     inactive_since (the 12-month clock), status 'free' (the marker that
//     tells a free league reaching 15 from a trial that ended unpaid);
//   - a subscription Stripe paused at its trial's end is resumed once a card
//     is on file (decision 3, src/stripe_webhook.js resumeIfCardAdded);
//   - the notices (src/billing_notices.js), through the outbox, once each:
//     trial in 7 days and on the day, read-only at the trial's end, a free
//     league at 15 (14 days), grace ended, a tier change at the next billing
//     date, a failed payment, over 100 players, deletion in 30 and 7 days;
//   - the 12-month deletion of an inactive league, through the existing
//     deletion flow (src/hard_delete.js performLeagueHardDelete), only after
//     both deletion notices: at the earliest 30 days after the first and 7
//     days after the second.
// Nothing at all while BILLING_LAUNCH_AT is unset: the first thing it does
// is return. SMBHL is never read.
import { billingEnabled, SMBHL_ID, classifyLeague, freeSlotsByOwner, isFreeEligible, addMonths, leagueStateFor, GRACE_DAYS, INACTIVE_DELETE_MONTHS } from './billing.js';
import { subscriptionHasCard, resumeIfCardAdded } from './stripe_webhook.js';
import { renderBillingNotice, OWNER_NOTICES, BILLING_NOTICE_KIND } from './billing_notices.js';
import { performLeagueHardDelete } from './hard_delete.js';
import { stripeRequest, stripeId } from './stripe.js';

const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();

// host: { enqueue({ leagueId, to, mail, dedupKey }), drainLeague(leagueId),
// adminEmails(leagueId) -> [{ email }], ownerEmail(leagueId) -> string|null,
// publicUrl }. Returns { checked, notices, deleted }.
export async function runBillingEnforcement(env, host, now = new Date()) {
  const out = { checked: 0, notices: 0, deleted: 0 };
  if (!billingEnabled(env) || env.LEAGUE_PRODUCT !== 'true') return out;
  const leagues = (await env.DB.prepare(
    `SELECT id, name, created_at, created_by, deactivated_at, language_mode FROM leagues WHERE id != ?`
  ).bind(SMBHL_ID).all()).results || [];
  const rows = (await env.DB.prepare('SELECT * FROM league_billing').all()).results || [];
  const byId = new Map(rows.map(r => [r.league_id, r]));
  const slots = freeSlotsByOwner(leagues, byId);
  for (const league of leagues) {
    if (league.deactivated_at) continue;
    const row = byId.get(league.id) || null;
    if (row && row.billing_exempt) continue;
    out.checked++;
    try {
      const r = await enforceLeague(env, host, league, row, isFreeEligible(league, row, slots), now);
      out.notices += r.notices;
      if (r.deleted) out.deleted++;
    } catch (e) {
      console.error(`[billing] enforcement for ${league.id}: ${e.message}`);
    }
  }
  return out;
}

async function enforceLeague(env, host, league, row, freeEligible, now) {
  const res = { notices: 0, deleted: false };
  let state = classifyLeague(env, league, row, { freeEligible, now });
  if (state.status === 'exempt' || state.status === 'off') return res;

  // Decision 3: Stripe paused it at the trial's end; a card added since
  // resumes it (and unlocks the league when the payment goes through).
  if (state.reason === 'trial_no_card' && env.STRIPE_SECRET_KEY) {
    try {
      const r = await resumeIfCardAdded(env, league.id, now);
      if (r.resumed || r.synced) {
        row = await env.DB.prepare('SELECT * FROM league_billing WHERE league_id = ?').bind(league.id).first();
        state = classifyLeague(env, league, row, { freeEligible, now });
      }
    } catch (e) { console.error(`[billing] resume check for ${league.id}: ${e.message}`); }
  }

  row = await writeFlags(env, league, row, state, now);
  // The grace's end, as just written (the first pass in grace sets it).
  if (state.status === 'grace' && !state.graceEndsAt) state = { ...state, graceEndsAt: row.grace_ends_at };

  const send = (kind, periodKey, vars) => sendOnce(env, host, league, kind, periodKey, vars, now).then(sent => { if (sent) res.notices++; return sent; });
  const live = !!(row && row.stripe_subscription_id && ['active', 'past_due', 'paused'].includes(row.status));
  const nowMs = now.getTime();

  // The trial ends in 7 days, and on the day (within its last 24 hours):
  // to the owner, unless the league will be free or is above 100. Subscribed
  // with a card: nothing to do. Subscribed without one: add a card.
  // (A league that subscribed inside its trial is 'active' and keeps its
  // trial: the subscription's own trial end.)
  const left = state.trialEnd ? Date.parse(state.trialEnd) - nowMs : 0;
  const trialing = (state.status === 'trial' && !live) || (state.status === 'active' && live);
  if (trialing && left > 0 && left <= 7 * DAY) {
    const needsPlan = live || (!(state.countTier === 'free' && freeEligible) && state.countTier !== 'custom');
    const kind = left <= DAY ? 'trial_day' : 'trial_7d';
    if (needsPlan && !(await noticeSent(env, league.id, kind, state.trialEnd))) {
      // Subscribed: only when no card is on file (Stripe, asked once per notice).
      if (live && await subscriptionHasCard(env, row)) await recordNotice(env, league.id, kind, state.trialEnd, now);
      else await send(kind, state.trialEnd, { date: state.trialEnd, variant: live ? 'card' : 'subscribe' });
    }
  }

  // The trial ended without a subscription (or with one Stripe paused for
  // want of a card): the league is read-only. Every admin.
  if ((state.status === 'unpaid' && state.reason === 'trial_ended') || state.reason === 'trial_no_card') {
    const end = state.trialEnd || (row && row.trial_ends_at);
    if (end) await send('trial_end', end, { variant: state.reason === 'trial_no_card' ? 'card' : 'subscribe' });
  }

  // A free league at 15 regular players: 14 days to subscribe (the owner),
  // then its automatic emails stop (every admin).
  if (state.status === 'grace' && state.graceEndsAt) {
    await send('grace_start', state.graceEndsAt, { date: state.graceEndsAt, count: state.count });
    if (state.mailStopped) await send('grace_end', state.graceEndsAt, {});
  }

  // A paid league whose count belongs in the other paid tier: the change
  // applies at the next billing date (src/billing_actions.js runTierChanges).
  if (state.status === 'active' && live && !row.cancel_at_period_end && row.current_period_end
      && ['standard', 'plus'].includes(state.countTier) && ['standard', 'plus'].includes(row.tier) && state.countTier !== row.tier) {
    await send('tier_change', `${state.countTier}:${row.current_period_end}`, {
      date: row.current_period_end, count: state.count, oldTier: row.tier, newTier: state.countTier, interval: row.billing_interval
    });
  }

  // A failed payment, still unpaid: once per billing period, to the owner.
  if (state.status === 'past_due') await send('payment_failed', (row && row.current_period_end) || 'unknown', {});

  // Above 100 regular players: once, to the owner (and the operator's digest,
  // src/ops_digest.js, from this notice's record). No gating.
  if (state.countTier === 'custom') await send('over_100', 'count', { count: state.count });

  // The 12-month clock.
  if (state.inactive && row && row.inactive_since) {
    const r = await deletionStep(env, host, league, row, freeEligible, now, send);
    if (r === 'deleted') res.deleted = true;
  }
  return res;
}

// The flags this state implies; written only when one changes, and only
// if the row is still what was classified (a webhook may have written it
// meanwhile: the next pass then decides). Returns the row as it now is.
async function writeFlags(env, league, row, state, now) {
  const nowIso = now.toISOString();
  if (!row) {
    await env.DB.prepare(
      `INSERT INTO league_billing (league_id, owner_user_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(league_id) DO NOTHING`
    ).bind(league.id, league.created_by || null, nowIso).run();
    row = await env.DB.prepare('SELECT * FROM league_billing WHERE league_id = ?').bind(league.id).first();
  }
  const live = !!(row.stripe_subscription_id && ['active', 'past_due', 'paused'].includes(row.status));
  const want = {
    read_only_since: state.readOnly ? (row.read_only_since || nowIso) : null,
    grace_ends_at: state.status === 'grace' ? (row.grace_ends_at || iso(now.getTime() + GRACE_DAYS * DAY)) : null,
    emails_paused_since: state.status === 'grace' && state.mailStopped ? (row.emails_paused_since || row.grace_ends_at || nowIso) : null,
    // An unpaid trial counts from the trial's end; a cancellation from when
    // Stripe ended it (writeSubscription) or, failing that, now.
    inactive_since: state.inactive
      ? ((['trial_ended', 'trial_no_card'].includes(state.reason) && state.trialEnd ? state.trialEnd : null) || row.inactive_since || nowIso)
      : null,
    status: state.status === 'free' && !live ? 'free' : row.status
  };
  const changed = Object.keys(want).filter(k => (want[k] || null) !== (row[k] || null));
  if (!changed.length) return row;
  await env.DB.prepare(
    `UPDATE league_billing SET ${changed.map(k => `${k} = ?`).join(', ')}, updated_at = ?
      WHERE league_id = ? AND COALESCE(status, '') = ? AND COALESCE(stripe_subscription_id, '') = ?`
  ).bind(...changed.map(k => want[k]), nowIso, league.id, row.status || '', row.stripe_subscription_id || '').run();
  return await env.DB.prepare('SELECT * FROM league_billing WHERE league_id = ?').bind(league.id).first();
}

async function noticeRow(env, leagueId, kind, periodKey) {
  return await env.DB.prepare('SELECT sent_at FROM billing_notices WHERE league_id = ? AND kind = ? AND period_key = ?').bind(leagueId, kind, periodKey).first();
}
async function noticeSent(env, leagueId, kind, periodKey) {
  return !!(await noticeRow(env, leagueId, kind, periodKey));
}
async function recordNotice(env, leagueId, kind, periodKey, now) {
  const r = await env.DB.prepare(
    `INSERT INTO billing_notices (league_id, kind, period_key, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT(league_id, kind, period_key) DO NOTHING`
  ).bind(leagueId, kind, periodKey, now.toISOString()).run();
  return !!(r && r.meta && r.meta.changes === 1);
}

// Records the notice, then queues it for its recipients. A second pass (or
// one running at the same time) finds the record and sends nothing. When
// queueing fails, the record is removed so the next pass tries again.
async function sendOnce(env, host, league, kind, periodKey, vars, now) {
  if (await noticeSent(env, league.id, kind, periodKey)) return false;
  if (!(await recordNotice(env, league.id, kind, periodKey, now))) return false;
  try {
    let to = [];
    if (OWNER_NOTICES.has(kind)) {
      const owner = await host.ownerEmail(league.id);
      to = owner ? [owner] : (await host.adminEmails(league.id)).map(a => a.email);
    } else {
      to = (await host.adminEmails(league.id)).map(a => a.email);
    }
    to = [...new Set(to.filter(Boolean).map(e => String(e).trim()).filter(Boolean))];
    const mail = renderBillingNotice(kind, {
      ...vars, leagueName: league.name, languageMode: league.language_mode,
      billingUrl: `${host.publicUrl || 'https://rsvp.notreligue.ca'}/league/billing?league_id=${encodeURIComponent(league.id)}`
    });
    let i = 0;
    for (const addr of to) await host.enqueue({ leagueId: league.id, to: addr, mail, dedupKey: `${BILLING_NOTICE_KIND}:${league.id}:${kind}:${periodKey}:${i++}` });
    if (to.length) await host.drainLeague(league.id);
  } catch (e) {
    await env.DB.prepare('DELETE FROM billing_notices WHERE league_id = ? AND kind = ? AND period_key = ?').bind(league.id, kind, periodKey).run();
    throw e;
  }
  return true;
}

// The clock: inactive_since + 12 months. The 30-day notice first; the
// 7-day notice at the earliest 30 days after it was sent (a late first
// notice moves the date); the deletion at the earliest 7 days after the
// second. Subscribing clears inactive_since (src/stripe_webhook.js
// writeSubscription) and the clock starts over; a paused league is never
// inactive. Returns 'deleted' or null.
export function deletionDates(row, n30, n7) {
  const deleteAt = addMonths(new Date(row.inactive_since), INACTIVE_DELETE_MONTHS).getTime();
  const after30 = n30 ? Math.max(deleteAt, Date.parse(n30.sent_at) + 30 * DAY) : deleteAt;
  const after7 = n7 ? Math.max(after30, Date.parse(n7.sent_at) + 7 * DAY) : after30;
  return { deleteAt, after30, after7 };
}

async function deletionStep(env, host, league, row, freeEligible, now, send) {
  const key = row.inactive_since;
  const nowMs = now.getTime();
  const n30 = await noticeRow(env, league.id, 'deletion_30d', key);
  const n7 = await noticeRow(env, league.id, 'deletion_7d', key);
  const { deleteAt, after30, after7 } = deletionDates(row, n30, n7);
  if (!n30) {
    if (nowMs >= deleteAt - 30 * DAY) await send('deletion_30d', key, { date: iso(Math.max(deleteAt, nowMs + 30 * DAY)), since: key });
    return null;
  }
  if (!n7) {
    if (nowMs >= after30 - 7 * DAY) await send('deletion_7d', key, { date: iso(Math.max(after30, nowMs + 7 * DAY)), since: key });
    return null;
  }
  if (nowMs < after7) return null;
  // Right before: the league as it is now. Anything that stopped the clock
  // (a subscription, the free slot, a pause) stops the deletion.
  const fresh = await env.DB.prepare('SELECT id, name, created_at, created_by, deactivated_at FROM leagues WHERE id = ?').bind(league.id).first();
  if (!fresh || fresh.id === SMBHL_ID) return null;
  const freshRow = await env.DB.prepare('SELECT * FROM league_billing WHERE league_id = ?').bind(league.id).first();
  const st = await leagueStateFor(env, fresh, freshRow, now);
  if (!st || !st.inactive || !freshRow || freshRow.inactive_since !== key || freshRow.billing_exempt) return null;
  // A subscription Stripe still keeps paused (a trial that ended with no
  // card) is cancelled first, so nothing is left at Stripe for a league that
  // no longer exists. Cancelled or ended ones are left as they are.
  if (freshRow.stripe_subscription_id && freshRow.stripe_status && !['canceled', 'incomplete_expired'].includes(freshRow.stripe_status)) {
    await stripeRequest(env, 'DELETE', `/subscriptions/${stripeId(freshRow.stripe_subscription_id)}`);
  }
  await performLeagueHardDelete(env, league.id, fresh.name, null, 'billing_inactive_12_months');
  console.log(`[billing] league ${league.id} deleted after 12 months inactive (since ${key})`);
  return 'deleted';
}

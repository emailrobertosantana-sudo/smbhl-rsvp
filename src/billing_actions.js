// Notre Ligue billing, batch 2 of 3: what an admin can do on the billing
// page (/league/billing), and the tier change at renewal. The page itself is
// in src/index.js (handleLeagueBillingPage); src/billing.js has the count
// and the trial, src/stripe_webhook.js keeps league_billing current.
//
//   Checkout: Stripe's hosted page (a redirect), subscription mode, the
//   price for the tier the count implies and the chosen interval. A league
//   inside its trial keeps the rest of it: the subscription's trial ends
//   with the league's, and the first charge is then. No card is asked when
//   nothing is due (payment_method_collection if_required); a subscription
//   still in its trial without a card is paused by Stripe when the trial
//   ends (trial_settings end_behavior missing_payment_method pause), so a
//   card is required then unless the total is 0.
//   Portal: Stripe's Customer Portal, the account's default configuration.
//   Pause: monthly only, pause_collection with behavior void (no invoice is
//   collected while paused, for as long as it lasts). Resume: the pause is
//   cleared and, past the trial, the billing cycle starts again that day
//   (billing_cycle_anchor now, no proration); in the trial, only the pause
//   is cleared (Stripe keeps a trialing subscription's anchor).
//   Tier change: the price changes for the next billing date, never mid
//   period: once a day, a subscription whose stored count belongs in the
//   other paid tier gets the other price, with no proration, within the
//   last 36 hours before its renewal, so the renewal invoice is the first
//   at the new price.
// Only the league's owner (leagues.created_by) acts; every admin sees the
// page. SMBHL is never billed. Nothing happens while billing is off.
import { billingEnabled, refreshRegularCount, tierForCount, planTierForCount, trialWindow, leagueStateFor, SMBHL_ID } from './billing.js';
import { stripeRequest, stripeId } from './stripe.js';
import { writeSubscription } from './stripe_webhook.js';

export const PRICE_CENTS = { standard: { month: 999, year: 9990 }, plus: { month: 1999, year: 19990 } };
export const TIER_CHANGE_WINDOW_HOURS = 36;
const DAY = 86400000;

export function priceIdFor(env, tier, interval) {
  const key = `STRIPE_PRICE_${String(tier).toUpperCase()}_${interval === 'year' ? 'YEARLY' : 'MONTHLY'}`;
  return env[key] || null;
}

// « 9,99 $ » / "$9.99" (CAD).
export function money(cents, lang) {
  const v = (Number(cents) / 100).toFixed(2);
  return lang === 'en' ? `$${v}` : `${v.replace('.', ',')} $`;
}

// A subscription that is still going (trialing, active, past due, paused):
// the page offers the portal instead of a second Checkout.
export function hasLiveSubscription(row) {
  return !!(row && row.stripe_subscription_id && ['active', 'past_due', 'paused'].includes(row.status));
}

// Everything the page shows, read fresh: the count (refreshed now), the
// tier it implies, the trial, the subscription.
export async function billingView(env, leagueId, now = new Date()) {
  const league = await env.DB.prepare('SELECT id, name, created_by, created_at FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!league || leagueId === SMBHL_ID) return null;
  const count = (await refreshRegularCount(env, leagueId, now)) || 0;
  const row = await env.DB.prepare('SELECT * FROM league_billing WHERE league_id = ?').bind(leagueId).first();
  const trial = trialWindow(env, league, row);
  const trialLeftMs = trial ? Date.parse(trial.end) - now.getTime() : 0;
  const countTier = tierForCount(count);
  // Batch 3: the league's state (read-only, grace, ...) and the plan it
  // needs. A league under 15 that is not its owner's free one (the oldest
  // keeps the free slot) needs the Standard plan.
  const state = await leagueStateFor(env, league, row, now);
  const freeEligible = !!(state && state.freeEligible);
  // Over 100: Plus through Checkout until a custom price is agreed.
  const planTier = countTier === 'free' && !freeEligible ? 'standard' : planTierForCount(count);
  const paidTier = planTierForCount(count);
  return {
    league, row, count, countTier, state, freeEligible, planTier,
    trial: trial ? { end: trial.end, daysLeft: trialLeftMs > 0 ? Math.ceil(trialLeftMs / DAY) : 0 } : null,
    live: hasLiveSubscription(row),
    pendingTier: hasLiveSubscription(row) && ['standard', 'plus'].includes(paidTier) && ['standard', 'plus'].includes(row.tier) && row.tier !== paidTier ? paidTier : null
  };
}

export async function ownerOf(env, leagueId) {
  return await env.DB.prepare(
    `SELECT u.id, u.email FROM leagues l JOIN users u ON u.id = l.created_by WHERE l.id = ?`
  ).bind(leagueId).first();
}

// The Checkout session; returns its URL (Stripe's hosted page).
export async function createCheckout(env, leagueId, interval, { origin, lang, now = new Date(), idempotencyKey = null }) {
  if (!billingEnabled(env)) return { ok: false, errorKey: 'BILLING_OFF', status: 404 };
  if (interval !== 'month' && interval !== 'year') return { ok: false, errorKey: 'BILLING_BAD_INTERVAL', status: 400 };
  const view = await billingView(env, leagueId, now);
  if (!view) return { ok: false, errorKey: 'BILLING_NOT_AVAILABLE', status: 404 };
  if (view.live) return { ok: false, errorKey: 'BILLING_ALREADY_SUBSCRIBED', status: 409 };
  if (!['standard', 'plus'].includes(view.planTier)) return { ok: false, errorKey: view.planTier === 'free' ? 'BILLING_FREE' : 'BILLING_CUSTOM', status: 409 };
  const price = priceIdFor(env, view.planTier, interval);
  if (!price) return { ok: false, errorKey: 'BILLING_NOT_CONFIGURED', status: 503 };
  const owner = await ownerOf(env, leagueId);
  const back = `${origin}/league/billing`;
  const params = {
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    client_reference_id: leagueId,
    metadata: { league_id: leagueId },
    subscription_data: { metadata: { league_id: leagueId } },
    allow_promotion_codes: 'true',
    payment_method_collection: 'if_required',
    locale: lang === 'en' ? 'en' : 'fr-CA',
    success_url: `${back}?status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${back}?status=cancel`
  };
  if (view.row && view.row.stripe_customer_id) params.customer = view.row.stripe_customer_id;
  else if (owner && owner.email) params.customer_email = owner.email;
  // Inside the trial: the rest of it is kept (Stripe needs the end at least
  // 48 hours away); no card, the subscription pauses at the trial's end.
  if (view.trial && Date.parse(view.trial.end) - now.getTime() >= 48 * 3600000) {
    params.subscription_data.trial_end = Math.floor(Date.parse(view.trial.end) / 1000);
    params.subscription_data.trial_settings = { end_behavior: { missing_payment_method: 'pause' } };
  }
  const session = await stripeRequest(env, 'POST', '/checkout/sessions', params, { idempotencyKey: idempotencyKey || crypto.randomUUID() });
  return { ok: true, url: session.url };
}

// Back from Checkout: the session is read and, when it belongs to this
// league and is complete, its subscription written now (the webhook will
// write the same).
export async function syncAfterCheckout(env, leagueId, sessionId) {
  if (!billingEnabled(env) || !sessionId) return false;
  const session = await stripeRequest(env, 'GET', `/checkout/sessions/${stripeId(sessionId)}`);
  const ref = session.client_reference_id || (session.metadata && session.metadata.league_id);
  if (ref !== leagueId || session.status !== 'complete' || !session.subscription) return false;
  const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
  await writeSubscription(env, subId, { leagueId, customerId: typeof session.customer === 'string' ? session.customer : null });
  return true;
}

export async function createPortal(env, leagueId, { origin, lang }) {
  if (!billingEnabled(env)) return { ok: false, errorKey: 'BILLING_OFF', status: 404 };
  const row = await env.DB.prepare('SELECT stripe_customer_id FROM league_billing WHERE league_id = ?').bind(leagueId).first();
  if (!row || !row.stripe_customer_id) return { ok: false, errorKey: 'BILLING_NO_CUSTOMER', status: 409 };
  const s = await stripeRequest(env, 'POST', '/billing_portal/sessions', {
    customer: row.stripe_customer_id,
    return_url: `${origin}/league/billing`,
    locale: lang === 'en' ? 'en' : 'fr-CA'
  }, { idempotencyKey: crypto.randomUUID() });
  return { ok: true, url: s.url };
}

// A Stripe subscription still in its trial: Stripe says trialing, or its
// trial ends later than now.
export function subscriptionInTrial(sub, now = new Date()) {
  if (!sub) return false;
  if (sub.status === 'trialing') return true;
  return !!(sub.trial_end && Number(sub.trial_end) * 1000 > now.getTime());
}

async function liveRow(env, leagueId) {
  const row = await env.DB.prepare('SELECT * FROM league_billing WHERE league_id = ?').bind(leagueId).first();
  return hasLiveSubscription(row) ? row : null;
}

// Monthly only. pause_collection void: Stripe keeps the subscription and
// voids each invoice while paused, so nothing is charged, for as long as it
// lasts. The league is marked paused (stripe_webhook writeSubscription).
export async function pauseSubscription(env, leagueId, now = new Date()) {
  if (!billingEnabled(env)) return { ok: false, errorKey: 'BILLING_OFF', status: 404 };
  const row = await liveRow(env, leagueId);
  if (!row) return { ok: false, errorKey: 'BILLING_NO_SUBSCRIPTION', status: 409 };
  if (row.billing_interval !== 'month') return { ok: false, errorKey: 'BILLING_PAUSE_MONTHLY_ONLY', status: 409 };
  if (row.status === 'paused') return { ok: true };
  await stripeRequest(env, 'POST', `/subscriptions/${stripeId(row.stripe_subscription_id)}`,
    { pause_collection: { behavior: 'void' } },
    { idempotencyKey: `pause:${row.stripe_subscription_id}:${now.toISOString().slice(0, 10)}` });
  await writeSubscription(env, row.stripe_subscription_id, { leagueId });
  return { ok: true };
}

// Past its trial, the pause is cleared and billing restarts that day: a new
// billing cycle from now, the full period invoiced today, no proration.
// Still in its trial, only the pause is cleared: Stripe refuses to move the
// billing cycle anchor of a trialing subscription (400, billing_cycle_anchor),
// and the first charge stays at the trial's end. The app maps Stripe's
// trialing to active, so the live subscription is read first to tell.
export async function resumeSubscription(env, leagueId, now = new Date()) {
  if (!billingEnabled(env)) return { ok: false, errorKey: 'BILLING_OFF', status: 404 };
  const row = await liveRow(env, leagueId);
  if (!row) return { ok: false, errorKey: 'BILLING_NO_SUBSCRIPTION', status: 409 };
  if (row.status !== 'paused') return { ok: true };
  const path = `/subscriptions/${stripeId(row.stripe_subscription_id)}`;
  const live = await stripeRequest(env, 'GET', path);
  const trialing = subscriptionInTrial(live, now);
  await stripeRequest(env, 'POST', path,
    trialing ? { pause_collection: '' } : { pause_collection: '', billing_cycle_anchor: 'now', proration_behavior: 'none' },
    { idempotencyKey: `resume:${row.stripe_subscription_id}:${now.toISOString().slice(0, 10)}:${trialing ? 'trial' : 'cycle'}` });
  await writeSubscription(env, row.stripe_subscription_id, { leagueId });
  return { ok: true };
}

// Once a day per league is enough, but it is cheap and idempotent, so the
// cron calls it every pass. The price moves to the tier the count implies
// within the last TIER_CHANGE_WINDOW_HOURS before the renewal, with no
// proration: the renewal invoice is the first at the new price. A count
// over 100 is Plus (until a custom price is agreed); a subscription on a
// custom price is never changed; free counts are left to the enforcement.
export async function runTierChanges(env, now = new Date()) {
  if (!billingEnabled(env)) return 0;
  const until = new Date(now.getTime() + TIER_CHANGE_WINDOW_HOURS * 3600000).toISOString();
  const rows = (await env.DB.prepare(
    `SELECT * FROM league_billing
      WHERE stripe_subscription_id IS NOT NULL AND status = 'active' AND cancel_at_period_end = 0
        AND count_tier IN ('standard', 'plus', 'custom') AND tier IN ('standard', 'plus')
        AND (CASE WHEN count_tier = 'custom' THEN 'plus' ELSE count_tier END) != tier
        AND current_period_end IS NOT NULL AND current_period_end > ? AND current_period_end <= ?`
  ).bind(now.toISOString(), until).all()).results || [];
  let changed = 0;
  for (const row of rows) {
    const price = priceIdFor(env, row.count_tier === 'custom' ? 'plus' : row.count_tier, row.billing_interval);
    if (!price) continue;
    const sub = await stripeRequest(env, 'GET', `/subscriptions/${stripeId(row.stripe_subscription_id)}`);
    const item = sub.items && sub.items.data && sub.items.data[0];
    if (!item || (item.price && item.price.id === price)) continue;
    await stripeRequest(env, 'POST', `/subscriptions/${stripeId(row.stripe_subscription_id)}`,
      { items: [{ id: item.id, price }], proration_behavior: 'none' },
      { idempotencyKey: `tier:${row.stripe_subscription_id}:${price}:${row.current_period_end}` });
    await writeSubscription(env, row.stripe_subscription_id, { leagueId: row.league_id });
    changed++;
  }
  return changed;
}

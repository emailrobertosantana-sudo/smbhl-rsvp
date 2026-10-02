// POST /billing/stripe-webhook: Stripe's events for Notre Ligue billing
// (batch 1 of 3, src/billing.js).
//
//   1. Only on the Notre Ligue worker, and only when the signing secret
//      (STRIPE_WEBHOOK_SECRET) is set: 404 otherwise.
//   2. The signature: HMAC-SHA256 over "<t>.<raw body>" with
//      STRIPE_WEBHOOK_SECRET, the full 64-character hex (crypto_utils.hmac
//      cuts its digest to 32, so it is not used), any v1 value, compared in
//      constant time, the timestamp within 300 seconds. 400 when it fails.
//   3. Each event once: stripe_events by event id. A processed event
//      answers 200 again and does nothing.
//   4. The event's embedded object is never applied: the handler fetches
//      the current object from Stripe and writes the whole state, so a
//      late or repeated event writes the same truth.
//   5. A failure stores the error, counts the attempt and answers 500, so
//      Stripe sends it again later.
//   6. Before launch (BILLING_LAUNCH_AT unset): the event is verified and
//      recorded once, never processed, and the answer is 200. No Stripe
//      call, nothing gated. Once BILLING_LAUNCH_AT is set, every recorded
//      event not yet processed is processed once, oldest first: on the next
//      webhook delivery and from the Notre Ligue cron
//      (processPendingStripeEvents).
// Test-mode events (livemode false) are acknowledged and ignored: the app
// uses live mode only.
import { billingEnabled, SMBHL_ID } from './billing.js';
import { stripeRequest, stripeId } from './stripe.js';
import { same } from './crypto_utils.js';

export const SIGNATURE_TOLERANCE_SECONDS = 300;
const enc = new TextEncoder();

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>][,v0=...]
export async function verifyStripeSignature(raw, header, secret, nowSeconds = Math.floor(Date.now() / 1000), tolerance = SIGNATURE_TOLERANCE_SECONDS) {
  if (!secret || !header) return { ok: false, reason: 'missing' };
  let t = null;
  const v1 = [];
  for (const part of String(header).split(',')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1.push(v.toLowerCase());
  }
  if (!t || !/^\d+$/.test(t) || !v1.length) return { ok: false, reason: 'malformed' };
  if (Math.abs(nowSeconds - Number(t)) > tolerance) return { ok: false, reason: 'expired' };
  const expected = await hmacHex(secret, `${t}.${raw}`);
  if (!v1.some(s => same(s, expected))) return { ok: false, reason: 'mismatch' };
  return { ok: true, timestamp: Number(t) };
}

export async function handleStripeWebhook(req, env) {
  if (env.LEAGUE_PRODUCT !== 'true' || !env.STRIPE_WEBHOOK_SECRET)
    return new Response('Not found', { status: 404 });
  const raw = await req.text();
  const check = await verifyStripeSignature(raw, req.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);
  if (!check.ok) return Response.json({ ok: false, error: 'Bad signature.' }, { status: 400 });
  let event;
  try { event = JSON.parse(raw); } catch (_) { return Response.json({ ok: false, error: 'Bad payload.' }, { status: 400 }); }
  if (!event || typeof event.id !== 'string' || !/^evt_[A-Za-z0-9_]+$/.test(event.id) || typeof event.type !== 'string')
    return Response.json({ ok: false, error: 'Bad payload.' }, { status: 400 });
  if (event.livemode !== true) return Response.json({ ok: true, ignored: 'test_mode' });

  const obj = (event.data && event.data.object) || {};
  const objectId = typeof obj.id === 'string' && /^[A-Za-z0-9_]{3,255}$/.test(obj.id) ? obj.id : null;
  const before = await env.DB.prepare('SELECT processed_at FROM stripe_events WHERE id = ?').bind(event.id).first();
  if (before && before.processed_at) return Response.json({ ok: true, duplicate: true });
  if (!before) {
    await env.DB.prepare(
      `INSERT INTO stripe_events (id, type, object_id, created, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
    ).bind(event.id, event.type, objectId, Number(event.created) || null, new Date().toISOString()).run();
  }
  // Before launch: recorded, not processed.
  if (!billingEnabled(env)) return Response.json({ ok: true, ...(before ? { duplicate: true } : { recorded: true }) });

  await processPendingStripeEvents(env);
  const row = await env.DB.prepare('SELECT processed_at FROM stripe_events WHERE id = ?').bind(event.id).first();
  if (row && row.processed_at) return Response.json({ ok: true });
  return Response.json({ ok: false, error: 'Processing failed.' }, { status: 500 });
}

// Every recorded event not processed yet, oldest first (Stripe's created
// time, then arrival), each once. A failure is stored and counted and does
// not hold up the others (each handler fetches the current state, so the
// order is not load-bearing); an event is tried at most MAX_EVENT_ATTEMPTS
// times. Only while billing is on.
export const MAX_EVENT_ATTEMPTS = 5;
export async function processPendingStripeEvents(env, limit = 25) {
  if (!billingEnabled(env)) return 0;
  const rows = (await env.DB.prepare(
    `SELECT id, type, object_id, created FROM stripe_events
      WHERE processed_at IS NULL AND attempts < ?
      ORDER BY COALESCE(created, 0), received_at, id LIMIT ?`
  ).bind(MAX_EVENT_ATTEMPTS, limit).all()).results || [];
  let done = 0;
  for (const r of rows) {
    const event = { id: r.id, type: r.type, created: r.created, data: { object: { id: r.object_id } } };
    try {
      const out = await processStripeEvent(env, event);
      await env.DB.prepare(
        `UPDATE stripe_events SET processed_at = ?, league_id = ?, object_id = ?, attempts = attempts + 1, error = NULL WHERE id = ? AND processed_at IS NULL`
      ).bind(new Date().toISOString(), out.leagueId || null, out.objectId || r.object_id || null, r.id).run();
      done++;
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 300);
      await env.DB.prepare('UPDATE stripe_events SET attempts = attempts + 1, error = ? WHERE id = ?').bind(msg, r.id).run();
      console.error(`[billing] Stripe event ${r.id} (${r.type}) failed: ${msg}`);
    }
  }
  return done;
}

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'customer.subscription.paused', 'customer.subscription.resumed'
]);

// Returns { leagueId, objectId }.
export async function processStripeEvent(env, event) {
  const obj = (event.data && event.data.object) || {};
  const type = event.type;
  const created = Number(event.created) || null;
  if (type === 'checkout.session.completed') {
    const session = await stripeRequest(env, 'GET', `/checkout/sessions/${stripeId(obj.id)}`);
    const leagueId = session.client_reference_id || (session.metadata && session.metadata.league_id) || null;
    const subId = idOf(session.subscription);
    if (!subId) return { leagueId, objectId: session.id };
    const r = await writeSubscription(env, subId, { leagueId, customerId: idOf(session.customer), created });
    return { leagueId: r.leagueId, objectId: session.id };
  }
  if (SUBSCRIPTION_EVENTS.has(type)) {
    const r = await writeSubscription(env, stripeId(obj.id), { created });
    return { leagueId: r.leagueId, objectId: obj.id };
  }
  if (type === 'invoice.paid' || type === 'invoice.payment_failed') {
    const inv = await stripeRequest(env, 'GET', `/invoices/${stripeId(obj.id)}`);
    const subId = invoiceSubscriptionId(inv);
    let leagueId = null;
    if (subId) leagueId = (await writeSubscription(env, subId, { customerId: idOf(inv.customer), created })).leagueId;
    else leagueId = await leagueByStripe(env, { customerId: idOf(inv.customer) });
    if (leagueId && type === 'invoice.paid' && Number(inv.amount_paid) > 0) {
      const paidAt = inv.status_transitions && inv.status_transitions.paid_at ? new Date(inv.status_transitions.paid_at * 1000).toISOString() : new Date().toISOString();
      await env.DB.prepare('UPDATE league_billing SET last_paid_at = ?, updated_at = ? WHERE league_id = ?').bind(paidAt, new Date().toISOString(), leagueId).run();
    }
    // Decision 3 (batch 3): a subscription Stripe paused at its trial's end
    // is resumed once a card is on file. Never fails the event.
    if (leagueId && type === 'invoice.paid') {
      try { await resumeIfCardAdded(env, leagueId); }
      catch (e) { console.error(`[billing] resume after invoice.paid for ${leagueId}: ${e.message}`); }
    }
    return { leagueId, objectId: inv.id };
  }
  if (type === 'customer.deleted') {
    const customer = await stripeRequest(env, 'GET', `/customers/${stripeId(obj.id)}`);
    const leagueId = await leagueByStripe(env, { customerId: obj.id });
    if (customer && customer.deleted && leagueId) {
      await env.DB.prepare(
        `UPDATE league_billing SET stripe_customer_id = NULL, stripe_subscription_id = NULL, stripe_price_id = NULL, updated_at = ? WHERE league_id = ?`
      ).bind(new Date().toISOString(), leagueId).run();
    }
    return { leagueId, objectId: obj.id };
  }
  if (type === 'charge.refunded') {
    // A full refund of a subscription payment ends that subscription at
    // once (Roberto's rule); a partial refund changes nothing. The refund
    // itself is made in the Stripe Dashboard.
    const charge = await stripeRequest(env, 'GET', `/charges/${stripeId(obj.id)}`);
    const customerId = idOf(charge.customer);
    const leagueId = await leagueByStripe(env, { customerId });
    const full = charge.refunded === true && Number(charge.amount_refunded) >= Number(charge.amount) && Number(charge.amount) > 0;
    if (!full || !leagueId) return { leagueId, objectId: charge.id };
    // The subscription the payment was for: the charge's invoice when the
    // API version still links it, otherwise the league's own subscription.
    let subId = null;
    const invoiceId = idOf(charge.invoice);
    if (invoiceId) subId = invoiceSubscriptionId(await stripeRequest(env, 'GET', `/invoices/${stripeId(invoiceId)}`));
    if (!subId) {
      const row = await env.DB.prepare('SELECT stripe_subscription_id FROM league_billing WHERE league_id = ?').bind(leagueId).first();
      subId = row && row.stripe_subscription_id;
    }
    if (!subId) return { leagueId, objectId: charge.id };
    const sub = await stripeRequest(env, 'GET', `/subscriptions/${stripeId(subId)}`);
    if (!['canceled', 'incomplete_expired'].includes(sub.status)) {
      // A DELETE is idempotent on Stripe's side: no key needed.
      await stripeRequest(env, 'DELETE', `/subscriptions/${stripeId(subId)}`);
    }
    await writeSubscription(env, subId, { leagueId, customerId, created });
    return { leagueId, objectId: charge.id };
  }
  return { leagueId: null, objectId: obj.id || null };
}

function idOf(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return typeof v.id === 'string' ? v.id : null;
}

// An invoice's subscription: invoice.subscription (older API versions) or
// invoice.parent.subscription_details.subscription (newer ones).
function invoiceSubscriptionId(inv) {
  if (!inv) return null;
  return idOf(inv.subscription)
    || idOf(inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription)
    || null;
}

async function leagueByStripe(env, { subscriptionId = null, customerId = null }) {
  if (subscriptionId) {
    const r = await env.DB.prepare('SELECT league_id FROM league_billing WHERE stripe_subscription_id = ?').bind(subscriptionId).first();
    if (r) return r.league_id;
  }
  if (customerId) {
    const r = await env.DB.prepare('SELECT league_id FROM league_billing WHERE stripe_customer_id = ? ORDER BY updated_at DESC LIMIT 1').bind(customerId).first();
    if (r) return r.league_id;
  }
  return null;
}

// The price's tier: one of the four configured price ids, or the price's
// (or its product's) metadata.tier.
export function tierForPrice(env, price) {
  if (!price) return null;
  const id = price.id;
  if (id && (id === env.STRIPE_PRICE_STANDARD_MONTHLY || id === env.STRIPE_PRICE_STANDARD_YEARLY)) return 'standard';
  if (id && (id === env.STRIPE_PRICE_PLUS_MONTHLY || id === env.STRIPE_PRICE_PLUS_YEARLY)) return 'plus';
  const meta = (price.metadata && price.metadata.tier) || (price.product && typeof price.product === 'object' && price.product.metadata && price.product.metadata.tier);
  return ['standard', 'plus', 'custom'].includes(meta) ? meta : null;
}

// Stripe's status to the app's: subscribed (active), behind on payment,
// paused by the app (monthly pause_collection) or by Stripe, or over.
export function appStatusFor(sub) {
  const s = sub && sub.status;
  if (s === 'active' || s === 'trialing') return sub.pause_collection ? 'paused' : 'active';
  if (s === 'past_due') return 'past_due';
  if (s === 'paused') return 'paused';
  if (s === 'unpaid' || s === 'canceled' || s === 'incomplete_expired') return 'inactive';
  return null; // incomplete: nothing settled yet
}

const iso = secs => (secs ? new Date(Number(secs) * 1000).toISOString() : null);

// Fetches the subscription and writes its whole current state to the
// league's row. The league: the subscription's metadata.league_id, the one
// the caller knows (checkout), or the row that already holds this
// subscription or customer. SMBHL and unknown leagues are left alone.
export async function writeSubscription(env, subId, { leagueId = null, customerId = null, created = null } = {}) {
  const sub = await stripeRequest(env, 'GET', `/subscriptions/${stripeId(subId)}`);
  const customer = idOf(sub.customer) || customerId;
  const league = (sub.metadata && sub.metadata.league_id) || leagueId
    || await leagueByStripe(env, { subscriptionId: sub.id, customerId: customer });
  if (!league || league === SMBHL_ID) return { leagueId: null };
  const row = await env.DB.prepare('SELECT id, created_by FROM leagues WHERE id = ?').bind(league).first();
  if (!row) return { leagueId: null };
  const item = sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
  const price = item && item.price;
  const tier = tierForPrice(env, price);
  const status = appStatusFor(sub);
  const now = new Date().toISOString();
  const periodEnd = iso(sub.current_period_end || (item && item.current_period_end));
  await env.DB.prepare(
    `INSERT INTO league_billing (league_id, owner_user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, tier,
       billing_interval, stripe_status, status, current_period_end, cancel_at_period_end, paused_at, inactive_since, last_stripe_event_at, updated_at)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, 'free'), ?, ?, COALESCE(?, 'trial'), ?, ?, CASE WHEN ? = 'paused' THEN ? END, CASE WHEN ? = 'inactive' THEN ? END, ?, ?)
     ON CONFLICT(league_id) DO UPDATE SET
       owner_user_id = COALESCE(league_billing.owner_user_id, excluded.owner_user_id),
       stripe_customer_id = excluded.stripe_customer_id,
       stripe_subscription_id = excluded.stripe_subscription_id,
       stripe_price_id = excluded.stripe_price_id,
       tier = COALESCE(?, league_billing.tier),
       billing_interval = excluded.billing_interval,
       stripe_status = excluded.stripe_status,
       status = COALESCE(?, league_billing.status),
       current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end,
       paused_at = CASE WHEN ? = 'paused' THEN COALESCE(league_billing.paused_at, ?) ELSE NULL END,
       inactive_since = CASE WHEN ? = 'inactive' THEN COALESCE(league_billing.inactive_since, ?) WHEN ? IN ('active', 'paused') THEN NULL ELSE league_billing.inactive_since END,
       read_only_since = CASE WHEN ? = 'active' THEN NULL ELSE league_billing.read_only_since END,
       emails_paused_since = CASE WHEN ? = 'active' THEN NULL ELSE league_billing.emails_paused_since END,
       grace_ends_at = CASE WHEN ? = 'active' THEN NULL ELSE league_billing.grace_ends_at END,
       last_stripe_event_at = COALESCE(excluded.last_stripe_event_at, league_billing.last_stripe_event_at),
       updated_at = excluded.updated_at`
  ).bind(
    league, row.created_by || null, customer, sub.id, (price && price.id) || null, tier,
    (price && price.recurring && price.recurring.interval) || null, sub.status || null, status, periodEnd, sub.cancel_at_period_end ? 1 : 0,
    status, now, status, now, created, now,
    tier, status, status, now, status, now, status, status, status, status
  ).run();
  // The subscription's own trial (a league that subscribed inside its trial
  // keeps it: Checkout sets the same end) and a cancellation scheduled from
  // the portal: cancel_at (newer API versions) or cancel_at_period_end; the
  // end date shown is then current_period_end.
  const cancelAt = sub.cancel_at ? iso(sub.cancel_at) : null;
  await env.DB.prepare(
    `UPDATE league_billing SET
       trial_started_at = COALESCE(?, trial_started_at), trial_ends_at = COALESCE(?, trial_ends_at),
       cancel_at_period_end = ?, current_period_end = COALESCE(?, current_period_end)
     WHERE league_id = ?`
  ).bind(sub.trial_start ? iso(sub.trial_start) : null, sub.trial_end ? iso(sub.trial_end) : null,
    (sub.cancel_at_period_end || cancelAt) ? 1 : 0, cancelAt, league).run();
  return { leagueId: league, status, subscription: sub };
}

// Batch 3: whether the subscription can be charged: a default payment
// method (or source) on the subscription, or on its customer
// (invoice_settings.default_payment_method, where the Customer Portal puts
// a card it adds). sub: the subscription already fetched, or null.
export async function subscriptionHasCard(env, row, sub = null) {
  if (!sub) sub = await stripeRequest(env, 'GET', `/subscriptions/${stripeId(row.stripe_subscription_id)}`);
  if (sub.default_payment_method || sub.default_source) return true;
  const cus = idOf(sub.customer) || (row && row.stripe_customer_id) || null;
  if (!cus) return false;
  const c = await stripeRequest(env, 'GET', `/customers/${stripeId(cus)}`);
  return !!(c && !c.deleted && ((c.invoice_settings && c.invoice_settings.default_payment_method) || c.default_source));
}

// Decision 3 (Roberto, batch 3): Stripe pauses a subscription whose trial
// ends with no card (trial_settings end_behavior missing_payment_method
// pause; Stripe's own status 'paused', not the app's pause_collection).
// Adding a card in the Customer Portal does not resume it by itself: the
// app does, with POST /subscriptions/{id}/resume (a new cycle from today,
// billing_cycle_anchor now, no proration: the first period is invoiced now
// and charged to the card). Asked back from the portal (the billing page
// load), on invoice.paid and by the daily job (src/billing_enforcement.js).
// Does nothing unless the league's subscription is paused by Stripe and a
// card is on file. The new state is written at once, so a payment that goes
// through unlocks the league.
export async function resumeIfCardAdded(env, leagueId, now = new Date()) {
  if (!billingEnabled(env) || !leagueId || leagueId === SMBHL_ID) return { resumed: false };
  const row = await env.DB.prepare('SELECT * FROM league_billing WHERE league_id = ?').bind(leagueId).first();
  if (!row || !row.stripe_subscription_id || row.stripe_status !== 'paused') return { resumed: false };
  const path = `/subscriptions/${stripeId(row.stripe_subscription_id)}`;
  const sub = await stripeRequest(env, 'GET', path);
  if (sub.status !== 'paused') {
    await writeSubscription(env, row.stripe_subscription_id, { leagueId });
    return { resumed: false, synced: true };
  }
  if (!(await subscriptionHasCard(env, row, sub))) return { resumed: false, noCard: true };
  await stripeRequest(env, 'POST', `${path}/resume`, { billing_cycle_anchor: 'now', proration_behavior: 'none' },
    { idempotencyKey: `resume-paused:${row.stripe_subscription_id}:${now.toISOString().slice(0, 10)}` });
  await writeSubscription(env, row.stripe_subscription_id, { leagueId });
  return { resumed: true };
}

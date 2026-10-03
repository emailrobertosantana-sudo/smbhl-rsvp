// Instant alerts for Roberto (overnight batch, stage 1): a push through the
// operator webhook (ALERT_WEBHOOK_URL, src/health.js postWebhook) when
//   1a. a Notre Ligue league is created (not a co-admin joining, never
//       SMBHL), and
//   1b. a league's subscription becomes active (Stripe, through
//       writeSubscription in src/stripe_webhook.js).
// A webhook, not an email: nothing here goes through the outbox, the daily
// caps or the sending rules (src/mail_guard.js). The daily digest
// (src/ops_digest.js) is unchanged: new sign-ups stay in it as before.
//
// Once: a settings row per league (1a) and per league and subscription
// (1b), claimed before the push (INSERT ... ON CONFLICT DO NOTHING), so a
// retried request, a replayed Stripe event or the checkout return racing
// the webhook never alerts twice. The row carries the league id, so the
// league's deletion removes it. No migration.
//
// Privacy: the webhook is a third party (ntfy.sh). The owner's address is
// masked as the super-admin shows it (maskEmail, 'o***@example.com');
// postWebhook also masks any full address left in the text.
// Without ALERT_WEBHOOK_URL nothing is read or written.
import { postWebhook, postWebhookResult } from './health.js';
import { maskEmail } from './contact_name.js';
import { SMBHL_LEAGUE_ID } from './league_ids.js';
import { stripeId } from './stripe.js';

export const LEAGUE_CREATED_KEY = id => `ops_alert:league_created:${id}`;
export const SUBSCRIBED_KEY = (id, subId) => `ops_alert:subscribed:${id}:${subId}`;

export const LEAGUE_CREATED_TITLE = 'Notre Ligue : nouvelle ligue / new league';
export const SUBSCRIBED_TITLE = 'Notre Ligue : nouvel abonnement / new subscription';
export const TEST_ALERT_TITLE = "Notre Ligue : test d'alerte / alert test";

// The labels the onboarding summary uses (src/index.js
// onboardingSummaryScreen, SUMMARY_LANGUAGE), without the sentence ending.
const STRUCTURE = {
  fixed: { fr: 'Équipes fixes', en: 'Fixed teams' },
  weekly_draw: { fr: 'Équipes formées à chaque match', en: 'Teams formed every game' },
  headcount: { fr: 'Sans équipes', en: 'No teams' }
};
const LANGUAGE = {
  fr: { fr: 'Français', en: 'French' },
  en: { fr: 'Anglais', en: 'English' },
  both: { fr: 'Français et anglais', en: 'French and English' }
};
const PLAN = {
  standard: { fr: 'Standard', en: 'Standard' },
  plus: { fr: 'Plus', en: 'Plus' },
  custom: { fr: 'sur mesure', en: 'custom' },
  free: { fr: 'gratuit', en: 'free' }
};
const INTERVAL = {
  month: { fr: 'mensuel', en: 'monthly' },
  year: { fr: 'annuel', en: 'yearly' }
};

// The alert waits at most this long for the webhook: a sign-up or a Stripe
// event never hangs on it (src/health.js postWebhook).
const ALERT_TIMEOUT_MS = 4000;
const isLeague = id => !!id && id !== 'system' && id !== SMBHL_LEAGUE_ID;
const ordinalEn = n => {
  const m100 = n % 100, m10 = n % 10;
  if (m100 >= 11 && m100 <= 13) return `${n}th`;
  return `${n}${m10 === 1 ? 'st' : m10 === 2 ? 'nd' : m10 === 3 ? 'rd' : 'th'}`;
};

// True when this call took the marker (first time), false when it was
// already there.
async function claim(db, key, leagueId) {
  const r = await db.prepare('INSERT INTO settings (key, value, league_id) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING')
    .bind(key, new Date().toISOString(), leagueId).run();
  return !!(r && r.meta && r.meta.changes > 0);
}

// 1a. Pure: the alert for a new league.
export function leagueCreatedAlert({ name, teamStructure, languageMode, ownerMasked, ownerLeagueCount, link }) {
  const s = STRUCTURE[teamStructure] || STRUCTURE.fixed;
  const l = LANGUAGE[languageMode] || LANGUAGE.both;
  const n = Number(ownerLeagueCount) || 1;
  const who = ownerMasked || '?';
  const moreFr = n >= 2 ? ` C'est la ${n}e ligue créée par ce compte.` : '';
  const moreEn = n >= 2 ? ` This is the ${ordinalEn(n)} league this account has created.` : '';
  const fr = `${name} : ${s.fr}, ${l.fr}, créée par ${who}.${moreFr} Fiche : ${link}`;
  const en = `${name}: ${s.en}, ${l.en}, created by ${who}.${moreEn} Details: ${link}`;
  return { title: LEAGUE_CREATED_TITLE, body: `${fr}\n\n---\n\n${en}` };
}

// 1a. After handleLeagueCreate (src/leagues.js) has written the league.
// Never throws: league creation does not depend on it.
export async function alertLeagueCreated(env, leagueId) {
  try {
    if (!env || !env.ALERT_WEBHOOK_URL || !env.DB || !isLeague(leagueId)) return false;
    const row = await env.DB.prepare(
      `SELECT l.id, l.name, l.team_structure, l.language_mode, l.created_by, u.email
         FROM leagues l LEFT JOIN users u ON u.id = l.created_by WHERE l.id = ?`
    ).bind(leagueId).first();
    if (!row) return false;
    if (!(await claim(env.DB, LEAGUE_CREATED_KEY(leagueId), leagueId))) return false;
    const count = row.created_by
      ? Number(((await env.DB.prepare('SELECT COUNT(*) AS n FROM leagues WHERE created_by = ? AND id != ?').bind(row.created_by, SMBHL_LEAGUE_ID).first()) || {}).n) || 1
      : 1;
    const base = env.PUBLIC_URL || 'https://rsvp.notreligue.ca';
    const a = leagueCreatedAlert({
      name: row.name, teamStructure: row.team_structure, languageMode: row.language_mode,
      ownerMasked: maskEmail(row.email || ''), ownerLeagueCount: count,
      link: `${base}/super-admin/league?id=${encodeURIComponent(leagueId)}`
    });
    return await postWebhook(env, a.title, a.body, { tags: 'tada', timeoutMs: ALERT_TIMEOUT_MS });
  } catch (e) {
    console.error(`[ops-alert] league created: ${e && e.message}`);
    return false;
  }
}

// 1b. Pure: the alert for a new subscription.
export function subscribedAlert({ name, tier, interval, promo }) {
  const p = PLAN[tier] || { fr: String(tier || '?'), en: String(tier || '?') };
  const i = INTERVAL[interval] || { fr: String(interval || '?'), en: String(interval || '?') };
  const fr = `${name} : forfait ${p.fr}, ${i.fr}${promo ? ' (code promo)' : ''}`;
  const en = `${name}: ${p.en} plan, ${i.en}${promo ? ' (promo code)' : ''}`;
  return { title: SUBSCRIBED_TITLE, body: `${fr}\n\n---\n\n${en}` };
}

// A discount that takes the whole price: a coupon at 100 % off, or an
// amount off at least the price. Both API shapes: discount.coupon (older)
// and discount.source.coupon (2025-03-31 and later).
function fullCoupon(coupon, unitAmount) {
  if (!coupon || typeof coupon !== 'object') return false;
  if (Number(coupon.percent_off) >= 100) return true;
  return Number(coupon.amount_off) > 0 && Number.isFinite(Number(unitAmount)) && Number(coupon.amount_off) >= Number(unitAmount);
}

// Whether the subscription is free through a 100 %-off promotion code (or
// coupon). sub: the subscription writeSubscription fetched. Its discounts
// are ids unless expanded, so the subscription is read again with them
// expanded, and a coupon left as an id is read too. Only when the
// subscription has a discount at all. request: stripeRequest.
export async function subscriptionIsFullyDiscounted(env, sub, request) {
  const has = d => Array.isArray(d) ? d.length > 0 : !!d;
  if (!sub || (!has(sub.discounts) && !has(sub.discount))) return false;
  const item = sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
  const unit = item && item.price ? item.price.unit_amount : null;
  let list = [];
  if (sub.discount && typeof sub.discount === 'object') list.push(sub.discount);
  if (Array.isArray(sub.discounts)) {
    if (sub.discounts.some(d => typeof d === 'string')) {
      const full = await request(env, 'GET', `/subscriptions/${stripeId(sub.id)}`, { expand: ['discounts'] });
      list = list.concat((full && Array.isArray(full.discounts) ? full.discounts : []).filter(d => d && typeof d === 'object'));
    } else list = list.concat(sub.discounts.filter(d => d && typeof d === 'object'));
  }
  for (const d of list) {
    let coupon = d.coupon || (d.source && d.source.coupon) || null;
    if (typeof coupon === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(coupon)) coupon = await request(env, 'GET', `/coupons/${encodeURIComponent(coupon)}`);
    if (fullCoupon(coupon, unit)) return true;
  }
  return false;
}

// 1b. Called by writeSubscription once the league's row is written. prev:
// the league's row before the write ({ stripe_subscription_id, status } or
// null). Alerts when the subscription is active now (the app's status:
// Stripe active or trialing) and was not already active before, once per
// league and subscription. Never throws: the Stripe event does not depend
// on it.
export async function alertSubscriptionActive(env, { leagueId, sub, status, tier, interval, prev, request }) {
  try {
    if (!env || !env.ALERT_WEBHOOK_URL || !env.DB || !isLeague(leagueId) || !sub || !sub.id) return false;
    if (status !== 'active') return false;
    if (prev && prev.stripe_subscription_id === sub.id && prev.status === 'active') return false;
    if (!(await claim(env.DB, SUBSCRIBED_KEY(leagueId, sub.id), leagueId))) return false;
    // The plan and interval as written (the row keeps its tier when the
    // price names none).
    const row = await env.DB.prepare(
      'SELECT l.name, b.tier, b.billing_interval FROM leagues l LEFT JOIN league_billing b ON b.league_id = l.id WHERE l.id = ?'
    ).bind(leagueId).first();
    let promo = false;
    try { promo = await subscriptionIsFullyDiscounted(env, sub, request); }
    catch (e) { console.error(`[ops-alert] discount check for ${leagueId}: ${e && e.message}`); }
    const a = subscribedAlert({
      name: row ? row.name : leagueId,
      tier: tier || (row && row.tier), interval: interval || (row && row.billing_interval), promo
    });
    return await postWebhook(env, a.title, a.body, { tags: 'moneybag', timeoutMs: ALERT_TIMEOUT_MS });
  } catch (e) {
    console.error(`[ops-alert] subscription: ${e && e.message}`);
    return false;
  }
}

// The super-admin's « Envoyer une alerte test » button: one push through the
// same webhook call as 1a and 1b (same timeout), nothing written. Returns
// what the webhook answered and how long it took (postWebhookResult), and
// whether an access token was sent (never the token itself).
export async function sendTestAlert(env) {
  const body = "Alerte test envoyée depuis le super-admin. Rien à faire.\n\n---\n\nTest alert sent from the super-admin. Nothing to do.";
  const r = await postWebhookResult(env, TEST_ALERT_TITLE, body, { tags: 'test_tube', timeoutMs: ALERT_TIMEOUT_MS });
  return { ...r, configured: !!(env && env.ALERT_WEBHOOK_URL), token: !!(env && env.ALERT_WEBHOOK_TOKEN), timeoutMs: ALERT_TIMEOUT_MS };
}

// The Stripe configuration check (GET /super-admin/billing/check): read
// only, one GET per configured price and one per product, and one on
// refunds to report whether the key can read them. It shows prices and
// products only: no customer data, never the key.
import { stripeRequest, stripeId } from './stripe.js';

export const PRICE_VARS = [
  ['STRIPE_PRICE_STANDARD_MONTHLY', { tier: 'standard', interval: 'month', amount: 999 }],
  ['STRIPE_PRICE_STANDARD_YEARLY', { tier: 'standard', interval: 'year', amount: 9990 }],
  ['STRIPE_PRICE_PLUS_MONTHLY', { tier: 'plus', interval: 'month', amount: 1999 }],
  ['STRIPE_PRICE_PLUS_YEARLY', { tier: 'plus', interval: 'year', amount: 19990 }]
];

export async function checkStripeConfig(env) {
  const prices = [];
  for (const [name, want] of PRICE_VARS) {
    const id = env[name];
    if (!id) { prices.push({ var: name, ok: false, error: 'not set' }); continue; }
    try {
      const p = await stripeRequest(env, 'GET', `/prices/${stripeId(id)}`, null, { readOnly: true });
      const productId = typeof p.product === 'string' ? p.product : (p.product && p.product.id);
      const prod = productId ? await stripeRequest(env, 'GET', `/products/${stripeId(productId)}`, null, { readOnly: true }) : null;
      const got = {
        var: name, id,
        amount: p.unit_amount, currency: p.currency,
        interval: p.recurring ? p.recurring.interval : null,
        taxBehavior: p.tax_behavior,
        active: p.active,
        productName: prod ? prod.name : null,
        productTier: prod && prod.metadata ? prod.metadata.tier || null : null,
        priceTier: p.metadata ? p.metadata.tier || null : null
      };
      got.ok = got.amount === want.amount && got.currency === 'cad' && got.interval === want.interval
        && got.taxBehavior === 'exclusive' && (got.productTier === want.tier || got.priceTier === want.tier);
      prices.push(got);
    } catch (e) {
      prices.push({ var: name, id, ok: false, error: e.message, code: e.code || null });
    }
  }
  let refunds;
  try {
    await stripeRequest(env, 'GET', '/refunds', { limit: 1 }, { readOnly: true });
    refunds = { readable: true };
  } catch (e) {
    refunds = { readable: false, status: e.status || null, code: e.code || null, error: e.message };
  }
  // Refunds share Stripe's "Charges and Refunds" permission, which the key
  // holds on Read (needed to check a charge for a full refund). Read only:
  // it cannot create one. Reported, not a failure.
  return { ok: prices.every(p => p.ok), apiVersion: env.STRIPE_API_VERSION || null, prices, refunds };
}

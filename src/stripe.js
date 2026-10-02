// Stripe, from the Worker: plain fetch, no SDK. Batch 1 of the billing
// work (src/billing.js).
//
//   - form encoded (Stripe's own format: nested keys as a[b][0]=c);
//   - Stripe-Version pinned by STRIPE_API_VERSION (a var), so a Dashboard
//     upgrade never changes what the app receives;
//   - Idempotency-Key on every POST the caller marks;
//   - errors name the method, path, status and Stripe's error type and
//     code, never the key or a request header, and never Stripe's own
//     message (it can quote part of a key);
//   - refuses outright while billing is off (BILLING_LAUNCH_AT unset), so
//     no code path can reach Stripe before launch.
import { billingEnabled } from './billing.js';

export const STRIPE_API = 'https://api.stripe.com/v1';

export class StripeError extends Error {
  constructor(message, code = null, status = null) {
    super(message);
    this.name = 'StripeError';
    this.code = code;
    this.status = status;
  }
}

// { a: 1, b: { c: 'x' }, d: ['y', 'z'], e: null } ->
// a=1&b[c]=x&d[0]=y&d[1]=z (null and undefined are left out; an empty
// string is sent, which is how Stripe clears a field).
export function formEncode(params) {
  const out = [];
  const walk = (value, key) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${key}[${i}]`)); return; }
    if (typeof value === 'object') { for (const [k, v] of Object.entries(value)) walk(v, key ? `${key}[${k}]` : k); return; }
    out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  walk(params || {}, '');
  return out.join('&');
}

// A Stripe object id in a path: letters, digits and underscores only.
export function stripeId(id) {
  const s = String(id || '');
  if (!/^[A-Za-z0-9_]{3,255}$/.test(s)) throw new StripeError('Not a Stripe id.', 'bad_id');
  return s;
}

export async function stripeRequest(env, method, path, params = null, { idempotencyKey = null } = {}) {
  if (!billingEnabled(env)) throw new StripeError('Billing is off (BILLING_LAUNCH_AT is not set): no Stripe call.', 'billing_off');
  if (!env.STRIPE_SECRET_KEY) throw new StripeError('STRIPE_SECRET_KEY is not set.', 'no_key');
  if (!env.STRIPE_API_VERSION) throw new StripeError('STRIPE_API_VERSION is not set.', 'no_version');
  const m = String(method || 'GET').toUpperCase();
  const body = params ? formEncode(params) : '';
  const url = `${STRIPE_API}${path}${m === 'GET' && body ? `?${body}` : ''}`;
  const headers = {
    authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    'stripe-version': env.STRIPE_API_VERSION
  };
  if (m !== 'GET') headers['content-type'] = 'application/x-www-form-urlencoded';
  if (m === 'POST' && idempotencyKey) headers['idempotency-key'] = String(idempotencyKey);
  let res;
  try {
    res = await fetch(url, { method: m, headers, body: m === 'GET' ? undefined : body });
  } catch (_) {
    throw new StripeError(`Stripe ${m} ${path}: network error.`, 'network');
  }
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok) {
    const err = (data && data.error) || {};
    const detail = [err.type, err.code, err.param].filter(Boolean).join(' / ');
    throw new StripeError(`Stripe ${m} ${path} answered ${res.status}${detail ? ` (${detail})` : ''}.`, err.code || err.type || 'stripe_error', res.status);
  }
  return data;
}

// Shared HMAC token primitives. Used to sign/verify every scoped magic-link
// token in this app (player RSVP, team RSVP, polls, and the single-review
// scoresheet-email link) so index.js and admin_auth.js don't each keep their
// own copy.

const enc = new TextEncoder();

export async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// Constant-time string comparison, to avoid leaking token validity through
// response-time side channels.
export function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

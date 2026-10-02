// Ad test, item 2 (2026-10-02): where a new league came from, carried by URL
// parameters only, from the homepage through sign-up to the league record.
// No cookie, no storage, no pixel: a visitor who loses the parameters gives a
// league with none, and that is accepted.
//
// Allow-list: a (the homepage angle) and four utm_ keys. Each value keeps only
// letters, digits, hyphen, underscore and dot, at most 64 characters; an
// empty result is dropped. lang_landing is the homepage's language (fr | en).

export const ATTRIBUTION_KEYS = ['a', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];

export function cleanAttributionValue(v) {
  return String(v == null ? '' : v).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
}

// From URLSearchParams or a plain object: the allowed keys with a clean,
// non-empty value, plus lang_landing when it is fr or en.
export function attributionFrom(source) {
  const read = k => (source && typeof source.get === 'function' ? source.get(k) : source ? source[k] : null);
  const out = {};
  for (const k of ATTRIBUTION_KEYS) {
    const v = cleanAttributionValue(read(k));
    if (v) out[k] = v;
  }
  const lang = String(read('lang_landing') || '');
  if (lang === 'fr' || lang === 'en') out.lang_landing = lang;
  return out;
}

export function hasAttribution(attr) {
  return ATTRIBUTION_KEYS.some(k => attr && attr[k]);
}

// The query string a sign-up link carries: the allowed keys from the page's
// own URL and the page's language, or '' when the URL has none of the keys.
export function attributionQuery(params, lang) {
  const attr = attributionFrom(params);
  if (!hasAttribution(attr)) return '';
  const q = new URLSearchParams();
  for (const k of ATTRIBUTION_KEYS) if (attr[k]) q.set(k, attr[k]);
  q.set('lang_landing', lang === 'en' ? 'en' : 'fr');
  return '?' + q.toString();
}

// The league columns (migrate-057.sql) for an attribution, or null when it
// has none of the allowed keys.
export function attributionColumns(attr, now = new Date()) {
  const a = attributionFrom(attr || {});
  if (!hasAttribution(a)) return null;
  return {
    angle: a.a || null,
    utm_source: a.utm_source || null,
    utm_medium: a.utm_medium || null,
    utm_campaign: a.utm_campaign || null,
    utm_content: a.utm_content || null,
    landing_language: a.lang_landing || null,
    attributed_at: now.toISOString()
  };
}

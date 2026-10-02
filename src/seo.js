// Search engines, Notre Ligue only (homepage batch 3, item 3).
//
// robots.txt allows the public pages and disallows the private routes:
// admin pages, the signed-in app, and every route whose link carries a
// per-player or per-league token (in the query string: /rsvp, /league/rsvp,
// /team-rsvp, /avail, /poll, /reset-password, /auth/verify,
// /league/admins/accept). The same routes answer with X-Robots-Tag: noindex.
//
// The demo deployment (DEMO_ENV) serves Notre Ligue's real domain
// (notreligue.ca, rsvp.notreligue.ca, www.notreligue.ca) and its
// workers.dev address. Only the public marketing pages on the real domain
// are indexable; everything else keeps the demo's noindex, nofollow.
// SMBHL (no LEAGUE_PRODUCT) is untouched: none of this runs for it.

// First path segment of every private route.
export const NL_PRIVATE_SEGMENTS = [
  'admin', 'super-admin', 'dashboard', 'league', 'leagues', 'onboarding',
  'api', 'auth', 'accept-terms', 'rsvp', 'team-rsvp', 'avail', 'poll',
  'reset-password', 'billing', 'health'
];
const PRIVATE = new Set(NL_PRIVATE_SEGMENTS);

// The pages a search engine may index.
export const NL_INDEXABLE_PATHS = ['/', '/fr', '/en', '/confidentialite', '/conditions'];
const INDEXABLE = new Set(NL_INDEXABLE_PATHS);

export function isPrivatePath(pathname) {
  return PRIVATE.has(String(pathname || '').split('/')[1] || '');
}

// The product's own hostnames: PUBLIC_URL's domain (without rsvp. or
// www.) and its subdomains. Never a workers.dev address.
export function nlIndexableHost(env, url) {
  if (env.LEAGUE_PRODUCT !== 'true') return false;
  let base = '';
  try { base = new URL(env.PUBLIC_URL || '').hostname.replace(/^(rsvp|www)\./, ''); } catch (_) { return false; }
  if (!base || base.endsWith('workers.dev')) return false;
  const host = url.hostname;
  return host === base || host.endsWith('.' + base);
}

// The X-Robots-Tag for a response, or null for none.
export function robotsTagFor(env, url) {
  if (env.DEMO_ENV === 'true') {
    return nlIndexableHost(env, url) && INDEXABLE.has(url.pathname) ? null : 'noindex, nofollow';
  }
  if (env.LEAGUE_PRODUCT === 'true' && isPrivatePath(url.pathname)) return 'noindex';
  return null;
}

export function nlRobotsTxt(origin) {
  const lines = ['User-agent: *', 'Allow: /'];
  // /x$, /x/ and /x? block the route itself, below it and with a token in
  // its query string, without blocking a league page whose address merely
  // starts with the same letters.
  for (const s of NL_PRIVATE_SEGMENTS) lines.push(`Disallow: /${s}$`, `Disallow: /${s}/`, `Disallow: /${s}?`);
  lines.push('', `Sitemap: ${origin}/sitemap.xml`, '');
  return lines.join('\n');
}

export function nlSitemapXml(origin) {
  const alt = [
    `    <xhtml:link rel="alternate" hreflang="fr-CA" href="${origin}/fr"/>`,
    `    <xhtml:link rel="alternate" hreflang="en-CA" href="${origin}/en"/>`,
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${origin}/"/>`
  ].join('\n');
  const url = (p, withAlt) => `  <url>\n    <loc>${origin}${p}</loc>${withAlt ? '\n' + alt : ''}\n  </url>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    url('/', true), url('/fr', true), url('/en', true), url('/confidentialite', false), url('/conditions', false),
    '</urlset>',
    ''
  ].join('\n');
}

#!/usr/bin/env node
// Schema-drift guard task, Part 5: verifies SMBHL's Cloudflare Access
// policy (configured in the Cloudflare dashboard, NOT in this repo,
// not carried by any deploy -- see DEPLOY.md/README.md's own warning)
// is still actually in front of the admin surface.
//
// WHY THIS HAS TO BE A REAL EXTERNAL HTTP REQUEST, NOT A TEST: Access
// sits at Cloudflare's edge, in front of the Worker -- a genuinely
// protected request never reaches the Worker's own code at all. The
// Vitest suite's SELF.fetch() calls the Worker directly, entirely
// inside the test sandbox, and structurally cannot observe Access one
// way or the other (there is no edge in that harness to intercept the
// request). The only way to prove Access is still live is to make a
// real request to the real domain from outside Cloudflare's network,
// which is what this script does. It cannot be part of `npm test`.
//
// WHAT A "STILL PROTECTED" RESPONSE LOOKS LIKE: an unauthenticated
// request to a real admin path gets redirected (302) to
// <team>.cloudflareaccess.com/cdn-cgi/access/login/..., with a
// `Www-Authenticate: Cloudflare-Access ...` header -- Access's own
// challenge, never reaching src/index.js's own routing at all. If
// Access were ever removed, this same request would instead reach the
// Worker directly and get the ADMIN_KEY-gated page shell (200, with
// the "gate" prompt visible) or a 403 from checkAdminAuth -- NOT an
// Access redirect. That distinction is exactly what this script checks.
//
// Read-only: a single GET request, no state changed anywhere.
//
// Usage: node scripts/check_cloudflare_access.js [url]
//   (defaults to https://rsvp.smbhl.com/admin/contacts)
const https = require('https');
const { URL } = require('url');

const target = process.argv[2] || 'https://rsvp.smbhl.com/admin/contacts';

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'check-cloudflare-access-script' } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

async function main() {
  console.log(`check_cloudflare_access: requesting ${target} with no admin key or Access session...`);
  let res;
  try {
    res = await get(target);
  } catch (err) {
    console.error('check_cloudflare_access: request failed -- network issue, not a result either way.');
    console.error(String((err && err.message) || err));
    process.exit(2);
  }

  const location = res.headers['location'] || '';
  const wwwAuth = res.headers['www-authenticate'] || '';
  const redirectsToAccess = res.status >= 300 && res.status < 400 && /cloudflareaccess\.com\/cdn-cgi\/access\/login/i.test(location);
  const hasAccessChallengeHeader = /Cloudflare-Access/i.test(wwwAuth);

  if (redirectsToAccess && hasAccessChallengeHeader) {
    console.log(`check_cloudflare_access: OK -- protected. Got Access's own challenge (${res.status} -> ${location.split('?')[0]}), never reached the Worker.`);
    process.exit(0);
  }

  console.error('check_cloudflare_access: WARNING -- this request did NOT get Access\'s challenge.');
  console.error(`  status: ${res.status}`);
  console.error(`  location header: ${location || '(none)'}`);
  console.error(`  www-authenticate header: ${wwwAuth || '(none)'}`);
  console.error('If this path should be Access-protected, check the Cloudflare dashboard -- the policy may have been removed or misconfigured. Do NOT assume this means the Worker itself is broken; checkAdminAuth (src/admin_auth.js) is a separate, independent gate and may still be correctly rejecting this request on its own (e.g. a plain 403) -- that is a DIFFERENT, less severe situation than Access being gone entirely, but still worth checking.');
  process.exit(1);
}

main();

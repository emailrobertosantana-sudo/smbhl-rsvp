// Schema-drift guard task, Part 5: SMBHL's admin surface
// (rsvp.smbhl.com/admin/*) is protected by TWO independent layers --
// a Cloudflare Access policy (configured in the Cloudflare dashboard,
// outside this repo entirely -- see README.md's own documentation of
// it) sitting in front of the Worker at Cloudflare's edge, and
// checkAdminAuth (src/admin_auth.js), the Worker's own ADMIN_KEY gate.
//
// The risk this test answers: if Access were ever accidentally removed
// from the dashboard (the same class of "configuration silently
// missing" risk as the pre-guard schema drift this whole task exists
// to address), would the admin surface still be protected, or would it
// suddenly be wide open? This proves checkAdminAuth does NOT implicitly
// trust that Access has already filtered the request -- it never reads
// or checks for ANY Access-related header/cookie at all (confirmed by
// reading src/admin_auth.js's own source: checkAdminAuth only ever
// looks at the x-admin header, ?key/?k/?t query params, and the
// admin_key cookie -- nothing Access-shaped). A request carrying
// exactly the header Access injects for an APPROVED user
// (cf-access-authenticated-user-email) still gets rejected without the
// real ADMIN_KEY, proving the Worker's own gate would hold even if
// Access were gone.
//
// This can only be verified at the Worker-code level, from inside this
// test suite -- it answers "is the Worker's OWN gate independent",
// not "is Access itself still configured on the real domain" (that is
// an edge-level fact no in-process test can observe; see
// scripts/check_cloudflare_access.js and its own header comment for
// why that has to be a real external HTTP request instead, and
// README.md for how to run it).
//
// Overlaps intentionally with one existing assertion inside
// test/index.spec.js's own broad admin-auth regression test (the
// "Request carrying cf-access-authenticated-user-email without admin
// key must be rejected" case) -- kept here too, in its own clearly-
// named file, specifically so this exact guarantee is discoverable on
// its own rather than buried inside a much larger, differently-scoped
// file.
import worker from '../src/index.js';
import { checkAdminAuth } from '../src/admin_auth.js';
import { describe, it, expect } from 'vitest';

const ADMIN_KEY = 'test-cf-access-independence-key';
const env = { ADMIN_KEY };

describe('Part 5 (schema-drift guard task): checkAdminAuth is a genuinely independent second layer, not implicitly trusting Access', () => {
  it('checkAdminAuth never reads any Cloudflare Access header or cookie -- only ADMIN_KEY (header/query/cookie)', () => {
    // Every Access-shaped signal a real approved request could ever
    // carry, all present, with NO real admin key anywhere -- if
    // checkAdminAuth trusted any of these, this would incorrectly
    // return 'ok'.
    const req = new Request('https://rsvp.smbhl.com/admin/contacts', {
      headers: {
        'cf-access-authenticated-user-email': 'emailrobertosantana@gmail.com',
        'cf-access-jwt-assertion': 'not-a-real-jwt-but-shaped-like-one',
        'cookie': 'CF_Authorization=not-a-real-access-cookie',
      }
    });
    expect(checkAdminAuth(req, env)).toBe('unauthorized');
  });

  it('the SAME request WOULD succeed with the real ADMIN_KEY present -- proving the rejection above is genuinely about the key, not an unrelated bug', () => {
    const req = new Request('https://rsvp.smbhl.com/admin/contacts', {
      headers: {
        'cf-access-authenticated-user-email': 'emailrobertosantana@gmail.com',
        'cf-access-jwt-assertion': 'not-a-real-jwt-but-shaped-like-one',
        'x-admin': ADMIN_KEY,
      }
    });
    expect(checkAdminAuth(req, env)).toBe('ok');
  });

  it('end-to-end through the real Worker: an admin API route 403s for a request carrying Access\'s own approved-user header but no ADMIN_KEY', async () => {
    const res = await worker.fetch(new Request('http://example.com/admin/board/data', {
      headers: { 'cf-access-authenticated-user-email': 'emailrobertosantana@gmail.com', 'cf-connecting-ip': '203.0.113.201' }
    }), env);
    expect(res.status).toBe(403);
  });

  it('end-to-end: the admin PAGE shell still renders the locked "gate" (not the unlocked admin UI) for the same Access-header-but-no-key request', async () => {
    const res = await worker.fetch(new Request('http://example.com/admin/contacts', {
      headers: { 'cf-access-authenticated-user-email': 'emailrobertosantana@gmail.com', 'cf-connecting-ip': '203.0.113.202' }
    }), env);
    expect(res.status).toBe(200); // page shell always 200s; the GATE is what's actually protecting it
    const html = await res.text();
    expect(html).not.toContain('id="gate" style="display:none"'); // gate NOT hidden -- still locked
    expect(html).toContain('id="main" style="display:none"'); // real admin UI NOT shown
  });
});

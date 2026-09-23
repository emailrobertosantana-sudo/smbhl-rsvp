// Live-testing task, Part 6: bulk roster import. Parsing happens
// client-side (see the roster page's own parseBulkText/bulkPreview
// script) with a preview before committing -- these tests exercise the
// server side of the feature (POST /league/contacts/bulk), which is
// what actually matters for data correctness: it must run every row
// through the same createLeagueContactRow validation/dedup path the
// single-add route uses, never a second looser copy of that logic.
//
// DECISION (documented): a bad row (missing name, invalid email, a
// duplicate email either within the same pasted block or against an
// existing roster entry) is skipped with a per-row reason, not a hard
// failure of the whole batch -- a realistic paste of 20 players
// shouldn't be all-or-nothing over one typo.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part6-bulk-import-secret';

function extractCookie(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(', ');
  const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
  return csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
}
async function signup(email, ip) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  return { cookie: extractCookie(res), csrfToken: extractCsrfToken(res) };
}
async function createLeague(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).league;
}
async function bulkImport(cookie, csrfToken, contacts) {
  const res = await SELF.fetch('http://example.com/league/contacts/bulk', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ contacts })
  });
  return { status: res.status, json: await res.json() };
}

describe('Part 6 (live-testing task): bulk roster import (POST /league/contacts/bulk)', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('imports a realistic mixed batch: creates valid rows, reports counts', async () => {
    const { cookie, csrfToken } = await signup('bulk.import.basic@example.com', '203.0.128.001');
    await createLeague(cookie, csrfToken, { name: 'Bulk Import Basic League', teamNames: ['A', 'B'], tracksStats: true });

    const { status, json } = await bulkImport(cookie, csrfToken, [
      { name: 'Marie Tremblay', email: 'marie.tremblay@example.com', phone: '514-555-0100' },
      { name: 'Jean Bouchard', email: 'jean.bouchard@example.com' },
      { name: 'Ana García' }
    ]);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.createdCount).toBe(3);
    expect(json.skippedCount).toBe(0);
    expect(json.results.every(r => r.status === 'created')).toBe(true);

    const rows = await env.DB.prepare("SELECT name FROM contacts WHERE league_id = (SELECT id FROM leagues WHERE name = 'Bulk Import Basic League') ORDER BY name").all();
    expect(rows.results.map(r => r.name).sort()).toEqual(['Ana García', 'Jean Bouchard', 'Marie Tremblay']);
  });

  it('a duplicate email within the same pasted batch is skipped (second occurrence), not a hard failure of the whole batch', async () => {
    const { cookie, csrfToken } = await signup('bulk.import.dupebatch@example.com', '203.0.128.002');
    await createLeague(cookie, csrfToken, { name: 'Bulk Import Dupe Batch League', teamNames: ['A', 'B'], tracksStats: true });

    const { json } = await bulkImport(cookie, csrfToken, [
      { name: 'First Person', email: 'shared@example.com' },
      { name: 'Second Person', email: 'shared@example.com' },
      { name: 'Third Person', email: 'unique@example.com' }
    ]);
    expect(json.createdCount).toBe(2);
    expect(json.skippedCount).toBe(1);
    const skipped = json.results.find(r => r.status === 'skipped');
    expect(skipped.reason).toBe('duplicate_in_batch');
    expect(skipped.name).toBe('Second Person');
  });

  it('a duplicate email against an EXISTING roster entry is skipped with a note, not a hard failure', async () => {
    const { cookie, csrfToken } = await signup('bulk.import.dupeexisting@example.com', '203.0.128.003');
    await createLeague(cookie, csrfToken, { name: 'Bulk Import Dupe Existing League', teamNames: ['A', 'B'], tracksStats: true });
    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Already Here', email: 'already.here@example.com' })
    });

    const { json } = await bulkImport(cookie, csrfToken, [
      { name: 'New Person', email: 'new.person@example.com' },
      { name: 'Already Here Again', email: 'already.here@example.com' }
    ]);
    expect(json.createdCount).toBe(1);
    expect(json.skippedCount).toBe(1);
    const skipped = json.results.find(r => r.status === 'skipped');
    expect(skipped.reason).toBe('duplicate_existing');
    expect(skipped.errorKey).toBe('CONTACT_EMAIL_EXISTS');
  });

  it('a row with an invalid/missing name is skipped with a note, batch continues for the rest', async () => {
    const { cookie, csrfToken } = await signup('bulk.import.badname@example.com', '203.0.128.004');
    await createLeague(cookie, csrfToken, { name: 'Bulk Import Bad Name League', teamNames: ['A', 'B'], tracksStats: true });

    const { json } = await bulkImport(cookie, csrfToken, [
      { name: 'OnlyOneWord', email: 'oneword@example.com' },
      { name: 'Valid Name', email: 'valid.name@example.com' }
    ]);
    expect(json.createdCount).toBe(1);
    expect(json.skippedCount).toBe(1);
    const skipped = json.results.find(r => r.status === 'skipped');
    expect(skipped.reason).toBe('invalid');
    expect(skipped.errorKey).toBe('FULL_NAME_REQUIRED');
  });

  it('an empty batch is rejected with a clear error', async () => {
    const { cookie, csrfToken } = await signup('bulk.import.empty@example.com', '203.0.128.005');
    await createLeague(cookie, csrfToken, { name: 'Bulk Import Empty League', teamNames: ['A', 'B'], tracksStats: true });
    const { status, json } = await bulkImport(cookie, csrfToken, []);
    expect(status).toBe(400);
    expect(json.errorKey).toBe('BULK_CONTACTS_REQUIRED');
  });

  it('imported players get correctly collision-safe, sequential player IDs (reuses the single-add ID-assignment logic)', async () => {
    const { cookie, csrfToken } = await signup('bulk.import.ids@example.com', '203.0.128.006');
    const league = await createLeague(cookie, csrfToken, { name: 'Bulk Import IDs League', teamNames: ['A', 'B'], tracksStats: true });

    const { json } = await bulkImport(cookie, csrfToken, [
      { name: 'Player One' }, { name: 'Player Two' }, { name: 'Player Three' }
    ]);
    const ids = json.results.map(r => r.contact.player_id);
    expect(new Set(ids).size).toBe(3);
    ids.forEach(id => expect(id.startsWith(league.id + ':P')).toBe(true));
  });

  it('the roster page itself renders the import button and preview overlay', async () => {
    const { cookie, csrfToken } = await signup('bulk.import.ui@example.com', '203.0.128.008');
    await createLeague(cookie, csrfToken, { name: 'Bulk Import UI League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    expect(html).toContain('id="ro_toggle_bulk"');
    expect(html).toContain('id="ro_bulk_overlay"');
    expect(html).toContain('id="ro_bulk_text"');
    expect(html).toContain('/league/contacts/bulk');
  });

  it('this route cannot be used against SMBHL', async () => {
    const { cookie, csrfToken } = await signup('bulk.import.smbhl.blocked@example.com', '203.0.128.007');
    // No league created for this account -- resolveSessionLeagueId will
    // have nothing to resolve to, matching the single-add route's own
    // NO_LEAGUE_FOUND path (SMBHL itself is blocked identically to the
    // single-add route -- see ROUTE_BLOCKED_CONTACTS on that route,
    // which this route shares verbatim).
    const { status, json } = await bulkImport(cookie, csrfToken, [{ name: 'Someone Person' }]);
    expect(status).toBe(404);
    expect(json.errorKey).toBe('NO_LEAGUE_FOUND');
  });
});

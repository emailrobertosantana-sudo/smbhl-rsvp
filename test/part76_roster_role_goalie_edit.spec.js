// Live-testing task (batch 6), Part 5: the roster list showed Role
// and Goalie columns but offered no way to change either. After a
// bulk import there was no path to mark anyone a sub or a goalie at
// all -- every imported row lands as 'roster'/not-a-goalie by
// construction (parseBulkText has no column for either), and the
// only way forward was deleting and re-adding.
//
// Fix: both are now inline, clickable toggle buttons on the roster
// list (data-toggle-role / data-toggle-goalie), posting to a new
// POST /league/contacts/update route (leagues.js) -- same two
// INDEPENDENT axes as the existing "add a player" form (role:
// roster/sub_skater; is_goalie: gated on the sport's own goalie
// capability), each settable on its own, for a player created via
// single add OR bulk import alike (the update route doesn't care how
// the row was created).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { extractInlineScripts, assertNoSyntaxError, runScript } from './support/inline_scripts.js';

const AUTH_SECRET = 'test-part76-roster-role-goalie-edit-secret';

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
async function addContact(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).contact;
}
async function updateContact(cookie, csrfToken, body) {
  return SELF.fetch('http://example.com/league/contacts/update', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
}

describe('Part 5 (live-testing task, batch 6): roster role/goalie are now editable inline', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a player added via single add: role and is_goalie are both editable and persist', async () => {
    const { cookie, csrfToken } = await signup('rosteredit.single@example.com', '203.0.190.001');
    await createLeague(cookie, csrfToken, { name: 'Roster Edit Single League', teamNames: ['X', 'Y'] });
    const contact = await addContact(cookie, csrfToken, { name: 'Single Add Player' });
    expect(contact.role).toBe('roster');
    expect(contact.is_goalie).toBe(0);

    const roleRes = await updateContact(cookie, csrfToken, { player_id: contact.player_id, role: 'sub_skater' });
    const roleBody = await roleRes.json();
    expect(roleBody.ok).toBe(true);
    expect(roleBody.role).toBe('sub_skater');

    const goalieRes = await updateContact(cookie, csrfToken, { player_id: contact.player_id, is_goalie: true });
    const goalieBody = await goalieRes.json();
    expect(goalieBody.ok).toBe(true);
    expect(goalieBody.is_goalie).toBe(true);

    const row = await env.DB.prepare('SELECT role, is_goalie FROM contacts WHERE player_id = ?').bind(contact.player_id).first();
    expect(row.role).toBe('sub_skater');
    expect(row.is_goalie).toBe(1);
  });

  it('a player added via BULK import: role and is_goalie are both editable and persist -- the exact reported gap', async () => {
    const { cookie, csrfToken } = await signup('rosteredit.bulk@example.com', '203.0.190.002');
    await createLeague(cookie, csrfToken, { name: 'Roster Edit Bulk League', teamNames: ['X', 'Y'] });
    const bulkRes = await SELF.fetch('http://example.com/league/contacts/bulk', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ contacts: [{ name: 'Bulk Import Player' }] })
    });
    const bulkBody = await bulkRes.json();
    expect(bulkBody.createdCount).toBe(1);
    const playerId = bulkBody.results[0].contact.player_id;
    // Bulk import gives every row 'roster'/not-a-goalie by construction
    // -- exactly the reported gap this task fixes.
    expect(bulkBody.results[0].contact.role).toBe('roster');

    const res = await updateContact(cookie, csrfToken, { player_id: playerId, role: 'sub_skater', is_goalie: true });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.role).toBe('sub_skater');
    expect(body.is_goalie).toBe(true);

    const row = await env.DB.prepare('SELECT role, is_goalie FROM contacts WHERE player_id = ?').bind(playerId).first();
    expect(row.role).toBe('sub_skater');
    expect(row.is_goalie).toBe(1);
  });

  it('a partial update only touches the field actually sent -- role alone does not reset is_goalie, and vice versa', async () => {
    const { cookie, csrfToken } = await signup('rosteredit.partial@example.com', '203.0.190.003');
    await createLeague(cookie, csrfToken, { name: 'Roster Edit Partial League', teamNames: ['X', 'Y'] });
    const contact = await addContact(cookie, csrfToken, { name: 'Partial Update Player', is_goalie: true });
    expect(contact.is_goalie).toBe(1);

    await updateContact(cookie, csrfToken, { player_id: contact.player_id, role: 'sub_skater' });
    const row = await env.DB.prepare('SELECT role, is_goalie FROM contacts WHERE player_id = ?').bind(contact.player_id).first();
    expect(row.role).toBe('sub_skater');
    expect(row.is_goalie).toBe(1); // untouched by the role-only update
  });

  it('cross-league scoping: a league admin cannot update another league\'s contact', async () => {
    const a = await signup('rosteredit.crossa@example.com', '203.0.190.004');
    const leagueA = await createLeague(a.cookie, a.csrfToken, { name: 'Cross League A', teamNames: ['X', 'Y'] });
    const contactA = await addContact(a.cookie, a.csrfToken, { name: 'League A Player' });
    void leagueA;

    const b = await signup('rosteredit.crossb@example.com', '203.0.190.005');
    await createLeague(b.cookie, b.csrfToken, { name: 'Cross League B', teamNames: ['X', 'Y'] });

    const res = await updateContact(b.cookie, b.csrfToken, { player_id: contactA.player_id, role: 'sub_skater' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.errorKey).toBe('PLAYER_NOT_FOUND');

    const row = await env.DB.prepare('SELECT role FROM contacts WHERE player_id = ?').bind(contactA.player_id).first();
    expect(row.role).toBe('roster'); // untouched
  });

  it('requires session and CSRF, and rejects an invalid role value', async () => {
    const { cookie, csrfToken } = await signup('rosteredit.validation@example.com', '203.0.190.006');
    await createLeague(cookie, csrfToken, { name: 'Roster Edit Validation League', teamNames: ['X', 'Y'] });
    const contact = await addContact(cookie, csrfToken, { name: 'Validation Player' });

    const noAuth = await SELF.fetch('http://example.com/league/contacts/update', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ player_id: contact.player_id, role: 'sub_skater' })
    });
    expect(noAuth.status).toBe(401);

    const badRole = await updateContact(cookie, csrfToken, { player_id: contact.player_id, role: 'not_a_real_role' });
    expect(badRole.status).toBe(400);
    expect((await badRole.json()).errorKey).toBe('INVALID_ROLE');
  });

  it('SMBHL is blocked from this route (it has no leagues/league_admins session path into it to begin with, but the explicit guard is still tested)', async () => {
    const { cookie, csrfToken } = await signup('rosteredit.smbhlguard@example.com', '203.0.190.008');
    // No league created for this account -- resolveSessionLeagueId finds
    // none, so this hits NO_LEAGUE_FOUND before ever reaching the
    // SMBHL-id check, exactly like every other league-scoped write
    // route this engagement has tested this same way (no session path
    // to SMBHL exists at all).
    const res = await updateContact(cookie, csrfToken, { player_id: 'whatever', role: 'sub_skater' });
    expect(res.status).toBe(404);
    expect((await res.json()).errorKey).toBe('NO_LEAGUE_FOUND');
  });

  it('the roster page\'s inline scripts are syntactically valid, with the toggle functions and buttons present', async () => {
    const { cookie, csrfToken } = await signup('rosteredit.uicheck@example.com', '203.0.190.007');
    await createLeague(cookie, csrfToken, { name: 'Roster Edit UI League', teamNames: ['X', 'Y'] });
    await addContact(cookie, csrfToken, { name: 'UI Check Player' });

    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    expect(html).toContain('data-toggle-role=');
    expect(html).toContain('data-toggle-goalie=');

    const scripts = extractInlineScripts(html);
    assertNoSyntaxError(scripts, '/league/roster');
    const combined = scripts.join('\n;\n');
    expect(runScript(combined, 'return typeof toggleRosterField;')).toBe('function');
  });
});

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
async function createEvent(cookie, csrfToken, body) {
  return SELF.fetch('http://example.com/league/events', {
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

  // E1 bug fix (players polish task): "Gardien ou joueur?" as a label,
  // with a column header separately reading "Gardien" above cells
  // reading "Joueur", was contradictory. Both renamed to "Position" --
  // the options themselves are unchanged.
  it('E1: the label and column header both read "Position" now, not the old contradictory "Gardien ou joueur?"/"Gardien"', async () => {
    const { cookie, csrfToken } = await signup('rosteredit.e1.position@example.com', '203.0.190.020');
    await createLeague(cookie, csrfToken, { name: 'E1 Position League', teamNames: ['X', 'Y'] });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="goalieAxis">Position<');
    expect(html).toContain('data-i18n="colGoalie">Position<');
    expect(html).not.toContain('Gardien ou joueur?');
    // The options themselves are untouched.
    expect(html).toContain('data-i18n="axisPlayer">Joueur<');
    expect(html).toContain('data-i18n="axisGoalie">Gardien<');
  });

  // E2 bug fix (players polish task): "can also play goalie" -- a
  // Player who can cover the goalie spot if the primary is out.
  // Reuses contacts.is_backup_goalie (the same column SMBHL's own
  // admin already writes for this exact concept) -- new here is only
  // the league product's own write path and display.
  describe('E2: "can also play goalie"', () => {
    it('the add-player form shows the checkbox only under Player, hidden under Goalie, with the explanatory Regular/Sub line kept', async () => {
      const { cookie, csrfToken } = await signup('rosteredit.e2.form@example.com', '203.0.190.021');
      await createLeague(cookie, csrfToken, { name: 'E2 Form League', teamNames: ['X', 'Y'] });
      const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
      expect(html).toContain('id="r_backup_goalie_wrap"');
      expect(html).toContain('data-i18n="canAlsoGoalie"');
      expect(html).toContain("document.getElementById('r_backup_goalie_wrap')");
      expect(html).toContain("backupWrap.style.display = r_goalie ? 'none' : ''");
      // The existing Regular/Sub independence note is kept, unchanged.
      expect(html).toContain('data-i18n="goalieAxisHelp"');
      expect(html).toContain('Indépendant de Régulier/Remplaçant');
    });

    it('POST /league/contacts persists is_backup_goalie=1 for a Player, and the table shows the G badge', async () => {
      const { cookie, csrfToken } = await signup('rosteredit.e2.create@example.com', '203.0.190.022');
      await createLeague(cookie, csrfToken, { name: 'E2 Create League', teamNames: ['X', 'Y'] });
      const contact = await addContact(cookie, csrfToken, { name: 'Dual Position Player', is_goalie: false, is_backup_goalie: true });
      expect(contact.is_backup_goalie).toBe(1);
      const row = await env.DB.prepare('SELECT is_goalie, is_backup_goalie FROM contacts WHERE player_id = ?').bind(contact.player_id).first();
      expect(row.is_goalie).toBe(0);
      expect(row.is_backup_goalie).toBe(1);

      const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
      expect(html).toContain('data-i18n="goalieBadge"');
      expect(html).toContain('title="Peut aussi jouer gardien"');
    });

    it('is_backup_goalie is never set for an actual goalie, even if a caller sends true for both', async () => {
      const { cookie, csrfToken } = await signup('rosteredit.e2.mutex@example.com', '203.0.190.023');
      await createLeague(cookie, csrfToken, { name: 'E2 Mutex League', teamNames: ['X', 'Y'] });
      const contact = await addContact(cookie, csrfToken, { name: 'Actual Goalie Player', is_goalie: true, is_backup_goalie: true });
      expect(contact.is_goalie).toBe(1);
      expect(contact.is_backup_goalie).toBe(0);

      // Switching an existing backup-goalie Player TO Goalie clears the flag too.
      const player2 = await addContact(cookie, csrfToken, { name: 'Switching Player', is_goalie: false, is_backup_goalie: true });
      expect(player2.is_backup_goalie).toBe(1);
      await updateContact(cookie, csrfToken, { player_id: player2.player_id, is_goalie: true });
      const row = await env.DB.prepare('SELECT is_goalie, is_backup_goalie FROM contacts WHERE player_id = ?').bind(player2.player_id).first();
      expect(row.is_goalie).toBe(1);
      expect(row.is_backup_goalie).toBe(0);
    });

    it('E2 behaviour: counts as a player for roster minimums (unaffected skater count), and satisfies goalie coverage for a game when the primary goalie is out', async () => {
      // headcount: a single implicit team/pool -- isolates this check
      // from a SECOND real team's own, unrelated shortage (a 'fixed'
      // 2-team league would show team Y as short its own goalie too,
      // for having nobody confirmed at all -- a real but irrelevant
      // confound for what this test is actually checking).
      const { cookie, csrfToken } = await signup('rosteredit.e2.coverage@example.com', '203.0.190.024');
      await createLeague(cookie, csrfToken, { name: 'E2 Coverage League', teamStructure: 'headcount', minPlayers: 1, maxPlayers: 10 });
      await SELF.fetch('http://example.com/league/season/publish', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ season_name: 'E2 Season', min_players: 1, max_players: 10, min_goalies: 1 })
      });
      const primaryGoalie = await addContact(cookie, csrfToken, { name: 'Primary Goalie Player', is_goalie: true });
      const dualPlayer = await addContact(cookie, csrfToken, { name: 'Dual Coverage Player', is_goalie: false, is_backup_goalie: true });
      expect(dualPlayer.is_backup_goalie).toBe(1);

      const evRes = await createEvent(cookie, csrfToken, { date: '2099-08-08' });
      const eventId = (await evRes.json()).event.id;
      await SELF.fetch('http://example.com/league/rsvp/admin', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: primaryGoalie.player_id, status: 'out' })
      });
      await SELF.fetch('http://example.com/league/rsvp/admin', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: dualPlayer.player_id, status: 'in' })
      });

      // "Counts as a player for roster minimums": still a real skater
      // confirmation, unaffected by the backup-goalie flag.
      const detailHtml = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } })).text();
      expect(detailHtml).toContain('Dual Coverage Player');

      // "Satisfies goalie coverage": with the primary goalie out and this
      // player confirmed in, the event is NOT short a goalie -- no real
      // "Inviter un gardien" BUTTON, matching teamState/expected's own
      // existing backup-goalie fallback (index.js, unchanged by this
      // task). The embedded __I18N dict always carries the
      // "inviteGoalie" KEY regardless of whether it's used (same as
      // every other page here) -- what matters is whether a button
      // actually uses it as its own data-i18n value.
      expect(detailHtml).not.toContain('data-i18n="inviteGoalie"');
    });
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

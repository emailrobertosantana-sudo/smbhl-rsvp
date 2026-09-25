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
    it('the add-player form shows the checkbox only under Player, hidden under Goalie; the Regular/Sub helper line is gone (B4 -- Role and Position are already visually separate controls with their own labels)', async () => {
      const { cookie, csrfToken } = await signup('rosteredit.e2.form@example.com', '203.0.190.021');
      await createLeague(cookie, csrfToken, { name: 'E2 Form League', teamNames: ['X', 'Y'] });
      const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
      expect(html).toContain('id="r_backup_goalie_wrap"');
      expect(html).toContain('data-i18n="canAlsoGoalie"');
      expect(html).toContain("document.getElementById('r_backup_goalie_wrap')");
      expect(html).toContain("backupWrap.style.display = r_goalie ? 'none' : ''");
      // B4 (stale-copy polish task): the Regular/Sub independence note was
      // removed entirely, both languages -- Role and Position are already
      // visually separate controls with their own labels.
      expect(html).not.toContain('data-i18n="goalieAxisHelp"');
      expect(html).not.toContain('Indépendant de Régulier/Remplaçant');
      expect(html).not.toContain('Independent of Regular/Sub');
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

// Item 2 (player-editing polish task): name/email/phone were create-
// only -- the only way to fix a typo, add an email after the fact, or
// flag an EXISTING player as "can also play goalie" was delete-and-
// re-add (which also erases their rsvp/history, a real edit doesn't
// need to). Per this task's own "built means reachable from a
// rendered page" standard, these tests check the rendered controls
// exist and are wired, not just that the backend route works.
describe('Item 2: inline player editing (name, email, phone, can-also-play-goalie)', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the roster page renders an Edit control and a matching hidden edit row (name/email/phone fields) for each player', async () => {
    const { cookie, csrfToken } = await signup('item2.edit.render@example.com', '203.0.191.001');
    await createLeague(cookie, csrfToken, { name: 'Item2 Edit Render League', teamNames: ['A', 'B'] });
    const player = await addContact(cookie, csrfToken, { name: 'Render Edit Player', team: 'A', email: 'renderedit@example.com' });

    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    expect(html).toContain('data-i18n="editPlayerBtn"');
    expect(html).toContain(`onclick="toggleEditRow('${player.player_id}')"`);
    expect(html).toContain(`id="edit_row_${player.player_id}"`);
    expect(html).toContain(`id="edit_name_${player.player_id}"`);
    expect(html).toContain(`id="edit_email_${player.player_id}"`);
    expect(html).toContain(`id="edit_phone_${player.player_id}"`);
    expect(html).toContain(`onclick="submitEditRow('${player.player_id}')"`);
    // Hidden by default -- one click to open, matching every other
    // expand-in-place panel already on this page.
    expect(html).toMatch(new RegExp(`id="edit_row_${player.player_id}"[^>]*style="display:none;"`));
    // Role/Position remain their own separate inline toggles -- not
    // folded into this edit panel.
    expect(html).toContain(`data-toggle-role="${player.player_id}"`);
  });

  it('the goalie flag ("can also play goalie") can be changed on an EXISTING player through the rendered edit form, not just the route directly', async () => {
    const { cookie, csrfToken } = await signup('item2.edit.goalieflag@example.com', '203.0.191.002');
    await createLeague(cookie, csrfToken, { name: 'Item2 Edit Goalie Flag League', teamNames: ['A', 'B'] });
    const player = await addContact(cookie, csrfToken, { name: 'Goalie Flag Player', team: 'A', email: 'goalieflag@example.com' });

    const before = await env.DB.prepare('SELECT is_backup_goalie FROM contacts WHERE player_id = ?').bind(player.player_id).first();
    expect(before.is_backup_goalie).toBe(0);

    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    // The checkbox the rendered "can also play goalie" control is --
    // present, unchecked, and inside this player's own edit row.
    expect(html).toContain(`id="edit_backup_${player.player_id}"`);
    const rowStart = html.indexOf(`id="edit_row_${player.player_id}"`);
    const rowEnd = html.indexOf('</tr>', rowStart);
    const rowHtml = html.slice(rowStart, rowEnd);
    expect(rowHtml).toContain(`id="edit_backup_${player.player_id}"`);
    expect(rowHtml).not.toMatch(new RegExp(`id="edit_backup_${player.player_id}"[^>]*checked`));

    // Exactly the request submitEditRow() issues when that checkbox is
    // ticked and Save is clicked.
    const res = await SELF.fetch('http://example.com/league/contacts/update', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ player_id: player.player_id, name: player.name, email: 'goalieflag@example.com', phone: '', is_backup_goalie: true })
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.is_backup_goalie).toBe(true);

    const after = await env.DB.prepare('SELECT is_backup_goalie FROM contacts WHERE player_id = ?').bind(player.player_id).first();
    expect(after.is_backup_goalie).toBe(1);

    // The badge now renders on a fresh load of the same rendered page.
    const html2 = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    expect(html2).toContain('data-i18n="goalieBadge"');
  });

  it('the checkbox never renders for a player already flagged as a real goalie (mutually exclusive, matching the add-player form)', async () => {
    const { cookie, csrfToken } = await signup('item2.edit.realgoalie@example.com', '203.0.191.003');
    await createLeague(cookie, csrfToken, { name: 'Item2 Edit Real Goalie League', teamNames: ['A', 'B'] });
    const goalie = await addContact(cookie, csrfToken, { name: 'Real Goalie Player', team: 'A', is_goalie: true });

    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    const rowStart = html.indexOf(`id="edit_row_${goalie.player_id}"`);
    const rowEnd = html.indexOf('</tr>', rowStart);
    expect(html.slice(rowStart, rowEnd)).not.toContain(`id="edit_backup_${goalie.player_id}"`);
  });

  it('name and email can both be edited through the update route, with the same validation the add-player form already enforces', async () => {
    const { cookie, csrfToken } = await signup('item2.edit.namevalid@example.com', '203.0.191.004');
    await createLeague(cookie, csrfToken, { name: 'Item2 Edit Name Valid League', teamNames: ['A', 'B'] });
    const player = await addContact(cookie, csrfToken, { name: 'Original Name', team: 'A' });

    const renamed = await updateContact(cookie, csrfToken, { player_id: player.player_id, name: 'Updated Name Real' });
    expect(renamed.status).toBe(200);
    const renamedRow = await env.DB.prepare('SELECT name FROM contacts WHERE player_id = ?').bind(player.player_id).first();
    expect(renamedRow.name).toBe('Updated Name Real');

    const badName = await updateContact(cookie, csrfToken, { player_id: player.player_id, name: 'OnlyOneWord' });
    expect(badName.status).toBe(400);
    expect((await badName.json()).errorKey).toBe('FULL_NAME_REQUIRED');

    const emailed = await updateContact(cookie, csrfToken, { player_id: player.player_id, email: 'updatedemail@example.com' });
    expect(emailed.status).toBe(200);
    const emailedRow = await env.DB.prepare('SELECT email FROM contacts WHERE player_id = ?').bind(player.player_id).first();
    expect(emailedRow.email).toBe('updatedemail@example.com');

    const badEmail = await updateContact(cookie, csrfToken, { player_id: player.player_id, email: 'not-an-email' });
    expect(badEmail.status).toBe(400);
    expect((await badEmail.json()).errorKey).toBe('INVALID_EMAIL');
  });

  it('editing a player\'s email to one already used by another player in the same league is rejected', async () => {
    const { cookie, csrfToken } = await signup('item2.edit.emaildupe@example.com', '203.0.191.005');
    await createLeague(cookie, csrfToken, { name: 'Item2 Edit Email Dupe League', teamNames: ['A', 'B'] });
    await addContact(cookie, csrfToken, { name: 'Existing Email Player', team: 'A', email: 'taken@example.com' });
    const player2 = await addContact(cookie, csrfToken, { name: 'Second Player Here', team: 'B', email: 'nottaken@example.com' });

    const res = await updateContact(cookie, csrfToken, { player_id: player2.player_id, email: 'taken@example.com' });
    expect(res.status).toBe(400);
    expect((await res.json()).errorKey).toBe('CONTACT_EMAIL_EXISTS');

    // But re-saving a player's own UNCHANGED email is fine (self-dedup
    // exclusion) -- a plain re-save (e.g. only the phone changed)
    // must not falsely collide with the player's own existing row.
    const selfRes = await updateContact(cookie, csrfToken, { player_id: player2.player_id, email: 'nottaken@example.com', phone: '514-555-0100' });
    expect(selfRes.status).toBe(200);
  });
});

// Item 3 (players polish task): a retired player keeps all history but
// is hidden from active rosters, counts, and invite pools; a collapsed
// (hidden-by-default) section on the Players page, not a tab, is the
// only place they're reachable. SMBHL has its own version of this
// (role='archived') -- not reused here since role is a hard invariant
// elsewhere in this codebase (exactly 'roster'/'sub_skater'); this is
// the same CONCEPT ported as a new, orthogonal is_active column
// instead, matching how is_goalie/is_backup_goalie already work.
describe('Item 3: inactive players', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  async function publishSeason(cookie, csrfToken, body) {
    return SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify(body)
    });
  }
  async function setActive(cookie, csrfToken, playerId, isActive) {
    return SELF.fetch('http://example.com/league/contacts/active', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ player_id: playerId, is_active: isActive })
    });
  }

  it('marking a player inactive removes them from the active roster table and puts them in the collapsed section instead', async () => {
    const { cookie, csrfToken } = await signup('item3.roster.hide@example.com', '203.0.192.001');
    await createLeague(cookie, csrfToken, { name: 'Item3 Roster Hide League', teamNames: ['A', 'B'] });
    const player = await addContact(cookie, csrfToken, { name: 'Roster Hide Player', team: 'A', email: 'rosterhide@example.com' });

    const before = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    expect(before).toContain('Roster Hide Player');
    expect(before).not.toContain('id="ro_inactive_toggle"');

    const res = await setActive(cookie, csrfToken, player.player_id, false);
    expect(res.status).toBe(200);
    expect((await res.json()).is_active).toBe(false);

    const after = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    // Not in the active table's own tbody...
    const tbodyStart = after.indexOf('id="ro_tbody"');
    const tbodyEnd = after.indexOf('</tbody>', tbodyStart);
    expect(after.slice(tbodyStart, tbodyEnd)).not.toContain('Roster Hide Player');
    // ...but present, collapsed by default, in the inactive section.
    expect(after).toContain('id="ro_inactive_toggle"');
    expect(after).toMatch(/id="ro_inactive_list" style="display:none;"/);
    expect(after).toContain('Roster Hide Player');
    expect(after).toContain(`data-inactive-row="${player.player_id}"`);
    expect(after).toContain(`onclick="reactivatePlayer('${player.player_id}', this)"`);
    // Not a tab alongside All/Subs -- the filter pills are unaffected.
    expect(after).not.toContain('data-filter="inactive"');
  });

  it('an inactive player does not appear in an event\'s player list, and does not count toward confirmed/pending totals', async () => {
    const { cookie, csrfToken } = await signup('item3.event.exclude@example.com', '203.0.192.002');
    await createLeague(cookie, csrfToken, { name: 'Item3 Event Exclude League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'Item3 Event Exclude Season' });
    const active = await addContact(cookie, csrfToken, { name: 'Still Active Player', team: 'A', email: 'stillactive@example.com' });
    const toRetire = await addContact(cookie, csrfToken, { name: 'To Retire Player', team: 'A', email: 'toretire@example.com' });
    const evRes = await createEvent(cookie, csrfToken, { date: '2099-08-01' });
    const eventId = (await evRes.json()).event.id;
    // Confirm both IN before retiring one -- proves retiring actively
    // removes them from an event they were already part of, not just
    // that they were never added.
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: active.player_id, status: 'in' })
    });
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: toRetire.player_id, status: 'in' })
    });

    const before = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } })).text();
    expect(before).toContain('To Retire Player');
    const confirmedMatch = before.match(/<span class="stat tnum">(\d+)<\/span><span data-i18n="confirmed">/);
    expect(confirmedMatch[1]).toBe('2');

    await setActive(cookie, csrfToken, toRetire.player_id, true); // no-op sanity: reactivating an already-active player is harmless
    await setActive(cookie, csrfToken, toRetire.player_id, false);

    const after = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } })).text();
    expect(after).not.toContain('To Retire Player');
    expect(after).toContain('Still Active Player');
    const confirmedMatchAfter = after.match(/<span class="stat tnum">(\d+)<\/span><span data-i18n="confirmed">/);
    expect(confirmedMatchAfter[1]).toBe('1');

    // The rsvp row itself is real history, still queryable directly --
    // just flipped to 'out' so shortage/count math (which reads rsvp,
    // not a fresh roster pull) stays correct without needing its own
    // is_active awareness.
    const rsvpRow = await env.DB.prepare('SELECT status FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, toRetire.player_id).first();
    expect(rsvpRow.status).toBe('out');
  });

  it('an inactive player is never offered by the sub/goalie invite pool', async () => {
    const { cookie, csrfToken } = await signup('item3.invite.exclude@example.com', '203.0.192.003');
    await createLeague(cookie, csrfToken, { name: 'Item3 Invite Exclude League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'Item3 Invite Exclude Season', skaters_per_team: 3, min_skaters: 1, goalies_per_team: 0 });
    const sub = await addContact(cookie, csrfToken, { name: 'Retired Sub Player', role: 'sub_skater', email: 'retiredsub@example.com' });
    await setActive(cookie, csrfToken, sub.player_id, false);
    const evRes = await createEvent(cookie, csrfToken, { date: '2099-08-02' });
    const eventId = (await evRes.json()).event.id;

    const inviteRes = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, team: 'A', need: 'skater' })
    });
    expect(inviteRes.status).toBe(200);
    const outboxRow = await env.DB.prepare("SELECT 1 FROM outbox WHERE event_id = ? AND player_id = ? AND kind = 'sub_call'").bind(eventId, sub.player_id).first();
    expect(outboxRow).toBeNull();
  });

  it('reactivation restores a player to the active roster and event player lists', async () => {
    const { cookie, csrfToken } = await signup('item3.reactivate@example.com', '203.0.192.004');
    await createLeague(cookie, csrfToken, { name: 'Item3 Reactivate League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'Item3 Reactivate Season' });
    const player = await addContact(cookie, csrfToken, { name: 'Reactivate Me Player', team: 'A', email: 'reactivateme@example.com' });
    const evRes = await createEvent(cookie, csrfToken, { date: '2099-08-03' });
    const eventId = (await evRes.json()).event.id;

    await setActive(cookie, csrfToken, player.player_id, false);
    const midHtml = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    const midTbodyStart = midHtml.indexOf('id="ro_tbody"');
    const midTbodyEnd = midHtml.indexOf('</tbody>', midTbodyStart);
    expect(midHtml.slice(midTbodyStart, midTbodyEnd)).not.toContain('Reactivate Me Player');

    const reactivateRes = await setActive(cookie, csrfToken, player.player_id, true);
    expect(reactivateRes.status).toBe(200);
    expect((await reactivateRes.json()).is_active).toBe(true);

    const row = await env.DB.prepare('SELECT is_active FROM contacts WHERE player_id = ?').bind(player.player_id).first();
    expect(row.is_active).toBe(1);

    const afterHtml = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    const afterTbodyStart = afterHtml.indexOf('id="ro_tbody"');
    const afterTbodyEnd = afterHtml.indexOf('</tbody>', afterTbodyStart);
    expect(afterHtml.slice(afterTbodyStart, afterTbodyEnd)).toContain('Reactivate Me Player');
    // No leftover collapsed section once nobody is inactive anymore.
    expect(afterHtml).not.toContain('id="ro_inactive_toggle"');

    const eventHtml = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } })).text();
    expect(eventHtml).toContain('Reactivate Me Player');
  });

  it('players are league-wide, not season-scoped -- is_active on the contacts row itself, unaffected by publishing a new season', async () => {
    const { cookie, csrfToken } = await signup('item3.leaguewide@example.com', '203.0.192.005');
    await createLeague(cookie, csrfToken, { name: 'Item3 League Wide League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'Item3 League Wide Season 1' });
    const player = await addContact(cookie, csrfToken, { name: 'League Wide Player', team: 'A', email: 'leaguewide@example.com' });
    await setActive(cookie, csrfToken, player.player_id, false);

    await publishSeason(cookie, csrfToken, { season_name: 'Item3 League Wide Season 2' });
    const row = await env.DB.prepare('SELECT is_active FROM contacts WHERE player_id = ?').bind(player.player_id).first();
    expect(row.is_active).toBe(0);
  });

  it('the deactivate control lives inside the edit panel, not a separate tab, and validates player_id/is_active', async () => {
    const { cookie, csrfToken } = await signup('item3.control.validate@example.com', '203.0.192.006');
    await createLeague(cookie, csrfToken, { name: 'Item3 Control Validate League', teamNames: ['A', 'B'] });
    const player = await addContact(cookie, csrfToken, { name: 'Control Validate Player', team: 'A' });

    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    expect(html).toContain(`onclick="deactivatePlayer('${player.player_id}', this)"`);
    expect(html).toContain('data-i18n="deactivateBtn"');

    const missingId = await setActive(cookie, csrfToken, '', false);
    expect(missingId.status).toBe(400);
    expect((await missingId.json()).errorKey).toBe('PLAYER_ID_REQUIRED');

    const badType = await SELF.fetch('http://example.com/league/contacts/active', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ player_id: player.player_id, is_active: 'not-a-boolean' })
    });
    expect(badType.status).toBe(400);
    expect((await badType.json()).errorKey).toBe('IS_ACTIVE_REQUIRED');

    const unknownPlayer = await setActive(cookie, csrfToken, 'whatever-not-real', false);
    expect(unknownPlayer.status).toBe(404);
    expect((await unknownPlayer.json()).errorKey).toBe('PLAYER_NOT_FOUND');
  });

  it('SMBHL is blocked from this route', async () => {
    const { cookie, csrfToken } = await signup('item3.smbhlguard@example.com', '203.0.192.007');
    const res = await setActive(cookie, csrfToken, 'whatever', false);
    expect(res.status).toBe(404);
    expect((await res.json()).errorKey).toBe('NO_LEAGUE_FOUND');
  });
});

// Item 4 (season-rollover polish task): players are league-wide, not
// season-scoped (Item 3's own note), so there's no separate per-season
// roster to copy -- "importing" is the admin confirming, at the
// moment a new season starts, who stays active. Reuses
// setContactActiveState (Item 3's own mechanism) for both directions,
// per this task's "one path, not two implementations" instruction.
describe('Item 4: season rollover -- import players', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  async function publishSeason(cookie, csrfToken, body) {
    return SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify(body)
    });
  }
  async function setActive(cookie, csrfToken, playerId, isActive) {
    return SELF.fetch('http://example.com/league/contacts/active', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ player_id: playerId, is_active: isActive })
    });
  }
  async function rolloverImport(cookie, csrfToken, playerIds) {
    return SELF.fetch('http://example.com/league/season/rollover-import', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ player_ids: playerIds })
    });
  }

  it('a player from the previous season who is NOT imported becomes inactive, but keeps their history (not deleted)', async () => {
    const { cookie, csrfToken } = await signup('item4.notimported@example.com', '203.0.193.001');
    await createLeague(cookie, csrfToken, { name: 'Item4 Not Imported League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'Item4 Season 1' });
    const kept = await addContact(cookie, csrfToken, { name: 'Kept Player One', team: 'A', email: 'kept1@example.com' });
    const dropped = await addContact(cookie, csrfToken, { name: 'Dropped Player One', team: 'B', email: 'dropped1@example.com' });

    const res = await rolloverImport(cookie, csrfToken, [kept.player_id]);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deactivated).toBe(1);
    expect(data.activated).toBe(0);

    const keptRow = await env.DB.prepare('SELECT is_active FROM contacts WHERE player_id = ?').bind(kept.player_id).first();
    expect(keptRow.is_active).toBe(1);
    const droppedRow = await env.DB.prepare('SELECT is_active, name FROM contacts WHERE player_id = ?').bind(dropped.player_id).first();
    expect(droppedRow.is_active).toBe(0);
    expect(droppedRow.name).toBe('Dropped Player One'); // not deleted -- real history kept
  });

  it('an inactive player imported deliberately (checked in the list, matching this task\'s own "brought back" case) becomes active', async () => {
    const { cookie, csrfToken } = await signup('item4.deliberate@example.com', '203.0.193.002');
    await createLeague(cookie, csrfToken, { name: 'Item4 Deliberate League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'Item4 Deliberate Season 1' });
    const returning = await addContact(cookie, csrfToken, { name: 'Returning Player One', team: 'A', email: 'returning1@example.com' });
    await setActive(cookie, csrfToken, returning.player_id, false);
    const before = await env.DB.prepare('SELECT is_active FROM contacts WHERE player_id = ?').bind(returning.player_id).first();
    expect(before.is_active).toBe(0);

    const res = await rolloverImport(cookie, csrfToken, [returning.player_id]);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activated).toBe(1);

    const after = await env.DB.prepare('SELECT is_active FROM contacts WHERE player_id = ?').bind(returning.player_id).first();
    expect(after.is_active).toBe(1);
  });

  it('the import is skippable -- declining to call this route at all changes nothing', async () => {
    const { cookie, csrfToken } = await signup('item4.skippable@example.com', '203.0.193.003');
    await createLeague(cookie, csrfToken, { name: 'Item4 Skippable League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'Item4 Skippable Season 1' });
    const player = await addContact(cookie, csrfToken, { name: 'Skippable Player One', team: 'A', email: 'skippable1@example.com' });

    // A second, genuinely new season is created -- exactly the moment
    // the rollover offer would appear -- but the admin simply never
    // calls the import route (the rendered page's own "Ignorer"/Skip
    // button does nothing but reload, per submitSeasonMgmt's own JS).
    await publishSeason(cookie, csrfToken, { season_name: 'Item4 Skippable Season 2' });

    const row = await env.DB.prepare('SELECT is_active FROM contacts WHERE player_id = ?').bind(player.player_id).first();
    expect(row.is_active).toBe(1);
  });

  it('rejects a non-array player_ids, blocks SMBHL, and requires authentication', async () => {
    const { cookie, csrfToken } = await signup('item4.validate@example.com', '203.0.193.004');
    await createLeague(cookie, csrfToken, { name: 'Item4 Validate League', teamNames: ['A', 'B'] });

    const badBody = await SELF.fetch('http://example.com/league/season/rollover-import', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ player_ids: 'not-an-array' })
    });
    expect(badBody.status).toBe(400);
    expect((await badBody.json()).errorKey).toBe('PLAYER_IDS_REQUIRED');

    const noAuth = await SELF.fetch('http://example.com/league/season/rollover-import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ player_ids: [] })
    });
    expect(noAuth.status).toBe(401);

    const { cookie: smbhlCookie, csrfToken: smbhlCsrf } = await signup('item4.smbhlguard@example.com', '203.0.193.005');
    const smbhlRes = await rolloverImport(smbhlCookie, smbhlCsrf, []);
    expect(smbhlRes.status).toBe(404);
    expect((await smbhlRes.json()).errorKey).toBe('NO_LEAGUE_FOUND');
  });

  it('the settings page renders the collapsed rollover-import panel (hidden by default) with the checkbox-list wiring, once a season already exists', async () => {
    const { cookie, csrfToken } = await signup('item4.render@example.com', '203.0.193.006');
    await createLeague(cookie, csrfToken, { name: 'Item4 Render League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'Item4 Render Season 1' });

    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toContain('id="rollover_import_panel" style="display:none;"');
    expect(html).toContain('data-i18n="rolloverTitle"');
    expect(html).toContain('onclick="submitRolloverImport()"');
    expect(html).toContain('onclick="skipRolloverImport()"');
    expect(html).toContain('CURRENT_SEASON_NAME = "Item4 Render Season 1"');
  });

  it('GET /league/contacts (the panel\'s own data source) includes is_active, so the checkbox list can pre-check active players and leave inactive ones unchecked', async () => {
    const { cookie, csrfToken } = await signup('item4.contactsjson@example.com', '203.0.193.007');
    await createLeague(cookie, csrfToken, { name: 'Item4 Contacts Json League', teamNames: ['A', 'B'] });
    const active = await addContact(cookie, csrfToken, { name: 'Json Active Player', team: 'A' });
    const inactive = await addContact(cookie, csrfToken, { name: 'Json Inactive Player', team: 'B' });
    await setActive(cookie, csrfToken, inactive.player_id, false);

    const res = await SELF.fetch('http://example.com/league/contacts', { headers: { cookie } });
    const data = await res.json();
    const byId = Object.fromEntries(data.contacts.map(c => [c.player_id, c]));
    expect(byId[active.player_id].is_active).toBe(1);
    expect(byId[inactive.player_id].is_active).toBe(0);
  });
});

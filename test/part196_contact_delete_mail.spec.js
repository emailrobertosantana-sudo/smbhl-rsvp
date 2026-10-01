// Item 8. A permanently deleted contact gets no more mail (8a): every
// pending outbox row addressed to them is cancelled with the reason
// "contact deleted", sent rows stay. Archiving changes nothing. And a
// contact with no name is named in a notice on the SMBHL people page
// (8b), which sends no email to anyone.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { cancelPendingMailForContact } from '../src/index.js';

const KEY = 'p196-admin';
const one = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const rows = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then(r => r.results || []);
const post = body => SELF.fetch('http://example.com/admin/contacts', { method: 'POST', headers: { 'x-admin': KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function contact(id, name, role = 'sub_skater', league = 'smbhl') {
  await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id, is_active) VALUES (?, ?, ?, ?, 1, 0, 's', ?, 1)`)
    .bind(id, name, `${id.replace(/\W/g, '').toLowerCase()}@example.com`, role, league).run();
}
// pending, sent, failed: one row of each for the contact.
async function mail(id, league = 'smbhl') {
  const ins = (n, sent, failed) => env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, sent_at, failed_at, created_at, league_id) VALUES ('sub_call', '2099-11-01-x', ?, 'Red', ?, '{"need":"skater"}', '2099-01-01T00:00:00Z', ?, ?, '2026-10-01T00:00:00Z', ?)`)
    .bind(id, `p196:${id}:${n}`, sent, failed, league).run();
  await ins('pending', null, null);
  await ins('sent', '2026-10-01T00:05:00Z', null);
  await ins('failed', null, '2026-10-01T00:06:00Z');
}
const outboxOf = id => rows('SELECT dedup_key, sent_at, failed_at, cancelled, error FROM outbox WHERE player_id = ? ORDER BY id', id);

beforeAll(async () => {
  env.ADMIN_KEY = KEY;
  await applyRealSchema(env);
  await env.DB.prepare('DELETE FROM contacts').run();
  await env.DB.prepare('DELETE FROM outbox').run();
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: 'Fall 2099', seasons: [{ name: 'Fall 2099', config: { teams: [{ name: 'Red' }, { name: 'Blue' }] }, fixtures: [], standings: [] }], players: [] }));
});

describe('8a: a permanent delete cancels the contact\'s pending mail', () => {
  it('SMBHL: deleting a contact cancels its pending row, keeps the sent and failed rows, and leaves other contacts alone', async () => {
    await contact('smbhl:P8001', 'Paul Parti');
    await contact('smbhl:P8002', 'Rita Reste');
    await mail('smbhl:P8001');
    await mail('smbhl:P8002');
    const res = await post({ action: 'purge', player_id: 'smbhl:P8001' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deleted: true, cancelled_mail: 1 });
    expect(await one('SELECT 1 x FROM contacts WHERE player_id = ?', 'smbhl:P8001')).toBeNull();
    const gone = await outboxOf('smbhl:P8001');
    expect(gone.map(r => [r.dedup_key.split(':').pop(), r.cancelled, r.error])).toEqual([
      ['pending', 1, 'contact deleted'],
      ['sent', 0, null],
      ['failed', 0, null]
    ]);
    expect(gone[1].sent_at).toBe('2026-10-01T00:05:00Z');
    // Someone else's pending mail still goes.
    expect((await outboxOf('smbhl:P8002')).map(r => r.cancelled)).toEqual([0, 0, 0]);
  });

  it('delete_permanent does the same', async () => {
    await contact('smbhl:P8003', 'Dan Depart');
    await mail('smbhl:P8003');
    expect(await (await post({ action: 'delete_permanent', player_id: 'smbhl:P8003' })).json()).toMatchObject({ deleted: true, cancelled_mail: 1 });
    expect((await outboxOf('smbhl:P8003')).map(r => r.cancelled)).toEqual([1, 0, 0]);
  });

  it('archiving is not deleting: the pending row stays', async () => {
    await contact('smbhl:P8004', 'Alex Archive');
    await mail('smbhl:P8004');
    expect((await post({ action: 'remove', player_id: 'smbhl:P8004', reason: 'season_off' })).status).toBe(200);
    expect(await one('SELECT role FROM contacts WHERE player_id = ?', 'smbhl:P8004')).toMatchObject({ role: 'archived' });
    expect((await outboxOf('smbhl:P8004')).map(r => [r.cancelled, r.error])).toEqual([[0, null], [0, null], [0, null]]);
  });

  it('Notre Ligue: the same rule for a league contact\'s key', async () => {
    await mail('lg196:P1', 'lg196');
    expect(await cancelPendingMailForContact(env, 'lg196:P1')).toBe(1);
    expect((await outboxOf('lg196:P1')).map(r => [r.cancelled, r.error])).toEqual([[1, 'contact deleted'], [0, null], [0, null]]);
    // Run again: nothing left to cancel.
    expect(await cancelPendingMailForContact(env, 'lg196:P1')).toBe(0);
  });
});

describe('8b: a contact with no name is named in a notice on the people page', () => {
  it('the data lists active contacts with no name, by their readable label, and not named or archived ones', async () => {
    await contact('smbhl:P8010', '');
    await contact('smbhl:P8011', 'Nina Nommee');
    await contact('smbhl:P8012', '', 'archived');
    const d = await (await SELF.fetch('http://example.com/admin/people/data', { headers: { 'x-admin': KEY } })).json();
    const ids = d.unnamed.map(u => u.player_id);
    expect(ids).toContain('smbhl:P8010');
    expect(ids).not.toContain('smbhl:P8011');
    expect(ids).not.toContain('smbhl:P8012');
    const u = d.unnamed.find(x => x.player_id === 'smbhl:P8010');
    expect(u.name).toBeTruthy();
    expect(u.name).not.toBe('smbhl:P8010');
  });

  it('the page carries the notice and its copy in French and English', async () => {
    const page = await (await SELF.fetch('http://example.com/admin/people', { headers: { 'x-admin': KEY } })).text();
    expect(page).toContain('id="unnamed-notice"');
    expect(page).toContain("unnamedNotice: \"Contacts sans nom : {list}. Ajoutez leur nom pour qu'il apparaisse dans les listes et les courriels.\"");
    expect(page).toContain('unnamedNotice: "Contacts with no name: {list}. Add their name so it shows in lists and emails."');
  });

  it('the check sends no email: the outbox is the same before and after', async () => {
    const before = await rows('SELECT id, cancelled, sent_at FROM outbox ORDER BY id');
    await SELF.fetch('http://example.com/admin/people/data', { headers: { 'x-admin': KEY } });
    await SELF.fetch('http://example.com/admin/people', { headers: { 'x-admin': KEY } });
    expect(await rows('SELECT id, cancelled, sent_at FROM outbox ORDER BY id')).toEqual(before);
  });
});

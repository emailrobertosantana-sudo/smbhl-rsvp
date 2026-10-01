// No page shows a raw contact key (src/contact_name.js).
//
// On SMBHL production a sub-call list showed "smbhl:P9008": the contact
// had been deleted and its sub-call rows were left behind, so the page fell
// back to the key. Every page that lists people now resolves the name the
// same way: contacts.name, then the data.json roster by the exact id, then
// a readable label ("(sans nom) / (no name)" and the masked email, or
// "(contact supprimé) / (deleted contact)" when the contact row is gone).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { contactDisplayName, maskEmail, rosterNameMap, NO_NAME_LABEL, DELETED_CONTACT_LABEL } from '../src/contact_name.js';

const ADMIN_KEY = 'test-part189-admin';
const SEASON = 'P189';
const EV = 'smbhl:2099-03-01';
const ORPHAN = 'smbhl:P9008'; // sub calls left behind by a deleted contact
const BARE = 'P9008'; // a different person: the same number, issued bare
const NAMELESS = 'smbhl:P9013';
const NAMED = 'P0100';
const ROSTER_ONLY = 'P0200'; // in data.json, no contact row
const ROSTER = [{ id: BARE, name: 'Bare Number Player' }, { id: ROSTER_ONLY, name: 'Roster Only Player' }];
const admin = (path, body) => SELF.fetch('http://example.com' + path, { method: body ? 'POST' : 'GET', headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const RAW_KEY = /^(smbhl:)?P\d{4}$/;
let originalFetch;

describe('contactDisplayName', () => {
  it('contacts.name wins, then the roster by the exact id, then a readable label', () => {
    const roster = rosterNameMap(ROSTER);
    expect(contactDisplayName({ contact: { player_id: BARE, name: 'From Contacts', email: 'x@example.com' }, roster, id: BARE })).toBe('From Contacts');
    expect(contactDisplayName({ contact: { player_id: ROSTER_ONLY, name: '  ', email: null }, roster, id: ROSTER_ONLY })).toBe('Roster Only Player');
    expect(contactDisplayName({ contact: null, roster, id: ROSTER_ONLY })).toBe('Roster Only Player');
    // 'smbhl:P9008' is not 'P9008': no name borrowed across the two numberings.
    expect(contactDisplayName({ contact: null, roster, id: ORPHAN })).toBe(DELETED_CONTACT_LABEL);
    expect(contactDisplayName({ contact: { player_id: NAMELESS, name: '', email: 'benoit@example.com' }, roster, id: NAMELESS })).toBe(`${NO_NAME_LABEL} b***@example.com`);
    expect(contactDisplayName({ contact: { player_id: NAMELESS, name: null, email: null }, id: NAMELESS })).toBe(NO_NAME_LABEL);
  });

  it('getPlayerStats-style roster values (objects with .name) work too', () => {
    const stats = new Map([[ROSTER_ONLY, { ppg: 1, gp: 2, name: 'Roster Only Player' }]]);
    expect(contactDisplayName({ contact: null, roster: stats, id: ROSTER_ONLY })).toBe('Roster Only Player');
  });

  it('masks an address and nothing else', () => {
    expect(maskEmail('olivier@gmail.com')).toBe('o***@gmail.com');
    expect(maskEmail('')).toBe('');
    expect(maskEmail('not an address')).toBe('');
    expect(maskEmail('@x.com')).toBe('');
  });
});

describe('SMBHL pages never show a raw contact key', () => {
  beforeAll(async () => {
    env.ADMIN_KEY = ADMIN_KEY;
    delete env.LEAGUE_PRODUCT;
    await applyRealSchema(env);
    await env.DB.prepare('DELETE FROM contacts').run();
    originalFetch = globalThis.fetch;
    // getPlayerStats reads the public data.json over the network.
    globalThis.fetch = async url => (String(url).endsWith('/data.json')
      ? new Response(JSON.stringify({ players: ROSTER }), { status: 200 })
      : new Response('{}', { status: 404 }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: SEASON, seasons: [{ name: SEASON, config: { teams: [{ name: 'Red' }, { name: 'Blue' }] }, fixtures: [], standings: [] }], players: ROSTER }));
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, ?, 1, '2099-03-01', 'Aréna', 'open', '10:30', 'smbhl')`).bind(EV, SEASON).run();
    const contact = (id, name, email) => env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, 'sub_skater', 1, 0, 'salt', 'smbhl')`).bind(id, name, email).run();
    await contact(NAMED, 'Named Sub', 'named@example.com');
    await contact(NAMELESS, '', 'benoit@example.com');
    await contact(BARE, 'Olivier Bare', 'olivier@example.com');
    for (const pid of [ORPHAN, NAMELESS, NAMED, ROSTER_ONLY]) {
      await env.DB.prepare(
        `INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, sent_at, created_at, league_id)
         VALUES ('sub_call', ?, ?, 'Red', ?, '{"need":"skater"}', '2099-02-27T00:00:00Z', '2099-02-27T00:05:00Z', '2099-02-27T00:00:00Z', 'smbhl')`
      ).bind(EV, pid, `p189:${pid}`).run();
    }
    await env.DB.prepare(`INSERT INTO polls (season, title, description, created_at) VALUES (?, 'Meilleur gardien', '', '2099-01-01T00:00:00Z')`).bind(SEASON).run();
    const pollId = (await env.DB.prepare('SELECT id FROM polls LIMIT 1').first()).id;
    await env.DB.prepare(`INSERT INTO poll_votes (poll_id, voter_id, candidate_id, candidate_name, created_at, updated_at) VALUES (?, ?, 'P0001', 'Someone', '2099-01-02T00:00:00Z', '2099-01-02T00:00:00Z')`).bind(pollId, ORPHAN).run();
  });
  afterAll(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('the sub-call list: deleted, nameless, named and roster-only contacts', async () => {
    const d = await (await admin('/admin/subs/data?e=' + encodeURIComponent(EV))).json();
    const byId = Object.fromEntries(d.subs.map(s => [s.player_id, s.name]));
    expect(byId).toEqual({
      [ORPHAN]: DELETED_CONTACT_LABEL,
      [NAMELESS]: `${NO_NAME_LABEL} b***@example.com`,
      [NAMED]: 'Named Sub',
      [ROSTER_ONLY]: 'Roster Only Player'
    });
    for (const s of d.subs) expect(s.name).not.toMatch(RAW_KEY);
    expect(d.subs.some(s => 'realName' in s)).toBe(false);
  });

  it('the communications outbox names every row', async () => {
    const d = await (await admin('/admin/comms/data')).json();
    const rows = (d.outbox || []).filter(o => o.event_id === EV);
    expect(rows.length).toBe(4);
    const byId = Object.fromEntries(rows.map(o => [o.player_id, o.player_name]));
    expect(byId[ORPHAN]).toBe(DELETED_CONTACT_LABEL);
    expect(byId[NAMELESS]).toBe(`${NO_NAME_LABEL} b***@example.com`);
    expect(byId[NAMED]).toBe('Named Sub');
    for (const o of rows) expect(o.player_name).not.toMatch(RAW_KEY);
  });

  it('the people page labels a contact with no name', async () => {
    const d = await (await admin('/admin/people/data')).json();
    const p = d.people.find(x => x.player_id === NAMELESS);
    expect(p.name).toBe(`${NO_NAME_LABEL} b***@example.com`);
    for (const x of d.people) expect(x.name).not.toMatch(RAW_KEY);
  });

  it('the poll voters list names a deleted voter, and sends no voter email', async () => {
    const d = await (await admin('/admin/polls/data')).json();
    const votes = d.polls.flatMap(p => p.votes_list || []);
    expect(votes.map(v => v.voter_name)).toEqual([DELETED_CONTACT_LABEL]);
    expect(votes.some(v => 'voter_email' in v || 'contact_id' in v)).toBe(false);
  });

  it('adding a player to a team never writes the key into data.json as a name', async () => {
    const res = await admin('/admin/teams/add', { player_id: ORPHAN, season: SEASON, target_team: 'Red', position: 'A' });
    expect(res.status).toBe(404);
    const d = JSON.parse(await env.SHEETS_KV.get('data_json'));
    expect(d.players.some(p => p.id === ORPHAN || RAW_KEY.test(p.name))).toBe(false);
  });
});

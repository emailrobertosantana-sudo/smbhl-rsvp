// A league's URL slug is available again once the league is hard deleted
// (deletion means gone), the hard-delete audit log survives, and a live
// league's slug is still refused. The only thing that holds a slug is the
// league's own row in `leagues` (handleLeagueCreate: RESERVED_SLUGS, then
// SELECT id FROM leagues WHERE slug = ?; migrate-024's unique index) --
// hard delete removes that row.
//
// Also: the cascade leaves nothing behind. A league's sub answering a sub
// call goes through the shared /avail route (acceptAvailability), which
// used to write its rows with the column DEFAULT league_id 'smbhl' --
// invisible to a cascade that deletes by league_id. Those rows now carry
// the event's own league, and the cascade also deletes by event id and by
// league-keyed settings key.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { acceptAvailability } from '../src/index.js';
import { SCHEMA_MANIFEST } from '../src/schema_manifest.js';

const AUTH_SECRET = 'test-part116-auth';

function cookieOf(res) { return (res.headers.get('set-cookie') || '').split(';')[0]; }
function csrfOf(res) {
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.get('set-cookie') || '').split(', ');
  const c = cookies.find(x => x.startsWith('csrf_token='));
  return c ? c.split(';')[0].split('=')[1] : '';
}
async function account(email, ip) {
  const res = await SELF.fetch('http://example.com/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ accept_terms: true, email, password: 'a-strong-password-1' }) });
  const cookie = cookieOf(res), csrf = csrfOf(res);
  const post = (path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
  return { post };
}
const create = async (a, name, slug) => { const r = await a.post('/leagues/create', { name, slug, teamNames: ['A', 'B'] }); return { status: r.status, body: await r.json() }; };
async function hardDelete(a, league) {
  expect((await a.post('/league/deactivate', { confirmName: league.name })).status).toBe(200);
  // Past the 15-day unlock delay.
  await env.DB.prepare('UPDATE leagues SET deactivated_at = ? WHERE id = ?').bind(new Date(Date.now() - 16 * 86400000).toISOString(), league.id).run();
  const r = await a.post('/league/hard-delete', { confirmPhrase: `SUPPRIMER ${league.name}` });
  expect(r.status).toBe(200);
}

beforeAll(async () => {
  env.AUTH_SECRET = AUTH_SECRET;
  env.RSVP_SECRET = 'test-part116-rsvp';
  env.RESEND_API_KEY = 'test-part116-resend';
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => String(url).includes('api.resend.com') ? new Response('{"id":"x"}', { status: 200 }) : original(url, opts);
  await applyRealSchema(env);
});

describe('A slug is free again once its league is hard deleted', () => {
  let first;

  it('a live league holds its slug: anyone else asking for it is refused', async () => {
    const a = await account('p116-first@example.com', '203.0.116.1');
    const made = await create(a, 'First Owner', 'reuse-me');
    expect(made.status).toBe(200);
    first = { a, league: made.body.league };
    const other = await account('p116-other@example.com', '203.0.116.2');
    const refused = await create(other, 'Someone Else', 'reuse-me');
    expect(refused.status).toBe(409);
    expect(refused.body.errorKey).toBe('SLUG_TAKEN');
  });

  it('a deactivated league (not yet hard deleted) still holds it -- its row still exists', async () => {
    expect((await first.a.post('/league/deactivate', { confirmName: first.league.name })).status).toBe(200);
    const other = await account('p116-other2@example.com', '203.0.116.3');
    expect((await create(other, 'Too Early', 'reuse-me')).body.errorKey).toBe('SLUG_TAKEN');
  });

  it('after hard delete the same slug can be taken again, and the audit log keeps its row', async () => {
    await env.DB.prepare('UPDATE leagues SET deactivated_at = ? WHERE id = ?').bind(new Date(Date.now() - 16 * 86400000).toISOString(), first.league.id).run();
    expect((await first.a.post('/league/hard-delete', { confirmPhrase: `SUPPRIMER ${first.league.name}` })).status).toBe(200);
    expect(await env.DB.prepare('SELECT 1 FROM leagues WHERE slug = ?').bind('reuse-me').first()).toBeNull();

    const again = await account('p116-again@example.com', '203.0.116.4');
    const made = await create(again, 'First Owner', 'reuse-me');
    expect(made.status).toBe(200);
    expect(made.body.league.slug).toBe('reuse-me');
    expect(made.body.league.id).not.toBe(first.league.id);

    const log = await env.DB.prepare('SELECT league_id, league_name, deleted_via FROM league_hard_delete_log WHERE league_id = ?').bind(first.league.id).first();
    expect(log).toEqual({ league_id: first.league.id, league_name: 'First Owner', deleted_via: 'league_admin' });
  });
});

describe('The cascade leaves nothing of the league behind', () => {
  it("a league sub's /avail answer is tagged with the league, and after hard delete no row anywhere still refers to the league or its games", async () => {
    const a = await account('p116-cascade@example.com', '203.0.116.5');
    const league = (await create(a, 'Cascade League', 'cascade-league')).body.league;
    const ev = { id: `${league.id}:2026-12-01`, league_id: league.id, season: 'S', week: 1, date: '2026-12-01', start_time: '19:00', state: 'open' };
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'S', 1, '2026-12-01', 'Gym', 'open', '19:00', ?)`).bind(ev.id, league.id).run();
    const sub = `${league.id}:P0001`;
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, token_salt, league_id) VALUES (?, 'Sub', 'p116-sub@example.com', 'sub_skater', 1, 's', ?)`).bind(sub, league.id).run();
    await acceptAvailability(env, ev, sub, 'skater');
    expect((await env.DB.prepare('SELECT league_id FROM availability WHERE event_id = ?').bind(ev.id).first()).league_id).toBe(league.id);
    // A row some shared path left at the 'smbhl' default: gone too, by event id.
    await env.DB.prepare(`INSERT INTO team_messages (event_id, team, player_name, message, created_at) VALUES (?, 'A', 'x', 'hi', '2026-11-30T00:00:00Z')`).bind(ev.id).run();
    // The league's own settings rows: advanced cadence and a per-game message.
    await env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, '{}'), (?, 'msg')`).bind(`email_cadence_settings:${league.id}`, `league_message:${ev.id}`).run();

    await hardDelete(a, league);

    const leftovers = [];
    for (const [table, cols] of Object.entries(SCHEMA_MANIFEST)) {
      if (table === 'league_hard_delete_log') continue; // the audit trail, kept on purpose
      const conds = [], binds = [];
      const add = (sql, v) => { conds.push(sql); binds.push(v); };
      if (cols.includes('league_id')) add('league_id = ?', league.id);
      if (cols.includes('event_id')) add('event_id = ?', ev.id);
      if (cols.includes('player_id')) add('player_id = ?', sub);
      if (table === 'leagues') add('id = ?', league.id);
      if (table === 'settings') add('key LIKE ?', `%${league.id}%`);
      if (!conds.length) continue;
      const n = (await env.DB.prepare(`SELECT count(*) n FROM ${table} WHERE ${conds.join(' OR ')}`).bind(...binds).first()).n;
      if (n) leftovers.push(`${table}: ${n}`);
    }
    expect(leftovers).toEqual([]);
    expect(await env.DB.prepare('SELECT 1 FROM league_hard_delete_log WHERE league_id = ?').bind(league.id).first()).toBeTruthy();
  });
});

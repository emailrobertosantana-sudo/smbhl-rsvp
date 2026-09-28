// A player's team is settable from the Players table row, like Role and
// Position. Until now it could only be chosen in the Add-a-player form
// (bulk import has no team column, and nothing changed it afterwards), so
// nine imported players sat "Unassigned" with no way to place them.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.143.${++ip}` },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = async (s, path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const page = async (s, path) => (await SELF.fetch('http://example.com' + path, { headers: { cookie: s.cookie } })).text();
const teamOf = async id => (await env.DB.prepare('SELECT preferred_team FROM contacts WHERE player_id = ?').bind(id).first()).preferred_team;

beforeAll(async () => {
  env.AUTH_SECRET = 'p143-auth';
  await applyRealSchema(env);
});

describe('Team from the Players table row', () => {
  it('each row has a Team dropdown: the season\'s teams plus Unassigned, the current one selected', async () => {
    const s = await signup('p143.row@example.com');
    await post(s, '/leagues/create', { name: 'P143 Row', teamNames: ['Red', 'Blue', 'White'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const c = (await (await post(s, '/league/contacts', { name: 'Ann Blue', role: 'roster', team: 'Blue' })).json()).contact;
    const html = await page(s, '/league/roster');
    const sel = html.slice(html.indexOf(`data-set-team="${c.player_id}"`), html.indexOf('</select>', html.indexOf(`data-set-team="${c.player_id}"`)));
    expect(sel).toContain('<option value="" data-i18n="teamUnassigned">Non assigné</option>');
    for (const t of ['Red', 'White']) expect(sel).toContain(`<option value="${t}">${t}</option>`);
    expect(sel).toContain('<option value="Blue" selected>Blue</option>');
  });

  it('the row route sets a team, changes it, clears it -- and refuses one that is not the season\'s', async () => {
    const s = await signup('p143.route@example.com');
    await post(s, '/leagues/create', { name: 'P143 Route', teamNames: ['Red', 'Blue'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const c = (await (await post(s, '/league/contacts', { name: 'Bo Nobody', role: 'roster' })).json()).contact;
    expect(await teamOf(c.player_id)).toBeNull();
    let r = await (await post(s, '/league/contacts/update', { player_id: c.player_id, team: 'Red' })).json();
    expect(r.team).toBe('Red');
    expect(await teamOf(c.player_id)).toBe('Red');
    await post(s, '/league/contacts/update', { player_id: c.player_id, team: 'Blue' });
    expect(await teamOf(c.player_id)).toBe('Blue');
    await post(s, '/league/contacts/update', { player_id: c.player_id, team: '' });
    expect(await teamOf(c.player_id)).toBeNull();
    const bad = await post(s, '/league/contacts/update', { player_id: c.player_id, team: 'Green' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).errorKey).toBe('TEAM_UNKNOWN');
    // The page's own filter tabs follow.
    await post(s, '/league/contacts/update', { player_id: c.player_id, team: 'Red' });
    expect(await page(s, '/league/roster')).toContain('data-row-filter="team:Red"');
  });

  it('the existing paths keep working: Add a player with a team, and bulk import (Unassigned)', async () => {
    const s = await signup('p143.existing@example.com');
    await post(s, '/leagues/create', { name: 'P143 Existing', teamNames: ['Red', 'Blue'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const added = (await (await post(s, '/league/contacts', { name: 'Cy Added', role: 'roster', team: 'Blue' })).json()).contact;
    expect(await teamOf(added.player_id)).toBe('Blue');
    const bulk = await (await post(s, '/league/contacts/bulk', { contacts: [{ name: 'Di Bulk', email: 'di@p143.example' }, { name: 'Ed Bulk' }] })).json();
    expect(bulk.createdCount).toBe(2);
    for (const r of bulk.results) expect(await teamOf(r.contact.player_id)).toBeNull();
    // ...and a bulk-imported player can then be placed from the row.
    await post(s, '/league/contacts/update', { player_id: bulk.results[0].contact.player_id, team: 'Red' });
    expect(await teamOf(bulk.results[0].contact.player_id)).toBe('Red');
  });

  it('no Team dropdown where there are no fixed teams', async () => {
    const s = await signup('p143.pickup@example.com');
    await post(s, '/leagues/create', { name: 'P143 Pickup', teamStructure: 'weekly_draw', teamNames: ['A', 'B'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    await post(s, '/league/contacts', { name: 'Fay Pickup', role: 'roster' });
    expect(await page(s, '/league/roster')).not.toContain('data-set-team=');
  });
});

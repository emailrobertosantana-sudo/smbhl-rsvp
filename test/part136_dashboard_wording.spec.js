// Item 8: the dashboard says what it shows.
// 8a the game-status card showed "Cette semaine / This week" above the NEXT
//    game, even months away; it is now "Prochain match / Next game".
// 8b a no-teams league has no Teams tile (it showed "Aucune équipe fixe" in
//    a row of counts); Players and Public page remain.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.136.${++ip}` },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = async (s, path, body) => (await SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const dashboard = async s => (await SELF.fetch('http://example.com/dashboard', { headers: { cookie: s.cookie } })).text();

beforeAll(async () => {
  env.AUTH_SECRET = 'p136-auth';
  await applyRealSchema(env);
});

describe('Dashboard wording', () => {
  it('8a: a game months away is headed "next game", never "this week"', async () => {
    const s = await signup('p136.distant@example.com');
    await post(s, '/leagues/create', { name: 'P136 Distant', teamNames: ['A', 'B'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    await post(s, '/league/events', { date: '2099-01-01', season: 'S1', venue: 'Parc', start_time: '19:00' });
    const html = await dashboard(s);
    expect(html).toContain('data-i18n="weekStatusTitle">Prochain match<');
    expect(html).not.toContain('Cette semaine');
    expect(html).toContain('"weekStatusTitle":"Next game"');
    expect(html).not.toContain('This week');
  });

  it('8b: a no-teams league has no Teams tile; Players and Public page remain', async () => {
    const s = await signup('p136.headcount@example.com');
    await post(s, '/leagues/create', { name: 'P136 Headcount', teamStructure: 'headcount', minPlayers: 6, maxPlayers: 12 });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const html = await dashboard(s);
    expect(html).not.toContain('data-i18n="noFixedTeams"');
    expect((html.match(/dash-tile"/g) || []).length).toBe(2); // Players + Public page
    expect(html).toContain('<div class="overline" data-i18n="navRoster">Joueurs</div>');
    expect(html).toContain('data-i18n="publicPage">Page publique');
  });

  it('8b: a fixed league keeps its Teams tile', async () => {
    const s = await signup('p136.fixed@example.com');
    await post(s, '/leagues/create', { name: 'P136 Fixed', teamNames: ['A', 'B', 'C'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const html = await dashboard(s);
    expect((html.match(/dash-tile"/g) || []).length).toBe(3); // Teams + Players + Public page
  });
});

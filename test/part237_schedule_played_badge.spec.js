// Stage 2, item 2c: the « Ouvert » badge. A Notre Ligue game is never closed
// (only SMBHL's admin closes games), so on the admin schedule a game already
// played kept « Ouvert » / "Open" for good. A past game that was not
// cancelled now reads « Joué » / "Played", as on the public page; an upcoming
// game still reads « Ouvert », a cancelled one « Annulé ».
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

beforeAll(async () => {
  env.AUTH_SECRET = 'p237-auth'; env.LEAGUE_PRODUCT = 'true';
  await applyRealSchema(env);
});
afterAll(() => { delete env.LEAGUE_PRODUCT; });

describe('the admin schedule badges', () => {
  it('past: Joué; upcoming: Ouvert; cancelled: Annulé', async () => {
    const res = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.237.1' },
      body: JSON.stringify({ accept_terms: true, email: 'p237.owner@example.com', password: 'a-strong-password-1' })
    });
    const cookies = res.headers.getSetCookie();
    const cookie = cookies.map(c => c.split(';')[0]).join('; ');
    const csrf = (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1];
    const created = await (await SELF.fetch('http://example.com/leagues/create', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ligue badges', teamNames: ['A', 'B'] }) })).json();
    const lid = created.league.id;
    const ins = (id, date, state) => env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, end_time, league_id) VALUES (?, 'S1', 1, ?, 'Gym', ?, '19:00', '20:00', ?)`).bind(id, date, state, lid).run();
    await ins('p237-past', '2020-01-05', 'open');
    await ins('p237-past-cancelled', '2020-01-12', 'cancelled');
    await ins('p237-next', '2099-01-05', 'open');
    const page = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    const badge = id => {
      const at = page.indexOf(`href="/league/events/detail?e=${id}"`);
      return (page.slice(at).match(/<span class="nl-badge nl-badge--(\w+)" data-i18n="(\w+)">([^<]*)<\/span>/) || []).slice(1);
    };
    expect(badge('p237-past')).toEqual(['in', 'statePlayed', 'Joué']);
    expect(badge('p237-past-cancelled')).toEqual(['out', 'stateCancelled', 'Annulé']);
    expect(badge('p237-next')).toEqual(['pending', 'stateOpen', 'Ouvert']);
    const dict = JSON.parse(page.match(/var __I18N = (\{[\s\S]*?\});\n/)[1]);
    expect([dict.fr.statePlayed, dict.en.statePlayed]).toEqual(['Joué', 'Played']);
  });
});

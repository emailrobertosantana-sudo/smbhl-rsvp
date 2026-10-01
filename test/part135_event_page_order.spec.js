// Item 5: the event page in the agreed order -- title and Edit, reminders,
// the Players card, "confirmed, not yet assigned", then (after the game)
// the result and Player stats LAST.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { withGameTimes } from './support/game_times.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.135.${++ip}` },
    body: JSON.stringify({ accept_terms: true, email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = async (s, path, body) => (await SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

beforeAll(async () => {
  env.AUTH_SECRET = 'p135-auth';
  await applyRealSchema(env);
});

describe('Event page order', () => {
  for (const structure of ['fixed', 'weekly_draw']) {
    it(`${structure}: reminders, players, not-yet-assigned, then result and player stats last`, async () => {
      const s = await signup(`p135.${structure}@example.com`);
      await post(s, '/leagues/create', { name: `P135 ${structure}`, teamStructure: structure, tracksStats: true, teamNames: ['Otters', 'Bears'] });
      await post(s, '/league/settings/identity', { tracksResults: true, tracksPlayerStats: true });
      await post(s, '/league/season/publish', { season_name: 'S1' });
      const ev = (await post(s, '/league/events', withGameTimes({ date: '2020-05-03', season: 'S1', venue: 'Parc', start_time: '19:00' }))).event;
      const c = (await post(s, '/league/contacts', { name: 'Lea Player', role: 'roster', team: structure === 'fixed' ? 'Otters' : undefined })).contact;
      await post(s, '/league/rsvp/admin', { event_id: ev.id, player_id: c.player_id, status: 'in' });
      const html = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(ev.id)}`, { headers: { cookie: s.cookie } })).text();
      const at = marker => { const i = html.indexOf(marker); expect(i, marker).toBeGreaterThan(0); return i; };
      const order = [
        at('id="ev_edit_toggle"'),
        at('id="remind_now_btn"'),
        at('<div class="ev-teams">'),
        ...(structure === 'weekly_draw' ? [at('assign_team_')] : []),
        at('id="player_stats_section"')
      ];
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      // Player stats is the last card on the page.
      expect(html.indexOf('<section', at('id="player_stats_section"') + 1)).toBe(-1);
    });
  }
});

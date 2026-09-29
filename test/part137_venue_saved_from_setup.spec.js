// Item 7: a venue typed while creating the schedule (TESERE: "Letendre",
// entered during setup) is saved as a real venue -- it appears in Settings,
// and every event created references it by venue_id instead of carrying the
// name as free text. A later game typing the same name reuses it.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { withGameTimes } from './support/game_times.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.137.${++ip}` },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = async (s, path, body) => (await SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

beforeAll(async () => {
  env.AUTH_SECRET = 'p137-auth';
  await applyRealSchema(env);
});

describe('A venue from the setup flow is saved', () => {
  it('bulk create: one saved venue, in Settings, referenced by every event; a later game reuses it', async () => {
    const s = await signup('p137@example.com');
    const league = (await post(s, '/leagues/create', { name: 'P137 TESERE', teamNames: ['A', 'B'] })).league;
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const bulk = await post(s, '/league/events/bulk', withGameTimes({ startDate: '2099-01-01', occurrences: 4, season: 'S1', venue: 'Letendre', venue_address: '1000 Avenir', start_time: '19:00' }));
    expect(bulk.ok).toBe(true);

    const venues = (await env.DB.prepare('SELECT id, name, address FROM venues WHERE league_id = ?').bind(league.id).all()).results;
    expect(venues).toEqual([expect.objectContaining({ name: 'Letendre', address: '1000 Avenir' })]);
    const events = (await env.DB.prepare('SELECT venue, venue_id, venue_address FROM events WHERE league_id = ?').bind(league.id).all()).results;
    expect(events.length).toBe(4);
    for (const e of events) expect(e).toEqual({ venue: 'Letendre', venue_id: venues[0].id, venue_address: null });

    const settings = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie: s.cookie } })).text();
    expect(settings).toContain('Letendre');
    expect(settings).toContain('1000 Avenir');

    // Typed again (any case) on a later game: matched, not duplicated.
    const one = await post(s, '/league/events', withGameTimes({ date: '2099-03-01', season: 'S1', venue: 'letendre' }));
    expect(one.event.venue_id).toBe(venues[0].id);
    expect((await env.DB.prepare('SELECT count(*) n FROM venues WHERE league_id = ?').bind(league.id).first()).n).toBe(1);
  });
});

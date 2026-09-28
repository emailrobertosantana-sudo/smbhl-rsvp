// Item 12: the dead "assigned" email is gone; what it said -- the jersey
// colour, or "no shirt needed" in net -- is now in the sub's game-day email.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { body, drain } from '../src/index.js';

const ev = { id: 'smbhl:2099-04-05', season: 'Fall 2099', week: 5, date: 'Sunday April 5 2099', start_time: '10:30', venue: 'Aréna', state: 'open' };

describe('The sub game-day email carries the jersey colour', () => {
  it('a sub skater: bring a red shirt, in both languages', () => {
    const m = body('gameday', { ev, name: 'Sam', team: 'Red', link: 'L', payload: { isSub: true, isGoalie: false } });
    expect(m.text).toContain('👕 Apporte un chandail rouge.');
    expect(m.text).toContain('👕 Bring a red shirt.');
    expect(m.html).toContain('Apporte un chandail rouge.');
    expect(m.html).toContain('Bring a red shirt.');
  });
  it('a sub goalie: no shirt needed, gear lent', () => {
    const m = body('gameday', { ev, name: 'Gus', team: 'Blue', link: 'L', payload: { isSub: true, isGoalie: true } });
    expect(m.text).toContain("Pas besoin de chandail d'équipe. Si tu n'as pas d'équipement, la ligue en prête.");
    expect(m.text).toContain('No team shirt needed. If you do not have gear, the league lends it.');
  });
  it('a regular player gets no extra line; matchups that already name the shirt are not repeated', () => {
    expect(body('gameday', { ev, name: 'Reg', team: 'Red', link: 'L', payload: {} }).text).not.toContain('👕');
    const withFixtures = body('gameday', { ev, name: 'Sam', team: 'Red', link: 'L', payload: { isSub: true, fixtureText: '\n10:30 AM contre Bleu\nChandail rouge requis.\n', fixtureTextEn: '\n10:30 AM vs. Blue\nRed shirt required.\n' } });
    expect(withFixtures.text).not.toContain('👕');
    expect(withFixtures.text).toContain('Chandail rouge requis.');
  });
  it('"assigned" is no longer an email kind', () => {
    expect(body('assigned', { ev, name: 'X', team: 'Red', link: 'L', payload: {} })).toBeNull();
  });
});

describe('Through drain: a placed sub is recognised as a sub', () => {
  let originalFetch; const sent = [];
  beforeAll(async () => {
    env.RESEND_API_KEY = 'p133'; env.RSVP_SECRET = 'p133'; env.MAIL_DAILY_CAP = '100';
    await applyRealSchema(env);
    await env.DB.prepare('DELETE FROM contacts').run();
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('api.resend.com')) { sent.push(JSON.parse(opts.body)); return new Response('{"id":"x"}', { status: 200 }); }
      return new Response('{}', { status: 404 });
    };
    await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('email_cadence_settings', '{"quiet_hours_enabled":false}')`).run();
    await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: 'Fall 2099', seasons: [{ name: 'Fall 2099', standings: [], fixtures: [] }], players: [] }));
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'Fall 2099', 5, ?, 'Aréna', 'open', '10:30', 'smbhl')`).bind(ev.id, ev.date).run();
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES ('S9', 'Sam Sub', 's9@example.com', 'sub_skater', 1, 0, 's', 'smbhl')`).run();
    await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, 'S9', 'White', 'in', 'sub', '2099-01-01T00:00:00Z', 'smbhl')`).bind(ev.id).run();
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at, league_id) VALUES ('gameday', ?, 'S9', 'White', 'gd:s9', '{}', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z', 'smbhl')`).bind(ev.id).run();
  });
  afterAll(() => { globalThis.fetch = originalFetch; });
  it('the sent game-day email tells the sub to bring a white shirt', async () => {
    await drain(env);
    const m = sent.find(x => x.to[0] === 's9@example.com');
    expect(m.text).toContain('Apporte un chandail blanc.');
    expect(m.html).toContain('Bring a white shirt.');
  });
});

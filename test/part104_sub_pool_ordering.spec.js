// Sub-call rework, Part 5: the order subs are invited in.
//
// Before: SMBHL ordered by answered_ever DESC, then last_played DESC --
// last_played is a season NAME stored as text, so 'Winter 2016' sorted
// above 'Fall 2026' -- then last_asked; asked_streak was never used. The
// league product had a separate copy ordered by answered_ever, name.
// Now both use one responsiveness ordering (callSubs' SUB_POOL_ORDER_BY):
//   1. answered their latest invite and played this season
//   2. answered before, but not lately (or not played this season)
//   3. never answered, few invites
//   4. never answered, many invites
//   (dormant: never auto-invited)
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const ADMIN_KEY = 'test-part104-admin';
const EVENT_ID = 'p104-2026-10-04';
const OLD_EVENT_ID = 'p104-2026-09-20';

beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  env.RSVP_SECRET = 'test-part104-rsvp';
  await applyRealSchema(env);
  const d = new Date(Date.now() + 5 * 24 * 3600000);
  await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, 'Fall 2026', 5, 'open', '20:30', 'smbhl')`)
    .bind(EVENT_ID, d.toISOString().slice(0, 10)).run();
  await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, '2026-09-20', 'Fall 2026', 3, 'done', '20:30', 'smbhl')`)
    .bind(OLD_EVENT_ID).run();
  const sub = (id, name, f) => env.DB.prepare(
    `INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id, answered_ever, asked_streak, last_played, last_asked, dormant)
     VALUES (?, ?, ?, 'sub_skater', 1, 0, 'salt', 'smbhl', ?, ?, ?, ?, ?)`
  ).bind(id, name, `${id.toLowerCase()}@example.com`, f.answered ? 1 : 0, f.streak || 0, f.lastPlayed || null, f.lastAsked || null, f.dormant ? 1 : 0).run();
  // Deliberately inserted in an order unrelated to the expected one.
  await sub('S104F', 'Fay Many Invites', { answered: false, streak: 5, lastAsked: '2026-09-01T00:00:00Z' });
  await sub('S104B', 'Bob Old Season', { answered: true, streak: 0, lastPlayed: 'Winter 2016' });
  await sub('S104G', 'Gus Dormant', { answered: true, streak: 10, dormant: true, lastPlayed: 'Fall 2026' });
  await sub('S104D', 'Dee Never Asked', { answered: false, streak: 0 });
  await sub('S104C', 'Cal Answered Once', { answered: true, streak: 2, lastPlayed: 'Fall 2026' });
  await sub('S104E', 'Eve Two Invites', { answered: false, streak: 2, lastAsked: '2026-09-10T00:00:00Z' });
  await sub('S104H', 'Hal Played Via Rsvp', { answered: true, streak: 0 });
  await sub('S104A', 'Ann Top Tier', { answered: true, streak: 0, lastPlayed: 'Fall 2026' });
  // Hal played this season per the rsvp history, not last_played.
  await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, 'S104H', 'Red', 'in', 'sub', ?, 'smbhl')`)
    .bind(OLD_EVENT_ID, new Date().toISOString()).run();
});

describe('Sub pool ordering: responsiveness, not skill', () => {
  it('invites subs in responsiveness tiers, and never auto-invites a dormant sub', async () => {
    const res = await SELF.fetch('http://example.com/admin/subs/call', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-admin': ADMIN_KEY },
      body: JSON.stringify({ event_id: EVENT_ID, team: 'Red', need: 'skater' })
    });
    expect(res.status).toBe(200);
    const order = (await env.DB.prepare(
      `SELECT player_id FROM outbox WHERE event_id = ? AND kind = 'sub_call' AND player_id LIKE 'S104%' ORDER BY id`
    ).bind(EVENT_ID).all()).results.map(r => r.player_id);
    expect(order).toEqual([
      'S104A', // tier 1: answered latest invite, played this season (last_played)
      'S104H', // tier 1: answered latest invite, played this season (rsvp history)
      'S104B', // tier 2: answered, but last played in 2016 -- used to outrank Fall 2026 on a text sort
      'S104C', // tier 2: answered before, 2 unanswered since
      'S104D', // tier 3: never answered, never asked
      'S104E', // tier 3: never answered, 2 invites
      'S104F'  // tier 4: never answered, 5 invites
    ]);
    expect(order).not.toContain('S104G');
  });
});

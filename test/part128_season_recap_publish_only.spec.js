// The admin's season-recap prompt comes from publish only. The cron step
// fired at 13:30 local on any day for any open game with an end time, never
// checked the season was over, and marked the job done on non-final weeks
// (production: weeks 4 and 5). Publishing with a champion crowned queues it.
import { env, SELF, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import worker from '../src/index.js';

const ADMIN_KEY = 'test-part128-admin';
const SEASON = 'P128 Season';
const recapJobs = () => env.DB.prepare(`SELECT event_id FROM jobs WHERE job = 'season_recap_prompt'`).all().then(r => r.results);
const recapMail = () => env.DB.prepare(`SELECT event_id, dedup_key FROM outbox WHERE kind = 'season_recap_prompt'`).all().then(r => r.results);

let originalFetch;
beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  env.RSVP_SECRET = 'p128'; env.RESEND_API_KEY = 'p128';
  await applyRealSchema(env);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"id":"x"}', { status: 200 });
  // Week 2 is the final week; both games are 22 Nov 2026 and 29 Nov 2026, 10:30-12:30.
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: SEASON, seasons: [{ name: SEASON, standings: [], fixtures: [
    { week: 1, date: 'Sunday November 22 2026', time: '10:30 AM', home: 'Red', away: 'Blue' },
    { week: 2, date: 'Sunday November 29 2026', time: '10:30 AM', home: 'Red', away: 'Blue' }
  ] }], players: [] }));
  for (const [id, week, date] of [['smbhl:2026-11-22', 1, 'Sunday November 22 2026'], ['smbhl:2026-11-29', 2, 'Sunday November 29 2026']]) {
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, state, start_time, end_time, league_id) VALUES (?, ?, ?, ?, 'open', '10:30', '12:30', 'smbhl')`).bind(id, SEASON, week, date).run();
  }
});
afterAll(() => { globalThis.fetch = originalFetch; vi.useRealTimers(); });

describe('Season-recap prompt: publish only', () => {
  it('the cron neither records the step nor queues the prompt, for a non-final week or the final one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 14:00 Montreal on each game day: past 13:30 and 3h+ after the start, when the old step fired.
    for (const at of ['2026-11-22T19:00:00Z', '2026-11-29T19:00:00Z']) {
      vi.setSystemTime(new Date(at));
      const ctx = createExecutionContext();
      await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env, ctx);
      await waitOnExecutionContext(ctx);
    }
    vi.useRealTimers();
    expect(await recapJobs()).toEqual([]);
    expect(await recapMail()).toEqual([]);
  });

  it('publishing the final week with a champion crowned queues the prompt', async () => {
    const d = JSON.parse(await env.SHEETS_KV.get('data_json'));
    d.seasons[0].champion = 'Red';
    await env.SHEETS_KV.put('data_json', JSON.stringify(d));
    const start = await SELF.fetch('http://example.com/admin/review/manual-start', { method: 'POST', headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ season: SEASON, week: 2 }) });
    const { id } = await start.json();
    const pub = await SELF.fetch('http://example.com/admin/review/publish', { method: 'POST', headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ review_id: id, week: 2, games: [{ home_team: 'Red', away_team: 'Blue', home_score: 3, away_score: 1, home_players: [], away_players: [] }] }) });
    expect((await pub.json()).ok).toBe(true);
    expect((await recapMail()).map(r => r.dedup_key)).toEqual([`season_recap_prompt:${SEASON}`]);
  });
});

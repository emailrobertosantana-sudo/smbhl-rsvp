// A sub assigned to a team is invisible on the public team page.
//
// Observed live (Blue, Sept 27): public page "7 confirmés · équipe
// incomplète / 7 skaters, no goalie yet"; admin "Blue — 6 + 1G" with sub
// goalie Sean Pichette placed on Blue. The public page had its own goalie
// lookup (rosterGoalies) that took the FIRST goalie row on the team: with
// the rostered goalie OUT, it returned that out goalie, so the sub goalie
// who was IN was counted as a skater, got no G tag (and a forward/defence
// toggle instead). It now reads teamState() -- the admin's resolution.
//
// Also checked: the shortage calculation behind the shortfall trigger
// (expected(), teamState()) already counted an assigned sub goalie; locked
// here so it stays that way.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { hmac } from '../src/crypto_utils.js';
import { runSchedule, teamState } from '../src/index.js';

const SEASON = 'Fall 2026';
let EVENT_ID;

async function withResend(fn) {
  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) { sent.push(JSON.parse(opts.body).to[0]); return new Response('{"id":"x"}', { status: 200 }); }
    return new Response('{}', { status: 200 });
  };
  try { return { result: await fn(), sent }; } finally { globalThis.fetch = original; }
}
function eastern(h) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(Date.now() + h * 3600000));
  const g = t => parts.find(p => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}

beforeAll(async () => {
  env.RSVP_SECRET = 'test-part110-rsvp';
  env.RESEND_API_KEY = 'test-part110-resend';
  await applyRealSchema(env);
  await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('email_cadence_settings', ?)`).bind(JSON.stringify({ quiet_hours_enabled: false })).run();
  const { date, time } = eastern(60);
  EVENT_ID = date;
  await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, ?, 4, 'open', ?, 'smbhl')`).bind(EVENT_ID, date, SEASON, time).run();
  const add = (pid, name, role, goalie) => env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, ?, ?, ?, 's', 'smbhl')`)
    .bind(pid, name, `${pid.toLowerCase()}@example.com`, role, role === 'roster' ? 0 : 1, goalie ? 1 : 0).run();
  const rsvp = (pid, status, role, by) => env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, 'Blue', ?, ?, ?, ?, 'smbhl')`)
    .bind(EVENT_ID, pid, status, role, by, new Date().toISOString()).run();
  // Blue: rostered goalie OUT, 7 rostered skaters IN, sub goalie placed by the admin.
  await add('P110G', 'Roster Goalie', 'roster', true); await rsvp('P110G', 'out', 'roster', 'self');
  for (let i = 1; i <= 7; i++) { await add(`P110S${i}`, `Blue Skater ${i}`, 'roster', false); await rsvp(`P110S${i}`, 'in', 'roster', 'self'); }
  await add('P110SUB', 'Sean Pichette', 'sub_goalie', true); await rsvp('P110SUB', 'in', 'sub', 'manager');
  // A spare sub goalie who must NOT be called.
  await add('P110SPARE', 'Spare Goalie', 'sub_goalie', true);
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, 'fixedsalt')`).bind(`teamsalt:${SEASON}:Blue`).run();
});

describe('Public team page counts a sub the admin assigned to the team', () => {
  it('shows the assigned sub goalie as the goalie, and the same counts the admin shows', async () => {
    const t = await hmac(env.RSVP_SECRET, `t:${SEASON}:Blue:fixedsalt`);
    const html = await (await SELF.fetch(`http://example.com/team-rsvp?s=${encodeURIComponent(SEASON)}&team=Blue&t=${t}`)).text();
    expect(html).toContain('<span class="en">7 players, goalie confirmed</span>');
    expect(html).not.toContain('no goalie yet');
    expect(html).not.toContain('équipe incomplète');
    // Listed, with the G tag, and without the forward/defence toggle.
    expect(html).toMatch(/<td>Sean Pichette<span class="by">G<\/span><span class="by">/);
    expect(html).not.toContain('data-pid="P110SUB"');
    // Same numbers as the admin's teamState.
    const st = await teamState(env.DB, EVENT_ID, 'Blue', null);
    expect(st).toMatchObject({ goalies: 1, skaters: 7, shortGoalie: false, goalieIds: ['P110SUB'] });
  });

  it('a team whose only goalie is an assigned sub is not short a goalie: the shortfall check calls no goalie', async () => {
    const { sent } = await withResend(() => runSchedule(env));
    const goalieCalls = (await env.DB.prepare(
      `SELECT count(*) n FROM outbox WHERE event_id = ? AND kind = 'sub_call' AND json_extract(payload, '$.need') = 'goalie' AND team = 'Blue'`
    ).bind(EVENT_ID).first()).n;
    // (Red/White/Black have no players at all in this fixture, so they are
    // rightly short and may call goalies; Blue must not.)
    expect(goalieCalls).toBe(0);
    expect(sent.length).toBeGreaterThanOrEqual(0);
  });
});

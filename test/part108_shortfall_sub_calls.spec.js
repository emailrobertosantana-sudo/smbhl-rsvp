// Sub-call rework, Part 3: sub calls trigger on a real shortfall, not
// only on a cancellation.
//
// A team needs subs as soon as it CANNOT reach its minimum from the
// players still available (everyone on the team not marked out). The
// minimum is the league's own configured floor: goaliesPerTeam goalies
// and minSkaters skaters from the season config -- here set to 4 skaters
// to prove the configured value is used, not the 5 in DEFAULT_SEASON_CONFIG.
// Checked at event creation, every cron pass, when a sub is added, and
// when a league event is created.
import { env, SELF } from 'cloudflare:test';
import { answerViaEmailLink } from './support/email_link.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { wideSubCallWindow } from './support/wide_sub_call_window.js'; // the 8-day sub-call window these tests were written for
import { runSchedule, runLeagueReminders } from '../src/index.js';
import { hmac } from '../src/crypto_utils.js';
import { withGameTimes } from './support/game_times.js';

const ADMIN_KEY = 'test-part108-admin';
const RSVP_SECRET = 'test-part108-rsvp';

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
const subCallRows = (eventId) => env.DB.prepare(`SELECT player_id, team, payload, sent_at FROM outbox WHERE event_id = ? AND kind = 'sub_call' ORDER BY id`).bind(eventId).all().then(r => r.results);
const sentInvites = async (eventId, pid) => (await env.DB.prepare(
  `SELECT count(*) n FROM outbox WHERE event_id = ? AND player_id = ? AND kind = 'sub_call' AND sent_at IS NOT NULL`).bind(eventId, pid).first()).n;
async function addContact(pid, name, role, { goalie = false } = {}) {
  await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, ?, ?, ?, 'salt', 'smbhl')`)
    .bind(pid, name, `${pid.toLowerCase()}@example.com`, role, role === 'roster' ? 0 : 1, goalie ? 1 : 0).run();
}

beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  env.RSVP_SECRET = RSVP_SECRET;
  env.RESEND_API_KEY = 'test-part108-resend';
  env.AUTH_SECRET = 'test-part108-auth';
  await applyRealSchema(env); await wideSubCallWindow(env);
  await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('email_cadence_settings', ?)`)
    .bind(JSON.stringify({ quiet_hours_enabled: false })).run();
});

describe('SMBHL: a team below its minimum calls subs the moment the game exists', () => {
  let eventId;

  // Sub-call alignment task: a game short at creation calls subs WITH the
  // roster's invite, not before it (shortfallCallsHeld). This used to assert
  // the calls at creation; it now asserts they wait, then go to the short
  // team only once the invite has gone.
  it('creating the game holds the sub calls until the roster invite; then the short team only is called -- nobody has cancelled', async () => {
    // Red: 1 goalie + 3 skaters (below the configured 4). Blue: 1 goalie + 4 skaters (at 4:
    // not short under the configured minimum, though it would be under the default 5).
    const roster = [['G108R', 'Red', true], ['A108R', 'Red'], ['B108R', 'Red'], ['C108R', 'Red'],
      ['G108B', 'Blue', true], ['A108B', 'Blue'], ['B108B', 'Blue'], ['C108B', 'Blue'], ['D108B', 'Blue']];
    for (const [pid, , goalie] of roster) await addContact(pid, pid, 'roster', { goalie: !!goalie });
    for (const pid of ['S108A', 'S108B', 'S108C']) await addContact(pid, pid, 'sub_skater');
    const gameDay = new Date(Date.now() + 3 * 24 * 3600000);
    const dateLabel = gameDay.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' }).replace(/,/g, '');
    const season = 'P108 Season';
    await env.SHEETS_KV.put('data_json', JSON.stringify({
      current_season: season,
      seasons: [{ name: season, config: { teams: [{ name: 'Red' }, { name: 'Blue' }], goaliesPerTeam: 1, minSkaters: 4, skatersPerTeam: 8 },
        fixtures: [{ week: 1, date: dateLabel, time: '8:30 PM', home: 'Red', away: 'Blue' }] }],
      players: roster.map(([id, team]) => ({ id, name: id, seasons: { [season]: { team } } }))
    }));

    const created = await withResend(() => runSchedule(env));
    const ev = await env.DB.prepare(`SELECT * FROM events WHERE season = ?`).bind(season).first();
    expect(ev).toBeTruthy();
    eventId = ev.id;
    expect(await subCallRows(eventId)).toEqual([]);
    expect(created.sent.filter(to => /^s108/.test(to))).toEqual([]);
    // The roster invite goes out (its step ran); the next pass calls subs.
    await env.DB.prepare(`INSERT INTO jobs (event_id, job, ran_at) VALUES (?, 'invite', ?)`).bind(eventId, new Date().toISOString()).run();
    const { sent } = await withResend(() => runSchedule(env));
    expect((await env.DB.prepare(`SELECT count(*) n FROM rsvp WHERE event_id = ? AND status = 'out'`).bind(eventId).first()).n).toBe(0);
    const calls = await subCallRows(eventId);
    expect(calls.length).toBe(3);
    expect(new Set(calls.map(c => c.team))).toEqual(new Set(['Red']));
    expect(calls.every(c => JSON.parse(c.payload).need === 'skater')).toBe(true);
    expect(sent.filter(to => /^s108/.test(to)).sort()).toEqual(['s108a@example.com', 's108b@example.com', 's108c@example.com']);
  });

  it('a sub added late is contacted immediately -- in the same request that adds them', async () => {
    const { result, sent } = await withResend(async () => (await SELF.fetch('http://example.com/admin/contacts', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-admin': ADMIN_KEY },
      body: JSON.stringify({ action: 'new', name: 'Late Sub', email: 'late.sub108@example.com', role: 'sub_skater' })
    })).json());
    expect(result.ok).toBe(true);
    expect(sent).toEqual(['late.sub108@example.com']);
    expect((await subCallRows(eventId)).filter(c => c.player_id === result.player_id && c.sent_at).length).toBe(1);
  });

  it('once the team is no longer short, the check calls nobody new', async () => {
    await addContact('S108D', 'Quiet Sub', 'sub_skater');
    await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, 'S108A', 'Red', 'in', 'sub', ?, 'smbhl')`)
      .bind(eventId, new Date().toISOString()).run();
    await withResend(() => runSchedule(env));
    expect((await subCallRows(eventId)).some(c => c.player_id === 'S108D')).toBe(false);
  });
});

describe('The two-invite limit holds across the new trigger and a later cancellation', () => {
  it('shortfall invite, 36-hour follow-up, then a rostered player cancels: still two invites per sub', async () => {
    const { date, time } = eastern(30);
    const eventId = `p108lim:${date}`;
    await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, 'P108 Season', 2, 'open', ?, 'smbhl')`).bind(eventId, date, time).run();
    for (const pid of ['G108R', 'A108R', 'B108R', 'C108R']) {
      await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, 'Red', 'pending', 'roster', ?, 'smbhl')`).bind(eventId, pid, new Date().toISOString()).run();
    }
    for (const pid of ['G108B', 'A108B', 'B108B', 'C108B', 'D108B']) {
      await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, 'Blue', 'pending', 'roster', ?, 'smbhl')`).bind(eventId, pid, new Date().toISOString()).run();
    }
    // Pass 1: the shortfall invite. (Normally it goes out days earlier, at
    // creation; the one-time 36-hour follow-up job then runs later. Here
    // the game is already 30h out, so the job ran in this same pass before
    // any invite existed -- re-arm it to reproduce the real sequence.)
    await withResend(() => runSchedule(env));
    const subs = ['S108B', 'S108C', 'S108D'];
    for (const pid of subs) expect(await sentInvites(eventId, pid)).toBe(1);
    await env.DB.prepare(`DELETE FROM jobs WHERE event_id = ? AND job = 'pool36'`).bind(eventId).run();
    await withResend(() => runSchedule(env)); // pass 2: the one follow-up
    for (const pid of subs) expect(await sentInvites(eventId, pid)).toBe(2);
    // Even if the follow-up job ran again, the send-time guard stops a third.
    await env.DB.prepare(`DELETE FROM jobs WHERE event_id = ? AND job = 'pool36'`).bind(eventId).run();
    await withResend(() => runSchedule(env));
    for (const pid of subs) expect(await sentInvites(eventId, pid)).toBe(2);

    // A rostered Blue player cancels through their own RSVP link.
    const t = await hmac(RSVP_SECRET, `p:${eventId}:A108B:salt`);
    await withResend(() => answerViaEmailLink((u, i) => SELF.fetch(u, i), `http://example.com/rsvp?e=${encodeURIComponent(eventId)}&p=A108B&t=${t}&v=out`));
    expect((await env.DB.prepare(`SELECT status FROM rsvp WHERE event_id = ? AND player_id = 'A108B'`).bind(eventId).first()).status).toBe('out');
    await withResend(() => runSchedule(env));
    for (const pid of subs) expect(await sentInvites(eventId, pid)).toBe(2);
  });
});

describe('League product: the same shortfall trigger', () => {
  function extractCookie(res) { return (res.headers.get('set-cookie') || '').split(';')[0]; }
  function extractCsrf(res) { const c = res.headers.getSetCookie().find(x => x.startsWith('csrf_token=')); return c ? c.split(';')[0].split('=')[1] : ''; }
  async function league(tag) {
    const s = await SELF.fetch('http://example.com/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.232.${tag}` }, body: JSON.stringify({ accept_terms: true, email: `p108.l${tag}@example.com`, password: 'a-strong-password-1' }) });
    const cookie = extractCookie(s), csrf = extractCsrf(s);
    const post = (p, b) => SELF.fetch('http://example.com' + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(b) });
    await post('/leagues/create', { name: `P108 League ${tag}`, teamNames: ['Otters', 'Falcons'], tracksStats: true });
    await post('/league/season/publish', { season_name: 'S1', goalies_per_team: 0, skaters_per_team: 4, min_skaters: 2 });
    for (let i = 0; i < 4; i++) {
      const c = (await (await post('/league/contacts', { name: `L${tag} Roster ${i}`, email: `p108.l${tag}.r${i}@example.com`, role: 'roster' })).json()).contact;
      // Otters: 1 player (below the minimum of 2). Falcons: 3.
      await env.DB.prepare(`UPDATE contacts SET preferred_team = ? WHERE player_id = ?`).bind(i === 0 ? 'Otters' : 'Falcons', c.player_id).run();
    }
    await post('/league/contacts', { name: `L${tag} Sub`, email: `p108.l${tag}.sub@example.com`, role: 'sub_skater' });
    return { post };
  }

  it('creating a game where a team is already short calls subs in that same request', async () => {
    const { post } = await league(1);
    const date = new Date(Date.now() + 4 * 24 * 3600000).toISOString().slice(0, 10);
    const { result, sent } = await withResend(async () => (await post('/league/events', withGameTimes({ date, start_time: '20:00' }))).json());
    expect(result.ok).toBe(true);
    // (The admin is also told the other team is short of a goalie, with no
    // goalie sub to call -- D3.)
    expect(sent.filter(t => t !== 'p108.l1@example.com')).toEqual(['p108.l1.sub@example.com']);
    const calls = await subCallRows(result.event.id);
    expect(calls.map(c => c.team)).toEqual(['Otters']);
  });

  it('a game beyond the 8-day horizon calls nobody yet; the cron calls subs once it comes within range', async () => {
    const { post } = await league(2);
    const date = new Date(Date.now() + 20 * 24 * 3600000).toISOString().slice(0, 10);
    const { result, sent } = await withResend(async () => (await post('/league/events', withGameTimes({ date, start_time: '20:00' }))).json());
    expect(sent).toEqual([]);
    expect(await subCallRows(result.event.id)).toEqual([]);
    const soon = new Date(Date.now() + 5 * 24 * 3600000).toISOString().slice(0, 10);
    const newId = result.event.id.replace(date, soon);
    await env.DB.prepare(`UPDATE events SET id = ?, date = ? WHERE id = ?`).bind(newId, soon, result.event.id).run();
    const cron = await withResend(() => runLeagueReminders(env));
    expect(cron.sent).toContain('p108.l2.sub@example.com');
  });
});

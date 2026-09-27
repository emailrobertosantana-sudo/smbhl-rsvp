// Outbox QA batch: the drain exceeded Cloudflare's per-invocation
// subrequest limit and silently abandoned the emails that failed.
//
// Production evidence: 26 outbox rows with "Too many subrequests by
// single Worker invocation" (Sept 19: 9 gameday; Sept 21: 15 season
// invites; Sept 26: 4 gameday), each a burst of 15-30 sends in ONE cron
// pass. Measured cause: getTeamFixtures() fetched smbhl.com/data.json
// for EVERY recipient with a team, so each such email cost 2 external
// subrequests; the Free plan allows 50 per invocation, so a 40-row pass
// sent 25 and failed 15 -- exactly the Sept 21 cluster. A row that
// failed and was delivered on a later pass kept its error beside its
// new sent_at, so Comms counted it as sent and never as failed.
//
// These tests drive the real drain()/runSchedule()/runLeagueReminders()
// against a fetch stand-in that enforces the Free plan's 50-subrequest
// limit the way Cloudflare does (the 51st fetch throws the real error).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { applyRealSchema, getRealMigrationQueries } from './support/real_schema.js';
import { drain, runSchedule, runLeagueReminders } from '../src/index.js';
import {
  MAIL_SENDS_PER_INVOCATION, EXTERNAL_SUBREQUEST_LIMIT, RESERVED_NON_SEND_SUBREQUESTS,
  MAX_SEND_ATTEMPTS, RETRY_BACKOFF_MINUTES, classifySendError, createSendBudget
} from '../src/mail_queue.js';

const ADMIN_KEY = 'test-part103-admin-key';
const EVENT_ID = 'p103-2026-10-01';
const TEAMS = ['Red', 'Blue', 'White', 'Black'];
const SITE_DATA = {
  current_season: 'Fall 2026',
  seasons: [{ name: 'Fall 2026', fixtures: [{ week: 3, home: 'Red', away: 'Blue', time: '20:30' }, { week: 3, home: 'White', away: 'Black', time: '21:30' }] }],
  players: []
};

// One Worker invocation's worth of fetch: counts every subrequest and,
// like Cloudflare's Free plan, refuses the 51st. `resend(to)` decides
// Resend's answer per recipient (default: 200).
function invocation({ resend = () => 200 } = {}) {
  const state = { fetches: 0, delivered: [], refused: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (++state.fetches > EXTERNAL_SUBREQUEST_LIMIT) {
      state.refused++;
      throw new Error('Too many subrequests by single Worker invocation.');
    }
    const u = String(url);
    if (u.includes('api.resend.com')) {
      const body = JSON.parse(opts.body);
      const status = resend(body.to[0]);
      if (status === 200) { state.delivered.push(body.to[0]); return new Response('{"id":"x"}', { status: 200 }); }
      return new Response(`{"message":"mock ${status}"}`, { status });
    }
    return new Response(JSON.stringify(SITE_DATA), { status: 200 });
  };
  state.done = () => { globalThis.fetch = original; };
  return state;
}
async function asInvocation(fn, opts) {
  const inv = invocation(opts);
  try { inv.result = await fn(); } finally { inv.done(); }
  return inv;
}

const outboxRows = async () => (await env.DB.prepare('SELECT * FROM outbox ORDER BY id').all()).results;
const both = async () => (await env.DB.prepare('SELECT count(*) n FROM outbox WHERE sent_at IS NOT NULL AND error IS NOT NULL').first()).n;

async function queueRows(n, { kind = 'gameday', emailFor = i => `p103.${i}@example.com` } = {}) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const pid = `Q${String(i + 1).padStart(4, '0')}`;
    await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, preferred_team, league_id) VALUES (?, ?, ?, 'roster', 0, 0, 'salt', ?, 'smbhl')`)
      .bind(pid, `Player ${i + 1}`, emailFor(i), TEAMS[i % 4]).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, ?, 'in', 'roster', ?, 'smbhl')`)
      .bind(EVENT_ID, pid, TEAMS[i % 4], new Date().toISOString()).run();
    const r = await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, payload, send_after, created_at, league_id) VALUES (?, ?, ?, ?, '{}', ?, ?, 'smbhl')`)
      .bind(kind, EVENT_ID, pid, TEAMS[i % 4], new Date(0).toISOString(), new Date().toISOString()).run();
    ids.push(r.meta.last_row_id);
  }
  return ids;
}
const makeDue = id => env.DB.prepare(`UPDATE outbox SET next_attempt_at = ? WHERE id = ?`).bind(new Date(0).toISOString(), id).run();

beforeAll(async () => {
  env.RSVP_SECRET = 'test-part103-rsvp';
  env.RESEND_API_KEY = 'test-part103-resend';
  env.AUTH_SECRET = 'test-part103-auth';
  env.ADMIN_KEY = ADMIN_KEY;
  await applyRealSchema(env);
  await env.SHEETS_KV.put('data_json', JSON.stringify(SITE_DATA));
  const start = new Date(Date.now() + 30 * 3600000);
  await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, 'Fall 2026', 3, 'open', '20:30', 'smbhl')`)
    .bind(EVENT_ID, start.toISOString().slice(0, 10)).run();
});
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM outbox').run();
});

describe('Part 1: bounded work per invocation', () => {
  it('the cap is derived from the Free plan limit minus the measured non-send reserve', () => {
    expect(EXTERNAL_SUBREQUEST_LIMIT).toBe(50);
    expect(MAIL_SENDS_PER_INVOCATION).toBe(EXTERNAL_SUBREQUEST_LIMIT - RESERVED_NON_SEND_SUBREQUESTS);
    expect(MAIL_SENDS_PER_INVOCATION).toBe(45);
  });

  it('a team email costs ONE external subrequest -- data.json is fetched once per drain, not once per recipient', async () => {
    await queueRows(10, { kind: 'gameday' });
    const inv = await asInvocation(() => drain(env));
    expect(inv.result.sent).toBe(10);
    expect(inv.fetches).toBe(11); // 10 Resend + 1 shared data.json (was 20)
  });

  it('a queue larger than the cap drains across successive invocations with nothing lost, each within the 50-subrequest limit', async () => {
    const ids = await queueRows(100, { kind: 'gameday' });
    const passes = [];
    for (let pass = 1; pass <= 5; pass++) {
      const inv = await asInvocation(() => drain(env));
      const rows = await outboxRows();
      passes.push({ pass, fetches: inv.fetches, refused: inv.refused, sent: inv.result.sent, remaining: rows.filter(r => !r.sent_at).length });
      if (!rows.some(r => !r.sent_at)) break;
    }
    // 100 rows at 45 per pass: 45, 45, 10 -- three passes, nothing refused.
    expect(passes.map(p => p.sent)).toEqual([45, 45, 10]);
    expect(passes.map(p => p.remaining)).toEqual([55, 10, 0]);
    for (const p of passes) { expect(p.refused).toBe(0); expect(p.fetches).toBeLessThanOrEqual(EXTERNAL_SUBREQUEST_LIMIT); }
    const rows = await outboxRows();
    expect(rows.map(r => r.id)).toEqual(ids);
    expect(rows.every(r => r.sent_at && !r.error && !r.failed_at && r.attempts === 1)).toBe(true);
  });

  it('the production scenario: a 60-player invite wave queued and drained by runSchedule in one cron pass stays under the limit and leaves the overflow queued', async () => {
    for (let i = 0; i < 60; i++) {
      const pid = `W${String(i + 1).padStart(4, '0')}`;
      await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, preferred_team, league_id) VALUES (?, ?, ?, 'roster', 0, 0, 'salt', ?, 'smbhl')`)
        .bind(pid, `Wave ${i}`, `wave.${i}@example.com`, TEAMS[i % 4]).run();
      await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, ?, 'pending', 'roster', ?, 'smbhl')`)
        .bind(EVENT_ID, pid, TEAMS[i % 4], new Date().toISOString()).run();
    }
    await env.DB.prepare(`DELETE FROM jobs WHERE event_id = ?`).bind(EVENT_ID).run();
    const first = await asInvocation(() => runSchedule(env));
    expect(first.refused).toBe(0);
    expect(first.fetches).toBeLessThanOrEqual(EXTERNAL_SUBREQUEST_LIMIT);
    const afterFirst = await outboxRows();
    const invites = afterFirst.filter(r => r.kind === 'invite');
    expect(invites.length).toBeGreaterThan(MAIL_SENDS_PER_INVOCATION);
    expect(invites.filter(r => r.sent_at).length).toBe(MAIL_SENDS_PER_INVOCATION);
    expect(invites.filter(r => r.error).length).toBe(0);
    // Later passes deliver the rest, each within the cap and the limit.
    const total = invites.length;
    let passes = 1;
    while ((await outboxRows()).some(r => r.kind === 'invite' && !r.sent_at) && passes < 10) {
      const next = await asInvocation(() => runSchedule(env));
      passes++;
      expect(next.refused).toBe(0);
      expect(next.fetches).toBeLessThanOrEqual(EXTERNAL_SUBREQUEST_LIMIT);
      expect(next.delivered.length).toBeLessThanOrEqual(MAIL_SENDS_PER_INVOCATION);
    }
    const done = (await outboxRows()).filter(r => r.kind === 'invite');
    expect(done.length).toBe(total);
    expect(done.every(r => r.sent_at && !r.error)).toBe(true);
    expect(passes).toBe(Math.ceil(total / MAIL_SENDS_PER_INVOCATION));
    await env.DB.prepare(`DELETE FROM rsvp WHERE player_id LIKE 'W%'`).run();
  }, 60000);

  it('if the platform still refuses a subrequest, the drain stops at once: the refused row is retrying, the rest untouched and queued', async () => {
    await queueRows(12, { kind: 'sub_call' });
    const inv = invocation();
    inv.fetches = EXTERNAL_SUBREQUEST_LIMIT - 5; // an invocation that already spent most of its budget elsewhere
    let result;
    try { result = await drain(env); } finally { inv.done(); }
    expect(result.sent).toBe(5);
    const rows = await outboxRows();
    expect(rows.slice(0, 5).every(r => r.sent_at)).toBe(true);
    expect(rows[5].sent_at).toBeNull();
    expect(rows[5].error).toMatch(/Too many subrequests/);
    expect(rows[5].attempts).toBe(1);
    expect(rows[5].failed_at).toBeNull();
    expect(inv.refused).toBe(1); // stopped after the first refusal, did not burn the rest
    for (const r of rows.slice(6)) { expect(r.attempts).toBe(0); expect(r.error).toBeNull(); }
  });

  it('a shared budget caps the WHOLE invocation, not each drain() call', async () => {
    await queueRows(30, { kind: 'sub_call' });
    const budget = createSendBudget(20);
    const inv = await asInvocation(async () => [await drain(env, 45, null, null, budget), await drain(env, 45, null, null, budget)]);
    expect(inv.result[0].sent + inv.result[1].sent).toBe(20);
  });
});

describe('Part 2: sent, retrying and failed are separate states', () => {
  it('a transient failure (Resend 500) is retried after backoff and then delivered; its error does not survive the success', async () => {
    const [id] = await queueRows(1, { kind: 'sub_call' });
    await asInvocation(() => drain(env), { resend: () => 500 });
    let row = (await outboxRows())[0];
    expect(row.sent_at).toBeNull();
    expect(row.failed_at).toBeNull();
    expect(row.cancelled).toBe(0);
    expect(row.error).toMatch(/resend 500/);
    expect(row.attempts).toBe(1);
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + (RETRY_BACKOFF_MINUTES[0] - 1) * 60000);

    const early = await asInvocation(() => drain(env));
    expect(early.delivered).toEqual([]); // backoff respected

    await makeDue(id);
    const retry = await asInvocation(() => drain(env));
    expect(retry.delivered).toEqual(['p103.0@example.com']);
    row = (await outboxRows())[0];
    expect(row.sent_at).not.toBeNull();
    expect(row.error).toBeNull();
    expect(row.last_error).toMatch(/resend 500/); // history kept, off the live column
    expect(row.attempts).toBe(2);
  });

  it('a permanent failure (Resend 422, rejected recipient) is marked failed and never retried', async () => {
    const [id] = await queueRows(1, { kind: 'sub_call' });
    await asInvocation(() => drain(env), { resend: () => 422 });
    let row = (await outboxRows())[0];
    expect(row.failed_at).not.toBeNull();
    expect(row.cancelled).toBe(1);
    expect(row.sent_at).toBeNull();
    expect(row.error).toMatch(/resend 422/);
    await makeDue(id);
    const again = await asInvocation(() => drain(env));
    expect(again.fetches).toBe(0);
    row = (await outboxRows())[0];
    expect(row.attempts).toBe(1);
  });

  it(`retries are bounded: a failure that stays transient gives up after ${MAX_SEND_ATTEMPTS} attempts and becomes a visible permanent failure`, async () => {
    const [id] = await queueRows(1, { kind: 'sub_call' });
    for (let i = 0; i < MAX_SEND_ATTEMPTS + 2; i++) {
      await makeDue(id);
      await asInvocation(() => drain(env), { resend: () => 503 });
    }
    const row = (await outboxRows())[0];
    expect(row.attempts).toBe(MAX_SEND_ATTEMPTS);
    expect(row.failed_at).not.toBeNull();
    expect(row.error).toMatch(new RegExp(`gave up after ${MAX_SEND_ATTEMPTS} attempts`));
  });

  it('classifies failures: a bad recipient is permanent; rate limits, outages and configuration faults are retried (bounded)', () => {
    for (const m of ['Too many subrequests by single Worker invocation.', 'resend 429: slow down', 'resend 502: bad gateway', 'Network connection lost.',
      'resend 401: bad key', 'resend 403: domain not verified', 'RESEND_API_KEY not set']) {
      expect(classifySendError(new Error(m)), m).toBe('transient');
    }
    for (const m of ['resend 422: invalid to', 'resend 400: bad request', 'invalid email format: "x"', 'contact gone', 'event gone']) {
      expect(classifySendError(new Error(m)), m).toBe('permanent');
    }
  });

  it('no row ever carries both sent_at and an error, across every scenario above', async () => {
    await queueRows(4, { kind: 'sub_call' });
    const plan = { 'p103.0@example.com': 500, 'p103.1@example.com': 422 };
    await asInvocation(() => drain(env), { resend: to => plan[to] || 200 });
    for (const r of await outboxRows()) await makeDue(r.id);
    await asInvocation(() => drain(env));
    expect(await both()).toBe(0);
  });

  it('migration 050 repairs historical rows: sent + stale error keeps the text as last_error; old permanent failures become failed, deliberate skips stay skipped', async () => {
    const ins = (sent, cancelled, error) => env.DB.prepare(
      `INSERT INTO outbox (kind, event_id, player_id, payload, send_after, created_at, sent_at, cancelled, error, league_id) VALUES ('gameday', ?, NULL, '{}', ?, ?, ?, ?, ?, 'smbhl')`
    ).bind(EVENT_ID, '2026-09-21T10:00:00.000Z', '2026-09-21T10:00:00.000Z', sent, cancelled, error).run();
    await ins('2026-09-21T10:05:00.000Z', 0, 'Too many subrequests by single Worker invocation.');
    await ins(null, 1, 'resend 422: invalid recipient');
    await ins(null, 1, 'opted out');
    for (const q of getRealMigrationQueries(50).filter(q => /^UPDATE/i.test(q))) await env.DB.prepare(q).run();
    const [a, b, c] = await outboxRows();
    expect(a.error).toBeNull(); expect(a.last_error).toMatch(/Too many subrequests/); expect(a.sent_at).not.toBeNull();
    expect(b.failed_at).not.toBeNull();
    expect(c.failed_at).toBeNull();
    expect(await both()).toBe(0);
  });
});

describe('Part 3: failures appear where an admin looks', () => {
  async function commsData() {
    const res = await SELF.fetch('http://example.com/admin/emails/data', { headers: { 'x-admin': ADMIN_KEY } });
    expect(res.status).toBe(200);
    return res.json();
  }

  it('SMBHL Comms counts and lists permanent failures and retrying rows as failed; a failed-then-delivered row counts as sent only', async () => {
    await queueRows(3, { kind: 'sub_call' });
    const plan = { 'p103.0@example.com': 422, 'p103.1@example.com': 500 };
    await asInvocation(() => drain(env), { resend: to => plan[to] || 200 });
    let data = await commsData();
    const byStatus = s => data.outbox.filter(o => o.status === s).length;
    expect(byStatus('failed')).toBe(1);
    expect(byStatus('retrying')).toBe(1);
    expect(byStatus('sent')).toBe(1);
    expect(data.stats.failed).toBe(2);
    expect(data.stats.retrying).toBe(1);

    // The retrying row succeeds: it becomes sent, and only sent.
    for (const r of await outboxRows()) await makeDue(r.id);
    await asInvocation(() => drain(env));
    data = await commsData();
    expect(data.stats.failed).toBe(1);
    expect(data.stats.retrying).toBe(0);
    expect(data.outbox.filter(o => o.status === 'sent').length).toBe(2);
  });

  it('an old failure stays listed even after 150 newer messages', async () => {
    await queueRows(1, { kind: 'sub_call' });
    await asInvocation(() => drain(env), { resend: () => 422 });
    for (let i = 0; i < 160; i++) {
      await env.DB.prepare(`INSERT INTO outbox (kind, event_id, payload, send_after, created_at, sent_at, league_id) VALUES ('summary', ?, '{}', ?, ?, ?, 'smbhl')`)
        .bind(EVENT_ID, new Date().toISOString(), new Date().toISOString(), new Date().toISOString()).run();
    }
    const data = await commsData();
    expect(data.outbox.some(o => o.status === 'failed')).toBe(true);
  });

  it('the Comms page renders the failed/retrying states from the server status, with a retrying label in both languages', async () => {
    const html = await (await SELF.fetch('http://example.com/admin/emails', { headers: { 'x-admin': ADMIN_KEY } })).text();
    expect(html).toContain("if (currentFilter === 'failed') return o.status === 'failed' || o.status === 'retrying';");
    expect(html).toContain('badgeRetrying: "🔁 Nouvel essai ({n}/{max})"');
    expect(html).toContain('badgeRetrying: "🔁 Retrying ({n}/{max})"');
  });
});

describe('Part 4: the league product had the same two problems', () => {
  function extractCookie(res) { return (res.headers.get('set-cookie') || '').split(';')[0]; }
  function extractCsrf(res) {
    const c = res.headers.getSetCookie().find(x => x.startsWith('csrf_token='));
    return c ? c.split(';')[0].split('=')[1] : '';
  }
  function easternHoursFromNow(h) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date(Date.now() + h * 3600000));
    const g = t => parts.find(p => p.type === t).value;
    return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
  }
  async function leagueWithPlayers(tag, n) {
    const s = await SELF.fetch('http://example.com/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.230.${tag}` }, body: JSON.stringify({ email: `p103.league${tag}@example.com`, password: 'a-strong-password-1' }) });
    const cookie = extractCookie(s), csrf = extractCsrf(s);
    const post = (p, b) => SELF.fetch('http://example.com' + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(b) });
    const leagueId = (await (await post('/leagues/create', { name: `P103 League ${tag}`, teamNames: ['A', 'B'], tracksStats: true })).json()).league.id;
    await post('/league/season/publish', { season_name: 'S1' });
    await post('/league/reminders/settings', { reminder72h: true, reminder24h: true, reminder12h: true });
    for (let i = 0; i < n; i++) await post('/league/contacts', { name: `L${tag} Player ${i}`, team: i % 2 ? 'A' : 'B', email: `l${tag}.p${i}@example.com` });
    const { date, time } = easternHoursFromNow(60);
    const eventId = `${leagueId}:p103:${date}`;
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'S1', 1, ?, 'Gym', 'open', ?, ?)`).bind(eventId, date, time, leagueId).run();
    return { leagueId, eventId, cookie };
  }

  it('a 72h wave larger than the cap is delivered across successive cron passes, every invocation within the limit, nothing lost', async () => {
    const { leagueId, eventId } = await leagueWithPlayers(11, 60);
    const passes = [];
    for (let pass = 0; pass < 4; pass++) {
      const inv = await asInvocation(() => runLeagueReminders(env));
      passes.push({ fetches: inv.fetches, refused: inv.refused, delivered: inv.delivered.length });
    }
    const rows = (await env.DB.prepare(`SELECT * FROM outbox WHERE league_id = ? AND kind = 'reminder_72h'`).bind(leagueId).all()).results;
    expect(rows.length).toBe(60);
    expect(rows.every(r => r.sent_at && !r.error)).toBe(true);
    expect(passes[0].delivered).toBe(MAIL_SENDS_PER_INVOCATION);
    expect(passes.reduce((a, p) => a + p.delivered, 0)).toBe(60);
    for (const p of passes) { expect(p.refused).toBe(0); expect(p.fetches).toBeLessThanOrEqual(EXTERNAL_SUBREQUEST_LIMIT); }
    const log = await env.DB.prepare(`SELECT recipient_count FROM league_reminder_log WHERE event_id = ? AND kind = 'reminder_72h'`).bind(eventId).first();
    expect(log.recipient_count).toBe(60);
  });

  it('a failed league reminder is retried instead of abandoned (the wave log used to mark it done), and shows in the league Comms tab meanwhile', async () => {
    const { leagueId, cookie } = await leagueWithPlayers(12, 3);
    await asInvocation(() => runLeagueReminders(env), { resend: to => (to === 'l12.p0@example.com' ? 500 : 200) });
    const failing = await env.DB.prepare(`SELECT * FROM outbox WHERE league_id = ? AND player_id IS NOT NULL AND sent_at IS NULL`).bind(leagueId).all();
    expect(failing.results.length).toBe(1);
    const comms = await (await SELF.fetch('http://example.com/league/comms/data', { headers: { cookie } })).json();
    expect(comms.activity.some(a => a.status === 'retrying' && /resend 500/.test(a.reason))).toBe(true);
    expect(comms.stats.failed).toBeGreaterThanOrEqual(1);

    await makeDue(failing.results[0].id);
    const retry = await asInvocation(() => runLeagueReminders(env));
    expect(retry.delivered).toEqual(['l12.p0@example.com']);
    expect(await both()).toBe(0);
  });

  it('a permanently rejected league reminder shows as failed in the league Comms tab', async () => {
    const { cookie } = await leagueWithPlayers(13, 2);
    await asInvocation(() => runLeagueReminders(env), { resend: to => (to === 'l13.p0@example.com' ? 422 : 200) });
    const comms = await (await SELF.fetch('http://example.com/league/comms/data', { headers: { cookie } })).json();
    expect(comms.activity.some(a => a.status === 'failed' && /resend 422/.test(a.reason))).toBe(true);
  });
});

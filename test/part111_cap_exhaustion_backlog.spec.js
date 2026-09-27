// Cap exhaustion must not silently lose work.
//   1. queued while the cap is exhausted -> DEFERRED (not dropped, not
//      failed, not sent) -- including DIRECT sends, which used to be lost
//      when Resend refused for quota (they never went through the outbox);
//   2. at the 00:00 UTC reset the backlog drains on its own;
//   3. the backlog respects quiet hours;
//   4. roster mail before sub calls on resume;
//   5. an admin action whose email is deferred SAYS so.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { drain, runSchedule } from '../src/index.js';
import { utcDay, nextUtcMidnight } from '../src/mail_queue.js';

const ADMIN_KEY = 'test-part111-admin';
const SEASON = 'P111 Season';
const QUOTA = '{"name":"daily_quota_exceeded","message":"You have reached your daily email sending quota."}';
let EVENT_ID;

// resend(to) -> HTTP status for that recipient (200 = accepted).
async function withResend(fn, resend = () => 200) {
  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      const to = JSON.parse(opts.body).to[0];
      const st = resend(to);
      if (st === 200) { sent.push(to); return new Response('{"id":"x"}', { status: 200 }); }
      return new Response(QUOTA, { status: st });
    }
    return new Response('{}', { status: 200 });
  };
  try { return { result: await fn(), sent }; } finally { globalThis.fetch = original; }
}
const quota = () => 429;
const setQuiet = (start, end, enabled = true) => env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('email_cadence_settings', ?)`)
  .bind(JSON.stringify({ quiet_hours_enabled: enabled, quiet_hours_start: start, quiet_hours_end: end })).run();
async function queue(kind, pid, payload = '{}') {
  const r = await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, payload, send_after, created_at, league_id) VALUES (?, ?, ?, 'Red', ?, ?, ?, 'smbhl')`)
    .bind(kind, EVENT_ID, pid, payload, new Date(0).toISOString(), new Date().toISOString()).run();
  return r.meta.last_row_id;
}
const row = id => env.DB.prepare('SELECT * FROM outbox WHERE id = ?').bind(id).first();

beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  env.RSVP_SECRET = 'test-part111-rsvp';
  env.RESEND_API_KEY = 'test-part111-resend';
  await applyRealSchema(env);
  const d = new Date(Date.now() + 30 * 3600000).toISOString().slice(0, 10);
  EVENT_ID = d;
  await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, ?, 1, 'open', '20:30', 'smbhl')`).bind(EVENT_ID, d, SEASON).run();
  await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES ('R111', 'Roster P', 'r111@example.com', 'roster', 0, 0, 's', 'smbhl')`).run();
  await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, 'R111', 'Red', 'in', 'roster', ?, 'smbhl')`).bind(EVENT_ID, new Date().toISOString()).run();
  await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES ('S111', 'Sub P', 's111@example.com', 'sub_skater', 1, 0, 's', 'smbhl')`).run();
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: SEASON, seasons: [{ name: SEASON, standings: [], fixtures: [{ week: 1, date: 'Sunday', time: '8:30 PM', home: 'Red', away: 'Blue' }] }], players: [] }));
});
beforeEach(async () => {
  env.MAIL_DAILY_CAP = '10';
  await env.DB.prepare('DELETE FROM outbox').run();
  await env.DB.prepare('DELETE FROM mail_daily_count').run();
  await setQuiet(23, 7);
});
afterEach(() => { vi.useRealTimers(); });

describe('1-2: deferred, then drained at the reset with no manual nudge', () => {
  it('a sub call queued while the cap is exhausted defers (not failed, not sent), then goes out after 00:00 UTC on the next pass', async () => {
    await env.DB.prepare(`INSERT INTO mail_daily_count (day, sent, sub_calls) VALUES (?, 10, 10)`).bind(utcDay()).run();
    const id = await queue('sub_call', 'S111', '{"need":"skater"}');
    await withResend(() => drain(env));
    let r = await row(id);
    expect(r).toMatchObject({ sent_at: null, failed_at: null, cancelled: 0, error: null, attempts: 0, defer_reason: 'daily_cap' });
    // 00:00 UTC is 19:00-20:00 in Montreal: outside the default quiet hours (23-07), so no shift.
    expect(r.next_attempt_at).toBe(nextUtcMidnight().toISOString());
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(nextUtcMidnight().getTime() + 5 * 60000));
    const { sent } = await withResend(() => drain(env)); // the cron's own drain: nothing else needed
    expect(sent).toEqual(['s111@example.com']);
    r = await row(id);
    expect(r.sent_at).not.toBeNull();
    expect(r.defer_reason).toBeNull();
  });

  it('a DIRECT send Resend refuses for quota is queued (not lost), and the next pass after the reset sends it', async () => {
    // The dead-man alert is a direct send: make it fire, with Resend refusing.
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, payload, send_after, created_at, failed_at, cancelled, error, league_id) VALUES ('sub_call', ?, 'S111', '{}', ?, ?, ?, 1, 'resend 422: rejected', 'smbhl')`)
      .bind(EVENT_ID, new Date().toISOString(), new Date().toISOString(), new Date().toISOString()).run();
    await withResend(() => runSchedule(env), quota);
    const q = (await env.DB.prepare(`SELECT * FROM outbox WHERE kind = 'direct_mail'`).all()).results;
    expect(q.length).toBe(1);
    expect(q[0]).toMatchObject({ sent_at: null, failed_at: null, cancelled: 0, defer_reason: 'resend_quota' });
    expect(JSON.parse(q[0].payload).prerendered.subject).toContain('SMBHL');
    // The day is marked full.
    expect((await env.DB.prepare('SELECT sent FROM mail_daily_count WHERE day = ?').bind(utcDay()).first()).sent).toBe(10);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(new Date(q[0].next_attempt_at).getTime() + 60000));
    const { sent } = await withResend(() => drain(env));
    expect(sent).toContain(JSON.parse(q[0].payload).prerendered.to);
    expect((await row(q[0].id)).sent_at).not.toBeNull();
  });
});

describe('3: quiet hours', () => {
  it('when 00:00 UTC falls inside quiet hours, the deferred send is held until they end, not sent at 00:00', async () => {
    await setQuiet(19, 8); // quiet 19:00-08:00 Montreal: 00:00 UTC (19:00/20:00 local) is inside
    // Queued and first drained at 12:00 Montreal (outside quiet hours), whatever time the suite runs:
    // a drain inside quiet hours holds the row for them before the daily cap is even considered.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(nextUtcMidnight().getTime() - 8 * 3600000));
    await env.DB.prepare(`INSERT INTO mail_daily_count (day, sent, sub_calls) VALUES (?, 10, 10)`).bind(utcDay()).run();
    const id = await queue('sub_call', 'S111', '{"need":"skater"}');
    await withResend(() => drain(env));
    const r = await row(id);
    const until = new Date(r.next_attempt_at);
    expect(until.getTime()).toBeGreaterThan(nextUtcMidnight().getTime());
    const localHour = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', hour12: false }).format(until));
    expect(localHour).toBe(8);
    // At 00:05 UTC (inside quiet hours) nothing goes out; after 08:00 local it does.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(nextUtcMidnight().getTime() + 5 * 60000));
    expect((await withResend(() => drain(env))).sent).toEqual([]);
    vi.setSystemTime(new Date(until.getTime() + 60000));
    expect((await withResend(() => drain(env))).sent).toEqual(['s111@example.com']);
  });
});

describe('4: order on resume', () => {
  it('roster mail goes before sub calls when the backlog drains', async () => {
    const sub = await queue('sub_call', 'S111', '{"need":"skater"}');
    const roster = await queue('gameday', 'R111');
    const { sent } = await withResend(() => drain(env));
    expect(sent).toEqual(['r111@example.com', 's111@example.com']);
    expect((await row(roster)).id).toBeGreaterThan((await row(sub)).id); // queued later, still sent first
  });
});

describe('5: an admin action whose email is deferred says so', () => {
  it('publishing a scoresheet reports the backup email as deferred, with when -- not a plain success', async () => {
    const start = await (await SELF.fetch('http://example.com/admin/review/manual-start', {
      method: 'POST', headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ season: SEASON, week: 1 })
    })).json();
    const { result } = await withResend(async () => (await SELF.fetch('http://example.com/admin/review/publish', {
      method: 'POST', headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ review_id: start.id, week: 1, games: [{ home_team: 'Red', away_team: 'Blue', home_score: 3, away_score: 1, home_players: [], away_players: [] }] })
    })).json(), quota);
    expect(result.ok).toBe(true);
    expect(result.backup_email.status).toBe('deferred');
    expect(result.backup_email.until).toBeTruthy();
    const queued = await env.DB.prepare(`SELECT payload FROM outbox WHERE kind = 'direct_mail'`).first();
    expect(JSON.parse(queued.payload).prerendered.attachments.length).toBeGreaterThan(0); // the backup file travels with it
    const page = await (await SELF.fetch(`http://example.com/admin/review?id=${start.id}`, { headers: { 'x-admin': ADMIN_KEY } })).text();
    expect(page).toContain("backupEmailDeferred: \"Le courriel de sauvegarde n'est PAS encore parti : la limite d'envois quotidienne est atteinte. Il est en file d'attente et partira le {date}.\"");
    expect(page).toContain('backupEmailDeferred: "The backup email has NOT gone out yet: the daily send limit is reached. It is queued and will go out {date}."');
  });

  it('a broadcast counts deferred emails separately instead of calling them sent', async () => {
    const { result } = await withResend(async () => (await SELF.fetch('http://example.com/admin/emails/broadcast', {
      method: 'POST', headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'all', subject: 'Test', message: 'Hello' })
    })).json(), quota);
    expect(result.ok).toBe(true);
    expect(result.sent_count).toBe(0);
    expect(result.deferred_count).toBeGreaterThan(0);
  });

  it('the manual extra invite reports "deferred" when the day is used up, and the screen has the message', async () => {
    // Its own open game (publishing above closed week 1).
    const d = new Date(Date.now() + 40 * 3600000).toISOString().slice(0, 10);
    const eventId = `p111x:${d}`;
    await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, ?, 2, 'open', '20:30', 'smbhl')`).bind(eventId, d, SEASON).run();
    await env.DB.prepare(`INSERT INTO mail_daily_count (day, sent, sub_calls) VALUES (?, 10, 10)`).bind(utcDay()).run();
    const { result } = await withResend(async () => (await SELF.fetch('http://example.com/admin/subs/extra-invite', {
      method: 'POST', headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ event_id: eventId, player_id: 'S111' })
    })).json());
    expect(result).toMatchObject({ ok: true, status: 'deferred' });
    const page = await (await SELF.fetch('http://example.com/admin/subs', { headers: { 'x-admin': ADMIN_KEY } })).text();
    expect(page).toContain("extraInviteDeferred: \"L'invitation n'est PAS encore partie : la limite d'envois du jour est atteinte. Elle est en file d'attente et partira dès que la limite sera réinitialisée.\"");
    expect(page).toContain("statusDeferred: 'DEFERRED'");
  });
});

describe('2 (continued): the backlog can always drain', () => {
  it('a roster reserve estimate bigger than the cap cannot starve sub calls: they still get a fifth of the day', async () => {
    // 15 more rostered players on the open game: reserve estimate 17 + 3 > cap 10.
    for (let i = 0; i < 15; i++) {
      await env.DB.prepare(`INSERT OR IGNORE INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, 'roster', 0, 0, 's', 'smbhl')`)
        .bind(`R111X${i}`, `Roster X${i}`, `r111x${i}@example.com`).run();
    }
    for (let i = 0; i < 5; i++) {
      await env.DB.prepare(`INSERT OR IGNORE INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, 'sub_skater', 1, 0, 's', 'smbhl')`)
        .bind(`S111X${i}`, `Sub X${i}`, `s111x${i}@example.com`).run();
      await queue('sub_call', `S111X${i}`, '{"need":"skater"}');
    }
    const { sent, result } = await withResend(() => drain(env));
    expect(sent.length).toBe(2); // cap 10 - reserve held at 80% (8)
    expect(result.deferred).toBe(3);
  });
});

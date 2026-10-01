// Ending the reminder fork (league side). The advanced reminder model
// (src/reminders.js) is hidden from a league unless a super-admin turns on
// its 'advanced_reminders' flag. Without it: the simple 72/24/12 model,
// sent straight away, no advanced block in Comms. With it: its own
// hours-before and hour-of-day timing set in the same Comms section, its
// mail and sub calls held for its quiet hours -- through the same outbox
// (cap, retries) and the same callSubs (waves, dormancy) SMBHL uses. The
// window-skip rule follows whichever model the league is on.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { wideSubCallWindow } from './support/wide_sub_call_window.js'; // the 8-day sub-call window these tests were written for
import * as R from '../src/reminders.js';

const ADMIN_KEY = 'p115-admin';
let originalFetch;
const at = iso => vi.setSystemTime(new Date(iso));
const rows = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then(r => r.results);

function cookieOf(res) { return (res.headers.get('set-cookie') || '').split(';')[0]; }
function csrfOf(res) {
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.get('set-cookie') || '').split(', ');
  const c = cookies.find(x => x.startsWith('csrf_token='));
  return c ? c.split(';')[0].split('=')[1] : '';
}
async function newLeague(email, ip, name) {
  const s = await SELF.fetch('http://example.com/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ accept_terms: true, email, password: 'a-strong-password-1' }) });
  const cookie = cookieOf(s), csrf = csrfOf(s);
  const post = (path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
  const leagueId = (await (await post('/leagues/create', { name, teamNames: ['Otters', 'Bears'], tracksStats: true })).json()).league.id;
  await post('/league/season/publish', { season_name: `${name} Season` });
  await post('/league/reminders/settings', { reminder72h: true, reminder24h: true, reminder12h: true });
  return { leagueId, cookie, post, season: `${name} Season` };
}
const superAdmin = body => SELF.fetch('http://example.com/super-admin/leagues/update', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin': ADMIN_KEY }, body: JSON.stringify(body) });

let F, U; // F: advanced flag on. U: no flag.
async function seedLeague(L, tag) {
  await env.DB.prepare(`UPDATE leagues SET min_players = 6, max_players = 10, min_goalies = 1 WHERE id = ?`).bind(L.leagueId).run();
  const contact = (pid, role, team, { goalie = 0, dormant = 0, email } = {}) => env.DB.prepare(
    `INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, preferred_team, token_salt, dormant, league_id) VALUES (?, ?, ?, ?, ?, ?, ?, 's', ?, ?)`
  ).bind(pid, `${tag} ${pid}`, email || `${pid.toLowerCase()}@example.com`, role, role === 'roster' ? 0 : 1, goalie, team, dormant, L.leagueId).run();
  L.contact = contact;
  for (const [pid, team, goalie] of [[`${tag}G1`, 'Otters', 1], [`${tag}P1`, 'Otters', 0], [`${tag}P2`, 'Otters', 0], [`${tag}G2`, 'Bears', 1], [`${tag}P3`, 'Bears', 0], [`${tag}P4`, 'Bears', 0]]) {
    await contact(pid, 'roster', team, { goalie, email: pid === `${tag}P2` ? `flaky-${tag.toLowerCase()}@example.com` : undefined });
  }
  for (let i = 1; i <= 6; i++) await contact(`${tag}S${i}`, 'sub_skater', null);
  await contact(`${tag}SD`, 'sub_skater', null, { dormant: 1 });
  L.ev = `${L.leagueId}:2026-11-20`; // Friday 19:00 Montreal = 2026-11-21T00:00Z
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, ?, 1, '2026-11-20', 'Gym', 'open', '19:00', ?)`).bind(L.ev, L.season, L.leagueId).run();
}

beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  env.AUTH_SECRET = 'p115-auth';
  env.RSVP_SECRET = 'p115-rsvp';
  env.RESEND_API_KEY = 'p115-resend';
  env.PUBLIC_URL = 'https://rsvp.notreligue.ca';
  env.MAIL_DAILY_CAP = '100';
  await applyRealSchema(env); await wideSubCallWindow(env);
  await env.DB.prepare(`DELETE FROM contacts`).run();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      const b = JSON.parse(opts.body); const to = Array.isArray(b.to) ? b.to[0] : b.to;
      return to.startsWith('flaky') ? new Response('{"message":"upstream"}', { status: 500 }) : new Response('{"id":"x"}', { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  F = await newLeague('p115-flag@example.com', '203.0.113.151', 'P115 Flagged');
  U = await newLeague('p115-plain@example.com', '203.0.113.152', 'P115 Plain');
});
afterAll(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); vi.useRealTimers(); delete env.LEAGUE_PRODUCT; });

describe('The flag: hidden unless a super-admin turns it on', () => {
  it('a league starts without it; the super-admin turns it on for one league only', async () => {
    expect(await R.usesAdvancedReminders(env, F.leagueId)).toBe(false);
    const res = await superAdmin({ leagueId: F.leagueId, flags: { advanced_reminders: true } });
    expect(res.status).toBe(200);
    expect(await R.usesAdvancedReminders(env, F.leagueId)).toBe(true);
    expect(await R.usesAdvancedReminders(env, U.leagueId)).toBe(false);
    const list = await (await SELF.fetch('http://example.com/super-admin/leagues/data', { headers: { 'x-admin': ADMIN_KEY } })).json();
    const flags = id => list.leagues.find(l => l.id === id).flags;
    expect(flags(F.leagueId)).toMatchObject({ advanced_reminders: true, multi_admin: true });
    expect(flags(U.leagueId)).toMatchObject({ advanced_reminders: false, multi_admin: true });
    expect(flags('smbhl').advanced_reminders).toBe(true);
    const off = await superAdmin({ leagueId: 'smbhl', flags: { advanced_reminders: false } });
    expect(off.status).toBe(400);
    expect((await off.json()).errorKey).toBe('FLAG_ALWAYS_ON');
  });

  it('Comms: the advanced block sits in the same reminders section as the toggles -- only for the flagged league', async () => {
    const page = async L => (await SELF.fetch('http://example.com/league/settings', { headers: { cookie: L.cookie } })).text();
    const f = await page(F), u = await page(U);
    const section = html => html.slice(html.indexOf('id="reminders-section"'), html.indexOf('</section>', html.indexOf('id="reminders-section"')));
    expect(section(f)).toContain('id="reminder_72h_switch"');
    expect(section(f)).toContain('id="advanced-cadence"');
    expect(section(u)).toContain('id="reminder_72h_switch"');
    expect(u).not.toContain('id="advanced-cadence"');
    // Both languages carry the block's copy.
    expect(f).toContain('Horaire avancé');
    expect(f).toContain('Advanced timing');
  });

  it('the cadence route saves the flagged league its own settings, validates them, and refuses a league without the flag', async () => {
    const refused = await U.post('/league/reminders/cadence', { r72_hours: 96 });
    expect(refused.status).toBe(403);
    expect((await refused.json()).errorKey).toBe('ADVANCED_REMINDERS_OFF');
    const bad = await F.post('/league/reminders/cadence', { r72_hours: 0 });
    expect(bad.status).toBe(400);
    expect((await bad.json()).errorKey).toBe('CADENCE_INVALID');
    const ok = await F.post('/league/reminders/cadence', { r72_hours: 96, r72_hour_of_day: 15, quiet_hours_enabled: true, quiet_hours_start: 22, quiet_hours_end: 8 });
    expect(ok.status).toBe(200);
    const stored = JSON.parse((await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(`email_cadence_settings:${F.leagueId}`).first()).value);
    expect(stored).toMatchObject({ r72_hours: 96, r72_hour_of_day: 15, r24_hours: 24, r24_hour_of_day: 18, logistics_hours: 12, quiet_hours_enabled: true, quiet_hours_start: 22, quiet_hours_end: 8 });
    // SMBHL's own settings row is a different row, untouched.
    expect(await env.DB.prepare(`SELECT value FROM settings WHERE key = 'email_cadence_settings'`).first()).toBeNull();
  });
});

describe('The cron: the flagged league on the advanced model, the other on the simple one', () => {
  const pass = async iso => { at(iso); env.LEAGUE_PRODUCT = 'true'; return R.runReminderPass(env); };
  const log = (L, kind) => env.DB.prepare(`SELECT recipient_count, skipped FROM league_reminder_log WHERE event_id = ? AND kind = ?`).bind(L.ev, kind).first();

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at('2026-11-16T12:00:00Z');
    await seedLeague(F, 'F');
    await seedLeague(U, 'U');
  });

  it('shortfall sub calls go out in waves of five an hour apart for both; dormant subs are never called', async () => {
    const r = await pass('2026-11-16T23:30:00Z'); // Mon 18:30 Montreal, 96.5 h out
    expect(r.product).toBe('leagues');
    for (const L of [F, U]) {
      const calls = await rows(`SELECT player_id, send_after FROM outbox WHERE event_id = ? AND kind = 'sub_call' ORDER BY id`, L.ev);
      expect(calls.map(c => c.player_id).some(p => p.endsWith('SD'))).toBe(false);
      expect(calls.length).toBeGreaterThanOrEqual(6);
      const first = Date.parse(calls[0].send_after);
      const offsets = calls.slice(0, 6).map(c => Math.round((Date.parse(c.send_after) - first) / 60000));
      expect(offsets).toEqual([0, 0, 0, 0, 0, 60]);
    }
    expect(await log(F, 'reminder_72h')).toBeNull(); // 96.5 h: outside even the flagged league's 96 h
  });

  it("hour of day: at 83 h out and 08:00 the flagged league's first reminder waits for 15:00; at 15:05 it goes", async () => {
    await pass('2026-11-17T13:00:00Z'); // Tue 08:00, 83 h
    expect(await log(F, 'reminder_72h')).toBeNull();
    expect(await log(U, 'reminder_72h')).toBeNull(); // simple model: 83 h is outside 72 h
    await pass('2026-11-17T20:05:00Z'); // Tue 15:05, 76 h
    expect(await log(F, 'reminder_72h')).toMatchObject({ skipped: 0 });
    expect((await log(F, 'reminder_72h')).recipient_count).toBeGreaterThan(0);
    expect(await log(U, 'reminder_72h')).toBeNull(); // 76 h: still outside the simple 72 h
  });

  it('the simple model sends its 72 h wave as soon as the game is 72 h out, whatever the hour', async () => {
    await pass('2026-11-18T00:30:00Z'); // Tue 19:30, 71.5 h
    expect((await log(U, 'reminder_72h')).recipient_count).toBeGreaterThan(0);
  });

  it('retry states hold for the flagged league: a transient failure is retrying, not failed', async () => {
    const r = await env.DB.prepare(`SELECT attempts, failed_at, next_attempt_at, sent_at FROM outbox WHERE event_id = ? AND kind = 'reminder_72h' AND player_id = 'FP2'`).bind(F.ev).first();
    expect(r.sent_at).toBeNull();
    expect(r.failed_at).toBeNull();
    expect(r.attempts).toBeGreaterThanOrEqual(1);
    expect(r.next_attempt_at).toBeTruthy();
  });

  it("quiet hours: at 23:00 the flagged league's new sub call waits for its 08:00; the other league's goes now", async () => {
    at('2026-11-18T04:00:00Z'); // Tue 23:00 Montreal
    await F.contact('FS7', 'sub_skater', null);
    await U.contact('US7', 'sub_skater', null);
    await pass('2026-11-18T04:00:00Z');
    const f = await env.DB.prepare(`SELECT send_after, created_at FROM outbox WHERE player_id = 'FS7' AND kind = 'sub_call'`).first();
    const u = await env.DB.prepare(`SELECT send_after, created_at FROM outbox WHERE player_id = 'US7' AND kind = 'sub_call'`).first();
    expect(f.send_after).toBe('2026-11-18T13:00:00.000Z'); // 08:00 Montreal, the league's own quiet_hours_end
    expect(u.send_after).toBe(u.created_at);
  });

  it("the daily cap holds for the flagged league: with today's budget spent, its held sub call is deferred, not sent or failed", async () => {
    // The cap limits sub calls, as it always has. FS7's call was held for
    // quiet hours and comes due at 08:00.
    await env.DB.prepare(`INSERT OR REPLACE INTO mail_daily_count (day, sent, sub_calls) VALUES ('2026-11-18', 100, 0)`).run();
    await pass('2026-11-18T13:05:00Z');
    const f = await env.DB.prepare(`SELECT sent_at, failed_at, defer_reason FROM outbox WHERE player_id = 'FS7' AND kind = 'sub_call'`).first();
    expect(f).toMatchObject({ sent_at: null, failed_at: null, defer_reason: 'daily_cap' });
  });

  it("quiet hours: the flagged league's 12 h details due at 07:05 wait until after 08:00; the simple league's go now", async () => {
    for (const L of [F, U]) {
      const pid = L === F ? 'FP1' : 'UP1';
      await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, 'Otters', 'in', 'roster', '2026-11-19T00:00:00Z', ?)`).bind(L.ev, pid, L.leagueId).run();
    }
    await pass('2026-11-20T12:05:00Z'); // Fri 07:05, 11.9 h
    const f = await env.DB.prepare(`SELECT send_after, sent_at FROM outbox WHERE event_id = ? AND kind = 'logistics_12h'`).bind(F.ev).first();
    const u = await env.DB.prepare(`SELECT send_after, created_at, sent_at FROM outbox WHERE event_id = ? AND kind = 'logistics_12h'`).bind(U.ev).first();
    expect(f.send_after).toBe('2026-11-20T13:05:00.000Z'); // quiet hours step in half hours from 07:05: 08:05
    expect(f.sent_at).toBeNull();
    expect(u.send_after).toBe(u.created_at);
    expect(u.sent_at).toBeTruthy();
  });

});

describe('The window-skip rule follows the league\'s model', () => {
  it("flagged league (first reminder 96 h): a game created 90 h out skips that step -- the simple model's 72 h would not have", async () => {
    at('2026-11-18T06:00:00Z');
    const ev = `${F.leagueId}:2026-11-21`; // Sat 19:00 = 2026-11-22T00:00Z, 90 h out
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, ?, 2, '2026-11-21', 'Gym', 'open', '19:00', ?)`).bind(ev, F.season, F.leagueId).run();
    await R.applyReminderWindowSkipRule(env, F.leagueId, { id: ev, start_time: '19:00' });
    const skips = await rows(`SELECT kind, skipped FROM league_reminder_log WHERE event_id = ? ORDER BY kind`, ev);
    expect(skips).toEqual([{ kind: 'reminder_72h', skipped: 1 }]);
    // ...and the skipped step never sends, even when its hour comes round.
    env.LEAGUE_PRODUCT = 'true';
    at('2026-11-18T20:05:00Z');
    await R.runReminderPass(env);
    expect((await rows(`SELECT count(*) n FROM outbox WHERE event_id = ? AND kind = 'reminder_72h'`, ev))[0].n).toBe(0);
  });

  it('league without the flag: a game created 50 h out skips its 72 h step only, as before', async () => {
    at('2026-11-19T22:00:00Z');
    const ev = `${U.leagueId}:2026-11-21`; // 2026-11-22T00:00Z, 50 h out
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, ?, 2, '2026-11-21', 'Gym', 'open', '19:00', ?)`).bind(ev, U.season, U.leagueId).run();
    await R.applyReminderWindowSkipRule(env, U.leagueId, { id: ev, start_time: '19:00' });
    expect(await rows(`SELECT kind, skipped FROM league_reminder_log WHERE event_id = ? ORDER BY kind`, ev)).toEqual([{ kind: 'reminder_72h', skipped: 1 }]);
  });
});

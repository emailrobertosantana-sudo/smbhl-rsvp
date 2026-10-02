// Caps batch (items 1 to 4): Notre Ligue's sending guard
// (src/mail_guard.js), through the real drain and sendMail.
//   - a free league sends 25 emails a Montreal day to players and subs; the
//     rest wait for tomorrow, the pointless ones are then cancelled; the
//     dashboard says so and can drop them; trials and paid leagues have no
//     limit; billing notices, the operator's mail and sign-up mail are
//     never held;
//   - each rule trips, pauses what it concerns, alerts once (no address in
//     the alert), and Release and Cancel work; a normal week, a busy Sunday
//     for an SMBHL-sized league included, never trips;
//   - the digest's usage lines and when usage alone sends one;
//   - the demo settings: no daily caps.
// Mail and the alert webhook are captured by a local fetch; nothing leaves.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must } from './support/league_season.js';
import { drain, sendMail } from '../src/index.js';
import {
  checkSend, recordSend, releaseScope, cancelScope, listPauses, checkBounces, monthUsage, tripNumbers,
  FREE_DAILY_CAP, HELD_UNTIL, FREE_CAP_REASON, addressKey
} from '../src/mail_guard.js';
import { prepareOpsDigest, renderOpsDigest, usageLines } from '../src/ops_digest.js';
import { freeCapBannerHtml } from '../src/mail_limit_banner.js';
import { montrealDate, addDays, montrealMidnight } from '../src/montreal_time.js';
import { isMailDeferred } from '../src/mail_queue.js';

const NOW = Date.UTC(2026, 9, 14, 16, 0); // Wednesday 2026-10-14, 12:00 Montreal
const HOOK = 'https://ntfy.sh/p228-test-topic';
const sent = [];
const hooks = [];
let originalFetch;

beforeAll(async () => {
  Object.assign(env, { LEAGUE_PRODUCT: 'true', RESEND_API_KEY: 'x', RSVP_SECRET: 'p228', AUTH_SECRET: 'p228-auth', ALERT_WEBHOOK_URL: HOOK, BILLING_LAUNCH_AT: '2026-01-01', ADMIN_KEY: 'p228-admin-key', PUBLIC_URL: 'https://rsvp.p228.example' });
  delete env.MAIL_DAILY_CAP; delete env.MAIL_HARD_DAILY_CAP;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  await applyRealSchema(env);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url && url.url ? url.url : url);
    if (u.includes('api.resend.com')) { const b = JSON.parse(opts.body); sent.push({ to: Array.isArray(b.to) ? b.to[0] : b.to, subject: b.subject }); return new Response('{"id":"x"}', { status: 200 }); }
    if (u === HOOK) { hooks.push({ title: decodeURIComponent((opts.headers && opts.headers.Title) || ''), body: String(opts.body || '') }); return new Response('ok', { status: 200 }); }
    return new Response('{}', { status: 404 });
  };
});
afterAll(() => { globalThis.fetch = originalFetch; vi.useRealTimers(); });
beforeEach(async () => {
  vi.setSystemTime(new Date(NOW));
  sent.length = 0; hooks.length = 0;
  await env.DB.prepare('DELETE FROM outbox').run();
  await env.DB.prepare("DELETE FROM settings WHERE substr(key, 1, 5) = 'mail:'").run();
});

const rows = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results;
const one = async (sql, ...b) => env.DB.prepare(sql).bind(...b).first();

// A league with its owner and billing row. free: created long before now,
// its trial over, under 15 regulars (its owner's free slot). Otherwise in
// its trial.
async function makeLeague(id, { free = false } = {}) {
  const created = free ? '2026-01-05T15:00:00.000Z' : new Date(NOW - 5 * 86400000).toISOString();
  await env.DB.prepare('INSERT OR IGNORE INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').bind(`u-${id}`, `owner.${id}@p228.example`, 'x', created).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO leagues (id, name, team_count, team_names, created_by, created_at, language_mode) VALUES (?, ?, 2, '["A","B"]', ?, ?, 'fr')`).bind(id, `Ligue ${id}`, `u-${id}`, created).run();
  await env.DB.prepare('INSERT OR IGNORE INTO league_admins (user_id, league_id, created_at) VALUES (?, ?, ?)').bind(`u-${id}`, id, created).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO league_billing (league_id, owner_user_id, regular_count, count_tier, updated_at) VALUES (?, ?, 10, 'free', ?)`).bind(id, `u-${id}`, created).run();
  return id;
}
// n pre-rendered emails, as the league reminders are queued.
async function queue(n, { league, toPlayer = true, kind = 'reminder_72h', to = i => `p${i}@${league}.example`, subject = i => `Rappel ${i}`, eventId = `${league}:2026-10-17` } = {}) {
  for (let i = 0; i < n; i++) {
    const payload = JSON.stringify({ prerendered: { to: to(i), subject: subject(i), text: `Bonjour ${i}`, html: null } });
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, payload, send_after, created_at, league_id, quiet_exempt) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
      .bind(kind, eventId, toPlayer ? `${league}:P${String(i).padStart(4, '0')}` : null, payload, new Date(0).toISOString(), new Date().toISOString(), league).run();
  }
}
// The league's emails per Montreal day, for days before today (rule 2c).
async function seedHistory(league, perDay, days = 35) {
  const today = montrealDate(new Date(NOW));
  for (let i = 1; i <= days; i++) {
    const d = addDays(today, -i);
    const n = perDay(d, i);
    if (n > 0) await env.DB.prepare('INSERT INTO settings (key, value, league_id) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(`mail:vol:${league}:${d}`, String(n), league).run();
  }
}
const dow = d => new Date(d + 'T12:00:00Z').getUTCDay(); // 0 Sunday

// Many sends each, every one a few D1 writes: room under the full suite's load.
describe('Item 1: a free league sends 25 emails a day to players and subs', { timeout: 60000 }, () => {
  it('the 26th waits for the next Montreal day; admin mail is not counted', async () => {
    await makeLeague('free1', { free: true });
    await queue(30, { league: 'free1' });
    await queue(2, { league: 'free1', toPlayer: false, kind: 'short_alert', to: i => `admin${i}@free1.example`, subject: i => `Alerte ${i}` });
    await drain(env);
    expect(sent.filter(m => m.to.startsWith('admin'))).toHaveLength(2);
    expect(sent.filter(m => m.to.startsWith('p'))).toHaveLength(FREE_DAILY_CAP);
    const waiting = await rows('SELECT defer_reason, next_attempt_at FROM outbox WHERE sent_at IS NULL AND cancelled = 0');
    expect(waiting).toHaveLength(5);
    // Tomorrow, 07:00 Montreal (the end of quiet hours), never tonight.
    const tomorrow7 = montrealMidnight(addDays(montrealDate(new Date(NOW)), 1)).getTime() + 7 * 3600000;
    for (const w of waiting) { expect(w.defer_reason).toBe(FREE_CAP_REASON); expect(Date.parse(w.next_attempt_at)).toBe(tomorrow7); }
    // The same day, nothing more goes.
    vi.setSystemTime(new Date(NOW + 3 * 3600000));
    await drain(env);
    expect(sent).toHaveLength(27);
  });

  it('the next day they go, except a reminder for a game that has started and a sub call past its cutoff', async () => {
    await makeLeague('free2', { free: true });
    // Tonight's game (19:00 Montreal) and Saturday's.
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, state, start_time, end_time, league_id) VALUES ('free2:2026-10-14', 'S1', 1, '2026-10-14', 'open', '19:00', '20:00', 'free2'), ('free2:2026-10-15', 'S1', 2, '2026-10-15', 'open', '08:30', '09:30', 'free2'), ('free2:2026-10-17', 'S1', 3, '2026-10-17', 'open', '19:00', '20:00', 'free2')`).run();
    await queue(FREE_DAILY_CAP, { league: 'free2' });
    await queue(1, { league: 'free2', kind: 'reminder_24h', eventId: 'free2:2026-10-14', to: () => 'late@free2.example', subject: () => 'Rappel ce soir' });
    await queue(1, { league: 'free2', kind: 'sub_call', eventId: 'free2:2026-10-15', to: () => 'sub@free2.example', subject: () => 'Remplaçant demain matin' });
    await queue(1, { league: 'free2', kind: 'reminder_72h', eventId: 'free2:2026-10-17', to: () => 'sat@free2.example', subject: () => 'Rappel samedi' });
    await drain(env);
    expect(sent).toHaveLength(FREE_DAILY_CAP);
    vi.setSystemTime(new Date(montrealMidnight('2026-10-15').getTime() + 7 * 3600000 + 60000));
    await drain(env);
    // 07:01 on the 15th: tonight's game is over; the 08:30 game is inside its 2 h cutoff; Saturday's still matters.
    expect(sent.slice(FREE_DAILY_CAP).map(m => m.subject)).toEqual(['Rappel samedi']);
    const dropped = await rows('SELECT kind, error FROM outbox WHERE cancelled = 1 ORDER BY id');
    expect(dropped.map(d => d.kind)).toEqual(['reminder_24h', 'sub_call']);
    for (const d of dropped) expect(d.error).toMatch(/held by the daily limit/);
  });

  it('a league in its trial (or paying) has no daily limit', async () => {
    await makeLeague('trial1');
    await queue(40, { league: 'trial1' });
    await drain(env);
    expect(sent).toHaveLength(40);
  });

  it('never held: billing notices, the operator digest, and mail sent without a league', async () => {
    await makeLeague('free3', { free: true });
    await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('mail:pause:global', ?)`).bind(JSON.stringify({ scope: 'global', rule: '2d', since: new Date(NOW).toISOString(), numbers: { hour: 301 } })).run();
    await env.DB.prepare(`INSERT INTO settings (key, value, league_id) VALUES ('mail:pause:league:free3', ?, 'free3')`).bind(JSON.stringify({ scope: 'league:free3', rule: '2c', leagueId: 'free3', since: new Date(NOW).toISOString(), numbers: {} })).run();
    await queue(1, { league: 'free3', toPlayer: false, kind: 'billing_notice', to: () => 'owner@free3.example', subject: () => 'Avis de facturation' });
    await queue(1, { league: 'system', toPlayer: false, kind: 'ops_digest', to: () => 'bonjour@notreligue.ca', subject: () => 'Résumé' });
    await queue(1, { league: 'free3', toPlayer: true, kind: 'reminder_72h', subject: () => 'Retenu' });
    await drain(env);
    await sendMail(env, 'new.user@p228.example', 'Confirme ton courriel', 'x');
    expect(sent.map(m => m.subject).sort()).toEqual(['Avis de facturation', 'Confirme ton courriel', 'Résumé']);
    expect((await one("SELECT defer_reason FROM outbox WHERE kind = 'reminder_72h'")).defer_reason).toBe('held:global');
  });

  it('the dashboard says how many wait for tomorrow and can drop them', async () => {
    const a = await admin('p228dash');
    const created = await must(a.post('/leagues/create', { name: 'Ligue Gratuite', teamNames: ['A', 'B'], languageMode: 'fr' }), 'create');
    const id = created.league.id;
    await env.DB.prepare("UPDATE leagues SET created_at = '2026-01-05T15:00:00.000Z' WHERE id = ?").bind(id).run();
    await env.DB.prepare(`INSERT INTO league_billing (league_id, owner_user_id, regular_count, count_tier, updated_at) VALUES (?, (SELECT created_by FROM leagues WHERE id = ?), 3, 'free', ?)
      ON CONFLICT(league_id) DO UPDATE SET regular_count = 3, count_tier = 'free', trial_started_at = NULL, trial_ends_at = NULL`).bind(id, id, new Date(NOW).toISOString()).run();
    await queue(FREE_DAILY_CAP + 3, { league: id });
    await drain(env);
    const page = await a.get('/dashboard');
    expect(page.text).toContain('Limite quotidienne atteinte : 3 courriels seront envoyés demain.');
    expect(page.text).toContain('Ne pas les envoyer');
    expect(page.text).toContain('Abonne-toi pour envoyer sans limite quotidienne.');
    expect(page.text).toContain('data-date-en="Daily limit reached: 3 emails will be sent tomorrow."');
    expect(page.text).toMatch(/<a href="\/league\/billing"[^>]*>Abonne-toi/);
    const r = await a.post('/league/mail/held/cancel', {});
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, cancelled: 3 });
    expect((await a.get('/dashboard')).text).not.toContain('Limite quotidienne atteinte');
  });

  it('the notice: singular and plural, French and English', () => {
    expect(freeCapBannerHtml(0)).toBe('');
    const one1 = freeCapBannerHtml(1, 'fr');
    expect(one1).toContain('>Limite quotidienne atteinte : 1 courriel sera envoyé demain.<');
    expect(one1).toContain(">Ne pas l&#39;envoyer<");
    expect(one1).toContain('data-date-en="Daily limit reached: 1 email will be sent tomorrow."');
    expect(one1).toContain('data-date-en="Don&#39;t send it"');
    const many = freeCapBannerHtml(4, 'en');
    expect(many).toContain('>Daily limit reached: 4 emails will be sent tomorrow.<');
    expect(many).toContain(">Don&#39;t send them<");
    expect(many).toContain('data-date-fr="Ne pas les envoyer"');
    expect(many).not.toMatch(/\u2014/);
  });
});

describe('Item 2: five rules that catch a mistake', { timeout: 60000 }, () => {
  it('2a: the same email twice is blocked; a loop pauses the league and alerts once; Release lets it go', async () => {
    await makeLeague('dup1');
    await queue(1, { league: 'dup1', subject: () => 'Même courriel' });
    await drain(env);
    expect(sent).toHaveLength(1);
    // Six more copies of that same email in the hour: blocked, the sixth makes it a loop.
    for (let i = 0; i < 6; i++) await queue(1, { league: 'dup1', subject: () => 'Même courriel' });
    await drain(env);
    expect(sent).toHaveLength(1);
    const blocked = await rows("SELECT error FROM outbox WHERE cancelled = 1");
    expect(blocked).toHaveLength(6);
    for (const b of blocked) expect(b.error).toMatch(/rule 2a/);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].title).toContain('sending paused');
    expect(hooks[0].body).toContain('[Ligue dup1] Même courriel en boucle : 6 courriels en double bloqués en une heure');
    expect(hooks[0].body).not.toMatch(/@/);
    // A different email of that league now waits for the operator.
    await queue(1, { league: 'dup1', to: () => 'other@dup1.example', subject: () => 'Autre' });
    await drain(env);
    expect(sent).toHaveLength(1);
    expect((await listPauses(env)).map(p => [p.scope, p.rule, p.held])).toEqual([['league:dup1', '2a', 1]]);
    // A seventh copy: still blocked, no second alert.
    await queue(1, { league: 'dup1', subject: () => 'Même courriel' });
    await drain(env);
    expect(hooks).toHaveLength(1);
    expect(await releaseScope(env, 'league:dup1')).toBe(1);
    await drain(env);
    expect(sent.map(m => m.subject)).toEqual(['Même courriel', 'Autre']);
    expect(await listPauses(env)).toEqual([]);
  });

  it('2a: the same kind of email for the same game with new content still goes (a change of team, a new answer)', async () => {
    await makeLeague('dup2');
    await queue(1, { league: 'dup2', kind: 'team_assigned', subject: () => 'Équipe : A' });
    await queue(1, { league: 'dup2', kind: 'team_assigned', subject: () => 'Équipe : B' });
    await drain(env);
    expect(sent).toHaveLength(2);
  });

  it('2b: more than 5 emails to one player in an hour holds the rest for that address only; admins are not counted', async () => {
    await makeLeague('flood1');
    await queue(7, { league: 'flood1', to: () => 'same@flood1.example', subject: i => `Courriel ${i}` });
    await queue(2, { league: 'flood1', to: i => `other${i}@flood1.example`, subject: i => `Autre ${i}` });
    await queue(7, { league: 'flood1', toPlayer: false, kind: 'short_alert', to: () => 'admin@flood1.example', subject: i => `Alerte ${i}` });
    await drain(env);
    expect(sent.filter(m => m.to === 'same@flood1.example')).toHaveLength(5);
    expect(sent.filter(m => m.to.startsWith('other'))).toHaveLength(2);
    expect(sent.filter(m => m.to.startsWith('admin'))).toHaveLength(7);
    const h = await addressKey('same@flood1.example');
    expect((await rows('SELECT defer_reason, next_attempt_at FROM outbox WHERE sent_at IS NULL AND cancelled = 0'))).toEqual([
      { defer_reason: `held:addr:${h}`, next_attempt_at: HELD_UNTIL }, { defer_reason: `held:addr:${h}`, next_attempt_at: HELD_UNTIL }
    ]);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].body).toContain('Une personne inondée : 6 courriels à la même personne en une heure');
    expect(hooks[0].body).not.toMatch(/same|@/);
    const [p] = await listPauses(env);
    expect(p).toMatchObject({ scope: `addr:${h}`, rule: '2b', leagueId: 'flood1', masked: 's***@flood1.example', held: 2 });
    // Release: the two go (the rule leaves the address alone for a while).
    await releaseScope(env, `addr:${h}`);
    await drain(env);
    expect(sent.filter(m => m.to === 'same@flood1.example')).toHaveLength(7);
    expect(hooks).toHaveLength(1);
  });

  it('2c: a league far above its normal is paused; its other emails wait', async () => {
    await makeLeague('spike1');
    await seedHistory('spike1', () => 10);
    await env.DB.prepare('INSERT INTO settings (key, value, league_id) VALUES (?, ?, ?)').bind(`mail:vol:spike1:${montrealDate(new Date(NOW))}`, '50', 'spike1').run();
    await queue(3, { league: 'spike1' });
    await queue(1, { league: 'spike1', toPlayer: false, kind: 'short_alert', to: () => 'admin@spike1.example', subject: () => 'Alerte' });
    await drain(env);
    expect(sent).toHaveLength(0);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].body).toContain('[Ligue spike1] Ligue bien au-dessus de sa normale : 51 courriels aujourd\'hui, moyenne de 10 par jour sur 14 jours');
    expect((await listPauses(env)).map(p => [p.scope, p.rule, p.held])).toEqual([['league:spike1', '2c', 4]]);
    // Cancel: the held emails are dropped; the pause stays until released.
    expect(await cancelScope(env, 'league:spike1')).toBe(4);
    expect((await listPauses(env))[0].held).toBe(0);
    await releaseScope(env, 'league:spike1');
    await queue(1, { league: 'spike1', subject: () => 'Après' });
    await drain(env);
    expect(sent.map(m => m.subject)).toEqual(['Après']);
  });

  it('2c: a normal week never trips: the weekly reminder day, a broadcast on top, a new league, the first week back after the holidays', async () => {
    // A league like the simulation's busiest (L6): about 75 on reminder day
    // (Thursday), 60 on game day (Sunday), 15 otherwise.
    await makeLeague('weekly1');
    await seedHistory('weekly1', d => (dow(d) === 4 ? 78 : dow(d) === 0 ? 62 : 15));
    const day = async (leagueId, n) => {
      for (let i = 0; i < n; i++) {
        const c = await checkSend(env, { leagueId, kind: 'reminder_72h', eventId: 'e', address: `p${i}@${leagueId}.example`, toPlayer: false, subject: `s${i}`, text: 't' });
        expect(c.action, `${leagueId}, email ${i + 1}`).toBe('send');
        await recordSend(env, { leagueId });
      }
    };
    // Today, a reminder day with a broadcast to everyone on top: 140.
    await day('weekly1', 140);
    // A brand-new league's first busy day.
    await makeLeague('new1');
    await seedHistory('new1', (d, i) => (i <= 3 ? 20 : 0));
    await day('new1', 120);
    // Back after two quiet weeks.
    await makeLeague('back1');
    await seedHistory('back1', (d, i) => (i > 16 ? (dow(d) === 4 ? 60 : 15) : 0));
    await day('back1', 70);
    expect(hooks).toEqual([]);
    expect(await listPauses(env)).toEqual([]);
  });

  it('2d: everything at once pauses player mail everywhere; admin mail goes on; one alert', async () => {
    await makeLeague('glob1');
    await makeLeague('glob2');
    for (let i = 0; i < 6; i++) {
      const key = `mail:g10:${new Date(Math.floor((NOW - i * 600000) / 600000) * 600000).toISOString().slice(0, 15)}`;
      await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(key, '50').run();
    }
    await queue(2, { league: 'glob1' });
    await queue(2, { league: 'glob2' });
    await queue(1, { league: 'glob2', toPlayer: false, kind: 'short_alert', to: () => 'admin@glob2.example', subject: () => 'Alerte' });
    await drain(env);
    expect(sent.map(m => m.subject)).toEqual(['Alerte']);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].body).toContain('[toutes les ligues] Trop de courriels d\'un coup : 301 courriels dans la dernière heure');
    expect((await listPauses(env)).map(p => [p.scope, p.held])).toEqual([['global', 4]]);
    expect(await releaseScope(env, 'global')).toBe(4);
    await drain(env);
    expect(sent).toHaveLength(5);
    expect(hooks).toHaveLength(1);
  });

  it('2d: over 2,000 in a Montreal day trips it too', async () => {
    await makeLeague('glob3');
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(`mail:gday:${montrealDate(new Date(NOW))}`, '2000').run();
    const c = await checkSend(env, { leagueId: 'glob3', kind: 'reminder_72h', eventId: 'e', address: 'x@glob3.example', toPlayer: true, subject: 's', text: 't' });
    expect(c).toEqual({ action: 'hold', scope: 'global' });
    expect(hooks[0].body).toContain("Trop de courriels d'un coup : 2001 courriels aujourd'hui");
  });

  it('2e: bounces over 10% of a day (20 sent or more) alert once, without pausing', async () => {
    const dayStart = montrealMidnight(montrealDate(new Date(NOW))).toISOString();
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(`mail:gday:${montrealDate(new Date(NOW))}`, '30').run();
    for (let i = 0; i < 4; i++) await env.DB.prepare(`INSERT INTO outbox (kind, event_id, payload, send_after, created_at, cancelled, failed_at, error, league_id) VALUES ('reminder_72h', 'e', '{}', ?, ?, 1, ?, 'resend 422: invalid recipient', 'b1')`).bind(dayStart, dayStart, new Date(NOW - 3600000).toISOString()).run();
    expect(await checkBounces(env, new Date(NOW), dayStart)).toMatchObject({ rule: '2e' });
    expect(hooks).toHaveLength(1);
    expect(hooks[0].title).toContain('rebonds en hausse');
    expect(hooks[0].body).toContain('4 rebonds sur 34 courriels aujourd\'hui (12 %)');
    expect(await checkBounces(env, new Date(NOW), dayStart)).toBeNull();
    expect(hooks).toHaveLength(1);
    expect(await listPauses(env)).toEqual([]);
  });

  it('2e: under 20 sent, or under 10%, nothing', async () => {
    const dayStart = montrealMidnight(montrealDate(new Date(NOW))).toISOString();
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(`mail:gday:${montrealDate(new Date(NOW))}`, '19').run();
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, payload, send_after, created_at, cancelled, failed_at, error, league_id) VALUES ('reminder_72h', 'e', '{}', ?, ?, 1, ?, 'resend 422: x', 'b1')`).bind(dayStart, dayStart, new Date(NOW - 3600000).toISOString()).run();
    expect(await checkBounces(env, new Date(NOW), dayStart)).toBeNull();
    await env.DB.prepare('UPDATE settings SET value = ? WHERE key = ?').bind('200', `mail:gday:${montrealDate(new Date(NOW))}`).run();
    expect(await checkBounces(env, new Date(NOW), dayStart)).toBeNull();
    expect(hooks).toEqual([]);
  });

  it('a busy Sunday for an SMBHL-sized league never trips: 4 teams and 20 subs, every step of the week', async () => {
    // 60 regulars and 20 subs; on the Sunday, within the hours before the
    // game: the details email to 50 confirmed, two sub-call waves to the 20
    // subs, the game-day reminder to 40, and a dozen admin alerts. Its usual
    // week behind it.
    await makeLeague('smbhlsize');
    await seedHistory('smbhlsize', d => (dow(d) === 0 ? 150 : dow(d) === 4 ? 80 : 20));
    const step = async (n, to, kind, toPlayer = true) => { for (let i = 0; i < n; i++) await queue(1, { league: 'smbhlsize', toPlayer, kind, to: () => to(i), subject: () => `${kind} ${i}` }); };
    await step(50, i => `r${i}@smbhlsize.example`, 'logistics_12h');
    await step(20, i => `s${i}@smbhlsize.example`, 'sub_call');
    await drain(env);
    vi.setSystemTime(new Date(NOW + 3600000));
    await step(20, i => `s${i}@smbhlsize.example`, 'sub_call_wave2');
    await step(40, i => `r${i}@smbhlsize.example`, 'gameday');
    await step(12, i => `admin@smbhlsize.example`, 'late_reversal', false);
    await drain(env);
    expect(sent).toHaveLength(142);
    expect(hooks).toEqual([]);
    expect(await listPauses(env)).toEqual([]);
  });

  it('the super-admin data lists the pauses; Release and Cancel answer only with the admin key', async () => {
    await makeLeague('sa1');
    await env.DB.prepare(`INSERT INTO settings (key, value, league_id) VALUES ('mail:pause:league:sa1', ?, 'sa1')`).bind(JSON.stringify({ scope: 'league:sa1', rule: '2c', leagueId: 'sa1', leagueName: 'Ligue sa1', since: new Date(NOW).toISOString(), numbers: { today: 51, avg: 10 } })).run();
    const data = await SELF.fetch('http://example.com/super-admin/leagues/data', { headers: { 'x-admin': 'p228-admin-key' } }).then(r => r.json());
    expect(data.pauses).toEqual([{ scope: 'league:sa1', rule: '2c', leagueId: 'sa1', leagueName: 'Ligue sa1', numbers: { today: 51, avg: 10 }, since: new Date(NOW).toISOString(), held: 0 }]);
    const refused = await SELF.fetch('http://example.com/super-admin/mail/release', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'league:sa1' }) });
    expect(refused.status).toBeGreaterThanOrEqual(401);
    const bad = await SELF.fetch('http://example.com/super-admin/mail/release', { method: 'POST', headers: { 'x-admin': 'p228-admin-key', 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'drop table' }) });
    expect(bad.status).toBe(400);
    const ok = await SELF.fetch('http://example.com/super-admin/mail/release', { method: 'POST', headers: { 'x-admin': 'p228-admin-key', 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'league:sa1' }) });
    expect(await ok.json()).toEqual({ ok: true, released: 0 });
    expect(await listPauses(env)).toEqual([]);
    const page = await SELF.fetch('http://example.com/super-admin/leagues', { headers: { 'x-admin': 'p228-admin-key' } }).then(r => r.text());
    expect(page).toContain('id="sa-pauses"');
    expect(page).toContain('Relâcher');
    expect(page).toContain('Annuler les courriels retenus');
  });

  it('a direct send to players of a paused league is queued, not lost', async () => {
    await makeLeague('direct1');
    await env.DB.prepare(`INSERT INTO settings (key, value, league_id) VALUES ('mail:pause:league:direct1', ?, 'direct1')`).bind(JSON.stringify({ scope: 'league:direct1', rule: '2c', leagueId: 'direct1', since: new Date(NOW).toISOString(), numbers: {} })).run();
    let err = null;
    try { await sendMail(env, 'p@direct1.example', 'Diffusion', 'x', null, null, null, { leagueId: 'direct1', kind: 'broadcast', toPlayer: true }); } catch (e) { err = e; }
    expect(isMailDeferred(err)).toBe(true);
    expect(sent).toEqual([]);
    await releaseScope(env, 'league:direct1');
    await drain(env);
    expect(sent.map(m => m.subject)).toEqual(['Diffusion']);
  });
});

describe('Item 3: usage in the daily digest', () => {
  it('the lines: the month against 3,000, the line past it, the three busiest leagues', () => {
    expect(usageLines({ sent: 1, top: [], over: false }, 'fr')).toEqual(['1 courriel ce mois-ci, sur 3 000 inclus']);
    expect(usageLines({ sent: 1, top: [], over: false }, 'en')).toEqual(['1 email this month, of 3,000 included']);
    const big = { sent: 3120, over: true, top: [{ name: 'Ligue A', n: 1500 }, { name: 'Ligue B', n: 900 }, { name: 'Ligue C', n: 400 }] };
    expect(usageLines(big, 'fr')).toEqual([
      '3 120 courriels ce mois-ci, sur 3 000 inclus',
      'Le mois a dépassé les 3 000 courriels inclus : chaque courriel de plus est facturé.',
      'Ligues les plus actives : Ligue A (1 500), Ligue B (900), Ligue C (400)'
    ]);
    expect(usageLines(big, 'en')).toEqual([
      '3,120 emails this month, of 3,000 included',
      'The month is past the 3,000 included emails: each extra email is billed.',
      'Busiest leagues: Ligue A (1,500), Ligue B (900), Ligue C (400)'
    ]);
  });

  it('usage alone sends no digest; a tripped rule or crossing 3,000 does, once', async () => {
    await makeLeague('dg1');
    const day = montrealDate(new Date(NOW));
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(`mail:gday:${day}`, '120').run();
    await env.DB.prepare('INSERT INTO settings (key, value, league_id) VALUES (?, ?, ?)').bind(`mail:vol:dg1:${day}`, '120', 'dg1').run();
    await env.DB.prepare("DELETE FROM settings WHERE key IN ('ops_digest:pending', 'ops_digest:cutoff')").run();
    // From now: the leagues earlier tests created are not new sign-ups.
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ops_digest:cutoff', ?)").bind(new Date(NOW).toISOString()).run();
    const health = { worsened: [], trialsEntering: [], day };
    expect(await prepareOpsDigest(env, health, new Date(NOW))).toBeNull();
    // A rule trips: the digest carries it, and the month's usage.
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind('mail:trips', JSON.stringify([{ scope: 'league:dg1', rule: '2c', leagueId: 'dg1', leagueName: 'Ligue dg1', numbers: { today: 51, avg: 10 }, since: new Date(NOW + 60000).toISOString() }])).run();
    vi.setSystemTime(new Date(NOW + 86400000));
    const pending = await prepareOpsDigest(env, health, new Date(NOW + 86400000));
    const text = renderOpsDigest(pending, 'https://rsvp.p228.example').text;
    expect(text).toContain("Règles d'envoi déclenchées");
    expect(text).toContain("Ligue dg1 : Ligue bien au-dessus de sa normale, 51 courriels aujourd'hui, moyenne de 10 par jour sur 14 jours");
    expect(text).toContain('120 courriels ce mois-ci, sur 3 000 inclus');
    expect(text).toContain('Ligues les plus actives : Ligue dg1 (120)');
    expect(text).toContain('Sending rules tripped');
    expect(text).toContain('120 emails this month, of 3,000 included');
    expect(text).not.toMatch(/@|\u2014/);
    // Crossing 3,000: once.
    await env.DB.prepare("DELETE FROM settings WHERE key IN ('ops_digest:pending', 'mail:trips')").run();
    await env.DB.prepare('UPDATE settings SET value = ? WHERE key = ?').bind('3001', `mail:gday:${day}`).run();
    vi.setSystemTime(new Date(NOW + 2 * 86400000));
    const crossed = await prepareOpsDigest(env, health, new Date(NOW + 2 * 86400000));
    expect(renderOpsDigest(crossed, '').text).toContain('Le mois a dépassé les 3 000 courriels inclus');
    await env.DB.prepare("DELETE FROM settings WHERE key = 'ops_digest:pending'").run();
    vi.setSystemTime(new Date(NOW + 3 * 86400000));
    expect(await prepareOpsDigest(env, health, new Date(NOW + 3 * 86400000))).toBeNull();
  });

  it('the month and the busiest leagues come from the guard counters', async () => {
    const day = montrealDate(new Date(NOW));
    for (const [id, n] of [['m1', 40], ['m2', 300], ['m3', 12], ['m4', 90]]) {
      await makeLeague(id);
      await env.DB.prepare('INSERT INTO settings (key, value, league_id) VALUES (?, ?, ?)').bind(`mail:vol:${id}:${day}`, String(n), id).run();
    }
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(`mail:gday:${day}`, '442').run();
    const u = await monthUsage(env, new Date(NOW));
    expect(u).toMatchObject({ month: day.slice(0, 7), sent: 442, over: false });
    expect(u.top.map(t => [t.name, t.n])).toEqual([['Ligue m2', 300], ['Ligue m4', 90], ['Ligue m1', 40]]);
  });

  it('every rule has its words, both languages, singular and plural', () => {
    expect(tripNumbers('2b', { count: 1 }, 'en')).toBe('1 email to one person in an hour');
    expect(tripNumbers('2a', { blocks: 1 }, 'fr')).toBe('1 courriel en double bloqué en une heure');
    expect(tripNumbers('2c', { today: 60, avg: 12.5 }, 'fr')).toBe("60 courriels aujourd'hui, moyenne de 12,5 par jour sur 14 jours");
    expect(tripNumbers('2d', { day: 2001 }, 'en')).toBe('2001 emails today');
    expect(tripNumbers('2e', { bounced: 1, sent: 20 }, 'en')).toBe('1 bounce out of 20 emails today (5%)');
  });
});

describe('Item 4: the Notre Ligue environment has no daily caps', () => {
  it('wrangler.jsonc: no MAIL_DAILY_CAP, MAIL_HARD_DAILY_CAP or PAYMENT_REMINDER_RESERVE on demo; production unchanged', () => {
    const raw = Object.values(import.meta.glob('../wrangler.jsonc', { eager: true, query: '?raw', import: 'default' }))[0];
    const demo = raw.slice(raw.indexOf('"demo": {'));
    const demoVars = demo.slice(demo.indexOf('"vars": {'), demo.indexOf('},', demo.indexOf('"vars": {')));
    expect(demoVars).not.toMatch(/"MAIL_DAILY_CAP"|"MAIL_HARD_DAILY_CAP"|"PAYMENT_REMINDER_RESERVE"/);
    expect(demoVars).toContain('"DEMO_ENV": "true"');
    const top = raw.slice(0, raw.indexOf('"env": {'));
    expect(top).toContain('"MAIL_DAILY_CAP": "90"');
  });
});

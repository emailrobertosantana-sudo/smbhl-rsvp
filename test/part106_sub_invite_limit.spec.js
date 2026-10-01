// Sub-call rework, Part 4: a sub gets at most TWO automatic invites per
// event -- the first invite and one follow-up -- whatever triggers them.
// A third only ever goes out through the admin's deliberate manual
// extra (/admin/subs/extra-invite), once per sub per event. Enforced at
// send time in drain(), so no current or future trigger can slip past.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { wideSubCallWindow } from './support/wide_sub_call_window.js'; // the 8-day sub-call window these tests were written for
import { runSchedule, drain } from '../src/index.js';
import { withGameTimes } from './support/game_times.js';

const ADMIN_KEY = 'test-part106-admin';

function eastern(h) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(Date.now() + h * 3600000));
  const g = t => parts.find(p => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}
async function withResend(fn) {
  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) { sent.push(JSON.parse(opts.body)); return new Response('{"id":"x"}', { status: 200 }); }
    return new Response('{}', { status: 200 });
  };
  try { return { result: await fn(), sent }; } finally { globalThis.fetch = original; }
}
const adminPost = (path, body, key = ADMIN_KEY) => SELF.fetch('http://example.com' + path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-admin': key } : {}) }, body: JSON.stringify(body)
});
const sentInvites = async (eventId, pid) => (await env.DB.prepare(
  `SELECT count(*) n FROM outbox WHERE event_id = ? AND player_id = ? AND kind = 'sub_call' AND sent_at IS NOT NULL`
).bind(eventId, pid).first()).n;

let EVENT_ID;
beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  env.RSVP_SECRET = 'test-part106-rsvp';
  env.RESEND_API_KEY = 'test-part106-resend';
  await applyRealSchema(env); await wideSubCallWindow(env);
  await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('email_cadence_settings', ?)`)
    .bind(JSON.stringify({ quiet_hours_enabled: false })).run();
  const { date, time } = eastern(30); // inside 36h (the follow-up job) and 48h (no waves)
  EVENT_ID = `p106:${date}`;
  await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, 'Fall 2026', 5, 'open', ?, 'smbhl')`)
    .bind(EVENT_ID, date, time).run();
  for (const [id, name] of [['S106A', 'Ann Sub'], ['S106B', 'Ben Sub']]) {
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, 'sub_skater', 1, 0, 'salt', 'smbhl')`)
      .bind(id, name, `${id.toLowerCase()}@example.com`).run();
  }
});

describe('Two automatic invites per sub per event', () => {
  it('first invite, one follow-up, and nothing more -- however many triggers fire', async () => {
    // Trigger 1: the admin (or any shortage) calls subs.
    await withResend(async () => { await adminPost('/admin/subs/call', { event_id: EVENT_ID, team: 'Red', need: 'skater' }); await drain(env); });
    expect(await sentInvites(EVENT_ID, 'S106A')).toBe(1);
    // Trigger 2: the 36-hour pass sends the one follow-up to non-responders.
    await withResend(() => runSchedule(env));
    expect(await sentInvites(EVENT_ID, 'S106A')).toBe(2);
    // Trigger 3 and 4: more calls (a later cancellation, another shortage pass).
    await withResend(async () => { await adminPost('/admin/subs/call', { event_id: EVENT_ID, team: 'Blue', need: 'skater' }); await drain(env); });
    await withResend(() => runSchedule(env));
    expect(await sentInvites(EVENT_ID, 'S106A')).toBe(2);
    expect(await sentInvites(EVENT_ID, 'S106B')).toBe(2);
  });

  it('a third automatic invite that reaches the queue anyway is refused at send time', async () => {
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at, league_id) VALUES ('sub_call', ?, 'S106B', 'Red', 'call:stray', '{"need":"skater"}', ?, ?, 'smbhl')`)
      .bind(EVENT_ID, new Date(0).toISOString(), new Date().toISOString()).run();
    const { sent } = await withResend(() => drain(env));
    expect(sent.filter(m => m.to[0] === 's106b@example.com')).toEqual([]);
    const row = await env.DB.prepare(`SELECT cancelled, error FROM outbox WHERE dedup_key = 'call:stray'`).first();
    expect(row.cancelled).toBe(1);
    expect(row.error).toMatch(/invite limit reached \(2 per sub per event\)/);
    expect(await sentInvites(EVENT_ID, 'S106B')).toBe(2);
  });
});

describe('The manual third invite', () => {
  it('requires the admin key -- nothing is queued without it', async () => {
    const res = await adminPost('/admin/subs/extra-invite', { event_id: EVENT_ID, player_id: 'S106A' }, null);
    expect(res.status).not.toBe(200);
    expect(await sentInvites(EVENT_ID, 'S106A')).toBe(2);
  });

  it('an admin can send exactly one extra invite to one sub for one event', async () => {
    const { result, sent } = await withResend(async () => {
      const res = await adminPost('/admin/subs/extra-invite', { event_id: EVENT_ID, player_id: 'S106A' });
      return { status: res.status, body: await res.json() };
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, status: 'sent' });
    expect(sent.map(m => m.to[0])).toEqual(['s106a@example.com']);
    expect(await sentInvites(EVENT_ID, 'S106A')).toBe(3);
    expect(await sentInvites(EVENT_ID, 'S106B')).toBe(2); // only the chosen sub
  });

  it('a second manual extra for the same sub and event is refused', async () => {
    const res = await adminPost('/admin/subs/extra-invite', { event_id: EVENT_ID, player_id: 'S106A' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('extra_already_used');
    expect(await sentInvites(EVENT_ID, 'S106A')).toBe(3);
  });

  it('the admin sub-pool screen offers the button in both languages and reports each sub\'s invite state', async () => {
    const html = await (await SELF.fetch('http://example.com/admin/subs', { headers: { 'x-admin': ADMIN_KEY } })).text();
    expect(html).toContain("extraInviteBtn: 'Envoyer une invitation de plus'");
    expect(html).toContain("extraInviteBtn: 'Send one more invite'");
    expect(html).toContain('data-extra-invite');
  });
});

describe('League product: the same limit', () => {
  function extractCookie(res) { return (res.headers.get('set-cookie') || '').split(';')[0]; }
  function extractCsrf(res) { const c = res.headers.getSetCookie().find(x => x.startsWith('csrf_token=')); return c ? c.split(';')[0].split('=')[1] : ''; }

  it('a later OUT does not re-invite subs already invited for the event (its old copy of the pool query did, once 10 minutes had passed)', async () => {
    env.AUTH_SECRET = 'test-part106-auth';
    const s = await SELF.fetch('http://example.com/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.231.1' }, body: JSON.stringify({ email: 'p106.league@example.com', password: 'a-strong-password-1' }) });
    const cookie = extractCookie(s), csrf = extractCsrf(s);
    const post = (p, b) => SELF.fetch('http://example.com' + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(b) });
    const league = (await (await post('/leagues/create', { name: 'P106 League', teamNames: ['Otters', 'Falcons'], tracksStats: true })).json()).league;
    await post('/league/season/publish', { season_name: 'S1', goalies_per_team: 0, skaters_per_team: 3, min_skaters: 3 });
    // Both teams start exactly at their minimum (3), so nobody is short
    // until someone says OUT (a team below its minimum at creation would
    // call subs straight away -- Part 3, tested in part108).
    const players = [];
    for (let i = 0; i < 6; i++) {
      const c = (await (await post('/league/contacts', { name: `Roster ${i}`, email: `p106.r${i}@example.com`, role: 'roster' })).json()).contact;
      await env.DB.prepare(`UPDATE contacts SET preferred_team = ? WHERE player_id = ?`).bind(i < 3 ? 'Otters' : 'Falcons', c.player_id).run();
      players.push(c.player_id);
    }
    await post('/league/contacts', { name: 'League Sub', email: 'p106.sub@example.com', role: 'sub_skater' });
    const date = new Date(Date.now() + 5 * 24 * 3600000).toISOString().slice(0, 10);
    const eventId = (await (await post('/league/events', withGameTimes({ date, start_time: '20:00' }))).json()).event.id;
    const out = pid => withResend(() => post('/league/rsvp/admin', { event_id: eventId, player_id: pid, status: 'out' }));

    const first = await out(players[0]);
    expect(first.sent.map(m => m.to[0])).toContain('p106.sub@example.com');
    // Push the first invite past the old 10-minute re-invite window.
    await env.DB.prepare(`UPDATE outbox SET created_at = ? WHERE event_id = ?`).bind(new Date(Date.now() - 3600000).toISOString(), eventId).run();
    const second = await out(players[1]);
    expect(second.sent.map(m => m.to[0])).not.toContain('p106.sub@example.com');
    const n = (await env.DB.prepare(`SELECT count(*) n FROM outbox WHERE event_id = ? AND kind = 'sub_call' AND sent_at IS NOT NULL`).bind(eventId).first()).n;
    expect(n).toBe(1);
    expect(league.id).toBeTruthy();
  });
});

describe('League product: the manual third, from a league admin', () => {
  function extractCookie(res) { return (res.headers.get('set-cookie') || '').split(';')[0]; }
  function extractCsrf(res) { const c = res.headers.getSetCookie().find(x => x.startsWith('csrf_token=')); return c ? c.split(';')[0].split('=')[1] : ''; }
  async function admin(tag) {
    const s = await SELF.fetch('http://example.com/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.233.${tag}` }, body: JSON.stringify({ email: `p106.x${tag}@example.com`, password: 'a-strong-password-1' }) });
    const cookie = extractCookie(s), csrf = extractCsrf(s);
    const post = (p, b, withCsrf = true) => SELF.fetch('http://example.com' + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...(withCsrf ? { 'x-csrf-token': csrf } : {}) }, body: JSON.stringify(b) });
    await post('/leagues/create', { name: `P106 X League ${tag}`, teamNames: ['Otters', 'Falcons'], tracksStats: true });
    await post('/league/season/publish', { season_name: 'S1', goalies_per_team: 0, skaters_per_team: 1, min_skaters: 1 });
    for (const team of ['Otters', 'Falcons']) {
      const c = (await (await post('/league/contacts', { name: `X${tag} ${team}`, email: `p106.x${tag}.${team}@example.com`, role: 'roster' })).json()).contact;
      await env.DB.prepare(`UPDATE contacts SET preferred_team = ? WHERE player_id = ?`).bind(team, c.player_id).run();
    }
    const sub = (await (await post('/league/contacts', { name: `X${tag} Sub`, email: `p106.x${tag}.sub@example.com`, role: 'sub_skater' })).json()).contact;
    const date = new Date(Date.now() + 5 * 24 * 3600000).toISOString().slice(0, 10);
    const eventId = (await (await post('/league/events', withGameTimes({ date, start_time: '20:00' }))).json()).event.id;
    return { post, sub, eventId };
  }

  it('sends one extra invite, refuses a second, and refuses without CSRF or from another league', async () => {
    const a = await admin(1);
    const b = await admin(2);
    const noCsrf = await a.post('/league/subs/extra-invite', { event_id: a.eventId, player_id: a.sub.player_id }, false);
    expect(noCsrf.status).toBe(403);
    const otherLeague = await b.post('/league/subs/extra-invite', { event_id: a.eventId, player_id: a.sub.player_id });
    expect(otherLeague.status).toBe(404);

    const first = await withResend(async () => (await a.post('/league/subs/extra-invite', { event_id: a.eventId, player_id: a.sub.player_id })).json());
    expect(first.result).toMatchObject({ ok: true, status: 'sent' });
    // (The admin may also be told the game is short -- D3; not an invite.)
    expect(first.sent.filter(m => !/Short of players/.test(m.subject)).map(m => m.to[0])).toEqual([`p106.x1.sub@example.com`]);
    const second = await a.post('/league/subs/extra-invite', { event_id: a.eventId, player_id: a.sub.player_id });
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('extra_already_used');
  });
});

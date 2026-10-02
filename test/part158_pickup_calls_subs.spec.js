// D2 (decided 2026-09-29): a pickup league (weekly draw) never called subs
// -- no team can be short before the draw -- so a short pickup game had no
// way to fill spots. Before the draw, the whole pool is now checked
// against the league's minimum player count; a sub who says yes joins the
// pool, with no team, and the draw places them with everyone else.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { DAY, local, mail, installMailCapture, removeMailCapture, admin, must, one, rows } from './support/league_season.js';
import { callSubsForShortfall, drain } from '../src/index.js';
import { hmac } from '../src/crypto_utils.js';

const START = Date.UTC(2026, 9, 5, 16, 0);
beforeAll(async () => {
  env.LEAGUE_PRODUCT = 'true'; env.RESEND_API_KEY = 'x'; env.RSVP_SECRET = 'p158'; env.AUTH_SECRET = 'p158-auth'; env.MAIL_DAILY_CAP = ''; env.PUBLIC_URL = 'https://rsvp.example.com';
  vi.useFakeTimers({ toFake: ['Date'] });
  await applyRealSchema(env);
  installMailCapture();
});
beforeEach(() => { vi.setSystemTime(new Date(START)); mail.sent.length = 0; });
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

// A pickup league with its pool limits, `regulars` rostered (the first a
// goalie) and `subs` sub skaters, and one game three days out.
async function pickup(tag, { min, max, regulars, subs }) {
  const a = await admin(tag);
  const lg = (await must(a.post('/leagues/create', { name: `P158 ${tag}`, teamStructure: 'weekly_draw', teamNames: ['Dark', 'Light'] }), 'create')).league;
  await must(a.post('/league/settings/structure', { min_players: min, max_players: max }), 'limits');
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  for (let i = 0; i < regulars; i++) await must(a.post('/league/contacts', { name: `${tag} Reg${i}`, email: `${tag}.reg${i}@example.com`, ...(i === 0 ? { is_goalie: true } : {}) }), 'reg');
  const subIds = [];
  for (let i = 0; i < subs; i++) subIds.push((await must(a.post('/league/contacts', { name: `${tag} Sub${i}`, email: `${tag}.sub${i}@example.com`, role: 'sub_skater' }), 'sub')).contact.player_id);
  const { date, time } = local(START + 3 * DAY);
  const id = `${lg.id}:g:${date}`;
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, auto_reminders_enabled) VALUES (?, 'S1', 1, ?, 'Gym', 'open', ?, ?, 1)`).bind(id, date, time, lg.id).run();
  return { a, lg, ev: await one('SELECT * FROM events WHERE id = ?', id), subIds };
}
async function availLink(ev, pid, a = 'yes') {
  const c = await one('SELECT token_salt FROM contacts WHERE player_id = ?', pid);
  const t = await hmac(env.RSVP_SECRET, `a:${ev.id}:${pid}:skater:${c.token_salt}`);
  return `http://example.com/avail?e=${encodeURIComponent(ev.id)}&p=${encodeURIComponent(pid)}&n=skater&t=${t}&a=${a}`;
}
const accept = async url => SELF.fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=yes' });

describe('A short pickup game calls subs on headcount, before the draw', () => {
  it('6 players against a pool minimum of 10: the subs are called, with no team named', async () => {
    const { ev } = await pickup('short', { min: 10, max: 14, regulars: 6, subs: 3 });
    expect(await callSubsForShortfall(env, ev)).toBe(3);
    const calls = await rows(`SELECT team FROM outbox WHERE event_id = ? AND kind = 'sub_call'`, ev.id);
    expect(calls).toHaveLength(3);
    expect(calls.every(c => c.team === null)).toBe(true);
    await drain(env);
    const m = mail.sent.find(x => x.to === 'short.sub0@example.com');
    expect(m.subject).toContain('P158 short');
    expect(m.text).toContain("P158 short needs a sub on");
  });

  it('a full pool calls nobody', async () => {
    const { ev } = await pickup('full', { min: 6, max: 14, regulars: 8, subs: 2 });
    expect(await callSubsForShortfall(env, ev)).toBe(0);
  });

  it('a sub who says yes joins the pool; the draw gives them a team; after the draw nothing is called', async () => {
    const { a, ev, subIds } = await pickup('draw', { min: 10, max: 14, regulars: 6, subs: 2 });
    await callSubsForShortfall(env, ev);
    // The league's /avail page (neutral French, apostrophes escaped as &#39;).
    const page = (await (await accept(await availLink(ev, subIds[0]))).text()).replace(/&#39;/g, "'");
    expect(page).toMatch(/C(&#39;|&#x27;|')est noté!/);
    expect(page).toMatch(/You(&#39;|&#x27;|')re in!/);
    expect(page).toMatch(/You(&#39;|&#x27;|')ll get your team before the game\./);
    let row = await one('SELECT team, status, role FROM rsvp WHERE event_id = ? AND player_id = ?', ev.id, subIds[0]);
    expect(row).toEqual({ team: null, status: 'in', role: 'sub' });
    expect((await a.post('/league/events/random-assign', { event_id: ev.id })).status).toBe(200);
    row = await one('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?', ev.id, subIds[0]);
    expect(['Dark', 'Light']).toContain(row.team);
    // Drawn: pickup's automatic calls stop (as before this change).
    await env.DB.prepare(`DELETE FROM outbox WHERE event_id = ?`).bind(ev.id).run();
    expect(await callSubsForShortfall(env, ev)).toBe(0);
  });

  it('the waves stop once the pool is full', async () => {
    // Pool of 4 skaters at most (2 a team); 3 regular skaters + a goalie.
    const { ev, subIds } = await pickup('waves', { min: 4, max: 5, regulars: 4, subs: 8 });
    // Regulars answer: one out, so 2 skaters left against a minimum of 4.
    const regs = await rows(`SELECT player_id FROM contacts WHERE league_id = ? AND role = 'roster' ORDER BY player_id`, ev.league_id);
    for (const [i, r] of regs.entries()) await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, NULL, ?, 'roster', 'self', ?, ?)`).bind(ev.id, r.player_id, i === 3 ? 'out' : 'in', new Date().toISOString(), ev.league_id).run();
    expect(await callSubsForShortfall(env, ev)).toBe(8);
    const pending = async () => (await one(`SELECT count(*) n FROM outbox WHERE event_id = ? AND kind = 'sub_call' AND sent_at IS NULL AND cancelled = 0`, ev.id)).n;
    await drain(env); // the first wave goes; later waves wait
    expect(await pending()).toBeGreaterThan(0);
    await accept(await availLink(ev, subIds[0]));
    expect(await pending()).toBeGreaterThan(0); // 3 of 4
    await accept(await availLink(ev, subIds[1]));
    expect(await pending()).toBe(0); // 4 of 4: the pool is full, the waves stop
    // A later yes waits.
    const late = await (await accept(await availLink(ev, subIds[2]))).text();
    expect(late).toMatch(/tu es sur la liste d(&#39;|&#x27;|')attente, et on t(&#39;|&#x27;|')écrit si une place se libère\./);
  });
});

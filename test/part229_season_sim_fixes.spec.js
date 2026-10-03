// The season simulation's problems (league-sim/REPORT.md, 2026-10-02),
// each reproduced as the simulation met it, then fixed:
//   1a  playoffs seeded after a cancelled regular-season game
//   1b  a sub who plays both positions, confirmed as a skater, is never put
//       in goal unasked; the goalie call starts at once; the admin's switch
//       is not refused
//   1c  a goalie who has not answered is not "out": no goalie sub placed on
//       their team
//   1d  a sub with a preferred team gets no regular's ask
//   1e  a league sub placed inside 24 h gets the league's own email
//   C1  an address refused twice gets nothing more, is flagged, can be cleared
//   C2  a noon game's details and a late "out"'s sub calls wait for 07:00
//   C4  a time change is told to whoever was already asked (as before)
//   C6  a one-click unsubscribe link
//   C7  the billing page says what pause and resume do to the paid month
//   C8  a read-only league: no "not sent" alert, never green
//   C9  before a pickup draw, a sub never takes a regular's spot
//   C10 a yes after a pickup draw gets a team and is told it
//   K1  alerts and the digest in words; K2 an English page in English;
//   K5  sub-call waves never go past the cutoff
// Mail is captured by a local fetch; nothing leaves.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must } from './support/league_season.js';
import { answerViaEmailLink } from './support/email_link.js';
import { drain, runCronPass, acceptAvailability, teamState, expected, syncDualRoles, callSubs, sendLeagueReminderKind } from '../src/index.js';
import { getLeagueSeasonConfig } from '../src/leagues.js';
import { evaluateHealth, HEALTH_RULES } from '../src/league_health.js';
import { collectProblems } from '../src/health.js';
import { renderOpsDigest } from '../src/ops_digest.js';
import { montrealMidnight } from '../src/montreal_time.js';

const H = 3600000, DAY = 24 * H;
const NOW = Date.UTC(2026, 9, 14, 16, 0); // Wednesday 2026-10-14, 12:00 Montreal
const sent = [];
const refused = new Set();
let originalFetch;

beforeAll(async () => {
  Object.assign(env, { LEAGUE_PRODUCT: 'true', RESEND_API_KEY: 'x', RSVP_SECRET: 'p229', AUTH_SECRET: 'p229-auth', PUBLIC_URL: 'https://rsvp.p229.example', HEALTH_ALERTS: 'off' });
  delete env.MAIL_DAILY_CAP; delete env.MAIL_HARD_DAILY_CAP; delete env.BILLING_LAUNCH_AT;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  await applyRealSchema(env);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url && url.url ? url.url : url);
    if (u.includes('api.resend.com')) {
      const b = JSON.parse(opts.body);
      const to = Array.isArray(b.to) ? b.to[0] : b.to;
      sent.push({ to, subject: b.subject, text: b.text || '', html: b.html || '', headers: b.headers || {}, at: Date.now() });
      if (refused.has(to)) return new Response('{"message":"invalid recipient"}', { status: 422 });
      return new Response('{"id":"x"}', { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
});
afterAll(() => { globalThis.fetch = originalFetch; vi.useRealTimers(); });
beforeEach(() => { vi.setSystemTime(new Date(NOW)); sent.length = 0; refused.clear(); delete env.BILLING_LAUNCH_AT; });

const rows = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results;
const one = async (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const local = (date, time) => { for (const off of [4, 5]) { const ms = Date.parse(`${date}T${time}:00Z`) + off * H; const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms)); if (p.replace('24', '00') === time) return ms; } return Date.parse(`${date}T${time}:00Z`) + 5 * H; };

async function league(tag, { structure = 'fixed', teams = ['A', 'B'], lang = 'fr', stats = false, create = {} } = {}) {
  const a = await admin(tag);
  const r = await must(a.post('/leagues/create', { name: `Ligue ${tag}`, teamStructure: structure, teamNames: teams, tracksStats: stats, languageMode: lang, ...create }), 'create');
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  return { a, id: r.league.id };
}
async function add(a, body) {
  const r = await must(a.post('/league/contacts', { role: 'roster', emailChoice: 'send', regularNoticeSeen: true, ...body }), `add ${body.name}`);
  return r.contact.player_id;
}
async function game(a, date, start, end, extra = {}) {
  const r = await must(a.post('/league/events', { date, start_time: start, end_time: end, venue: 'Aréna Centre', season: 'S1', ...extra }), `game ${date}`);
  return r.event.id;
}
const ev = id => one('SELECT * FROM events WHERE id = ?', id);
const say = (leagueId, eventId, playerId, status, team = null, role = 'roster') => env.DB.prepare(
  `INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, ?, ?, ?, 'self', ?, ?)
   ON CONFLICT(event_id, player_id) DO UPDATE SET status = excluded.status, team = excluded.team, role = excluded.role`
).bind(eventId, playerId, team, status, role, new Date().toISOString(), leagueId).run();

// A fixed league whose teams (A and B unless told) have a goalie and four
// skaters each.
async function twoTeams(tag, extra = {}) {
  const L = await league(tag, extra);
  const teams = extra.teams || ['A', 'B'];
  const p = {};
  for (const t of teams) {
    p[t] = { skaters: [] };
    p[t].goalie = await add(L.a, { name: `Goal ${t} ${tag}`, email: `g${t.toLowerCase()}.${tag}@p229.example`, team: t, is_goalie: true });
    for (let i = 0; i < 4; i++) p[t].skaters.push(await add(L.a, { name: `Ska ${t}${i} ${tag}`, email: `s${t.toLowerCase()}${i}.${tag}@p229.example`, team: t, is_goalie: false }));
  }
  return { ...L, p };
}

describe('1a: playoffs after a cancelled regular-season game', () => {
  it('the final is seeded once the games played have results, the cancelled one counting as done', async () => {
    const { a, id } = await league('p1a', { stats: true });
    await must(a.post('/league/settings/playoffs', { playoffs_enabled: true, playoff_format: 'single_elimination', playoff_teams: 2 }), 'playoffs');
    const ids = [];
    for (const d of ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']) ids.push(await game(a, d, '20:00', '21:00'));
    await must(a.post('/league/season/matchups-confirm', { mode: 'fill_blanks' }), 'matchups');
    expect((await ev(ids[3])).is_playoff).toBe(1);
    // The simulation's case: one regular game cancelled, the others played.
    await must(a.post('/league/events/cancel', { event_id: ids[1] }), 'cancel');
    vi.setSystemTime(new Date(local('2026-11-03', '10:00')));
    await must(a.post('/league/events/score', { event_id: ids[0], home_score: 3, away_score: 1 }), 'score 1');
    await must(a.post('/league/events/score', { event_id: ids[2], home_score: 2, away_score: 4 }), 'score 3');
    const final = await ev(ids[3]);
    expect([final.home_team, final.away_team].sort()).toEqual(['A', 'B']);
  });

  it('cancelling the last open regular game seeds the playoffs at once', async () => {
    const { a } = await league('p1a2', { stats: true });
    await must(a.post('/league/settings/playoffs', { playoffs_enabled: true, playoff_format: 'single_elimination', playoff_teams: 2 }), 'playoffs');
    const ids = [];
    for (const d of ['2026-10-19', '2026-10-26', '2026-11-02']) ids.push(await game(a, d, '20:00', '21:00'));
    await must(a.post('/league/season/matchups-confirm', { mode: 'fill_blanks' }), 'matchups');
    vi.setSystemTime(new Date(local('2026-10-20', '10:00')));
    await must(a.post('/league/events/score', { event_id: ids[0], home_score: 1, away_score: 0 }), 'score');
    expect((await ev(ids[2])).home_team).toBeNull();
    await must(a.post('/league/events/cancel', { event_id: ids[1] }), 'cancel');
    expect((await ev(ids[2])).home_team).not.toBeNull();
  });
});

describe('1b and 1c: goalies', () => {
  it('1b: a sub who plays both positions, confirmed as a skater, is not put in goal when the goalie is out; the goalie call goes at once', async () => {
    const L = await twoTeams('p1b');
    const both = await add(L.a, { name: 'Both Sub p1b', email: 'both.p1b@p229.example', role: 'sub_skater', is_goalie: false, is_backup_goalie: true });
    const gsub = await add(L.a, { name: 'Goal Sub p1b', email: 'gsub.p1b@p229.example', role: 'sub_skater', is_goalie: true });
    const eid = await game(L.a, '2026-10-17', '08:00', '09:00', { home_team: 'A', away_team: 'B' });
    for (const t of ['A', 'B']) for (const s of L.p[t].skaters) await say(L.id, eid, s, 'in', t);
    await say(L.id, eid, L.p.B.goalie, 'in', 'B');
    await say(L.id, eid, both, 'in', 'A', 'sub'); // placed as a skater
    const cfg = await getLeagueSeasonConfig(env, L.id, 'S1');
    // The admin marks A's goalie out (the simulation: Thursday, 20:00).
    vi.setSystemTime(new Date(local('2026-10-15', '20:00')));
    await must(L.a.post('/league/rsvp/admin', { event_id: eid, player_id: L.p.A.goalie, status: 'out', scope: 'night', notify: false }), 'goalie out');
    const st = await teamState(env.DB, eid, 'A', cfg);
    expect(st.goalieIds).not.toContain(both);
    expect(st.shortGoalie).toBe(true);
    // The goalie call is queued at once, and nobody is told they are in goal.
    const calls = await rows("SELECT player_id FROM outbox WHERE event_id = ? AND kind = 'sub_call' AND dedup_key LIKE 'call:%:goalie:%'", eid);
    expect(calls.map(c => c.player_id)).toContain(gsub);
    await syncDualRoles(env, await ev(eid));
    await drain(env);
    expect(sent.filter(m => /dans les buts/.test(m.subject) && m.to === 'both.p1b@p229.example')).toEqual([]);
  });

  it('1b: once the dual-role sub says yes to the goalie call, they count in goal', async () => {
    const L = await twoTeams('p1b2');
    const both = await add(L.a, { name: 'Both Sub p1b2', email: 'both.p1b2@p229.example', role: 'sub_skater', is_goalie: false, is_backup_goalie: true });
    const eid = await game(L.a, '2026-10-17', '08:00', '09:00', { home_team: 'A', away_team: 'B' });
    await say(L.id, eid, L.p.A.goalie, 'out', 'A');
    await say(L.id, eid, both, 'in', 'A', 'sub');
    const cfg = await getLeagueSeasonConfig(env, L.id, 'S1');
    expect((await teamState(env.DB, eid, 'A', cfg)).goalieIds).toEqual([]);
    await env.DB.prepare(`INSERT INTO availability (event_id, player_id, need, status, answered_at, league_id) VALUES (?, ?, 'goalie', 'yes', ?, ?)`).bind(eid, both, new Date().toISOString(), L.id).run();
    expect((await teamState(env.DB, eid, 'A', cfg)).goalieIds).toEqual([both]);
  });

  it("1b: the admin can put a dual-role regular from the night's other game in goal", async () => {
    const L = await twoTeams('p1b3', { teams: ['A', 'B', 'C', 'D'] });
    const dual = await add(L.a, { name: 'Dual Reg p1b3', email: 'dual.p1b3@p229.example', team: 'C', is_goalie: false, is_backup_goalie: true });
    const first = await game(L.a, '2026-10-18', '08:00', '09:00', { home_team: 'A', away_team: 'B' });
    const second = await game(L.a, '2026-10-18', '09:15', '10:15', { home_team: 'C', away_team: 'D' });
    await say(L.id, first, L.p.A.goalie, 'out', 'A');
    await say(L.id, second, dual, 'in', 'C');
    await say(L.id, second, L.p.C.goalie, 'in', 'C');
    vi.setSystemTime(new Date(local('2026-10-17', '10:00')));
    const r = await L.a.post('/league/events/dual-goalie', { event_id: first, player_id: dual, team: 'A', action: 'switch' });
    expect(r.json).toMatchObject({ ok: true, switched: true, to: 'A' });
    const cfg = await getLeagueSeasonConfig(env, L.id, 'S1');
    expect((await teamState(env.DB, first, 'A', cfg)).goalieIds).toEqual([dual]);
    // Still in their own game after: two games, never two at once.
    expect((await one('SELECT status, team FROM rsvp WHERE event_id = ? AND player_id = ?', second, dual))).toMatchObject({ status: 'in', team: 'C' });
  });

  it("1c: a goalie sub is not placed on a team whose goalie simply hasn't answered; they wait, and fill the spot that opens", async () => {
    const L = await twoTeams('p1c');
    const s1 = await add(L.a, { name: 'Goal Sub1 p1c', email: 'gs1.p1c@p229.example', role: 'sub_skater', is_goalie: true });
    const s2 = await add(L.a, { name: 'Goal Sub2 p1c', email: 'gs2.p1c@p229.example', role: 'sub_skater', is_goalie: true });
    const eid = await game(L.a, '2026-10-19', '20:00', '21:00', { home_team: 'A', away_team: 'B' });
    const cfg = await getLeagueSeasonConfig(env, L.id, 'S1');
    // A's goalie out; B's goalie has not answered (no row).
    await say(L.id, eid, L.p.A.goalie, 'out', 'A');
    expect((await expected(env.DB, eid, 'B', cfg)).goalies).toBe(1);
    expect((await teamState(env.DB, eid, 'B', cfg)).shortGoalie).toBe(false);
    // The simulation: one sub accepts (placed on A), then a second.
    expect((await acceptAvailability(env, await ev(eid), s1, 'goalie')).placed).toBe('A');
    expect((await acceptAvailability(env, await ev(eid), s2, 'goalie')).placed).toBeNull();
    // The first drops out: the second takes A's net from the waitlist.
    const { fillFromWaitlist } = await import('../src/index.js');
    await say(L.id, eid, s1, 'out', 'A', 'sub');
    await fillFromWaitlist(env, await ev(eid), 'A', 'goalie', cfg);
    expect(await one('SELECT team, status FROM rsvp WHERE event_id = ? AND player_id = ?', eid, s2)).toMatchObject({ team: 'A', status: 'in' });
  });

  it('1c: inside the last 24 hours, a goalie still not answering no longer holds the spot', async () => {
    const L = await twoTeams('p1c2');
    const eid = await game(L.a, '2026-10-15', '20:00', '21:00', { home_team: 'A', away_team: 'B' });
    const cfg = await getLeagueSeasonConfig(env, L.id, 'S1');
    vi.setSystemTime(new Date(local('2026-10-15', '08:00')));
    expect((await expected(env.DB, eid, 'B', cfg)).goalies).toBe(0);
  });
});

describe('1d and 1e: subs', () => {
  it("1d: a sub with a preferred team gets no regular's ask", async () => {
    const L = await twoTeams('p1d');
    await add(L.a, { name: 'Pref Sub p1d', email: 'pref.p1d@p229.example', role: 'sub_skater', team: 'A', is_goalie: false });
    const eid = await game(L.a, '2026-10-17', '19:00', '20:00', { home_team: 'A', away_team: 'B' });
    const leagueRow = await one('SELECT * FROM leagues WHERE id = ?', L.id);
    const cfg = await getLeagueSeasonConfig(env, L.id, 'S1');
    await sendLeagueReminderKind(env, leagueRow, cfg, await ev(eid), 'reminder_72h', { drainNow: true });
    expect(sent.map(m => m.to)).not.toContain('pref.p1d@p229.example');
    expect(sent.filter(m => /p1d@p229/.test(m.to)).length).toBe(10);
  });

  it("1e: a sub placed inside 24 hours gets the league's own email, its language, its links and its fee", async () => {
    const L = await twoTeams('p1e');
    const sub = await add(L.a, { name: 'Late Sub p1e', email: 'late.p1e@p229.example', role: 'sub_skater', is_goalie: false });
    const eid = await game(L.a, '2026-10-15', '10:00', '11:00', { home_team: 'A', away_team: 'B' });
    await must(L.a.post('/league/finances/pricing', { season: 'S1', mode: 'season', price_player: 150, price_goalie: 0, price_game_player: 7, price_game_goalie: 0 }), 'pricing');
    await say(L.id, eid, L.p.A.skaters[0], 'out', 'A');
    vi.setSystemTime(new Date(local('2026-10-14', '20:00')));
    expect((await acceptAvailability(env, await ev(eid), sub, 'skater')).placed).toBe('A');
    const m = sent.find(x => x.to === 'late.p1e@p229.example' && /joues avec/.test(x.text));
    expect(m.subject).not.toMatch(/See you at the gym/);
    expect(m.text).toContain('Tu joues avec A');
    expect(m.text).toContain('Frais de remplaçant : 7,00 $ pour ce match.');
    expect(m.text).not.toMatch(/Hi |Venue:|team-rsvp|https?:\/\/[^/\s]+\/rsvp\?|#\/team|smbhl|5,00/);
    expect(m.text).toMatch(/\/league\/rsvp\?/);
  });

  it('1e: an English league charging no sub fee: English, no fee line', async () => {
    const L = await twoTeams('p1e2', { lang: 'en' });
    const sub = await add(L.a, { name: 'Late Sub p1e2', email: 'late.p1e2@p229.example', role: 'sub_skater', is_goalie: false });
    const eid = await game(L.a, '2026-10-15', '10:00', '11:00', { home_team: 'A', away_team: 'B' });
    await say(L.id, eid, L.p.B.skaters[1], 'out', 'B');
    vi.setSystemTime(new Date(local('2026-10-14', '20:00')));
    const team = (await acceptAvailability(env, await ev(eid), sub, 'skater')).placed;
    expect(['A', 'B']).toContain(team);
    const m = sent.find(x => x.to === 'late.p1e2@p229.example' && /playing with/.test(x.text));
    expect(m.text).toContain(`You're playing with ${team}`);
    expect(m.text).not.toMatch(/Sub fee|Salut|Tu joues/);
  });
});

describe('C1: an address refused twice', () => {
  it('gets nothing more, is flagged on the players page, and the admin can clear it', async () => {
    const L = await league('pc1');
    const pid = await add(L.a, { name: 'Bad Mail pc1', email: 'bad.pc1@p229.example', team: 'A' });
    refused.add('bad.pc1@p229.example');
    const queue = async n => {
      const payload = JSON.stringify({ prerendered: { to: 'bad.pc1@p229.example', subject: `Rappel ${n}`, text: `x${n}`, html: null } });
      await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, payload, send_after, created_at, league_id, quiet_exempt) VALUES ('reminder_72h', ?, ?, ?, ?, ?, ?, 1)`)
        .bind(`${L.id}:2026-10-20`, pid, payload, new Date(0).toISOString(), new Date().toISOString(), L.id).run();
    };
    for (let i = 0; i < 3; i++) { await queue(i); await drain(env); }
    expect(sent.filter(m => m.to === 'bad.pc1@p229.example')).toHaveLength(2);
    expect((await one("SELECT error FROM outbox WHERE payload LIKE '%Rappel 2%'")).error).toMatch(/refused 2 times/);
    const page = (await L.a.get('/league/roster')).text;
    expect(page).toContain(`data-bounce="${pid}"`);
    expect(page).toContain("Courriel refusé 2 fois : on n'écrit plus à cette adresse.");
    expect(page).toContain("L'adresse est bonne");
    expect(page).toContain("Pour retirer un joueur, marque-le inactif");
    expect((await L.a.post('/league/contacts/bounce/clear', { player_id: pid })).json).toEqual({ ok: true, cleared: 1 });
    expect((await L.a.get('/league/roster')).text).not.toContain(`data-bounce="${pid}"`);
    refused.clear();
    await queue(3); await drain(env);
    expect(sent.filter(m => m.to === 'bad.pc1@p229.example')).toHaveLength(3);
  });
});

describe('C2: quiet hours for a league', () => {
  it("a noon game's 12-hour details wait for 07:00; an 08:00 game's go at 20:00 as before", async () => {
    const L = await twoTeams('pc2');
    const noon = await game(L.a, '2026-10-16', '12:00', '13:00', { home_team: 'A', away_team: 'B' });
    for (const s of L.p.A.skaters) await say(L.id, noon, s, 'in', 'A');
    vi.setSystemTime(new Date(local('2026-10-16', '00:00')));
    const leagueRow = await one('SELECT * FROM leagues WHERE id = ?', L.id);
    const cfg = await getLeagueSeasonConfig(env, L.id, 'S1');
    await sendLeagueReminderKind(env, leagueRow, cfg, await ev(noon), 'logistics_12h', { drainNow: true });
    expect(sent.filter(m => /pc2@p229/.test(m.to))).toEqual([]);
    const waiting = await rows("SELECT send_after FROM outbox WHERE kind = 'logistics_12h' AND event_id = ? AND sent_at IS NULL", noon);
    expect(waiting.length).toBe(4);
    for (const w of waiting) expect(Date.parse(w.send_after)).toBe(local('2026-10-16', '07:00'));
  });

  it("a late 'out' at 23:45 calls subs at 07:00 for a game days away, at once for a game a few hours away", async () => {
    const L = await twoTeams('pc2b');
    await add(L.a, { name: 'Sub One pc2b', email: 'sub1.pc2b@p229.example', role: 'sub_skater', is_goalie: false });
    const far = await game(L.a, '2026-10-17', '19:00', '20:00', { home_team: 'A', away_team: 'B' });
    vi.setSystemTime(new Date(local('2026-10-14', '23:45')));
    await callSubs(env, await ev(far), 'A', 'skater', 0, L.id, true, true, true);
    const row = await one("SELECT send_after FROM outbox WHERE event_id = ? AND kind = 'sub_call'", far);
    // The end of quiet hours, in the half-hour steps afterQuiet takes: 07:15.
    expect(Date.parse(row.send_after)).toBeGreaterThanOrEqual(local('2026-10-15', '07:00'));
    expect(Date.parse(row.send_after)).toBeLessThan(local('2026-10-15', '07:30'));
    const soon = await game(L.a, '2026-10-15', '08:30', '09:30', { home_team: 'A', away_team: 'B' });
    await callSubs(env, await ev(soon), 'A', 'skater', 0, L.id, true, true, true);
    const urgent = await one("SELECT send_after FROM outbox WHERE event_id = ? AND kind = 'sub_call'", soon);
    expect(Date.parse(urgent.send_after)).toBe(local('2026-10-14', '23:45'));
  });

  it('K5: the waves of a sub call never go past the cutoff', async () => {
    const L = await twoTeams('pk5');
    for (let i = 0; i < 25; i++) await add(L.a, { name: `Sub ${i} pk5`, email: `sub${i}.pk5@p229.example`, role: 'sub_skater', is_goalie: false });
    const gid = await game(L.a, '2026-10-16', '14:00', '15:00', { home_team: 'A', away_team: 'B' });
    vi.setSystemTime(new Date(local('2026-10-14', '12:30'))); // 49.5 hours out: waves of 5 an hour
    await callSubs(env, await ev(gid), 'A', 'skater', 0, L.id, true, true, true);
    const cutoff = local('2026-10-16', '12:00');
    for (const r of await rows("SELECT send_after FROM outbox WHERE event_id = ? AND kind = 'sub_call'", gid)) expect(Date.parse(r.send_after)).toBeLessThanOrEqual(cutoff);
  });
});

describe('C4: a game time changed after the players were asked', () => {
  it('the players already asked are told the new time; before any ask, nobody needs telling', async () => {
    const L = await twoTeams('pc4');
    const eid = await game(L.a, '2026-10-19', '21:15', '22:15', { home_team: 'A', away_team: 'B' });
    // Before any ask: nothing is queued.
    await must(L.a.post('/league/events/update', { event_id: eid, start_time: '21:30', end_time: '22:30', venue: 'Aréna Centre', home_team: 'A', away_team: 'B' }), 'update 1');
    expect((await rows("SELECT 1 FROM outbox WHERE kind = 'night_moved'"))).toEqual([]);
    // After the 72-hour ask.
    vi.setSystemTime(new Date(local('2026-10-16', '22:00')));
    const leagueRow = await one('SELECT * FROM leagues WHERE id = ?', L.id);
    const cfg = await getLeagueSeasonConfig(env, L.id, 'S1');
    await sendLeagueReminderKind(env, leagueRow, cfg, await ev(eid), 'reminder_72h', { writeLog: true, drainNow: true });
    await must(L.a.post('/league/events/update', { event_id: eid, start_time: '21:45', end_time: '22:45', venue: 'Aréna Centre', home_team: 'A', away_team: 'B' }), 'update 2');
    expect((await rows("SELECT player_id FROM outbox WHERE kind = 'night_moved' AND cancelled = 0")).length).toBe(10);
  });
});

describe('C6: unsubscribing', () => {
  it("a league player's email carries a one-click link; the page asks, the POST unsubscribes, and nothing more is sent", async () => {
    const L = await twoTeams('pc6');
    const eid = await game(L.a, '2026-10-17', '19:00', '20:00', { home_team: 'A', away_team: 'B' });
    const leagueRow = await one('SELECT * FROM leagues WHERE id = ?', L.id);
    const cfg = await getLeagueSeasonConfig(env, L.id, 'S1');
    await sendLeagueReminderKind(env, leagueRow, cfg, await ev(eid), 'reminder_72h', { drainNow: true });
    const m = sent.find(x => x.to === `sa0.pc6@p229.example`);
    expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const link = /<(https:[^>]+)>/.exec(m.headers['List-Unsubscribe'])[1];
    expect(link).toMatch(/\/league\/unsubscribe\?league=/);
    expect(m.headers['List-Unsubscribe']).toMatch(/mailto:/);
    const page = await (await SELF.fetch(link)).text();
    expect(page).toContain('Ne plus recevoir les courriels de Ligue pc6?');
    expect(page).toContain('Me désabonner');
    const done = await (await SELF.fetch(link, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).text();
    expect(done).toContain("C'est fait : tu ne recevras plus de courriels de Ligue pc6.");
    expect((await one('SELECT opted_out FROM contacts WHERE player_id = ?', L.p.A.skaters[0])).opted_out).toBe(1);
    expect((await SELF.fetch(link.replace(/t=[0-9a-f]+/, 't=00'))).status).toBe(200);
    expect(await (await SELF.fetch(link.replace(/t=[0-9a-f]+/, 't=00'))).text()).toContain('Ce lien est invalide.');
    sent.length = 0;
    await sendLeagueReminderKind(env, leagueRow, cfg, await ev(eid), 'reminder_24h', { drainNow: true });
    expect(sent.map(x => x.to)).not.toContain('sa0.pc6@p229.example');
  });
});

describe('C7 and C8: billing on the pages and in the health', () => {
  it('C7: the billing page says what pause and resume do to the paid month', async () => {
    env.BILLING_LAUNCH_AT = '2026-10-02';
    const L = await league('pc7');
    const page = (await L.a.get('/league/billing')).text;
    expect(page).toContain("ces jours ne sont pas remboursés");
    expect(page).toContain("un nouveau mois commence et il est payé aujourd'hui");
    expect(page).toContain('those days are not refunded');
    expect(page).toContain('a new month starts and is charged today');
  });

  it('C8: a read-only, unpaid league is never green, and its missed reminders raise no alert', async () => {
    expect(HEALTH_RULES.map(r => r.key)).toContain('billing_ok');
    const m = { signInDays: 0, gameInWindow: true, invitations14: 0, answered14: 0, trialEndingNoSub: false, mailFailures7: 0, ageDays: 30, players: 5, games: 5, paymentFailed: false };
    expect(evaluateHealth({ ...m, readOnly: false }).light).toBe('green');
    expect(evaluateHealth({ ...m, readOnly: true }).light).toBe('red');
    env.BILLING_LAUNCH_AT = '2026-01-01';
    const L = await league('pc8');
    await env.DB.prepare("UPDATE leagues SET created_at = '2026-01-05T15:00:00.000Z' WHERE id = ?").bind(L.id).run();
    for (let i = 0; i < 16; i++) await add(L.a, { name: `Reg ${i} pc8`, email: `r${i}.pc8@p229.example`, team: 'A' }).catch(() => null);
    await env.DB.prepare(`INSERT INTO league_billing (league_id, owner_user_id, regular_count, count_tier, updated_at) VALUES (?, (SELECT created_by FROM leagues WHERE id = ?), 16, 'standard', ?)
      ON CONFLICT(league_id) DO UPDATE SET regular_count = 16, count_tier = 'standard', trial_started_at = NULL, trial_ends_at = NULL`).bind(L.id, L.id, new Date().toISOString()).run();
    // A game whose 72-hour reminder is "due" and was never sent (billing stopped it).
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, state, start_time, end_time, league_id, auto_reminders_enabled) VALUES (?, 'S1', 1, '2026-10-16', 'open', '19:00', '20:00', ?, 1)`).bind(`${L.id}:2026-10-16`, L.id).run();
    const problems = await collectProblems(env, {}, new Date(NOW));
    expect(problems.filter(p => p.scope === L.id && /reminder_missed/.test(p.key))).toEqual([]);
  });
});

describe('C9 and C10: a pickup league', () => {
  it('C10: a yes after the draw goes to the team with fewer players, and is told it', async () => {
    const L = await league('pc10', { structure: 'weekly_draw', teams: ['Dark', 'Light'], lang: 'en' });
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await add(L.a, { name: `Pick ${i} pc10`, email: `p${i}.pc10@p229.example`, is_goalie: false }));
    const eid = await game(L.a, '2026-10-15', '21:00', '22:00');
    await say(L.id, eid, ids[0], 'in', 'Dark');
    await say(L.id, eid, ids[1], 'in', 'Dark');
    await say(L.id, eid, ids[2], 'in', 'Light');
    // The game's details already went: a late yes is told their team.
    await env.DB.prepare(`INSERT INTO league_reminder_log (event_id, league_id, kind, sent_at, skipped) VALUES (?, ?, 'logistics_12h', ?, 0)`).bind(eid, L.id, new Date().toISOString()).run();
    vi.setSystemTime(new Date(local('2026-10-15', '11:00')));
    const link = await (async () => {
      const leagueRow = await one('SELECT * FROM leagues WHERE id = ?', L.id);
      const cfg = await getLeagueSeasonConfig(env, L.id, 'S1');
      await sendLeagueReminderKind(env, leagueRow, cfg, await ev(eid), 'reminder_24h', { drainNow: true });
      const m = sent.find(x => x.to === 'p3.pc10@p229.example');
      return /https:\/\/\S+v=in/.exec(m.text)[0];
    })();
    sent.length = 0;
    await answerViaEmailLink((u, i) => SELF.fetch(u, i), link);
    expect((await one('SELECT team, status FROM rsvp WHERE event_id = ? AND player_id = ?', eid, ids[3]))).toMatchObject({ team: 'Light', status: 'in' });
    await drain(env);
    const told = sent.find(x => x.to === 'p3.pc10@p229.example');
    expect(told.text).toContain("You're now on Light");
  });

  it("C9: before the draw, a sub's yes does not take a spot a regular who hasn't answered still holds", async () => {
    const L = await league('pc9', { structure: 'weekly_draw', teams: ['Dark', 'Light'], lang: 'en' });
    const cfg = await getLeagueSeasonConfig(env, L.id, 'S1');
    const max = (cfg.skatersPerTeam || 0) * 2;
    const regs = [];
    for (let i = 0; i < max; i++) regs.push(await add(L.a, { name: `Reg ${i} pc9`, email: `r${i}.pc9@p229.example`, is_goalie: false }));
    const sub = await add(L.a, { name: 'Sub pc9', email: 'sub.pc9@p229.example', role: 'sub_skater', is_goalie: false });
    const eid = await game(L.a, '2026-10-16', '21:00', '22:00');
    // Half the regulars said yes; the others have not answered.
    for (const r of regs.slice(0, max / 2)) await say(L.id, eid, r, 'in');
    expect((await acceptAvailability(env, await ev(eid), sub, 'skater')).placed).toBeNull();
    expect(await one('SELECT 1 FROM rsvp WHERE event_id = ? AND player_id = ?', eid, sub)).toBeNull();
    // A regular says no: now there is room for the sub.
    await say(L.id, eid, regs[max - 1], 'out');
    expect((await acceptAvailability(env, await ev(eid), sub, 'skater')).pool).toBe(true);
  });
});

describe('K1, K2', () => {
  it('K1: the digest and the health alerts give dates in words', async () => {
    const d = renderOpsDigest({ day: '2026-10-03', items: { signups: [{ name: 'Ligue X', at: '2026-10-02T15:00:00.000Z' }], worsened: [], trials: [{ name: 'Ligue Y', trialEndsAt: '2026-12-03T05:00:00.000Z' }], payments: [], custom: [] } }, '');
    expect(d.subject).toBe('Notre Ligue : résumé du samedi 3 octobre / daily digest, Saturday, October 3');
    expect(d.text).toContain('Résumé du samedi 3 octobre :');
    expect(d.text).toContain('Ligue X : inscrite le vendredi 2 octobre');
    expect(d.text).toContain("Ligue Y : fin de l'essai le mercredi 2 décembre");
    expect(d.text).toContain('Ligue Y: trial ends on Wednesday, December 2');
    expect(d.text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // An alert: a league reminder due and never sent.
    const L = await league('pk1');
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, state, start_time, end_time, league_id, auto_reminders_enabled) VALUES (?, 'S1', 1, '2026-10-16', 'open', '19:00', '20:00', ?, 1)`).bind(`${L.id}:2026-10-16`, L.id).run();
    const p = (await collectProblems(env, {}, new Date(NOW))).find(x => x.scope === L.id && /reminder_missed/.test(x.key));
    expect(p.fr).toBe('Le rappel 72 h du match de vendredi 16 oct. à 19 h aurait dû partir et n\'est pas parti.');
    expect(p.en).toBe('The 72h reminder for the game on Friday, Oct 16 at 7 PM should have gone out and has not.');
  });

  it("K2: an English league's answer page is English before its script runs, the weekday capitalized", async () => {
    const L = await twoTeams('pk2', { lang: 'en' });
    const eid = await game(L.a, '2026-10-15', '21:00', '22:00', { home_team: 'A', away_team: 'B' });
    const leagueRow = await one('SELECT * FROM leagues WHERE id = ?', L.id);
    const cfg = await getLeagueSeasonConfig(env, L.id, 'S1');
    await sendLeagueReminderKind(env, leagueRow, cfg, await ev(eid), 'reminder_72h', { drainNow: true });
    const link = /https:\/\/\S+v=in/.exec(sent.find(x => x.to === 'sa0.pk2@p229.example').text)[0];
    const page = (await (await SELF.fetch(link.replace('&v=in', ''))).text()).replace(/<script[\s\S]*?<\/script>/g, '');
    expect(page).toContain('>Thursday Oct 15 · 9 PM<');
    expect(page).toContain('>9 PM</span> – <span');
    expect(page).not.toMatch(/>jeudi|playing thursday/);
  });

  // K3 (an admin putting a Castors player in Lynx v Loups) is not changed:
  // an admin may put a regular in another team's game on purpose (a fill-in;
  // test/part165 relies on it).
});

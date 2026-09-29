// Leagues unlike SMBHL, each driven through a whole season the way it
// really runs (test/support/league_season.js): the admin sets it up
// through the product's routes, the cron runs every hour, players answer
// the links in their emails (some out, some never, one sub declines, one
// confirmed player drops out from the 12h email), the admin enters scores
// and stats, and one game is cancelled. What must hold in every one:
//   - no pass fails and no Worker error is logged;
//   - reminders and details go only to the players of the two teams in a
//     fixed-teams game; details only to confirmed players;
//   - subs are called only for, and placed only on, a team in the game,
//     and only on this league's own teams;
//   - nothing is sent twice, and nothing about a game after it is cancelled;
//   - every admin page and the public page render (200, no undefined/NaN).
// Found this way and fixed (their own tests: part153): placement and the
// extra invite read SMBHL's season config; a cancel left its mail queued;
// the late-reversal alert (": Name", roster team, "subs invited" always);
// "Team Tous". Behaviour still waiting on a decision is pinned here as it
// is today, marked DECISION PENDING, so changing it is deliberate.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { H, DAY, local, mail, installMailCapture, removeMailCapture, linksIn, admin, must, pass, answer, rows, one } from './support/league_season.js';

const START = Date.UTC(2026, 9, 5, 16, 0); // Mon 2026-10-05 12:00 Toronto

beforeAll(async () => {
  env.LEAGUE_PRODUCT = 'true';
  env.RESEND_API_KEY = 'x'; env.RSVP_SECRET = 'p152'; env.AUTH_SECRET = 'p152-auth';
  env.MAIL_DAILY_CAP = '';
  env.PUBLIC_URL = 'https://rsvp.example.com';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(START));
  await applyRealSchema(env);
  installMailCapture();
});
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

const startMs = ev => Date.parse(`${ev.date}T${ev.start_time}:00-04:00`);
const kindOf = m => /as-tu décidé|have you decided|Rappel|reminder/i.test(m.subject) ? 'remind'
  : /détails|details/i.test(m.subject) ? 'details'
  : linksIn(m, '/avail').length ? 'subcall' : 'other';

async function runSeason(fx) {
  vi.setSystemTime(new Date(fx.start || START));
  const T0 = fx.start || START;
  const a = await admin(fx.tag);
  const created = await must(a.post('/leagues/create', { name: `F ${fx.tag}`, teamStructure: fx.structure, teamNames: fx.teams, tracksStats: fx.tracksStats !== false, ...(fx.create || {}) }), 'create');
  const leagueId = created.league.id;
  await must(a.post('/league/season/publish', { season_name: 'S1', ...(fx.publish || {}) }), 'publish');
  await must(a.post('/league/reminders/settings', fx.reminders || { reminder72h: true, reminder24h: true, reminder12h: true }), 'reminders');
  const players = [];
  for (const p of fx.players) {
    const r = await a.post('/league/contacts', { name: p.name, email: p.email, team: p.team || '', role: p.role || 'roster', ...(p.goalie ? { is_goalie: true } : {}) });
    if (r.status !== 200) { players.push({ ...p, id: null, createError: JSON.stringify(r.json).slice(0, 200) }); continue; }
    players.push({ ...p, id: r.json.contact ? r.json.contact.player_id : null });
  }
  const first = local(T0 + 8 * DAY).date;
  for (const t of fx.times) await must(a.post('/league/events/bulk', { startDate: first, occurrences: fx.weeks, start_time: t, venue: 'Gym', season: 'S1' }), 'events ' + t);
  const setupNotes = [];
  if (fx.structure === 'fixed' && fx.matchups !== false) {
    const m = await a.post('/league/season/matchups-confirm', { mode: 'fill_blanks' });
    setupNotes.push(`matchups-confirm ${m.status} ${m.json ? JSON.stringify({ ok: m.json.ok, updated: m.json.updatedCount, err: m.json.errorKey, dist: m.json.distribution && m.json.distribution.case, warn: m.json.distribution && m.json.distribution.warnings }).slice(0, 300) : ''}`);
  }
  if (fx.setup) setupNotes.push(...((await fx.setup({ a, leagueId, players })) || []));
  let events = await rows(`SELECT * FROM events WHERE league_id = ? ORDER BY date, start_time`, leagueId);
  const answered = new Set();
  const problems = [];
  let lastGame = Math.max(...events.map(startMs));
  const scored = new Set(); let resultsOff = false; const lateDone = new Set(); const lateOuts = new Set(); const cancelled = new Map();
  const mailStart = mail.sent.length;
  let seen = mail.sent.length;
  for (let t = T0 + H; t <= lastGame + 6 * H; t += H) {
    if (fx.during) { const n = await fx.during({ a, leagueId, t, players }); if (n) { setupNotes.push(...n); events = await rows(`SELECT * FROM events WHERE league_id = ? ORDER BY date, start_time`, leagueId); lastGame = Math.max(...events.map(startMs)); } }
    if (fx.cancel && !cancelled.size) {
      const ev = events[fx.cancel.index];
      if (ev && startMs(ev) - fx.cancel.hoursBefore * H <= t) {
        const pending = (await one('SELECT count(*) n FROM outbox WHERE event_id = ? AND sent_at IS NULL AND cancelled = 0', ev.id)).n;
        const r = await a.post('/league/events/cancel', { event_id: ev.id });
        cancelled.set(ev.id, t);
        events = await rows(`SELECT * FROM events WHERE league_id = ? ORDER BY date, start_time`, leagueId);
        setupNotes.push(`cancelled ${ev.date} ${ev.start_time} ${fx.cancel.hoursBefore}h before: ${r.status}, ${pending} unsent at the time, response ${JSON.stringify(r.json).slice(0, 120)}`);
      }
    }
    const p = await pass(t);
    const failed = p.logs.filter(l => /FAILED|pass failed|check failed/.test(l));
    if (p.errors.length || failed.length) problems.push(`${new Date(t).toISOString()} errors=${JSON.stringify(p.errors.slice(0, 2)).slice(0, 400)} failed=${JSON.stringify(failed.slice(0, 2)).slice(0, 300)}`);
    const fresh = mail.sent.slice(seen); seen = mail.sent.length;
    for (const m of fresh) {
      const who = players.find(x => x.email === m.to);
      if (!who) continue;
      if (kindOf(m) === 'details' && fx.lateOut && fx.lateOut(who)) {
        const out = linksIn(m, '/league/rsvp').find(l => new URL(l).searchParams.get('v') === 'out');
        const evId = out && new URL(out).searchParams.get('e');
        if (out && !lateDone.has(evId)) {
          lateDone.add(evId); lateOuts.add(evId + '|' + who.email);
          const adminBefore = mail.sent.filter(x => x.to === `admin.${fx.tag}@example.com`).length;
          const callsBefore = (await one("SELECT count(*) n FROM outbox WHERE event_id = ? AND kind = 'sub_call'", evId)).n;
          const r = await answer(out);
          const adminAfter = mail.sent.filter(x => x.to === `admin.${fx.tag}@example.com`).length;
          const callsAfter = (await one("SELECT count(*) n FROM outbox WHERE event_id = ? AND kind = 'sub_call'", evId)).n;
          const st = await one('SELECT status FROM rsvp WHERE event_id = ? AND player_id = ?', evId, who.id);
          setupNotes.push(`late out by ${who.name} for ${evId.slice(-10)}: ${r.postRes.status}, status now ${st && st.status}, admin alerts +${adminAfter - adminBefore}, sub calls +${callsAfter - callsBefore}`);
        }
        continue;
      }
      for (const link of [...linksIn(m, '/league/rsvp'), ...linksIn(m, '/avail')]) {
        const u = new URL(link);
        const v = u.searchParams.get('v') || u.searchParams.get('a');
        if (!v) continue;
        const key = `${u.searchParams.get('e')}:${who.email}`;
        if (answered.has(key)) continue;
        const want = fx.answer ? fx.answer(who, u) : 'in';
        if (!want) continue;
        if ((v === 'in' || v === 'yes') !== (want === 'in')) continue;
        const r = await answer(link);
        answered.add(key);
        if (r.postRes.status !== 303 && !(u.pathname === '/avail' && r.postRes.status === 200)) problems.push(`${new Date(t).toISOString()} answer ${u.pathname} v=${v} -> ${r.postRes.status} ${r.finalHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
    for (const ev of events) {
      if (fx.score !== false && !resultsOff && ev.state !== 'cancelled' && !scored.has(ev.id) && startMs(ev) + 2 * H <= t) {
        scored.add(ev.id);
        const r = await a.post('/league/events/score', { event_id: ev.id, home_score: 3, away_score: 2 });
        if (r.json && r.json.errorKey === 'RESULTS_NOT_TRACKED') { resultsOff = true; setupNotes.push('results not tracked (score refused, as designed)'); continue; }
        if (r.status === 200 && fx.stats) {
          const ins = await rows("SELECT r.player_id, r.team FROM rsvp r WHERE r.event_id = ? AND r.status = 'in' AND r.role != 'sub' ORDER BY r.player_id", ev.id);
          const entries = [];
          for (const team of [ev.home_team, ev.away_team].filter(Boolean)) { const p0 = ins.find(x => x.team === team); if (p0) entries.push({ player_id: p0.player_id, role: 'skater', goals: 1, assists: 1 }); }
          const sr = await a.post('/league/events/player-stats', { event_id: ev.id, entries });
          if (sr.status !== 200) problems.push(`${new Date(t).toISOString()} player-stats ${ev.id.slice(-14)} -> ${sr.status} ${JSON.stringify(sr.json).slice(0, 200)}`);
        }
        if (r.status !== 200) problems.push(`${new Date(t).toISOString()} score ${ev.id.slice(-14)} -> ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
      }
    }
  }
  events = await rows(`SELECT * FROM events WHERE league_id = ? ORDER BY date, start_time`, leagueId);
  const sent = mail.sent.slice(mailStart);
  const perEvent = [];
  const games = [];
  const violations = [];
  for (const ev of events) {
    const mine = sent.filter(m => [...linksIn(m, '/league/rsvp'), ...linksIn(m, '/avail')].some(l => new URL(l).searchParams.get('e') === ev.id));
    const k = {}; for (const m of mine) k[kindOf(m)] = (k[kindOf(m)] || 0) + 1;
    const dup = {}; for (const m of mine) { const key = m.to + '|' + m.subject; dup[key] = (dup[key] || 0) + 1; }
    const dups = Object.entries(dup).filter(([, n]) => n > 1).map(([x, n]) => `${x.split('@')[0]}x${n}`);
    const rs = await rows(`SELECT r.player_id, r.team, r.status, r.role FROM rsvp r WHERE r.event_id = ?`, ev.id);
    const subs = rs.filter(r => r.role === 'sub');
    const teams = [...new Set(rs.filter(r => r.status === 'in').map(r => r.team || '∅'))].join('/');
    const byEmail = new Map(players.map(p => [p.email, p]));
    const confirmed = new Set();
    for (const r of rs.filter(x => x.status === 'in')) { const c = await one('SELECT email FROM contacts WHERE player_id = ?', r.player_id); if (c) confirmed.add(c.email); }
    const playing = ev.home_team && ev.away_team ? [ev.home_team, ev.away_team] : null;
    for (const m of mine) {
      const who = byEmail.get(m.to); const kind = kindOf(m);
      if (fx.structure === 'fixed' && playing && (kind === 'remind' || kind === 'details') && who && who.role !== 'sub_skater' && !playing.includes(who.team)) violations.push(`${ev.date} ${ev.start_time}: ${kind} to ${who.name} (team ${who.team}) for ${playing.join('v')}`);
      if (kind === 'details' && !confirmed.has(m.to) && !lateOuts.has(ev.id + '|' + m.to)) violations.push(`${ev.date} ${ev.start_time}: details to ${m.to} who is not confirmed`);
    }
    const leagueTeams = fx.structure === 'headcount' ? null : (fx.teams || []);
    for (const r of subs) {
      if (fx.structure === 'fixed' && playing && !playing.includes(r.team)) violations.push(`${ev.date} ${ev.start_time}: sub placed on ${r.team}, game is ${playing.join('v')}`);
      if (leagueTeams && leagueTeams.length && !leagueTeams.includes(r.team)) violations.push(`${ev.date} ${ev.start_time}: sub placed on ${r.team}, not a team of this league`);
    }
    if (dups.length) violations.push(`${ev.date} ${ev.start_time}: sent twice: ${dups.slice(0, 4).join(',')}`);
    games.push({ ev, kinds: k, ins: rs.filter(r => r.status === 'in').length, outs: rs.filter(r => r.status === 'out').length, subs, mine });
    perEvent.push(`${ev.date} ${ev.start_time} ${ev.season} ${ev.home_team || '-'}v${ev.away_team || '-'} ${ev.state} score=${ev.home_score ?? '-'}:${ev.away_score ?? '-'} mail=${JSON.stringify(k)} in=${rs.filter(r => r.status === 'in').length}[${teams}] out=${rs.filter(r => r.status === 'out').length} subs=${subs.map(s => s.team + ':' + s.status).join(',') || 0}${dups.length ? ' DUP=' + dups.slice(0, 4).join(',') : ''}`);
  }
  for (const [evId, at] of cancelled) {
    const after = sent.filter(m => m.at > at && [...linksIn(m, '/league/rsvp'), ...linksIn(m, '/avail')].some(l => new URL(l).searchParams.get('e') === evId));
    if (after.length) violations.push(`${after.length} email(s) about the cancelled game sent after it was cancelled: ${[...new Set(after.map(m => m.subject))].join(' ; ').slice(0, 200)}`);
    const told = sent.filter(m => m.at > at && /annul|cancel/i.test(m.subject));
    setupNotes.push(`after cancelling: ${told.length} email(s) telling anyone it is cancelled`);
  }
  const unlinked = sent.filter(m => ![...linksIn(m, '/league/rsvp'), ...linksIn(m, '/avail')].length).map(m => `${kindOf(m)}: ${m.subject}`);
  const unlinkedCounts = {}; for (const u of unlinked) unlinkedCounts[u] = (unlinkedCounts[u] || 0) + 1;
  for (const sc of await rows(`SELECT o.team, e.home_team, e.away_team, e.date, e.start_time FROM outbox o JOIN events e ON e.id = o.event_id WHERE o.league_id = ? AND o.kind = 'sub_call'`, leagueId)) {
    if (sc.home_team && sc.away_team && ![sc.home_team, sc.away_team].includes(sc.team)) violations.push(`${sc.date} ${sc.start_time}: sub call for ${sc.team}, game is ${sc.home_team}v${sc.away_team}`);
  }
  const perNight = {};
  for (const m of sent) { const l = linksIn(m, '/league/rsvp')[0]; if (!l) continue; const ev = events.find(e => e.id === new URL(l).searchParams.get('e')); if (!ev) continue; const k = m.to + '|' + ev.date; perNight[k] = (perNight[k] || 0) + 1; }
  const nightMax = Math.max(0, ...Object.values(perNight));
  const subCalls = await rows(`SELECT event_id, player_id, team, sent_at IS NOT NULL AS sent, cancelled FROM outbox WHERE league_id = ? AND kind = 'sub_call' ORDER BY id`, leagueId);
  const pages = [];
  const slugRow = await one('SELECT slug FROM leagues WHERE id = ?', leagueId);
  for (const path of ['/dashboard', '/league/schedule', '/league/roster', '/league/settings', '/league/comms', slugRow && slugRow.slug ? '/' + slugRow.slug : null].filter(Boolean)) {
    const r = await a.get(path);
    const text = r.text.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
    const bad = (text.match(/\b(undefined|NaN)\b|\[object Object\]/g) || []);
    pages.push(`${path.split('?')[0]} ${r.status}${bad.length ? ' GARBAGE=' + [...new Set(bad)].join(',') + ' «' + (text.match(/.{0,60}\b(?:undefined|NaN)\b.{0,40}/) || [''])[0].replace(/\s+/g, ' ') + '»' : ''}`);
  }
  const samples = [];
  const seenKinds = new Set();
  for (const m of sent) {
    const k = kindOf(m) + (/(Sub)/.test(m.to) || /\.sub\d/.test(m.to) ? '(sub)' : '');
    if (seenKinds.has(k)) continue; seenKinds.add(k);
    samples.push(`[${k}] ${m.subject} :: ${m.text.replace(/https?:\/\/\S+/g, '<link>').replace(/\s+/g, ' ').slice(0, 420)}`);
  }
  let standings = '';
  if (slugRow && slugRow.slug) {
    const pub = await a.get('/' + slugRow.slug);
    const sec = (pub.text.match(/<section id="standings"[\s\S]*?<\/section>/) || [''])[0];
    standings = sec.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    const lead = (pub.text.match(/<section id="(?:leaders|players|stats)"[\s\S]*?<\/section>/) || [''])[0];
    standings += ' || ' + lead.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  return { games, sent, cancelled, samples, standings, violations, nightMax, leagueId, players: players.filter(p => p.createError).map(p => `${p.name}: ${p.createError}`), setupNotes, perEvent, unlinked: Object.entries(unlinkedCounts).map(([s, n]) => `${n}x ${s}`), subCalls: subCalls.map(s => `${s.event_id.slice(-10)} ${s.player_id.slice(-5)} ${s.team} sent=${s.sent} c=${s.cancelled}`), problems, pages, totalMail: sent.length };
}

function roster(prefix, n, { teams = null, goalies = 0, subs = 0, role = 'roster' } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ name: `${prefix} P${i}`, email: `${prefix.toLowerCase()}.p${i}@example.com`, team: teams ? teams[i % teams.length] : '', goalie: i < goalies, role });
  for (let i = 0; i < subs; i++) out.push({ name: `${prefix} Sub${i}`, email: `${prefix.toLowerCase()}.sub${i}@example.com`, role: 'sub_skater' });
  return out;
}
const idx = who => Number((who.email.match(/\.(?:p|sub)(\d+)@/) || [0, 0])[1]);
// Every k-th player out, one in six never answers, Sub0 declines.
const outEvery = k => (who) => (/Sub/.test(who.name) ? (idx(who) === 0 ? 'out' : 'in') : idx(who) % 6 === 5 ? null : (idx(who) % k === k - 1 ? 'out' : 'in'));

const FIXTURES = {
  pickup: {
    tag: 'pickup', structure: 'weekly_draw', teams: ['Dark', 'Light'], weeks: 3, times: ['20:30', '21:30'],
    players: roster('Pick', 12, { goalies: 2, subs: 3 }), answer: outEvery(2), lateOut: who => idx(who) === 0,
    reminders: { reminder72h: true, reminder24h: true, reminder12h: true, autoDrawEnabled: true }
  },
  noteams: {
    tag: 'noteams', structure: 'headcount', teams: [], weeks: 3, times: ['19:00'], create: { minPlayers: 10, maxPlayers: 12, minGoalies: 0 },
    players: roster('Head', 12), answer: outEvery(4)
  },
  three: {
    tag: 'three', structure: 'fixed', teams: ['Red', 'Blue', 'Green'], weeks: 3, times: ['20:30', '21:30'],
    players: roster('Tri', 21, { teams: ['Red', 'Blue', 'Green'], goalies: 3, subs: 4 }), answer: outEvery(3), stats: true, lateOut: who => idx(who) === 1, cancel: { index: 3, hoursBefore: 30 }
  },
  oneteam: {
    tag: 'oneteam', structure: 'fixed', teams: ['Solo', 'Other'], weeks: 3, times: ['19:00'], matchups: false,
    players: roster('One', 8, { teams: ['Solo'] }),
    setup: async ({ a }) => { const r = await a.post('/league/settings/teams', { teamNames: ['Solo'] }); return [`settings/teams -> one team: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`]; }
  },
  allsubs: {
    tag: 'allsubs', structure: 'fixed', teams: ['Red', 'Blue'], weeks: 3, times: ['19:00'],
    players: roster('Subby', 0, { subs: 10 })
  },
  remindersoff: {
    tag: 'remoff', structure: 'fixed', teams: ['Red', 'Blue'], weeks: 3, times: ['19:00'],
    players: roster('Quiet', 10, { teams: ['Red', 'Blue'], subs: 2 }), answer: outEvery(2),
    reminders: { reminder72h: false, reminder24h: false, reminder12h: false }
  },
  rollover: {
    tag: 'rollover', structure: 'fixed', teams: ['Red', 'Blue'], weeks: 4, times: ['19:00'],
    players: roster('Roll', 12, { teams: ['Red', 'Blue'], goalies: 2, subs: 2 }), answer: outEvery(5), stats: true,
    during: async ({ a, t }) => {
      if (t !== START + 14 * DAY) return null;
      const notes = [];
      const p = await a.post('/league/season/publish', { season_name: 'S2' });
      notes.push(`publish S2 mid-season: ${p.status} ${JSON.stringify(p.json).slice(0, 200)}`);
      const e = await a.post('/league/events/bulk', { startDate: local(START + 40 * DAY).date, occurrences: 2, start_time: '19:00', venue: 'Gym', season: 'S2' });
      notes.push(`S2 events: ${e.status} ${JSON.stringify(e.json && { ok: e.json.ok, n: e.json.results && e.json.results.length, st: e.json.results && e.json.results.map(x => x.status) }).slice(0, 200)}`);
      const m = await a.post('/league/season/matchups-confirm', { mode: 'fill_blanks' });
      notes.push(`S2 matchups: ${m.status} ${JSON.stringify(m.json && { ok: m.json.ok, updated: m.json.updatedCount, err: m.json.errorKey }).slice(0, 160)}`);
      return notes;
    }
  }
};

// Everything that must hold in every league, whatever its shape.
function common(r) {
  expect(r.players, 'contacts created').toEqual([]);
  expect(r.problems, 'pass errors, failed answers, failed scores').toEqual([]);
  expect(r.violations).toEqual([]);
  for (const p of r.pages) expect(p, 'page renders').toMatch(/ 200$/);
}
const sumKind = (r, k) => r.games.reduce((a, g) => a + (g.kinds[k] || 0), 0);

describe('Leagues unlike SMBHL, a whole season each', () => {
  it('PICKUP, weekly draw, two games a night', async () => {
    const r = await runSeason(FIXTURES.pickup);
    common(r);
    for (const g of r.games) {
      expect([g.ev.home_team, g.ev.away_team]).toEqual(['Dark', 'Light']); // the auto-draw ran
      expect(g.ev.home_score).toBe(3);
      expect(g.kinds.remind).toBeGreaterThan(0);
    }
    // DECISION PENDING: two games a night are two events -- two RSVPs and
    // two sets of mail per player per night (4 emails), subjects alike.
    expect(r.nightMax).toBe(4);
    // DECISION PENDING: a pickup league never calls subs (no team is short
    // before the draw, and the check does not run after it).
    expect(r.subCalls).toEqual([]);
    // The late-reversal alert names the drawn team and claims no sub call.
    const alerts = r.sent.filter(m => /dropped out/.test(m.subject));
    expect(alerts.length).toBeGreaterThan(0);
    for (const m of alerts) { expect(m.subject).toMatch(/^(Dark|Light): Pick P0/); expect(m.text).not.toMatch(/Subs invited/); }
  }, 900000);

  it('NO TEAMS, one game a night, 12 players and no subs', async () => {
    const r = await runSeason(FIXTURES.noteams);
    common(r);
    expect(r.setupNotes).toContain('results not tracked (score refused, as designed)');
    expect(r.subCalls).toEqual([]);
    for (const g of r.games) { expect(g.kinds.remind).toBeGreaterThan(0); expect(g.kinds.details).toBe(g.ins); }
    for (const m of r.sent) expect(m.text).not.toMatch(/Tous/);
    // DECISION PENDING: short of its 10-player minimum (8 in) with no subs,
    // and nobody -- the admin included -- is told.
    expect(r.games.every(g => g.ins < 10)).toBe(true);
    expect(r.sent.filter(m => m.to.startsWith('admin.'))).toEqual([]);
  }, 900000);

  it('FIXED, THREE teams, two games a night (partly avoidable double games)', async () => {
    const r = await runSeason(FIXTURES.three);
    common(r);
    expect(r.setupNotes.some(n => /matchups-confirm 200 .*partly_avoidable/.test(n))).toBe(true);
    const played = r.games.filter(g => g.ev.state !== 'cancelled');
    for (const g of played) expect(g.ev.home_score).toBe(3);
    // Subs only ever for, and on, Green (the short team) in Green's games.
    for (const g of r.games) for (const s of g.subs) expect([g.ev.home_team, g.ev.away_team]).toContain(s.team);
    expect(r.subCalls.length).toBeGreaterThan(0);
    // The cancelled game: nothing about it after the cancel; DECISION
    // PENDING: nobody is told it is cancelled.
    const [cancelledId] = [...r.cancelled.keys()];
    const cancelledGame = r.games.find(g => g.ev.id === cancelledId);
    expect(cancelledGame.ev.state).toBe('cancelled');
    expect(r.setupNotes).toContain('after cancelling: 0 email(s) telling anyone it is cancelled');
    // Standings and leaders from the results and stats entered.
    expect(r.standings).toMatch(/Classement/);
    for (const t of ['Red', 'Blue', 'Green']) expect(r.standings).toContain(t);
    expect(r.standings).toMatch(/Meilleurs pointeurs Joueur Buts Passes Points Tri P/);
  }, 900000);

  it('ONE team, no matchups: refused (at least two teams), so the closest league plays a phantom team', async () => {
    const r = await runSeason(FIXTURES.oneteam);
    common(r);
    // DECISION PENDING: a single-team club cannot be set up as teams at all.
    expect(r.setupNotes.some(n => /settings\/teams -> one team: 400 .*MIN_TEAM_NAMES/.test(n))).toBe(true);
    for (const g of r.games) expect(g.kinds.details).toBe(8);
  }, 900000);

  it('EVERY player a sub, none regular', async () => {
    const r = await runSeason(FIXTURES.allsubs);
    common(r);
    expect(sumKind(r, 'remind')).toBe(0); // subs get no roster reminders
    for (const g of r.games) {
      expect(g.subs).toHaveLength(10);
      expect(new Set(g.subs.map(s => s.team))).toEqual(new Set([g.ev.home_team, g.ev.away_team]));
      expect(g.kinds.details).toBe(10);
    }
  }, 900000);

  it('REMINDERS OFF entirely', async () => {
    const r = await runSeason(FIXTURES.remindersoff);
    common(r);
    // DECISION PENDING: nothing at all is sent -- no reminders, no details,
    // and no sub calls (unanswered players count as available).
    expect(r.totalMail).toBe(0);
    for (const g of r.games) expect(g.ev.home_score).toBe(3);
  }, 900000);

  it('MID-SEASON, a second season published and scheduled', async () => {
    const r = await runSeason(FIXTURES.rollover);
    common(r);
    expect(r.setupNotes.some(n => /publish S2 mid-season: 200/.test(n))).toBe(true);
    const s1 = r.games.filter(g => g.ev.season === 'S1'), s2 = r.games.filter(g => g.ev.season === 'S2');
    expect(s1).toHaveLength(4); expect(s2).toHaveLength(2);
    for (const g of [...s1, ...s2]) { expect(g.kinds.remind).toBeGreaterThan(0); expect(g.ev.home_score).toBe(3); }
    // The public page shows the current season (S2): two games each.
    expect(r.standings).toMatch(/Red 2 /);
    expect(r.standings).toMatch(/Blue 2 /);
  }, 900000);
});

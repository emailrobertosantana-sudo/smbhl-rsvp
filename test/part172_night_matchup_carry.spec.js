// D1 (nights), decided 2026-09-30, revised: a player answers for the
// NIGHT; which game their team plays is the schedule's. When a matchup
// changes, the team's answers move with it -- so Blue, who said yes for
// Thursday and is moved from 10:30 to 11:30, is still in, not "no reply"
// and chased. The players whose time changed are told, but ONLY if they
// had already been told about the night (an ask or details email went
// out); with nothing sent yet, there is nothing to correct.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { H, DAY, local, mail, installMailCapture, removeMailCapture, linksIn, admin, must, pass, rows, one, answer } from './support/league_season.js';

const START = Date.UTC(2026, 9, 5, 16, 0); // Mon 2026-10-05 12:00 Toronto
const GAME_DAY = local(START + 5 * DAY).date; // Sat 2026-10-10
const FIRST = Date.parse(`${GAME_DAY}T10:30:00-04:00`);

beforeAll(async () => {
  env.LEAGUE_PRODUCT = 'true';
  env.RESEND_API_KEY = 'x'; env.RSVP_SECRET = 'p172'; env.AUTH_SECRET = 'p172-auth';
  env.MAIL_DAILY_CAP = '';
  env.PUBLIC_URL = 'https://rsvp.example.com';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(START));
  await applyRealSchema(env);
  installMailCapture();
});
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

const TEAMS = ['Blue', 'Red', 'Green', 'Yellow'];
async function league(tag, date) {
  const a = await admin(tag);
  await must(a.post('/leagues/create', { name: 'Carry ' + tag, teamNames: TEAMS }), 'create');
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  await must(a.post('/league/reminders/settings', { reminder72h: true, reminder24h: true, reminder12h: true }), 'reminders');
  const players = {};
  for (const team of TEAMS) {
    for (const i of [1, 2]) {
      const email = `${tag}.${team.toLowerCase()}${i}@example.com`;
      players[`${team}${i}`] = { ...(await must(a.post('/league/contacts', { name: `${team} Player${i}`, email, role: 'roster', team }), 'contact')).contact, email };
    }
  }
  const X = (await must(a.post('/league/events', { date, season: 'S1', venue: 'Rink 1', start_time: '10:30', end_time: '11:30', home_team: 'Blue', away_team: 'Red' }), 'X')).event;
  const Y = (await must(a.post('/league/events', { date, season: 'S1', venue: 'Rink 1', start_time: '11:30', end_time: '12:30', home_team: 'Green', away_team: 'Yellow' }), 'Y')).event;
  // Move Blue from 10:30 to 11:30 and Green the other way, one game at a time.
  const move = async () => {
    await must(a.post('/league/events/matchup', { event_id: Y.id, home_team: 'Blue', away_team: 'Yellow' }), 'Y');
    await must(a.post('/league/events/matchup', { event_id: X.id, home_team: 'Green', away_team: 'Red' }), 'X');
  };
  return { a, players, X, Y, move };
}
const statusOf = async (ev, p) => { const r = await one('SELECT status FROM rsvp WHERE event_id = ? AND player_id = ?', ev.id, p.player_id); return r ? r.status : null; };
const countedIn = async (ev, team) => (await rows("SELECT player_id FROM rsvp WHERE event_id = ? AND status = 'in' AND team = ?", ev.id, team)).length;

describe('A changed matchup carries the answers', () => {
  it('after the asks went out: Blue\'s yes moves to 11:30, and Blue and Green are told once each; Red and Yellow are not', async () => {
    const { players: P, X, Y, move } = await league('told', GAME_DAY);
    await pass(FIRST - 70 * H);
    const ask = p => mail.sent.find(m => m.to === p.email && /have you decided/.test(m.subject));
    for (const k of Object.keys(P)) expect(ask(P[k])).toBeTruthy();
    const yes = p => linksIn(ask(p), '/league/rsvp').find(l => new URL(l).searchParams.get('v') === 'in');
    const no = p => linksIn(ask(p), '/league/rsvp').find(l => new URL(l).searchParams.get('v') === 'out');
    await answer(yes(P.Blue1));
    await answer(yes(P.Green1));
    await answer(no(P.Green2));
    expect(await statusOf(X, P.Blue1)).toBe('in');

    const seen = mail.sent.length;
    await move();
    // The answers moved with the teams.
    expect(await statusOf(Y, P.Blue1)).toBe('in');
    expect(await countedIn(Y, 'Blue')).toBe(1);
    expect(await statusOf(X, P.Green1)).toBe('in');
    expect(await statusOf(X, P.Green2)).toBe('out');
    expect(await statusOf(Y, P.Blue2)).toBe(null); // never answered: still no reply
    // Told a few minutes later, once, with the night as it ended up.
    expect(mail.sent.length).toBe(seen);
    await pass(Date.now() + 15 * 60000);
    const told = mail.sent.slice(seen).filter(m => /new schedule/.test(m.subject));
    expect(told.map(m => m.to).sort()).toEqual([P.Blue1.email, P.Blue2.email, P.Green1.email].sort()); // Green2 said no
    const blue1 = told.find(m => m.to === P.Blue1.email);
    expect(blue1.text).toContain('Blue now plays: Sat Oct 10 · 11:30 AM · Rink 1.');
    expect(blue1.text).toContain('Blue joue maintenant : Sam 10 oct. · 11 h 30 · Rink 1.');
    expect(blue1.text).toContain("Your answer carries over: you're still playing. Nothing to do.");
    expect(told.find(m => m.to === P.Blue2.email).text).toContain('We still need your answer.');
    expect(told.find(m => m.to === P.Green1.email).text).toContain('10:30 AM');

    // The 24h ask does not chase Blue1 for the game they already agreed to.
    const before24 = mail.sent.length;
    await pass(FIRST - 23.5 * H);
    const last = mail.sent.slice(before24).filter(m => /last reminder/.test(m.subject)).map(m => m.to);
    expect(last).not.toContain(P.Blue1.email);
    expect(last).toContain(P.Blue2.email);
  });

  it('before anything was sent: the answers still move, and no one is emailed', async () => {
    const later = local(START + 20 * DAY).date;
    const { players: P, X, Y, move } = await league('untold', later);
    // Blue1 answers from their own page (no email has gone out).
    const lgId = X.id.split(':')[0];
    const salt = (await one('SELECT token_salt FROM contacts WHERE player_id = ?', P.Blue1.player_id)).token_salt;
    const { hmac } = await import('../src/crypto_utils.js');
    const t = await hmac(env.RSVP_SECRET, `lr:${lgId}:${X.id}:${P.Blue1.player_id}:${salt}`);
    const r = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(lgId)}&e=${encodeURIComponent(X.id)}&p=${encodeURIComponent(P.Blue1.player_id)}&t=${t}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'in' }) });
    expect(r.status).toBe(200);
    const seen = mail.sent.length;
    await move();
    expect(await statusOf(Y, P.Blue1)).toBe('in');
    await pass(Date.now() + 15 * 60000);
    const mine = Object.values(P).map(p => p.email);
    expect(mail.sent.slice(seen).filter(m => mine.includes(m.to))).toEqual([]);
    expect(await one("SELECT 1 AS x FROM outbox WHERE kind = 'night_moved' AND event_id IN (?, ?)", X.id, Y.id)).toBeNull();
  });

  it('a new opponent at the same time is not a time change: no email', async () => {
    const date = local(START + 30 * DAY).date; // a night of its own, after the others
    const { a, players: P, X } = await league('samehour', date);
    await pass(Date.parse(`${date}T10:30:00-04:00`) - 70 * H);
    const seen = mail.sent.length;
    // Red is swapped for Yellow at 10:30; Yellow's time changes, Blue's does not.
    await must(a.post('/league/events/matchup', { event_id: X.id, home_team: 'Blue', away_team: 'Yellow' }), 'swap');
    await pass(Date.now() + 15 * 60000);
    const told = mail.sent.slice(seen).filter(m => /new schedule/.test(m.subject)).map(m => m.to);
    expect(told).not.toContain(P.Blue1.email);
    expect(told).toContain(P.Yellow1.email);
  });
});

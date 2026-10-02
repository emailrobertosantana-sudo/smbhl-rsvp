// D1 (nights), decided 2026-09-30: no player, sub or draw may end up in two
// games that overlap. Overlap comes from the games' times
// (src/league_nights.js); every route that puts someone IN a game checks
// it -- the admin's answer for a player, a sub accepting a call, the sub
// call itself and the waitlist -- and an edit may not create one, by time
// or by matchup. (The player's own answer is the night's, part166.)
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must, one, rows } from './support/league_season.js';
import { hmac } from '../src/crypto_utils.js';
import { gamesOverlap, concurrencyClusters, gameInterval } from '../src/league_nights.js';
import { groupNights, getLeagueSeasonConfig } from '../src/leagues.js';
import { fillFromWaitlist } from '../src/index.js';

beforeAll(async () => { env.AUTH_SECRET = 'p165'; env.RSVP_SECRET = 'p165r'; await applyRealSchema(env); });

const g = (id, start_time, end_time, date = '2099-05-05') => ({ id, date, start_time, end_time });

describe('Which games overlap', () => {
  it('same time overlaps; back to back does not; an end past midnight is the next day', () => {
    expect(gamesOverlap(g('a', '10:30', '11:30'), g('b', '10:30', '11:30'))).toBe(true);
    expect(gamesOverlap(g('a', '10:00', '11:00'), g('b', '10:30', '11:30'))).toBe(true);
    expect(gamesOverlap(g('a', '10:30', '11:30'), g('b', '11:30', '12:30'))).toBe(false);
    expect(gamesOverlap(g('a', '23:30', '00:30'), g('b', '00:00', '01:00'))).toBe(false); // b is early that same date, not after a
    expect(gamesOverlap(g('a', '22:30', '00:30'), g('b', '23:30', '00:15'))).toBe(true);
    expect(gameInterval(g('a', '23:30', '00:30'))).toEqual({ start: 1410, end: 1470 });
    expect(gamesOverlap(g('a', '10:30', '11:30'), g('b', '10:30', '11:30', '2099-05-06'))).toBe(false);
  });
  it('a game with no end time (made before they were required) overlaps only one that starts at the same time', () => {
    expect(gamesOverlap(g('a', '10:30', null), g('b', '10:30', '11:30'))).toBe(true);
    expect(gamesOverlap(g('a', '10:30', null), g('b', '10:45', '11:30'))).toBe(false);
    expect(gamesOverlap(g('a', null, null), g('b', '10:30', '11:30'))).toBe(false);
  });
  it('clusters: overlap chains into one cluster; back-to-back games are separate clusters, in time order', () => {
    const c = concurrencyClusters([g('d', '12:30', '13:30'), g('b', '10:30', '11:30'), g('a', '10:00', '11:00'), g('c', '11:15', '12:00')]);
    expect(c.map(x => x.map(y => y.id))).toEqual([['a', 'b', 'c'], ['d']]);
    const smbhl = concurrencyClusters([g('s1', '10:30', '11:30'), g('s2', '10:30', '11:30'), g('s3', '11:30', '12:30'), g('s4', '11:30', '12:30')]);
    expect(smbhl.map(x => x.map(y => y.id))).toEqual([['s1', 's2'], ['s3', 's4']]);
  });
  it('the matchup planner treats overlapping games as concurrent, not only the same start', () => {
    const [n] = groupNights([g('x', '10:00', '11:00'), g('y', '10:30', '11:30'), g('z', '11:30', '12:30')]);
    expect(n.groupOf).toEqual([0, 0, 1]);
    const [legacy] = groupNights([g('x', '10:30', null), g('y', '10:30', null), g('z', '11:30', null)]);
    expect(legacy.groupOf).toEqual([0, 0, 1]);
  });
});

async function fixedLeague(tag) {
  const a = await admin(tag);
  const lg = (await must(a.post('/leagues/create', { name: 'Overlap ' + tag, teamNames: ['Bears', 'Otters', 'Wolves', 'Owls'] }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  let rink = 0; // games at the same time are on different ice
  const game = async (start_time, end_time, home_team, away_team) => (await must(a.post('/league/events', { date: '2099-05-05', season: 'S1', venue: 'Rink ' + (++rink), start_time, end_time, ...(home_team ? { home_team, away_team } : {}) }), 'game')).event;
  const player = async (name, extra = {}) => (await must(a.post('/league/contacts', { name, email: name.toLowerCase().replace(/ /g, '.') + '@example.com', role: 'roster', ...extra }), 'contact')).contact;
  return { a, lg, game, player };
}

describe('The admin can\'t put a player in two games at once', () => {
  it('in A at 10:30, in B at 10:30 is refused (409, FR/EN), in C at 11:30 is fine', async () => {
    const { a, game, player } = await fixedLeague('p165admin');
    const A = await game('10:30', '11:30', 'Bears', 'Otters');
    const B = await game('10:30', '11:30', 'Wolves', 'Owls');
    const C = await game('11:30', '12:30', 'Bears', 'Wolves');
    const p = await player('Ann Two', { team: 'Bears' });
    await must(a.post('/league/rsvp/admin', { event_id: A.id, player_id: p.player_id, status: 'in' }), 'in A');
    const r = await a.post('/league/rsvp/admin', { event_id: B.id, player_id: p.player_id, status: 'in' });
    expect([r.status, r.json.errorKey]).toEqual([409, 'PLAYER_IN_OVERLAPPING_GAME']);
    expect(await one('SELECT status FROM rsvp WHERE event_id = ? AND player_id = ?', B.id, p.player_id)).toBeNull();
    await must(a.post('/league/rsvp/admin', { event_id: C.id, player_id: p.player_id, status: 'in' }), 'in C');
    // Out of A first, then B is fine.
    await must(a.post('/league/rsvp/admin', { event_id: A.id, player_id: p.player_id, status: 'out' }), 'out A');
    await must(a.post('/league/rsvp/admin', { event_id: B.id, player_id: p.player_id, status: 'in' }), 'in B');
    const errs = JSON.parse((await a.get('/league/schedule')).text.match(/window\.__ERROR_I18N = (\{[\s\S]*?\});/)[1]);
    expect(errs.PLAYER_IN_OVERLAPPING_GAME).toEqual({ fr: "Ce joueur est déjà inscrit à un match qui se joue en même temps. Retire-le de ce match d'abord.", en: 'This player is already in a game at the same time. Take them out of that game first.' });
  });
});

describe('Subs: a call, an acceptance, the waitlist', () => {
  it('a sub placed in A is not called for B, and accepting B anyway is refused with nothing recorded', async () => {
    const { a, lg, game } = await fixedLeague('p165subs');
    const A = await game('10:30', '11:30', 'Bears', 'Otters');
    const B = await game('10:30', '11:30', 'Wolves', 'Owls');
    const sub = (await must(a.post('/league/contacts', { name: 'Sam Sub', email: 'sam.sub@example.com', role: 'sub_skater' }), 'sub')).contact;
    const free = (await must(a.post('/league/contacts', { name: 'Fay Free', email: 'fay.free@example.com', role: 'sub_skater' }), 'sub2')).contact;
    const salt = (await one('SELECT token_salt FROM contacts WHERE player_id = ?', sub.player_id)).token_salt;
    const availUrl = async ev => `http://example.com/avail?e=${encodeURIComponent(ev.id)}&p=${encodeURIComponent(sub.player_id)}&n=skater&t=${await hmac(env.RSVP_SECRET, `a:${ev.id}:${sub.player_id}:skater:${salt}`)}`;
    const accept = async ev => SELF.fetch(await availUrl(ev), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=yes' });

    const inA = await (await accept(A)).text();
    expect(inA).toMatch(/Tu es dans l(&#39;|')équipe/);
    expect((await one('SELECT status FROM rsvp WHERE event_id = ? AND player_id = ?', A.id, sub.player_id)).status).toBe('in');

    // The call for B goes to the free sub only.
    await env.DB.prepare("DELETE FROM outbox WHERE event_id = ?").bind(B.id).run();
    await must(a.post('/league/events/invite-subs', { event_id: B.id, team: 'Wolves', need: 'skater' }), 'invite');
    const called = (await rows("SELECT player_id FROM outbox WHERE event_id = ? AND kind = 'sub_call'", B.id)).map(r => r.player_id);
    expect(called).toContain(free.player_id);
    expect(called).not.toContain(sub.player_id);

    // An old link to B, accepted anyway.
    // The league's /avail page escapes apostrophes (&#39;).
    const html = (await (await accept(B)).text()).replace(/&#39;/g, "'");
    expect(html).toContain("Tu joues déjà à cette heure-là");
    expect(html).toContain("You're already playing at that time");
    expect(html).toContain('On ne peut pas te mettre dans les deux.');
    expect(html).toContain("We can't put you in both.");
    expect(await one('SELECT 1 FROM rsvp WHERE event_id = ? AND player_id = ?', B.id, sub.player_id)).toBeNull();
    expect(await one('SELECT 1 FROM availability WHERE event_id = ? AND player_id = ?', B.id, sub.player_id)).toBeNull();
    expect(lg.id).toBeTruthy();
  });

  it('the waitlist skips a sub who has since been placed in an overlapping game', async () => {
    const { a, lg, game } = await fixedLeague('p165wait');
    const A = await game('10:30', '11:30', 'Bears', 'Otters');
    const B = await game('10:30', '11:30', 'Wolves', 'Owls');
    const sub = (await must(a.post('/league/contacts', { name: 'Wes Wait', email: 'wes.wait@example.com', role: 'sub_skater' }), 'sub')).contact;
    const other = (await must(a.post('/league/contacts', { name: 'Ola Other', email: 'ola.other@example.com', role: 'sub_skater' }), 'sub')).contact;
    // Both said yes to B while it was full (waitlisted), Wes first.
    for (const [pid, at] of [[sub.player_id, '2026-01-01T00:00:00Z'], [other.player_id, '2026-01-01T00:05:00Z']])
      await env.DB.prepare(`INSERT INTO availability (event_id, player_id, need, status, answered_at, league_id) VALUES (?, ?, 'skater', 'yes', ?, ?)`).bind(B.id, pid, at, lg.id).run();
    // Wes is then placed in A.
    await must(a.post('/league/rsvp/admin', { event_id: A.id, player_id: sub.player_id, status: 'in' }), 'Wes in A');
    // A spot opens on Wolves in B: the waitlist fills it.
    const cfg = await getLeagueSeasonConfig(env, lg.id, 'S1');
    const ev = await one('SELECT * FROM events WHERE id = ?', B.id);
    expect(await fillFromWaitlist(env, ev, 'Wolves', 'skater', cfg)).toBe(true);
    expect(await one('SELECT 1 FROM rsvp WHERE event_id = ? AND player_id = ?', B.id, sub.player_id)).toBeNull();
    expect((await one('SELECT status FROM rsvp WHERE event_id = ? AND player_id = ?', B.id, other.player_id)).status).toBe('in');
  });
});

describe('An edit can\'t double-book', () => {
  it('moving a game onto another a player is in is refused, naming them (FR/EN)', async () => {
    const { a, game, player } = await fixedLeague('p165edit');
    const A = await game('10:30', '11:30', 'Bears', 'Otters');
    const C = await game('11:30', '12:30'); // no matchup yet
    const p = await player('Bea Both', { team: 'Bears' });
    await must(a.post('/league/rsvp/admin', { event_id: A.id, player_id: p.player_id, status: 'in' }), 'A');
    await must(a.post('/league/rsvp/admin', { event_id: C.id, player_id: p.player_id, status: 'in' }), 'C');
    const r = await a.post('/league/events/update', { event_id: C.id, start_time: '11:00', end_time: '12:00', venue: 'Rink 2' });
    expect([r.status, r.json.errorKey, r.json.players]).toEqual([409, 'GAME_TIME_DOUBLE_BOOKS', ['Bea Both']]);
    expect((await one('SELECT start_time FROM events WHERE id = ?', C.id)).start_time).toBe('11:30');
    await must(a.post('/league/events/update', { event_id: C.id, start_time: '11:45', end_time: '12:45', venue: 'Rink 2' }), 'later is fine');
    const errs = JSON.parse((await a.get('/league/schedule')).text.match(/window\.__ERROR_I18N = (\{[\s\S]*?\});/)[1]);
    expect(errs.GAME_TIME_DOUBLE_BOOKS).toEqual({ fr: "À cette heure, {players} seraient dans deux matchs en même temps. Retire-les d'un des deux matchs d'abord.", en: 'At this time, {players} would be in two games at once. Take them out of one of the games first.' });
    expect(errs.MATCHUP_TEAM_BUSY).toEqual({ fr: 'Une de ces équipes joue déjà un match à la même heure.', en: 'One of these teams already plays a game at the same time.' });
  });

  it('a matchup that has a team in two games at once is refused, by either route', async () => {
    const { a, game } = await fixedLeague('p165mx');
    await game('10:30', '11:30', 'Bears', 'Otters');
    const B = await game('10:30', '11:30');
    const r1 = await a.post('/league/events/matchup', { event_id: B.id, home_team: 'Bears', away_team: 'Wolves' });
    expect([r1.status, r1.json.errorKey]).toEqual([409, 'MATCHUP_TEAM_BUSY']);
    const r2 = await a.post('/league/events/update', { event_id: B.id, start_time: '10:30', end_time: '11:30', home_team: 'Wolves', away_team: 'Otters' });
    expect([r2.status, r2.json.errorKey]).toEqual([409, 'MATCHUP_TEAM_BUSY']);
    await must(a.post('/league/events/matchup', { event_id: B.id, home_team: 'Wolves', away_team: 'Owls' }), 'free teams');
    // Back to back is fine: Bears again at 11:30.
    const C = await game('11:30', '12:30');
    await must(a.post('/league/events/matchup', { event_id: C.id, home_team: 'Bears', away_team: 'Owls' }), 'back to back');
  });
});

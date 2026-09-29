// Decided 2026-09-29: a game's TIME change tells people like a matchup
// change does -- only players who had already been told about the night
// (an ask or details email went out), not those who said no, and 10
// minutes later so two edits send one email. A fixed team left with no
// game that night is told there is no game (closer to a cancellation than
// to a move), under the same rules.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { H, DAY, local, mail, installMailCapture, removeMailCapture, linksIn, admin, must, pass, one, answer } from './support/league_season.js';

const START = Date.UTC(2026, 9, 5, 16, 0); // Mon 2026-10-05 12:00 Toronto

beforeAll(async () => {
  env.LEAGUE_PRODUCT = 'true';
  env.RESEND_API_KEY = 'x'; env.RSVP_SECRET = 'p175'; env.AUTH_SECRET = 'p175-auth';
  env.MAIL_DAILY_CAP = '';
  env.PUBLIC_URL = 'https://rsvp.example.com';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(START));
  await applyRealSchema(env);
  installMailCapture();
});
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

// Each fixture is a night of its own, days apart, so the fake clock only
// moves forward.
let nth = 0;
async function night(tag, { structure = 'fixed', teams = ['Blue', 'Red', 'Green', 'Yellow'], perTeam = 2 } = {}) {
  const date = local(START + (5 + 7 * nth++) * DAY).date;
  const first = Date.parse(`${date}T19:00:00-04:00`);
  const a = await admin(tag);
  const create = structure === 'fixed' ? { teamNames: teams } : { teamStructure: 'headcount', minPlayers: 1, maxPlayers: 10, minGoalies: 0 };
  await must(a.post('/leagues/create', { name: 'Time ' + tag, ...create }), 'create');
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  await must(a.post('/league/reminders/settings', { reminder72h: true, reminder24h: true, reminder12h: true }), 'reminders');
  const P = {};
  for (const team of structure === 'fixed' ? teams : ['Pool']) {
    for (let i = 1; i <= (structure === 'fixed' ? perTeam : 3); i++) {
      const email = `${tag}.${team.toLowerCase()}${i}@example.com`;
      P[`${team}${i}`] = { ...(await must(a.post('/league/contacts', { name: `${team} Player${i}`, email, role: 'roster', ...(structure === 'fixed' ? { team } : {}) }), 'contact')).contact, email };
    }
  }
  const game = async (start_time, end_time, extra = {}) => (await must(a.post('/league/events', { date, season: 'S1', venue: 'Rink 1', start_time, end_time, ...extra }), 'game')).event;
  const edit = (ev, fields) => must(a.post('/league/events/update', { event_id: ev.id, venue: 'Rink 1', ...fields }), 'edit');
  const ask = p => mail.sent.find(m => m.to === p.email && /have you decided/.test(m.subject));
  const link = (p, v) => linksIn(ask(p), '/league/rsvp').find(l => new URL(l).searchParams.get('v') === v);
  return { a, P, date, first, game, edit, ask, link };
}
const changed = (from, P) => mail.sent.slice(from).filter(m => /new schedule|no game for/.test(m.subject)).map(m => m.to).sort();
const byTo = (from, p) => mail.sent.slice(from).find(m => m.to === p.email && /new schedule|no game for/.test(m.subject));

describe('A game moved from 7pm to 9pm', () => {
  it('fixed teams, after the asks: the players of both teams are told once, with 9 PM; not the one who said no', async () => {
    const { P, first, game, edit, ask, link } = await night('p175fixed');
    const X = await game('19:00', '20:00', { home_team: 'Blue', away_team: 'Red' });
    await pass(first - 70 * H);
    for (const k of ['Blue1', 'Blue2', 'Red1', 'Red2']) expect(ask(P[k])).toBeTruthy();
    await answer(link(P.Blue1, 'in'));
    await answer(link(P.Red1, 'out'));
    const seen = mail.sent.length;
    // Two edits within the 10 minutes: 7pm -> 8pm -> 9pm.
    await edit(X, { start_time: '20:00', end_time: '21:00', home_team: 'Blue', away_team: 'Red' });
    await edit(X, { start_time: '21:00', end_time: '22:00', home_team: 'Blue', away_team: 'Red' });
    expect(changed(seen)).toEqual([]); // not before the wait
    await pass(Date.now() + 15 * 60000);
    expect(changed(seen)).toEqual([P.Blue1.email, P.Blue2.email, P.Red2.email].sort());
    const blue1 = byTo(seen, P.Blue1);
    expect(blue1.text).toContain('Blue now plays: ');
    expect(blue1.text).toContain('9 PM');
    expect(blue1.text).not.toContain('8 PM');
    expect(blue1.text).toContain("Your answer carries over: you're still playing. Nothing to do.");
    expect(byTo(seen, P.Blue2).text).toContain('We still need your answer.');
    // Their answers stayed on the game.
    expect((await one('SELECT status FROM rsvp WHERE event_id = ? AND player_id = ?', X.id, P.Blue1.player_id)).status).toBe('in');
  });

  it('before anything was sent: no one is emailed', async () => {
    const { P, game, edit } = await night('p175untold');
    const X = await game('19:00', '20:00', { home_team: 'Blue', away_team: 'Red' });
    const seen = mail.sent.length;
    await edit(X, { start_time: '21:00', end_time: '22:00', home_team: 'Blue', away_team: 'Red' });
    await pass(Date.now() + 15 * 60000);
    expect(changed(seen)).toEqual([]);
    expect(Object.keys(P).length).toBeGreaterThan(0);
  });

  it('no teams: the player who said yes and the one who has not answered are told; the one who said no is not', async () => {
    const { P, first, game, edit, ask, link } = await night('p175pool', { structure: 'headcount' });
    const X = await game('19:00', '20:00');
    await pass(first - 70 * H);
    for (const k of ['Pool1', 'Pool2', 'Pool3']) expect(ask(P[k])).toBeTruthy();
    await answer(link(P.Pool1, 'in'));
    await answer(link(P.Pool3, 'out'));
    const seen = mail.sent.length;
    await edit(X, { start_time: '21:00', end_time: '22:00' });
    await pass(Date.now() + 15 * 60000);
    expect(changed(seen)).toEqual([P.Pool1.email, P.Pool2.email].sort());
    expect(byTo(seen, P.Pool1).text).toContain('Your game is now: ');
    expect(byTo(seen, P.Pool1).text).toContain('Ton match est maintenant : ');
    expect(byTo(seen, P.Pool1).text).toContain('9 PM');
  });

  it('a change of opponent only is still not a time change for the team that stays', async () => {
    const { P, first, game, a, ask } = await night('p175opp');
    const X = await game('19:00', '20:00', { home_team: 'Blue', away_team: 'Red' });
    await game('20:00', '21:00', { home_team: 'Green', away_team: 'Yellow' });
    await pass(first - 70 * H);
    expect(ask(P.Blue1)).toBeTruthy();
    const seen = mail.sent.length;
    await must(a.post('/league/events/matchup', { event_id: X.id, home_team: 'Blue', away_team: 'Green' }), 'swap');
    await pass(Date.now() + 15 * 60000);
    expect(changed(seen)).not.toContain(P.Blue1.email);
  });
});

describe('A team left with no game that night', () => {
  it('its players who were told, and did not say no, are told there is no game', async () => {
    const { P, first, game, a, ask, link } = await night('p175none');
    const X = await game('19:00', '20:00', { home_team: 'Blue', away_team: 'Red' });
    await pass(first - 70 * H);
    expect(ask(P.Blue1)).toBeTruthy();
    await answer(link(P.Blue1, 'in'));
    await answer(link(P.Blue2, 'out'));
    const seen = mail.sent.length;
    // Blue out, Green in: Blue has no game that night.
    await must(a.post('/league/events/matchup', { event_id: X.id, home_team: 'Green', away_team: 'Red' }), 'drop Blue');
    await pass(Date.now() + 15 * 60000);
    const told = mail.sent.slice(seen).filter(m => /no game for/.test(m.subject)).map(m => m.to);
    expect(told).toEqual([P.Blue1.email]); // Blue2 said no
    const m = byTo(seen, P.Blue1);
    expect(m.subject).toContain('no game for Blue');
    expect(m.text).toContain('Blue is no longer playing on ');
    expect(m.text).toContain('No need to come.');
    expect(m.text).toContain('Blue ne joue plus ');
    expect(m.text).toContain('Pas besoin de te présenter.');
  });

  it('put back in a game within the 10 minutes: one email, the new schedule, not "no game"', async () => {
    const { P, first, game, a, ask, link } = await night('p175back');
    const X = await game('19:00', '20:00', { home_team: 'Blue', away_team: 'Red' });
    const Y = await game('21:00', '22:00', { home_team: 'Green', away_team: 'Yellow' });
    await pass(first - 70 * H);
    await answer(link(P.Blue1, 'in'));
    const seen = mail.sent.length;
    await must(a.post('/league/events/matchup', { event_id: X.id, home_team: 'Green', away_team: 'Red' }), 'Blue out of X');
    await must(a.post('/league/events/matchup', { event_id: Y.id, home_team: 'Blue', away_team: 'Yellow' }), 'Blue into Y');
    await pass(Date.now() + 15 * 60000);
    const mine = mail.sent.slice(seen).filter(m => m.to === P.Blue1.email);
    expect(mine.length).toBe(1);
    expect(mine[0].subject).toMatch(/new schedule/);
    expect(mine[0].text).toContain('9 PM');
    expect(await one("SELECT status FROM rsvp WHERE event_id = ? AND player_id = ?", Y.id, P.Blue1.player_id)).toEqual({ status: 'in' });
    expect(ask(P.Blue1)).toBeTruthy();
  });
});

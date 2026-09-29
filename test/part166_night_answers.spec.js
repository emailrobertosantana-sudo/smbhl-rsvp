// D1 (nights), decided 2026-09-30: a league's games on the same day are a
// night. One answer per player per night, written to each game it covers;
// on their own page a player can drop one game of the night, and that
// can't put them in two games at once. Games at the same time split the
// group evenly (revised: balanced, not filled in order -- part170); games
// that follow each other take everyone. The 12h email's "can't make it" drops
// the whole night.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must, one, rows, mail, installMailCapture, removeMailCapture } from './support/league_season.js';
import { hmac } from '../src/crypto_utils.js';

beforeAll(async () => {
  env.AUTH_SECRET = 'p166'; env.RSVP_SECRET = 'p166r'; env.RESEND_API_KEY = 'p166';
  await applyRealSchema(env);
  installMailCapture();
});
afterAll(() => removeMailCapture());

const DATE = '2099-05-05';
async function league(tag, create) {
  const a = await admin(tag);
  const lg = (await must(a.post('/leagues/create', { name: 'Nights ' + tag, ...create }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  let rink = 0;
  const game = async (start_time, end_time, extra = {}) => (await must(a.post('/league/events', { date: DATE, season: 'S1', venue: 'Rink ' + (++rink), start_time, end_time, ...extra }), 'game')).event;
  const player = async (name, extra = {}) => {
    const c = (await must(a.post('/league/contacts', { name, email: name.toLowerCase().replace(/ /g, '.') + '@example.com', role: 'roster', ...extra }), 'contact')).contact;
    const salt = (await one('SELECT token_salt FROM contacts WHERE player_id = ?', c.player_id)).token_salt;
    c.qs = async ev => `league=${encodeURIComponent(lg.id)}&e=${encodeURIComponent(ev.id)}&p=${encodeURIComponent(c.player_id)}&t=${await hmac(env.RSVP_SECRET, `lr:${lg.id}:${ev.id}:${c.player_id}:${salt}`)}`;
    return c;
  };
  return { a, lg, game, player };
}
const answer = async (p, ev, status) => SELF.fetch(`http://example.com/league/rsvp?${await p.qs(ev)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
const gameAnswer = async (p, ev, game, status) => SELF.fetch(`http://example.com/league/rsvp/game?${await p.qs(ev)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ game: game.id, status }) });
const page = async (p, ev, extra = '') => (await SELF.fetch(`http://example.com/league/rsvp?${await p.qs(ev)}${extra}`)).text();
const statusOf = async (ev, p) => { const r = await one('SELECT status, status_by FROM rsvp WHERE event_id = ? AND player_id = ?', ev.id, p.player_id); return r ? (r.status === 'out' && r.status_by === 'night' ? 'elsewhere' : r.status) : null; };
const inIds = async ev => (await rows("SELECT player_id FROM rsvp WHERE event_id = ? AND status = 'in' ORDER BY player_id", ev.id)).map(r => r.player_id);
const dictOf = html => JSON.parse(html.match(/var RV_I18N = (\{[\s\S]*?\});\n/)[1]);

describe('No teams: games at the same time split the group, the next game takes everyone', () => {
  it('two games at 10:30 (max 5 each) take turns; the 11:30 game takes all five; no one is in both 10:30 games', async () => {
    const { game, player } = await league('p166pool', { teamStructure: 'headcount', minPlayers: 1, maxPlayers: 5, minGoalies: 0 });
    const A = await game('10:30', '11:30'), B = await game('10:30', '11:30'), C = await game('11:30', '12:30');
    const ps = [];
    for (let i = 1; i <= 5; i++) ps.push(await player(`Pool Player${i}`));
    for (const p of ps) expect((await answer(p, A, 'in')).status).toBe(200);
    const id = i => ps[i].player_id;
    expect(await inIds(A)).toEqual([id(0), id(2), id(4)].sort()); // a tie goes to the first game
    expect(await inIds(B)).toEqual([id(1), id(3)].sort());
    expect(await inIds(C)).toEqual(ps.map(p => p.player_id).sort());
    for (const p of ps) expect([await statusOf(A, p), await statusOf(B, p)].sort()).toEqual(['elsewhere', 'in']);
    // Answering again changes nothing.
    await answer(ps[1], C, 'in');
    expect(await statusOf(B, ps[1])).toBe('in');
    expect(await statusOf(A, ps[1])).toBe('elsewhere');
  });

  it('one answer, from any game\'s link, is the night\'s: "can\'t make it" is written to every game', async () => {
    const { game, player } = await league('p166out', { teamStructure: 'headcount', minPlayers: 1, maxPlayers: 4, minGoalies: 0 });
    const A = await game('19:00', '20:00'), B = await game('20:00', '21:00');
    const p = await player('Olive Out');
    await answer(p, B, 'in');
    expect([await statusOf(A, p), await statusOf(B, p)]).toEqual(['in', 'in']);
    await answer(p, A, 'out');
    expect([await statusOf(A, p), await statusOf(B, p)]).toEqual(['out', 'out']);
  });
});

describe('Pickup: the draw of two games at the same time', () => {
  it('each game draws only its own players: no one gets a team in both', async () => {
    const { a, game, player } = await league('p166draw', { teamStructure: 'weekly_draw', teamNames: ['Dark', 'Light'] });
    const A = await game('20:30', '21:30'), B = await game('20:30', '21:30');
    const ps = [];
    for (let i = 1; i <= 8; i++) ps.push(await player(`Draw Player${i}`));
    for (const p of ps) expect((await answer(p, A, 'in')).status).toBe(200);
    await must(a.post('/league/events/random-assign', { event_id: A.id }), 'draw A');
    await must(a.post('/league/events/random-assign', { event_id: B.id }), 'draw B');
    const drawn = async ev => (await rows("SELECT player_id FROM rsvp WHERE event_id = ? AND status = 'in' AND team IS NOT NULL", ev.id)).map(r => r.player_id);
    const [inA, inB] = [await drawn(A), await drawn(B)];
    expect(inA.length + inB.length).toBe(8);
    expect(inA.filter(x => inB.includes(x))).toEqual([]);
  });
});

describe('Fixed teams: a yes is for the games the player\'s team plays that night', () => {
  it('Bears play 19:00 and 20:00: in both; the 20:00 game Bears aren\'t in gets nothing', async () => {
    const { game, player } = await league('p166fixed', { teamNames: ['Bears', 'Otters', 'Wolves', 'Owls'] });
    const A = await game('19:00', '20:00', { home_team: 'Bears', away_team: 'Otters' });
    const B = await game('20:00', '21:00', { home_team: 'Bears', away_team: 'Wolves' });
    const C = await game('20:00', '21:00', { home_team: 'Otters', away_team: 'Owls' });
    const bear = await player('Bea Bear', { team: 'Bears' });
    const otter = await player('Otto Otter', { team: 'Otters' });
    await answer(bear, A, 'in');
    await answer(otter, C, 'in');
    expect([await statusOf(A, bear), await statusOf(B, bear), await statusOf(C, bear)]).toEqual(['in', 'in', null]);
    expect([await statusOf(A, otter), await statusOf(B, otter), await statusOf(C, otter)]).toEqual(['in', null, 'in']);
  });
});

describe('The player\'s own page: the night, and one game dropped', () => {
  it('lists the night\'s games, says what a yes means (FR/EN), and drops one game, then takes it back', async () => {
    const { game, player } = await league('p166page', { teamNames: ['Bears', 'Otters', 'Wolves', 'Owls'] });
    const A = await game('19:00', '20:00', { home_team: 'Bears', away_team: 'Otters' });
    const B = await game('20:00', '21:00', { home_team: 'Bears', away_team: 'Wolves' });
    const bear = await player('Pia Page', { team: 'Bears' });
    let html = await page(bear, B);
    expect(html).toContain('Bears – Otters');
    expect(html).toContain('Bears – Wolves');
    let d = dictOf(html);
    expect([d.fr.nightNoteTeams, d.en.nightNoteTeams]).toEqual(['Ta réponse vaut pour la soirée : pour chaque match de ton équipe.', "Your answer is for the night: each of your team's games."]);
    expect([d.fr.nightNoteFollow, d.en.nightNoteFollow]).toEqual(['Les matchs qui se suivent, tu les joues tous.', 'Games that follow each other, you play them all.']);
    expect(html).toContain('data-i18n="nightNoteTeams"');
    expect(html).toContain('data-i18n="nightNoteFollow"');

    await answer(bear, B, 'in');
    html = await page(bear, B);
    d = dictOf(html);
    expect([d.fr.gameBtnOut, d.en.gameBtnOut, d.fr.gameBtnIn, d.en.gameBtnIn]).toEqual(['Je ne peux pas pour ce match', "I can't make this game", 'Finalement, je joue ce match', 'I can make this game after all']);
    expect([d.fr.gameIn, d.en.gameIn, d.fr.gameOut, d.en.gameOut]).toEqual(['Tu joues', "You're playing", 'Tu ne joues pas ce match', "You're not playing this game"]);
    expect(d.fr.nightDoneInBody).toMatch(/^On se voit .+\. Tes matchs :$/);
    expect(d.en.nightDoneInBody).toMatch(/^See you .+\. Your games:$/);
    expect((html.match(/data-gv="out"/g) || []).length).toBe(2);

    expect((await gameAnswer(bear, B, A, 'out')).status).toBe(200);
    expect([await statusOf(A, bear), await statusOf(B, bear)]).toEqual(['out', 'in']);
    html = await page(bear, A);
    expect(html).toContain('data-game-state="out"');
    expect(html).toContain('data-game-state="in"');
    expect(html).toContain('rv-done--ok'); // still in for the night
    expect((await gameAnswer(bear, A, A, 'in')).status).toBe(200);
    expect([await statusOf(A, bear), await statusOf(B, bear)]).toEqual(['in', 'in']);
  });

  it('taking back a game can\'t put a player in two games at once', async () => {
    const { game, player } = await league('p166back', { teamStructure: 'headcount', minPlayers: 1, maxPlayers: 5, minGoalies: 0 });
    const A = await game('10:30', '11:30'), B = await game('10:30', '11:30');
    const p = await player('Tess Twice');
    await answer(p, A, 'in');
    expect([await statusOf(A, p), await statusOf(B, p)]).toEqual(['in', 'elsewhere']);
    let html = await page(p, A);
    expect(html).toContain('data-game-state="other"');
    expect(dictOf(html).en.nightNoteConcurrent).toBe('Some games are at the same time: we spread players evenly across them.');
    expect(dictOf(html).fr.nightNoteConcurrent).toBe('Des matchs se jouent en même temps : on répartit les joueurs également entre eux.');
    expect(dictOf(html).fr.nightNotePool).toBe('Ta réponse vaut pour la soirée : tu es disponible, et on te place dans les matchs où il y a de la place.');
    expect(dictOf(html).en.nightNotePool).toBe("Your answer is for the night: you're available, and we place you in the games that have room.");
    const r = await gameAnswer(p, A, B, 'in');
    expect(r.status).toBe(409);
    expect((await r.json()).errorKey).toBe('RSVP_OVERLAPPING_GAME');
    expect([await statusOf(A, p), await statusOf(B, p)]).toEqual(['in', 'elsewhere']);
    expect(dictOf(html).fr.errOverlap).toBe('Tu es déjà inscrit à un match qui se joue en même temps.');
    expect(dictOf(html).en.errOverlap).toBe("You're already in a game at the same time.");
    // Out of A first: then B, and A stays out.
    await gameAnswer(p, A, A, 'out');
    expect((await gameAnswer(p, A, B, 'in')).status).toBe(200);
    expect([await statusOf(A, p), await statusOf(B, p)]).toEqual(['out', 'in']);
    html = await page(p, B);
    expect(html).toContain('rv-done--ok');
  });

  it('a single-game night looks as it always has', async () => {
    const { game, player } = await league('p166single', { teamNames: ['Bears', 'Otters'] });
    const A = await game('19:00', '20:00', { home_team: 'Bears', away_team: 'Otters' });
    const p = await player('Sol Single', { team: 'Bears' });
    const html = await page(p, A);
    expect(html).not.toContain('rv-games');
    expect(dictOf(html).fr.nightNoteTeams).toBeUndefined();
  });
});

describe('The 12h email\'s "can\'t make it" drops the whole night', () => {
  it('both games out, one late-reversal alert for the night', async () => {
    const { game, player } = await league('p166late', { teamNames: ['Bears', 'Otters', 'Wolves', 'Owls'] });
    const A = await game('19:00', '20:00', { home_team: 'Bears', away_team: 'Otters' });
    const B = await game('20:00', '21:00', { home_team: 'Bears', away_team: 'Wolves' });
    const p = await player('Lou Late', { team: 'Bears' });
    await answer(p, A, 'in');
    const before = mail.sent.filter(m => /dropped out/.test(m.subject)).length;
    const html = await page(p, A, '&v=out&src=logistics12h');
    expect(html).toContain('data-i18n="confirmAnswerOutNight"');
    const d = dictOf(html);
    expect([d.fr.confirmAnswerOutNight, d.en.confirmAnswerOutNight]).toEqual(['Tu vas répondre : je ne peux pas, pour toute la soirée.', "You're about to answer: can't make it, for the whole night."]);
    const post = await SELF.fetch(`http://example.com/league/rsvp/confirm?${await p.qs(A)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'status=out&src=logistics12h', redirect: 'manual' });
    expect(post.status).toBe(303);
    expect([await statusOf(A, p), await statusOf(B, p)]).toEqual(['out', 'out']);
    const alerts = mail.sent.filter(m => /dropped out/.test(m.subject));
    expect(alerts.length - before).toBe(1);
    expect(alerts[alerts.length - 1].subject).toContain('Lou Late');
  });

  it('a sub\'s night is only the games they were placed in', async () => {
    const { a, game } = await league('p166sub', { teamNames: ['Bears', 'Otters', 'Wolves', 'Owls'] });
    const A = await game('19:00', '20:00', { home_team: 'Bears', away_team: 'Otters' });
    const B = await game('20:00', '21:00', { home_team: 'Wolves', away_team: 'Owls' });
    const lgId = A.id.split(':')[0];
    const sub = (await must(a.post('/league/contacts', { name: 'Sid Sub', email: 'sid.sub@example.com', role: 'sub_skater' }), 'sub')).contact;
    const salt = (await one('SELECT token_salt FROM contacts WHERE player_id = ?', sub.player_id)).token_salt;
    sub.qs = async ev => `league=${encodeURIComponent(lgId)}&e=${encodeURIComponent(ev.id)}&p=${encodeURIComponent(sub.player_id)}&t=${await hmac(env.RSVP_SECRET, `lr:${lgId}:${ev.id}:${sub.player_id}:${salt}`)}`;
    await must(a.post('/league/rsvp/admin', { event_id: A.id, player_id: sub.player_id, status: 'in' }), 'placed in A');
    expect(await page(sub, A)).not.toContain('rv-games');
    await SELF.fetch(`http://example.com/league/rsvp/confirm?${await sub.qs(A)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'status=out&src=logistics12h', redirect: 'manual' });
    expect([await statusOf(A, sub), await statusOf(B, sub)]).toEqual(['out', null]);
  });
});

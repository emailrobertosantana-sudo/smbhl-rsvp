// D1 (nights), decided 2026-09-30: the system never moves a player between
// games at the same time on its own. So when a drop-out leaves one of them
// thin (fewer confirmed than its minimum) while another at that time has
// more confirmed than it needs, the admin is told -- a move is theirs to
// make -- whether or not a sub can be called (the short-game alert before
// this only fired when no sub could be).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must, one, rows, mail, installMailCapture, removeMailCapture, local, DAY } from './support/league_season.js';
import { hmac } from '../src/crypto_utils.js';

beforeAll(async () => {
  env.AUTH_SECRET = 'p173'; env.RSVP_SECRET = 'p173r'; env.RESEND_API_KEY = 'p173'; env.MAIL_DAILY_CAP = '';
  await applyRealSchema(env);
  installMailCapture();
});
afterAll(() => removeMailCapture());

async function night(tag, { sub }) {
  const a = await admin(tag);
  const lg = (await must(a.post('/leagues/create', { name: 'Thin ' + tag, teamStructure: 'headcount', minPlayers: 3, maxPlayers: 4, minGoalies: 0 }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  if (sub) await must(a.post('/league/contacts', { name: 'Sal Sub', email: `sal.sub.${tag}@example.com`, role: 'sub_skater' }), 'sub');
  const ps = [];
  for (let i = 1; i <= 7; i++) {
    const c = (await must(a.post('/league/contacts', { name: `Thin Player${i}`, email: `thin.p${i}.${tag}@example.com`, role: 'roster' }), 'player')).contact;
    const salt = (await one('SELECT token_salt FROM contacts WHERE player_id = ?', c.player_id)).token_salt;
    c.qs = async ev => `league=${encodeURIComponent(lg.id)}&e=${encodeURIComponent(ev.id)}&p=${encodeURIComponent(c.player_id)}&t=${await hmac(env.RSVP_SECRET, `lr:${lg.id}:${ev.id}:${c.player_id}:${salt}`)}`;
    ps.push(c);
  }
  const date = local(Date.now() + 3 * DAY).date;
  const A = (await must(a.post('/league/events', { date, season: 'S1', venue: 'Rink 1', start_time: '19:00', end_time: '20:00' }), 'A')).event;
  const B = (await must(a.post('/league/events', { date, season: 'S1', venue: 'Rink 2', start_time: '19:00', end_time: '20:00' }), 'B')).event;
  const answer = async (p, status) => SELF.fetch(`http://example.com/league/rsvp?${await p.qs(A)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
  for (const p of ps) expect((await answer(p, 'in')).status).toBe(200);
  return { a, A, B, ps, answer };
}
const inIds = async ev => (await rows("SELECT player_id FROM rsvp WHERE event_id = ? AND status = 'in'", ev.id)).map(r => r.player_id);
const thinAlerts = (from, tag) => mail.sent.slice(from).filter(m => m.to === `admin.${tag}@example.com` && /same time|même heure/.test(m.subject));

describe('A game at the same time left thin by a drop-out', () => {
  for (const sub of [true, false]) {
    it(`the admin is told, naming the game with a player to spare (${sub ? 'a sub to call' : 'no sub'})`, async () => {
      const tag = sub ? 'p173sub' : 'p173nosub';
      const { B, ps, answer } = await night(tag, { sub });
      // Balanced: A 4, B 3 (the minimum).
      expect((await inIds(B)).length).toBe(3);
      const seen = mail.sent.length;
      const leaving = ps;
      const inB = await inIds(B);
      await answer(leaving.find(p => p.player_id === inB[0]), 'out');
      const alerts = thinAlerts(seen, tag);
      expect(alerts.length).toBe(1);
      expect(alerts[0].text).toContain('Rink 2');
      expect(alerts[0].text).toContain('Players: 2 of 3 needed.');
      expect(alerts[0].text).toContain('Counted: confirmed players.'); // email review item 2
      expect(alerts[0].text).toContain('Rink 1: 4 confirmed, 1 more than it needs.');
      // Once per game.
      const again = mail.sent.length;
      await answer(leaving.find(p => p.player_id === inB[1]), 'out');
      expect(thinAlerts(again, tag).length).toBe(0);
    });
  }
});

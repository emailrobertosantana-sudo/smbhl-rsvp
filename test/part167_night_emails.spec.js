// D1 (nights), decided 2026-09-30: one set of emails per night. A league's
// games on the same day get one 72h ask, one 24h ask and one 12h details
// email per player -- timed from the night's first game, listing the
// player's games that night, and logged for every game so no pass sends
// them again. The 12h email's "can't make it" drops the whole night.
// (A single-game night's emails are unchanged: part114's golden record.)
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { H, DAY, local, mail, installMailCapture, removeMailCapture, linksIn, admin, must, pass, rows } from './support/league_season.js';

const START = Date.UTC(2026, 9, 5, 16, 0); // Mon 2026-10-05 12:00 Toronto
const GAME_DAY = local(START + 5 * DAY).date; // Sat 2026-10-10
const FIRST = Date.parse(`${GAME_DAY}T19:00:00-04:00`);

beforeAll(async () => {
  env.LEAGUE_PRODUCT = 'true';
  env.RESEND_API_KEY = 'x'; env.RSVP_SECRET = 'p167'; env.AUTH_SECRET = 'p167-auth';
  env.MAIL_DAILY_CAP = '';
  env.PUBLIC_URL = 'https://rsvp.example.com';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(START));
  await applyRealSchema(env);
  installMailCapture();
});
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

const toPlayers = (sent, emails) => sent.filter(m => emails.includes(m.to));

describe('One set of emails per night', () => {
  it('72h and 24h asks, then the 12h details: one of each per player, with both games, logged for both', async () => {
    const a = await admin('p167');
    await must(a.post('/leagues/create', { name: 'Two A Night', teamStructure: 'headcount', minPlayers: 1, maxPlayers: 10, minGoalies: 0 }), 'create');
    await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
    await must(a.post('/league/reminders/settings', { reminder72h: true, reminder24h: true, reminder12h: true }), 'reminders');
    const emails = [];
    for (let i = 1; i <= 3; i++) {
      const email = `night.p${i}@example.com`;
      await must(a.post('/league/contacts', { name: `Night Player${i}`, email, role: 'roster' }), 'contact');
      emails.push(email);
    }
    const A = (await must(a.post('/league/events', { date: GAME_DAY, season: 'S1', venue: 'Gym', start_time: '19:00', end_time: '20:00' }), 'A')).event;
    const B = (await must(a.post('/league/events', { date: GAME_DAY, season: 'S1', venue: 'Gym', start_time: '20:00', end_time: '21:00' }), 'B')).event;

    // 72 h before the first game.
    let seen = mail.sent.length;
    await pass(FIRST - 71.5 * H);
    const asks = toPlayers(mail.sent.slice(seen), emails);
    expect(asks.map(m => m.to).sort()).toEqual(emails);
    for (const m of asks) {
      expect(m.subject).toMatch(/have you decided/);
      expect(m.text).toContain('7 PM and 8 PM');
      expect(m.text).toContain('19 h et 20 h');
      for (const l of linksIn(m, '/league/rsvp')) expect(new URL(l).searchParams.get('e')).toBe(A.id);
    }
    expect((await rows("SELECT event_id FROM league_reminder_log WHERE kind = 'reminder_72h' ORDER BY event_id", )).map(r => r.event_id).filter(id => [A.id, B.id].includes(id)).sort()).toEqual([A.id, B.id].sort());

    // Player 1 answers yes from the email: both games.
    const yes = linksIn(asks.find(m => m.to === emails[0]), '/league/rsvp').find(l => new URL(l).searchParams.get('v') === 'in');
    const u = new URL(yes);
    const post = await SELF.fetch(`http://example.com/league/rsvp/confirm?${u.searchParams.toString()}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'status=in', redirect: 'manual' });
    expect(post.status).toBe(303);
    const p1 = (await rows("SELECT player_id FROM contacts WHERE email = ?", emails[0]))[0].player_id;
    expect((await rows('SELECT event_id, status FROM rsvp WHERE player_id = ? ORDER BY event_id', p1)).map(r => r.status)).toEqual(['in', 'in']);

    // An hour later: nothing new.
    seen = mail.sent.length;
    await pass(FIRST - 70.5 * H);
    expect(toPlayers(mail.sent.slice(seen), emails)).toEqual([]);

    // 24 h: only the two who haven't answered, once each.
    seen = mail.sent.length;
    await pass(FIRST - 23.5 * H);
    const last = toPlayers(mail.sent.slice(seen), emails);
    expect(last.map(m => m.to).sort()).toEqual([emails[1], emails[2]]);
    expect(last.every(m => /last reminder/.test(m.subject))).toBe(true);

    // 12 h: the details, once, to the confirmed player, with both games.
    seen = mail.sent.length;
    await pass(FIRST - 11.5 * H);
    const details = toPlayers(mail.sent.slice(seen), emails);
    expect(details.map(m => m.to)).toEqual([emails[0]]);
    expect(details[0].subject).toMatch(/details for/);
    expect(details[0].text).toContain('7 PM and 8 PM');
    const optOut = linksIn(details[0], '/league/rsvp').find(l => new URL(l).searchParams.get('src') === 'logistics12h');
    expect(new URL(optOut).searchParams.get('e')).toBe(A.id);

    // Its "can't make it" drops the night.
    const o = new URL(optOut);
    const out = await SELF.fetch(`http://example.com/league/rsvp/confirm?${o.searchParams.toString()}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'status=out&src=logistics12h', redirect: 'manual' });
    expect(out.status).toBe(303);
    expect((await rows('SELECT status FROM rsvp WHERE player_id = ? ORDER BY event_id', p1)).map(r => r.status)).toEqual(['out', 'out']);
    expect(mail.sent.filter(m => /dropped out/.test(m.subject)).length).toBe(1);

    // After the second game's own 12 h mark: still nothing more.
    seen = mail.sent.length;
    await pass(FIRST - 10.5 * H);
    expect(toPlayers(mail.sent.slice(seen), emails)).toEqual([]);
  });
});

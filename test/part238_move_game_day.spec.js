// Stage 2, item 2d: a game moves to another day and keeps its event id. Its
// RSVPs stay, and every place reads the stored date, not the day in the id:
// the admin schedule and game page, the public page, the player's page, the
// reminders (when they fire and what they say), and the schedule change
// email (« (avant : …) » names the old day). Refused for a game that has
// started, for a day already past, and onto a taken slot. SMBHL's rows (a
// text date, the ISO date in the id) read exactly as before.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { H, DAY, local, mail, installMailCapture, removeMailCapture, linksIn, admin, must, pass, rows, one } from './support/league_season.js';
import { eventStart, eventHasStarted, eventDate } from '../src/league_ids.js';
import { SELF } from 'cloudflare:test';

const START = Date.UTC(2099, 9, 1, 16, 0); // Thu 2099-10-01 12:00 Toronto
const OLD_DAY = '2099-10-11';
let a, leagueId, slug, eventId, players;

beforeAll(async () => {
  env.LEAGUE_PRODUCT = 'true';
  env.RESEND_API_KEY = 'x'; env.RSVP_SECRET = 'p238'; env.AUTH_SECRET = 'p238-auth';
  env.MAIL_DAILY_CAP = '';
  env.PUBLIC_URL = 'https://rsvp.example.com';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(START));
  await applyRealSchema(env);
  installMailCapture();
});
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

const move = (date, extra = {}) => a.post('/league/events/update', { event_id: eventId, date, start_time: '19:00', end_time: '20:30', venue: 'Aréna', ...extra });

describe('moving a game to another day', () => {
  it('setup: a fixed-teams game on 11 October, one player already in', async () => {
    a = await admin('p238');
    const created = await must(a.post('/leagues/create', { name: 'Ligue p238', teamStructure: 'fixed', teamNames: ['Red', 'Blue'] }), 'create');
    leagueId = created.league.id;
    await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
    await must(a.post('/league/reminders/settings', { reminder72h: true, reminder24h: true, reminder12h: true }), 'reminders');
    await must(a.post('/league/settings/identity', { publicPageEnabled: true }), 'public page');
    players = {};
    for (const [name, team] of [['Ann Red', 'Red'], ['Bob Red', 'Red'], ['Cid Blue', 'Blue']]) {
      const r = await must(a.post('/league/contacts', { name, email: `${name.split(' ')[0].toLowerCase()}.p238@example.com`, team, role: 'roster' }), 'contact ' + name);
      players[name] = r.contact.player_id;
    }
    const ev = await must(a.post('/league/events', { date: OLD_DAY, season: 'S1', venue: 'Aréna', start_time: '19:00', end_time: '20:30', home_team: 'Red', away_team: 'Blue' }), 'event');
    eventId = ev.event.id;
    expect(eventId).toContain(OLD_DAY);
    await env.DB.prepare("INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at) VALUES (?, ?, 'Red', 'in', 'roster', datetime('now'))").bind(eventId, players['Ann Red']).run();
    slug = (await one('SELECT slug FROM leagues WHERE id = ?', leagueId)).slug;
    // Ten days out: no reminder yet.
    const p = await pass(START);
    expect(p.failed.filter(l => !/ failed=0 /.test(l))).toEqual([]);
    expect(mail.sent.filter(m => /^(ann|bob|cid).p238@/.test(m.to))).toEqual([]);
  });

  it('moves to 3 October: same id, the answer kept, the stored date read everywhere', async () => {
    const r = await move('2099-10-03');
    expect(r.status).toBe(200);
    expect(r.json.event).toMatchObject({ id: eventId, date: '2099-10-03' });
    const row = await one('SELECT id, date FROM events WHERE id = ?', eventId);
    expect(row).toEqual({ id: eventId, date: '2099-10-03' });
    expect(await rows('SELECT player_id, status FROM rsvp WHERE event_id = ?', eventId)).toEqual([{ player_id: players['Ann Red'], status: 'in' }]);
    expect(await one('SELECT count(*) n FROM events WHERE league_id = ?', leagueId)).toEqual({ n: 1 });

    // The helpers: the stored day, not the one in the id.
    expect(eventDate(row)).toBe('2099-10-03');
    expect(local(eventStart({ ...row, start_time: '19:00' }).getTime())).toEqual({ date: '2099-10-03', time: '19:00' });

    // Admin: the schedule and the game page.
    const schedule = (await a.get('/league/schedule')).text;
    expect(schedule).toMatch(/data-date-en="[^"]*Oct 3"/);
    expect(schedule).not.toMatch(/data-date-en="[^"]*Oct 11"/);
    const detail = (await a.get(`/league/events/detail?e=${encodeURIComponent(eventId)}`)).text;
    expect(detail).toContain('id="ev_edit_date" type="date" value="2099-10-03">');
    expect(detail).toContain('Changer la date garde les réponses des joueurs.');
    // The public page.
    const pub = await (await SELF.fetch(`http://example.com/${slug}`)).text();
    expect(pub).toMatch(/data-date-en="[^"]*Oct 3"/);
    expect(pub).not.toMatch(/data-date-en="[^"]*Oct 11"/);
  });

  it('the reminders fire for the new day and name it; the player page shows it', async () => {
    const before = mail.sent.length;
    const p = await pass(START + 32 * H); // 2 October, 20:00 Toronto: 23 h before the new day
    expect(p.failed.filter(l => !/ failed=0 /.test(l))).toEqual([]);
    const sent = mail.sent.slice(before).filter(m => /^(ann|bob|cid).p238@/.test(m.to));
    // The 72 h ask was skipped by the move (its window had passed, as for a new
    // game); the last reminder, 24 h before the new day, to the two who have
    // not answered.
    const asks = sent.filter(m => /dernier rappel|last reminder/i.test(m.subject));
    expect(asks.map(m => m.to).sort()).toEqual(['bob.p238@example.com', 'cid.p238@example.com']);
    for (const m of asks) {
      expect(m.text).toMatch(/samedi 3 oct\./);
      expect(m.text).not.toMatch(/11 oct\./);
    }
    const bob = asks.find(m => m.to.startsWith('bob'));
    const link = linksIn(bob, '/league/rsvp')[0];
    expect(link).toContain(encodeURIComponent(eventId));
    const page = await (await SELF.fetch(link.replace(/&v=(in|out)$/, ''))).text();
    expect(page).toMatch(/3 oct\.|Oct 3|2099-10-03/);
    expect(page).not.toMatch(/11 oct\.|Oct 11/);
  });

  it('moved again after the ask: the answer stays and the players told get « (avant : samedi 3 oct. à 19 h) »', async () => {
    const r = await move('2099-10-05');
    expect(r.status).toBe(200);
    expect(await one('SELECT id, date FROM events WHERE id = ?', eventId)).toEqual({ id: eventId, date: '2099-10-05' });
    expect(await rows("SELECT player_id, status FROM rsvp WHERE event_id = ? AND status = 'in'", eventId)).toEqual([{ player_id: players['Ann Red'], status: 'in' }]);
    const told = await rows("SELECT player_id, payload FROM outbox WHERE kind = 'night_moved' AND event_id = ? AND cancelled = 0", eventId);
    expect(told.map(t => t.player_id).sort()).toEqual([players['Bob Red'], players['Cid Blue']].sort());
    const text = told.map(t => t.payload).join('\n');
    expect(text).toMatch(/lundi 5 oct\. à 19 h \(avant : samedi 3 oct\. à 19 h\)/);
    expect(text).toMatch(/Monday, Oct 5 at 7 PM \(was Saturday, Oct 3 at 7 PM\)/);
  });

  it('refused: onto a taken slot, to a day already past, and once the game has started', async () => {
    const other = await must(a.post('/league/events', { date: '2099-10-07', season: 'S1', venue: 'Aréna', start_time: '19:00', end_time: '20:30' }), 'second event');
    let r = await move('2099-10-07');
    expect(r.status).toBe(409);
    expect(r.json.errorKey).toBe('EVENT_SLOT_EXISTS');
    r = await move('2099-09-30');
    expect(r.status).toBe(409);
    expect(r.json.errorKey).toBe('EVENT_MOVE_PAST');
    r = await move('not-a-date');
    expect(r.status).toBe(400);
    expect(await one('SELECT date FROM events WHERE id = ?', eventId)).toEqual({ date: '2099-10-05' });
    // Started: 5 October, 19:30 Toronto.
    vi.setSystemTime(new Date(Date.UTC(2099, 9, 5, 23, 30)));
    r = await move('2099-10-09');
    expect(r.status).toBe(409);
    expect(r.json.errorKey).toBe('EVENT_MOVE_STARTED');
    expect((await a.get(`/league/events/detail?e=${encodeURIComponent(eventId)}`)).text).toContain('id="ev_edit_date" type="date" value="2099-10-05" disabled>');
    // The other game's day can still change; the same date is no change.
    vi.setSystemTime(new Date(START + 2 * H));
    r = await a.post('/league/events/update', { event_id: other.event.id, date: '2099-10-07', start_time: '19:00', end_time: '20:30', venue: 'Aréna' });
    expect(r.status).toBe(200);
  });

  it('SMBHL: a text date and the ISO date in the id read as before', () => {
    const smbhl = { id: '2099-09-27', date: 'Sunday September 27 2099', start_time: '10:30' };
    expect(eventDate(smbhl)).toBe('2099-09-27');
    expect(local(eventStart(smbhl).getTime())).toEqual({ date: '2099-09-27', time: '10:30' });
    expect(eventHasStarted(smbhl, Date.UTC(2099, 8, 27, 14, 0))).toBe(false);
    expect(eventHasStarted(smbhl, Date.UTC(2099, 8, 27, 15, 0))).toBe(true);
  });
});

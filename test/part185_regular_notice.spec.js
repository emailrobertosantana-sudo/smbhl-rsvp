// The notice for regular players, once per league (src/add_emails.js
// regularNotice). Adding a regular player sends no email: their first one
// is the league's next reminder that asks who is coming, for the next game
// that still has one to send. The first time the Players page adds or
// imports regular players in a league, it is told so, before anything is
// created: the route answers 409 with needsRegularNotice and when that
// first email comes. Sent again with regularNoticeSeen, the players are
// added and the notice is never shown again in that league. An API caller
// that does not ask for the notice (no wantsNotice) is not stopped.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { DAY, H, local, mail, installMailCapture, removeMailCapture, admin, must, pass, rows } from './support/league_season.js';
import { getAddEmails } from '../src/add_emails.js';

const T0 = Date.parse('2027-03-01T15:00:00Z');
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
  env.AUTH_SECRET = 'p185-auth'; env.RSVP_SECRET = 'p185-rsvp'; env.RESEND_API_KEY = 'p185'; env.LEAGUE_PRODUCT = 'true'; env.PUBLIC_URL = 'https://notice.example'; env.MAIL_DAILY_CAP = ''; env.MAIL_HARD_DAILY_CAP = '';
  await applyRealSchema(env);
  installMailCapture();
});
beforeEach(() => { vi.setSystemTime(new Date(T0)); mail.sent.length = 0; });
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

let seq = 0;
async function league({ gameInDays = 10, structure = null, remindersOff = false, noGame = false } = {}) {
  const tag = `n${++seq}`;
  const a = await admin(`p185.${tag}`);
  const lg = (await must(a.post('/leagues/create', { name: `P185 ${tag}`, ...(structure ? { teamStructure: structure } : { teamNames: ['Bulls', 'Parade'] }) }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'season');
  if (remindersOff) await env.DB.prepare('UPDATE leagues SET reminder_72h_enabled = 0, reminder_24h_enabled = 0, reminder_12h_enabled = 0 WHERE id = ?').bind(lg.id).run();
  let ev = null;
  if (!noGame) {
    const d = local(T0 + gameInDays * DAY);
    ev = (await must(a.post('/league/events', { date: d.date, start_time: '19:00', end_time: '20:00', venue: 'Gym', ...(structure ? {} : { home_team: 'Bulls', away_team: 'Parade' }) }), 'ev')).event;
  }
  mail.sent.length = 0;
  return { a, lg, ev, tag };
}
const reg = (tag, i, team) => ({ name: `Regular Person${String.fromCharCode(65 + i)}`, email: `${tag}.r${i}@players.example`, ...(team ? { team } : {}) });
const regularsOf = lg => rows(`SELECT name FROM contacts WHERE league_id = ? AND role = 'roster' ORDER BY name`, lg.id);
const outboxOf = lg => rows(`SELECT kind FROM outbox WHERE league_id = ?`, lg.id);

describe('The first add of regular players in a league: a notice, then never again', () => {
  it('one regular player: 409 with when their first email comes; nothing created, nothing queued', async () => {
    const { a, lg, tag } = await league({ gameInDays: 10 });
    const r = await a.post('/league/contacts', { ...reg(tag, 0, 'Bulls'), wantsNotice: true });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ ok: false, errorKey: 'ADD_NOTICE_REQUIRED', needsRegularNotice: true, regularCount: 1, teamlessCount: 0, addCount: 1 });
    expect(r.json.needsEmailChoice).toBeUndefined();
    // The game is 10 days away: the first ask is the 72 h reminder, not open yet.
    expect(r.json.firstEmail).toEqual({ kind: 'reminder', hours: 72, soon: false, date: { fr: expect.stringMatching(/^\w+ \d+ \w+\.? · 19 h$/u), en: expect.stringMatching(/ · 7 PM$/) } });
    expect(await regularsOf(lg)).toEqual([]);
    expect(await outboxOf(lg)).toEqual([]);
    expect(mail.sent).toEqual([]);
  });

  it('seen: the player is added, still no email, and the league is not told again, for an add or an import', async () => {
    const { a, lg, tag } = await league();
    const r = await a.post('/league/contacts', { ...reg(tag, 0, 'Bulls'), wantsNotice: true, regularNoticeSeen: true });
    expect(r.status).toBe(200);
    expect(await getAddEmails(env.DB, lg.id)).toEqual({ mode: null, held: [], regularNotice: true });
    const again = await a.post('/league/contacts', { ...reg(tag, 1, 'Bulls'), wantsNotice: true });
    expect(again.status).toBe(200);
    const bulk = await a.post('/league/contacts/bulk', { contacts: [reg(tag, 2), reg(tag, 3)], wantsNotice: true });
    expect(bulk.json).toMatchObject({ ok: true, createdCount: 2 });
    await pass(T0 + 15 * 60000);
    expect(await regularsOf(lg)).toHaveLength(4);
    expect(await outboxOf(lg)).toEqual([]);
    expect(mail.sent.filter(m => /players\.example$/.test(m.to))).toEqual([]);
  });

  it('an import of 20, no team in a fixed-teams league: the plural, and all 20 counted as having no team', async () => {
    const { a, lg, tag } = await league();
    const r = await a.post('/league/contacts/bulk', { contacts: Array.from({ length: 20 }, (_, i) => reg(tag, i)), wantsNotice: true });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ needsRegularNotice: true, regularCount: 20, teamlessCount: 20, addCount: 20 });
    expect(await regularsOf(lg)).toEqual([]);
  });

  it('the game already inside its 72 h window (created there, so that step is skipped): the first email is the 24 h reminder', async () => {
    const { a, tag } = await league({ gameInDays: 2 });
    const r = await a.post('/league/contacts', { ...reg(tag, 0, 'Bulls'), wantsNotice: true });
    expect(r.json.firstEmail).toMatchObject({ kind: 'reminder', hours: 24, soon: false });
  });

  it('no game yet, and a league with its reminders off', async () => {
    const none = await league({ noGame: true });
    expect((await none.a.post('/league/contacts', { ...reg(none.tag, 0, 'Bulls'), wantsNotice: true })).json.firstEmail).toEqual({ kind: 'none_scheduled' });
    const off = await league({ remindersOff: true });
    expect((await off.a.post('/league/contacts', { ...reg(off.tag, 0, 'Bulls'), wantsNotice: true })).json.firstEmail).toEqual({ kind: 'reminders_off' });
  });

  it('a league without fixed teams: no "no team" count', async () => {
    const { a, tag } = await league({ structure: 'headcount' });
    const r = await a.post('/league/contacts/bulk', { contacts: [reg(tag, 0), reg(tag, 1)], wantsNotice: true });
    expect(r.json).toMatchObject({ needsRegularNotice: true, regularCount: 2, teamlessCount: 0 });
  });

  it('regular players and a substitute together, both steps due: one answer carrying both', async () => {
    const { a, lg, tag } = await league({ gameInDays: 2 });
    const contacts = [reg(tag, 0, 'Bulls'), reg(tag, 1), { name: 'Sam Sub', role: 'sub_skater', email: `${tag}.sub@subs.example` }];
    const r = await a.post('/league/contacts/bulk', { contacts, wantsNotice: true });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ errorKey: 'ADD_EMAIL_CHOICE_REQUIRED', needsEmailChoice: true, emailCount: 1, needsRegularNotice: true, regularCount: 2, teamlessCount: 1, addCount: 3 });
    const done = await a.post('/league/contacts/bulk', { contacts, wantsNotice: true, regularNoticeSeen: true, emailChoice: 'skip' });
    expect(done.json).toMatchObject({ ok: true, createdCount: 3 });
    expect(await getAddEmails(env.DB, lg.id)).toMatchObject({ mode: 'on', regularNotice: true });
    // Nothing to a player: no sub call, no reminder (the admin's short-of-players alert may go).
    expect((await outboxOf(lg)).filter(r => r.kind !== 'short_alert')).toEqual([]);
  });

  it('an API caller that does not ask for the notice is not stopped', async () => {
    const { a, lg, tag } = await league();
    const r = await a.post('/league/contacts', reg(tag, 0, 'Bulls'));
    expect(r.status).toBe(200);
    expect((await getAddEmails(env.DB, lg.id)).regularNotice).toBe(false);
  });
});

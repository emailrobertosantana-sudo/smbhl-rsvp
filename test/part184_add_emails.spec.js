// "Email players when they are added" (src/add_emails.js).
//
// What adding a player sends was checked first, and it is not what it
// looked like from the Players page:
//   - a regular player gets NO email when added, with or without a team,
//     one at a time or twenty at once. Their first email is the game's
//     next scheduled reminder;
//   - a substitute is called by email AT ONCE when a game in the next 8
//     days is short at their position. Twenty substitutes added the day
//     before a short game: twenty emails, with no warning.
// So the warning is about substitutes. The first time an add or an import
// would email someone, the league's admin is asked, before anything is
// created: add and send, or add without emailing, and whether to turn
// automatic emails off for the league. The answer is saved; the league is
// not asked again. Substitutes added without emailing are not called
// automatically until an admin invites subs by hand for a game, or turns
// the setting back on.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { H, DAY, local, mail, installMailCapture, removeMailCapture, admin, must, pass, rows, one } from './support/league_season.js';
import { getAddEmails, addEmailsKey } from '../src/add_emails.js';

const T0 = Date.parse('2027-03-01T15:00:00Z');
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
  env.AUTH_SECRET = 'p184-auth'; env.RSVP_SECRET = 'p184-rsvp'; env.RESEND_API_KEY = 'p184'; env.LEAGUE_PRODUCT = 'true'; env.PUBLIC_URL = 'https://add.example'; env.MAIL_DAILY_CAP = ''; env.MAIL_HARD_DAILY_CAP = '';
  await applyRealSchema(env);
  installMailCapture();
});
beforeEach(() => { vi.setSystemTime(new Date(T0)); mail.sent.length = 0; });
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

// A fixed-teams league whose next game, in two days, is short of players
// on both teams (nobody on them yet besides one player each): a sub added
// now is called at once.
let seq = 0;
async function league({ shortGame = true } = {}) {
  const tag = `l${++seq}`;
  const a = await admin(`p184.${tag}`);
  const lg = (await must(a.post('/leagues/create', { name: `P184 ${tag}`, teamNames: ['Bulls', 'Parade'] }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'season');
  await must(a.post('/league/contacts', { name: 'Bulls One', email: `${tag}.b1@players.example`, team: 'Bulls' }), 'b');
  await must(a.post('/league/contacts', { name: 'Parade One', email: `${tag}.p1@players.example`, team: 'Parade' }), 'p');
  const d = local(T0 + (shortGame ? 2 : 20) * DAY);
  const ev = (await must(a.post('/league/events', { date: d.date, start_time: '19:00', end_time: '20:00', venue: 'Gym', home_team: 'Bulls', away_team: 'Parade' }), 'ev')).event;
  mail.sent.length = 0;
  return { a, lg, ev, tag };
}
const sub = (tag, i) => ({ name: `Sub Person${String.fromCharCode(65 + i)}`, role: 'sub_skater', email: `${tag}.sub${i + 1}@subs.example` });
const subs = (tag, n) => Array.from({ length: n }, (_, i) => sub(tag, i));
const contactsOf = lg => rows(`SELECT player_id, name, role, email FROM contacts WHERE league_id = ? AND role = 'sub_skater' ORDER BY player_id`, lg.id);
const subCalls = lg => rows(`SELECT player_id, sent_at IS NOT NULL AS sent, cancelled FROM outbox WHERE league_id = ? AND kind = 'sub_call' ORDER BY id`, lg.id);
const toSubs = () => mail.sent.filter(m => /@subs\.example$/.test(m.to));

describe('What adding a player sends, before any setting', () => {
  it('regular players: no email and no warning, one or twenty, with or without a team', async () => {
    const { a, lg } = await league();
    const one1 = await a.post('/league/contacts', { name: 'New Regular', email: 'reg@players.example' });
    expect(one1.status).toBe(200);
    const bulk = await a.post('/league/contacts/bulk', { contacts: Array.from({ length: 20 }, (_, i) => ({ name: `Import Person${String.fromCharCode(65 + i)}`, email: `imp${i}@players.example` })) });
    expect(bulk.json).toMatchObject({ ok: true, createdCount: 20 });
    await pass(T0 + 15 * 60000);
    expect(mail.sent.filter(m => /@players\.example$/.test(m.to))).toEqual([]);
    expect(await subCalls(lg)).toEqual([]);
    expect((await getAddEmails(env.DB, lg.id)).mode).toBe(null); // never asked: nothing to ask about
  });

  it('a substitute, no game short in range: no email, no warning', async () => {
    const { a, lg, tag } = await league({ shortGame: false });
    const r = await a.post('/league/contacts', sub(tag, 0));
    expect(r.status).toBe(200);
    expect(toSubs()).toEqual([]);
    expect((await getAddEmails(env.DB, lg.id)).mode).toBe(null);
  });
});

describe('The first add or import that would email someone: the admin is asked first', () => {
  it('one substitute: 409 with the count, nothing created, nothing sent; asking again changes nothing', async () => {
    const { a, lg, tag } = await league();
    for (let i = 0; i < 2; i++) {
      const r = await a.post('/league/contacts', sub(tag, 0));
      expect(r.status).toBe(409);
      expect(r.json).toMatchObject({ ok: false, errorKey: 'ADD_EMAIL_CHOICE_REQUIRED', needsEmailChoice: true, emailCount: 1, addCount: 1 });
    }
    // Closing the warning is sending nothing more: nothing exists.
    expect(await contactsOf(lg)).toEqual([]);
    expect(await subCalls(lg)).toEqual([]);
    expect(mail.sent).toEqual([]);
    expect(await one('SELECT 1 AS x FROM settings WHERE key = ?', addEmailsKey(lg.id))).toBe(null);
  });

  it('"Add and send emails", one substitute: created, 1 sub call sent, the choice is saved as on, and no warning again', async () => {
    const { a, lg, tag } = await league();
    const r = await a.post('/league/contacts', { ...sub(tag, 0), emailChoice: 'send' });
    expect(r.status).toBe(200);
    expect(await contactsOf(lg)).toHaveLength(1);
    expect(await subCalls(lg)).toEqual([{ player_id: r.json.contact.player_id, sent: 1, cancelled: 0 }]);
    expect(toSubs().map(m => m.to)).toEqual([`${tag}.sub1@subs.example`]);
    expect(await getAddEmails(env.DB, lg.id)).toEqual({ mode: 'on', held: [] });
    // The next one: no question, sent.
    const again = await a.post('/league/contacts', sub(tag, 1));
    expect(again.status).toBe(200);
    expect(toSubs()).toHaveLength(2);
  });

  it('"Add without emailing", one substitute: created, no outbox row, no email now or at the next passes; the league keeps emails on', async () => {
    const { a, lg, tag } = await league();
    const r = await a.post('/league/contacts', { ...sub(tag, 0), emailChoice: 'skip' });
    expect(r.status).toBe(200);
    expect(await contactsOf(lg)).toHaveLength(1);
    await pass(T0 + 15 * 60000);
    await pass(T0 + 30 * 60000);
    expect(await subCalls(lg)).toEqual([]);
    expect(toSubs()).toEqual([]);
    expect(await getAddEmails(env.DB, lg.id)).toEqual({ mode: 'on', held: [r.json.contact.player_id] });
    // The choice was for that add: the next substitute is emailed, without a question.
    const next = await a.post('/league/contacts', sub(tag, 1));
    expect(next.status).toBe(200);
    expect(toSubs().map(m => m.to)).toEqual([`${tag}.sub2@subs.example`]);
  });

  it('"Add without emailing" with "turn off automatic emails": saved as off; later adds never email and never ask', async () => {
    const { a, lg, tag } = await league();
    const r = await a.post('/league/contacts', { ...sub(tag, 0), emailChoice: 'skip', turnOffAutoEmails: true });
    expect(r.status).toBe(200);
    expect((await getAddEmails(env.DB, lg.id)).mode).toBe('off');
    const more = await a.post('/league/contacts/bulk', { contacts: subs(tag, 6).slice(1) });
    expect(more.json).toMatchObject({ ok: true, createdCount: 5 });
    await pass(T0 + 15 * 60000);
    expect(await contactsOf(lg)).toHaveLength(6);
    expect(await subCalls(lg)).toEqual([]);
    expect(toSubs()).toEqual([]);
    expect((await getAddEmails(env.DB, lg.id)).held).toHaveLength(6);
  });

  it('importing 20 substitutes: the count announced is the number emailed; "send" sends 20, once', async () => {
    const { a, lg, tag } = await league();
    const ask = await a.post('/league/contacts/bulk', { contacts: subs(tag, 20) });
    expect(ask.status).toBe(409);
    expect(ask.json).toMatchObject({ needsEmailChoice: true, emailCount: 20, addCount: 20 });
    expect(await contactsOf(lg)).toEqual([]);
    expect(mail.sent).toEqual([]);
    const r = await a.post('/league/contacts/bulk', { contacts: subs(tag, 20), emailChoice: 'send' });
    expect(r.json).toMatchObject({ ok: true, createdCount: 20 });
    // All 20 are queued at once. The game is more than 48 hours away, so
    // the calls go out five at a time, an hour apart (inside 48 hours they
    // all go at once): five now, all twenty within three hours, each once.
    let calls = await subCalls(lg);
    expect(calls).toHaveLength(20);
    expect(calls.every(c => c.cancelled === 0)).toBe(true);
    expect(calls.filter(c => c.sent === 1)).toHaveLength(5);
    expect(toSubs()).toHaveLength(5);
    for (const h of [1, 2, 3]) await pass(T0 + h * H + 5 * 60000);
    calls = await subCalls(lg);
    expect(calls.filter(c => c.sent === 1)).toHaveLength(20);
    expect(toSubs()).toHaveLength(20);
    expect(new Set(toSubs().map(m => m.to)).size).toBe(20);
  });

  it('importing 20 substitutes, "Add without emailing": 20 created, 0 outbox rows, 0 emails', async () => {
    const { a, lg, tag } = await league();
    const r = await a.post('/league/contacts/bulk', { contacts: subs(tag, 20), emailChoice: 'skip' });
    expect(r.json).toMatchObject({ ok: true, createdCount: 20 });
    await pass(T0 + 15 * 60000);
    expect(await contactsOf(lg)).toHaveLength(20);
    expect(await subCalls(lg)).toEqual([]);
    expect(toSubs()).toEqual([]);
    expect((await getAddEmails(env.DB, lg.id)).held).toHaveLength(20);
  });

  it('importing 20 substitutes, "Add without emailing" and turn off: the same, and the league is off', async () => {
    const { a, lg, tag } = await league();
    const r = await a.post('/league/contacts/bulk', { contacts: subs(tag, 20), emailChoice: 'skip', turnOffAutoEmails: true });
    expect(r.json).toMatchObject({ ok: true, createdCount: 20 });
    expect(await subCalls(lg)).toEqual([]);
    expect(toSubs()).toEqual([]);
    expect(await getAddEmails(env.DB, lg.id)).toMatchObject({ mode: 'off' });
  });

  it('a mixed import counts only who would be emailed: 3 substitutes among 10 players, one of them a duplicate', async () => {
    const { a, lg, tag } = await league();
    await must(a.post('/league/contacts', { name: 'Known Person', email: 'known@subs.example' }), 'known');
    const contacts = [...Array.from({ length: 7 }, (_, i) => ({ name: `Reg Person${String.fromCharCode(65 + i)}`, email: `mix${i}@players.example` })), ...subs(tag, 3), { name: 'Known Again', role: 'sub_skater', email: 'KNOWN@subs.example' }, { name: 'No Mail', role: 'sub_skater' }];
    const ask = await a.post('/league/contacts/bulk', { contacts });
    expect(ask.json).toMatchObject({ needsEmailChoice: true, emailCount: 3, addCount: 12 });
    await a.post('/league/contacts/bulk', { contacts, emailChoice: 'send' });
    expect(new Set(toSubs().map(m => m.to)).size).toBe(3);
    expect(await subCalls(lg)).toHaveLength(3);
  });
});

describe('The setting, from the Settings page', () => {
  it('turned off: adds never email and never ask; turned on again: the held substitutes are called at the next pass', async () => {
    const { a, lg, tag } = await league();
    expect((await a.post('/league/settings/add-emails', { enabled: false })).json).toEqual({ ok: true, enabled: false });
    const r = await a.post('/league/contacts', sub(tag, 0));
    expect(r.status).toBe(200);
    await pass(T0 + 15 * 60000);
    expect(toSubs()).toEqual([]);
    expect(await getAddEmails(env.DB, lg.id)).toEqual({ mode: 'off', held: [r.json.contact.player_id] });
    expect((await a.post('/league/settings/add-emails', { enabled: true })).json).toEqual({ ok: true, enabled: true });
    expect(await getAddEmails(env.DB, lg.id)).toEqual({ mode: 'on', held: [] });
    await pass(T0 + 30 * 60000);
    expect(toSubs().map(m => m.to)).toEqual([`${tag}.sub1@subs.example`]);
    // And a new one is emailed when added.
    await a.post('/league/contacts', sub(tag, 1));
    expect(toSubs()).toHaveLength(2);
    expect((await a.post('/league/settings/add-emails', { enabled: 'yes' })).status).toBe(400);
  });

  it('the settings page shows the switch in the state saved', async () => {
    const { a } = await league();
    let html = (await a.get('/league/settings')).text;
    expect(html).toContain('id="add_emails_switch"');
    expect(html).toMatch(/aria-checked="true" id="add_emails_switch"/);
    await a.post('/league/settings/add-emails', { enabled: false });
    html = (await a.get('/league/settings')).text;
    expect(html).toMatch(/aria-checked="false" id="add_emails_switch"/);
    expect(html).toContain('Envoyer un courriel aux joueurs lorsqu\'ils sont ajoutés');
    const dict = JSON.parse(html.match(/var __I18N = (\{[\s\S]*?\});\n/)[1]);
    expect(dict.en.addEmailsLabel).toBe('Email players when they are added');
    expect(dict.fr.addEmailsLabel).toBe("Envoyer un courriel aux joueurs lorsqu'ils sont ajoutés");
  });
});

describe('Inviting by hand the substitutes added without emailing', () => {
  it('"Invite subs" on the game page invites them, and they are in the automatic calls again', async () => {
    const { a, lg, ev, tag } = await league();
    await a.post('/league/contacts/bulk', { contacts: subs(tag, 3), emailChoice: 'skip', turnOffAutoEmails: true });
    expect(toSubs()).toEqual([]);
    const r = await a.post('/league/events/invite-subs', { event_id: ev.id, team: 'Bulls', need: 'skater' });
    expect(r.json).toMatchObject({ ok: true });
    expect(new Set(toSubs().map(m => m.to)).size).toBe(3);
    expect((await getAddEmails(env.DB, lg.id))).toEqual({ mode: 'off', held: [] });
  });
});

describe('SMBHL', () => {
  it('has no such setting and no such list: its sub pool is read as before', async () => {
    expect(await one('SELECT 1 AS x FROM settings WHERE key = ?', addEmailsKey('smbhl'))).toBe(null);
    expect(await getAddEmails(env.DB, 'smbhl')).toEqual({ mode: null, held: [] });
  });
});

// Making a regular player a sub follows "Email players when they are added"
// (src/add_emails.js), like adding a sub does.
//
// The only league path that changes a role is POST /league/contacts/update
// (the Players page's role button). A new sub is called by email at once
// when a game in range is short at their position. So:
//   - setting on: unchanged, called at once;
//   - setting off: the role changes and the player is held (no automatic
//     call until "Invite players" / "Invite a goalie" on a game's page, or
//     the setting is turned back on);
//   - no choice saved yet, and they would be called now: 409 with
//     needsEmailChoice and roleChange, and the role is not changed until
//     the page sends the answer.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { DAY, local, mail, installMailCapture, removeMailCapture, admin, must, pass, rows, one } from './support/league_season.js';
import { getAddEmails } from '../src/add_emails.js';

const T0 = Date.parse('2027-03-01T15:00:00Z');
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
  env.AUTH_SECRET = 'p186-auth'; env.RSVP_SECRET = 'p186-rsvp'; env.RESEND_API_KEY = 'p186'; env.LEAGUE_PRODUCT = 'true'; env.PUBLIC_URL = 'https://role.example'; env.MAIL_DAILY_CAP = ''; env.MAIL_HARD_DAILY_CAP = '';
  await applyRealSchema(env);
  installMailCapture();
});
beforeEach(() => { vi.setSystemTime(new Date(T0)); mail.sent.length = 0; });
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

let seq = 0;
// A league whose game in two days is short on both teams, and a regular
// player with no team who is about to be made a sub.
async function league({ setting = null, shortGame = true } = {}) {
  const tag = `r${++seq}`;
  const a = await admin(`p186.${tag}`);
  const lg = (await must(a.post('/leagues/create', { name: `P186 ${tag}`, teamNames: ['Bulls', 'Parade'] }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'season');
  await must(a.post('/league/contacts', { name: 'Bulls One', email: `${tag}.b1@players.example`, team: 'Bulls' }), 'b');
  await must(a.post('/league/contacts', { name: 'Parade One', email: `${tag}.p1@players.example`, team: 'Parade' }), 'p');
  const pid = (await must(a.post('/league/contacts', { name: 'Soon Sub', email: `${tag}.soon@players.example` }), 'c')).contact.player_id;
  const d = local(T0 + (shortGame ? 2 : 20) * DAY);
  await must(a.post('/league/events', { date: d.date, start_time: '19:00', end_time: '20:00', venue: 'Gym', home_team: 'Bulls', away_team: 'Parade' }), 'ev');
  if (setting !== null) await must(a.post('/league/settings/add-emails', { enabled: setting }), 'setting');
  mail.sent.length = 0;
  return { a, lg, pid, tag };
}
const roleOf = pid => one('SELECT role FROM contacts WHERE player_id = ?', pid);
const callsTo = pid => rows(`SELECT sent_at IS NOT NULL AS sent FROM outbox WHERE kind = 'sub_call' AND player_id = ?`, pid);

describe('Making a regular player a sub', () => {
  it('setting on: the role changes and they are called at once, as before', async () => {
    const { a, pid } = await league({ setting: true });
    const r = await a.post('/league/contacts/update', { player_id: pid, role: 'sub_skater' });
    expect(r.status).toBe(200);
    expect(await roleOf(pid)).toEqual({ role: 'sub_skater' });
    expect(await callsTo(pid)).toEqual([{ sent: 1 }]);
  });

  it('setting off: the role changes, no call now or at the next passes, held; turning it on calls them', async () => {
    const { a, lg, pid } = await league({ setting: false });
    const r = await a.post('/league/contacts/update', { player_id: pid, role: 'sub_skater' });
    expect(r.status).toBe(200);
    expect(await roleOf(pid)).toEqual({ role: 'sub_skater' });
    await pass(T0 + 15 * 60000);
    expect(await callsTo(pid)).toEqual([]);
    expect((await getAddEmails(env.DB, lg.id)).held).toEqual([pid]);
    await must(a.post('/league/settings/add-emails', { enabled: true }), 'on');
    await pass(T0 + 30 * 60000);
    expect(await callsTo(pid)).toEqual([{ sent: 1 }]);
  });

  it('no choice saved: 409 with roleChange, the role unchanged; "send" makes the change and the call', async () => {
    const { a, lg, pid } = await league();
    const r = await a.post('/league/contacts/update', { player_id: pid, role: 'sub_skater' });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ needsEmailChoice: true, roleChange: true, emailCount: 1, addCount: 1 });
    expect(await roleOf(pid)).toEqual({ role: 'roster' });
    expect(await callsTo(pid)).toEqual([]);
    const ok = await a.post('/league/contacts/update', { player_id: pid, role: 'sub_skater', emailChoice: 'send' });
    expect(ok.status).toBe(200);
    expect(await callsTo(pid)).toEqual([{ sent: 1 }]);
    expect((await getAddEmails(env.DB, lg.id)).mode).toBe('on');
  });

  it('no choice saved, "skip" and turn off: the change is made, no call, the league is off', async () => {
    const { a, lg, pid } = await league();
    const ok = await a.post('/league/contacts/update', { player_id: pid, role: 'sub_skater', emailChoice: 'skip', turnOffAutoEmails: true });
    expect(ok.status).toBe(200);
    await pass(T0 + 15 * 60000);
    expect(await roleOf(pid)).toEqual({ role: 'sub_skater' });
    expect(await callsTo(pid)).toEqual([]);
    expect(await getAddEmails(env.DB, lg.id)).toMatchObject({ mode: 'off', held: [pid] });
  });

  it('no game short in range: no question, the change is made', async () => {
    const { a, pid } = await league({ shortGame: false });
    const r = await a.post('/league/contacts/update', { player_id: pid, role: 'sub_skater' });
    expect(r.status).toBe(200);
    expect(await roleOf(pid)).toEqual({ role: 'sub_skater' });
  });

  it('other changes (a team, back to regular) are not asked about', async () => {
    const { a, pid } = await league();
    expect((await a.post('/league/contacts/update', { player_id: pid, team: 'Bulls' })).status).toBe(200);
    expect((await a.post('/league/contacts/update', { player_id: pid, role: 'roster' })).status).toBe(200);
  });
});

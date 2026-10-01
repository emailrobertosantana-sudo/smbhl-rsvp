// Bugs found by driving leagues unlike SMBHL through a season
// (part152_league_shapes). Each test fails on the code before its fix.
//  1. A league sub was placed using SMBHL's season config (SMBHL's teams
//     Red/Blue/White/Black and roster sizes): in a Red/Blue/Green league a
//     sub called for Green landed on Black, White or Blue.
//  2. The admin's "extra invite" named a team the same way.
//  3. Cancelling a league game left its unsent mail queued: a later sub-call
//     wave (or a reminder waiting out quiet hours) still went out.
//  4. The late-reversal alert to the admin began ": Name ..." when the player
//     had no roster team (a pickup player, a sub), named the roster team
//     instead of the team they were on for that game, and always said subs
//     had been invited -- also when none were.
//  5. A no-teams league's details email said "Équipe Tous / Team Tous".
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { wideSubCallWindow } from './support/wide_sub_call_window.js'; // the 8-day sub-call window these tests were written for
import { H, DAY, local, mail, installMailCapture, removeMailCapture, linksIn, admin, must, pass, answer, rows, one } from './support/league_season.js';
import { acceptAvailability, callSubsForShortfall, drain } from '../src/index.js';

const START = Date.UTC(2026, 9, 5, 16, 0); // Mon 2026-10-05 12:00 Toronto

beforeAll(async () => {
  env.LEAGUE_PRODUCT = 'true';
  env.RESEND_API_KEY = 'x'; env.RSVP_SECRET = 'p153'; env.AUTH_SECRET = 'p153-auth';
  env.MAIL_DAILY_CAP = '';
  env.PUBLIC_URL = 'https://rsvp.example.com';
  vi.useFakeTimers({ toFake: ['Date'] });
  await applyRealSchema(env); await wideSubCallWindow(env);
  installMailCapture();
});
beforeEach(() => { vi.setSystemTime(new Date(START)); mail.sent.length = 0; });
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

async function league(tag, { structure = 'fixed', teams = ['Red', 'Blue', 'Green'], create = {}, reminders = { reminder72h: true, reminder24h: true, reminder12h: true } } = {}) {
  const a = await admin(tag);
  const lg = (await must(a.post('/leagues/create', { name: `B ${tag}`, teamStructure: structure, teamNames: teams, tracksStats: true, ...create }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  await must(a.post('/league/reminders/settings', reminders), 'reminders');
  return { a, id: lg.id };
}
async function contact(a, name, team, role = 'roster', goalie = false) {
  const r = await must(a.post('/league/contacts', { name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`, team: team || '', role, ...(goalie ? { is_goalie: true } : {}) }), 'contact ' + name);
  return r.contact.player_id;
}
async function game(leagueId, suffix, startMs, home = null, away = null) {
  const { date, time } = local(startMs);
  const id = `${leagueId}:${suffix}:${date}`;
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, home_team, away_team, auto_reminders_enabled) VALUES (?, 'S1', 1, ?, 'Gym', 'open', ?, ?, ?, ?, 1)`)
    .bind(id, date, time, leagueId, home, away).run();
  return one('SELECT * FROM events WHERE id = ?', id);
}
const answerIn = (evId, pid, team) => env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) SELECT ?, ?, ?, 'in', 'roster', 'self', ?, league_id FROM events WHERE id = ?`).bind(evId, pid, team, new Date().toISOString(), evId).run();

describe('1-2. A league sub is placed, and named, by the LEAGUE\'s teams', () => {
  it('Green is short in a Green v Red game: the sub goes to Green, never to one of SMBHL\'s teams', async () => {
    const { a, id } = await league('place');
    for (let i = 0; i < 6; i++) { const pid = await contact(a, `Red P${i}`, 'Red', 'roster', i === 0); await answerIn(`${id}:gr:${local(START + 3 * DAY).date}`, pid, 'Red'); }
    const g = await contact(a, 'Green Goalie', 'Green', 'roster', true);
    const sub = await contact(a, 'Place Sub', null, 'sub_skater');
    const ev = await game(id, 'gr', START + 3 * DAY, 'Green', 'Red');
    await answerIn(ev.id, g, 'Green');
    const r = await acceptAvailability(env, ev, sub, 'skater');
    expect(r.placed).toBe('Green');
  });

  it('the admin\'s extra invite names a team in the game from the league\'s own teams', async () => {
    const { a, id } = await league('extra');
    for (let i = 0; i < 6; i++) await contact(a, `Xr P${i}`, 'Red', 'roster', i === 0);
    const sub = await contact(a, 'Extra Sub', null, 'sub_skater');
    const ev = await game(id, 'gr', START + 3 * DAY, 'Green', 'Red');
    const r = await a.post('/league/subs/extra-invite', { event_id: ev.id, player_id: sub });
    expect(r.status).toBe(200);
    const row = await one(`SELECT team FROM outbox WHERE event_id = ? AND player_id = ? AND kind = 'sub_call' ORDER BY id DESC`, ev.id, sub);
    expect(['Green', 'Red']).toContain(row.team);
    expect(row.team).toBe('Green'); // the empty team: its league's config says Green plays, SMBHL's has no Green
  });
});

describe('3. Cancelling a league game drops its mail not yet sent', () => {
  it('a later sub-call wave queued before the cancel never goes out', async () => {
    const { a, id } = await league('cancel', { teams: ['Red', 'Blue'] });
    for (let i = 0; i < 12; i++) await contact(a, `Cancel Sub${i}`, null, 'sub_skater');
    const ev = await game(id, 'rb', START + 5 * DAY, 'Red', 'Blue'); // both teams empty: short, waves of 5
    expect(await callSubsForShortfall(env, ev)).toBeGreaterThan(5);
    await drain(env);
    const unsent = (await one(`SELECT count(*) n FROM outbox WHERE event_id = ? AND sent_at IS NULL AND cancelled = 0`, ev.id)).n;
    expect(unsent).toBeGreaterThan(0); // the later waves, waiting
    const before = mail.sent.length;
    const c = await a.post('/league/events/cancel', { event_id: ev.id });
    expect(c.status).toBe(200);
    expect(c.json.cancelled_outbox).toBe(unsent);
    vi.setSystemTime(new Date(START + 2 * DAY));
    await drain(env);
    expect(mail.sent.length).toBe(before);
    expect((await one(`SELECT count(*) n FROM outbox WHERE event_id = ? AND sent_at IS NULL AND cancelled = 0`, ev.id)).n).toBe(0);
  });
});

// Runs the cron until the 12h details email reaches `email`, then clicks its
// "can't play anymore" link; returns the alert the admin got.
async function lateOut(tag, email, gameStart) {
  for (let t = START + H; t <= gameStart; t += H) {
    await pass(t);
    const details = mail.sent.find(m => m.to === email && /détails|details/i.test(m.subject));
    if (details) {
      const out = linksIn(details, '/league/rsvp').find(l => new URL(l).searchParams.get('v') === 'out');
      expect(out).toBeTruthy();
      const r = await answer(out);
      expect(r.postRes.status).toBe(303);
      return mail.sent.filter(m => m.to === `admin.${tag}@example.com` && /dropped out|désister/.test(m.subject));
    }
    // players answer "in" to their reminders as they arrive
    for (const m of mail.sent.filter(x => !x.seen)) {
      m.seen = true;
      const inLink = linksIn(m, '/league/rsvp').find(l => new URL(l).searchParams.get('v') === 'in');
      if (inLink && /décidé|decided/i.test(m.subject)) await answer(inLink);
    }
  }
  throw new Error('no details email arrived');
}

describe('4. The late-reversal alert says what happened', () => {
  it('fixed teams, not short, no subs: "Red: Name ...", and no claim that subs were invited', async () => {
    const { a, id } = await league('late', { teams: ['Red', 'Blue'] });
    for (let i = 0; i < 7; i++) await contact(a, `Late Red${i}`, 'Red', 'roster', i === 0);
    for (let i = 0; i < 7; i++) await contact(a, `Late Blue${i}`, 'Blue', 'roster', i === 0);
    const st = START + 4 * DAY;
    await game(id, 'rb', st, 'Red', 'Blue');
    const alerts = await lateOut('late', 'late.red3@example.com', st);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toMatch(/^Red: Late Red3 vient de se désister/);
    expect(alerts[0].subject).not.toMatch(/^: /);
    expect(alerts[0].text).not.toMatch(/Subs invited|invitation aux remplaçants/);
  }, 120000);

  it('pickup: names the DRAWN team for that game, never ": Name"', async () => {
    const { a, id } = await league('latepick', { structure: 'weekly_draw', teams: ['Dark', 'Light'], reminders: { reminder72h: true, reminder24h: true, reminder12h: true, autoDrawEnabled: true } });
    for (let i = 0; i < 10; i++) await contact(a, `Pick Late${i}`, null, 'roster', i < 2);
    const st = START + 4 * DAY;
    await game(id, 'pk', st);
    const alerts = await lateOut('latepick', 'pick.late4@example.com', st);
    expect(alerts).toHaveLength(1);
    const drawn = await one(`SELECT r.team FROM rsvp r JOIN contacts c ON c.player_id = r.player_id WHERE c.email = 'pick.late4@example.com'`);
    expect(['Dark', 'Light']).toContain(drawn.team);
    expect(alerts[0].subject.startsWith(`${drawn.team}: Pick Late4`)).toBe(true);
    expect(alerts[0].text).not.toMatch(/Subs invited|invitation aux remplaçants/);
  }, 120000);
});

describe('5. A no-teams league\'s details email names no team', () => {
  it('never "Équipe Tous / Team Tous"', async () => {
    const { a, id } = await league('tous', { structure: 'headcount', teams: [], create: { minPlayers: 4, maxPlayers: 12, minGoalies: 0 } });
    for (let i = 0; i < 6; i++) await contact(a, `Tous P${i}`, null);
    const st = START + 4 * DAY;
    await game(id, 'hc', st);
    for (let t = START + H; t <= st && !mail.sent.some(m => /détails|details/i.test(m.subject)); t += H) {
      await pass(t);
      for (const m of mail.sent.filter(x => !x.seen)) {
        m.seen = true;
        const inLink = linksIn(m, '/league/rsvp').find(l => new URL(l).searchParams.get('v') === 'in');
        if (inLink && /décidé|decided/i.test(m.subject)) await answer(inLink);
      }
    }
    const details = mail.sent.filter(m => /détails|details/i.test(m.subject));
    expect(details.length).toBeGreaterThan(0);
    for (const m of details) {
      expect(m.text).not.toMatch(/Tous/);
      expect(m.html).not.toMatch(/Équipe Tous|Team Tous/);
    }
  }, 120000);
});

// 6. A league game stays 'open' after it is played (SMBHL's cron locks its
// own): an old email link changed a player's answer after the game -- and
// the 12h email's "can't make it" told the admin they had just dropped
// out -- and a sub could still say yes and be placed.
describe('6. A league game takes no answers once it has started', () => {
  it('an old "can\'t make it" link after the game changes nothing and alerts nobody; a sub\'s yes is closed', async () => {
    const { a, id } = await league('after', { teams: ['Red', 'Blue'] });
    for (let i = 0; i < 7; i++) await contact(a, `After Red${i}`, 'Red', 'roster', i === 0);
    for (let i = 0; i < 7; i++) await contact(a, `After Blue${i}`, 'Blue', 'roster', i === 0);
    const sub = await contact(a, 'After Sub', null, 'sub_skater');
    const st = START + 4 * DAY;
    const ev = await game(id, 'rb', st, 'Red', 'Blue');
    // Everyone answers in; the 12h details email arrives.
    let details = null;
    for (let t = START + H; t <= st && !details; t += H) {
      await pass(t);
      for (const m of mail.sent.filter(x => !x.seen)) {
        m.seen = true;
        const inLink = linksIn(m, '/league/rsvp').find(l => new URL(l).searchParams.get('v') === 'in');
        if (inLink && /décidé|decided/i.test(m.subject)) await answer(inLink);
      }
      details = mail.sent.find(m => m.to === 'after.red2@example.com' && /détails|details/i.test(m.subject));
    }
    expect(details).toBeTruthy();
    const out = linksIn(details, '/league/rsvp').find(l => new URL(l).searchParams.get('v') === 'out');
    // The day after the game.
    vi.setSystemTime(new Date(st + 20 * H));
    const alertsBefore = mail.sent.filter(m => /dropped out/.test(m.subject)).length;
    const page = await (await SELF.fetch(out)).text();
    expect(page).not.toContain('rv_confirm'); // no button to press
    expect(page).toContain("n'accepte plus de réponses");
    const post = await SELF.fetch(new URL('/league/rsvp/confirm?' + new URL(out).searchParams.toString(), out).toString(), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'status=out&src=logistics12h', redirect: 'manual'
    });
    expect([303, 200]).toContain(post.status);
    const row = await one(`SELECT r.status FROM rsvp r JOIN contacts c ON c.player_id = r.player_id WHERE r.event_id = ? AND c.email = 'after.red2@example.com'`, ev.id);
    expect(row.status).toBe('in');
    expect(mail.sent.filter(m => /dropped out/.test(m.subject)).length).toBe(alertsBefore);
    // A sub's availability link, after the game: closed, not placed.
    const { hmac } = await import('../src/crypto_utils.js');
    const c = await one('SELECT token_salt FROM contacts WHERE player_id = ?', sub);
    const t = await hmac(env.RSVP_SECRET, `a:${ev.id}:${sub}:skater:${c.token_salt}`);
    const avail = `http://example.com/avail?e=${encodeURIComponent(ev.id)}&p=${encodeURIComponent(sub)}&n=skater&t=${t}&a=yes`;
    const availPage = await (await SELF.fetch(avail)).text();
    expect(availPage).toContain('Responses are closed');
    const availPost = await SELF.fetch(avail, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=yes' });
    expect(await availPost.text()).toContain('Responses are closed');
    expect(await one('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?', ev.id, sub)).toBeNull();
  }, 120000);
});

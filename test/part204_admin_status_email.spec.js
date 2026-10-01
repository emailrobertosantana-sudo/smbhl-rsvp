// "Notify the player" (« Aviser le joueur »): when an admin sets a player
// present or absent on the league game page, one short email, through the
// outbox. Checked by default, unchecked once the game has started. Skipped
// for no address, off game emails, nothing changed, or an action that sends
// its own email (an SMBHL sub placement).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must } from './support/league_season.js';
import { renderAdminStatusEmail, drain } from '../src/index.js';

const one = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const rows = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then(r => r.results || []);
let a, league, ev, past, lea, max, nomail, optout;
const statusMails = playerId => rows("SELECT payload, sent_at FROM outbox WHERE kind = 'admin_status' AND player_id = ? ORDER BY id", playerId);
const set = (playerId, status, notify, event = ev) => a.post('/league/rsvp/admin', { event_id: event.id, player_id: playerId, status, scope: 'night', ...(notify === undefined ? {} : { notify }) });

beforeAll(async () => {
  env.AUTH_SECRET = 'p204-auth'; env.RSVP_SECRET = 'p204-rsvp'; env.LEAGUE_PRODUCT = 'true';
  delete env.MAIL_HARD_DAILY_CAP;
  await applyRealSchema(env);
  a = await admin('p204');
  league = (await must(a.post('/leagues/create', { name: 'Ligue Avis', teamNames: ['A', 'B'] }), 'league')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'season');
  await env.DB.prepare("UPDATE leagues SET language_mode = 'fr' WHERE id = ?").bind(league.id).run();
  const add = async (name, email) => (await must(a.post('/league/contacts', { name, email, role: 'roster', team: 'A', emailChoice: 'skip' }), name)).contact;
  lea = await add('Léa Joueuse', 'lea.p204@example.com');
  max = await add('Max Joueur', 'max.p204@example.com');
  nomail = await add('Sans Courriel', '');
  optout = await add('Désabonné Joueur', 'off.p204@example.com');
  await env.DB.prepare('UPDATE contacts SET opted_out = 1 WHERE player_id = ?').bind(optout.player_id).run();
  ev = (await must(a.post('/league/events', { date: '2099-11-15', start_time: '19:00', end_time: '20:00', venue: 'Gym', season: 'S1' }), 'event')).event;
  past = (await must(a.post('/league/events', { date: '2020-11-15', start_time: '19:00', end_time: '20:00', venue: 'Gym', season: 'S1' }), 'past')).event;
});

describe('present and absent, checked', () => {
  it('present: one email, its subject and body, the answer link', async () => {
    const r = await set(lea.player_id, 'in', true);
    expect(r.json).toMatchObject({ ok: true, notified: 1 });
    const m = await statusMails(lea.player_id);
    expect(m).toHaveLength(1);
    const p = JSON.parse(m[0].payload).prerendered;
    expect(p.to).toBe('lea.p204@example.com');
    expect(p.subject).toBe('Ligue Avis : ta présence est confirmée, dimanche 15 nov. · 19 h');
    expect(p.text).toContain("L'organisateur a confirmé ta présence au match dimanche 15 nov. · 19 h. Si ce n'est pas le cas, change ta réponse ici : ");
    expect(p.text).toContain('/league/rsvp?league=');
    expect(p.text).toContain('&v=out');
    expect(p.text).not.toMatch(/organizer|confirmed you/);
  });

  it('absent: its own subject and body; it replaces a pending one for the same player', async () => {
    const r = await set(lea.player_id, 'out', true);
    expect(r.json).toMatchObject({ notified: 1 });
    const m = await statusMails(lea.player_id);
    const p = JSON.parse(m[m.length - 1].payload).prerendered;
    expect(p.subject).toBe('Ligue Avis : ton absence est notée, dimanche 15 nov. · 19 h');
    expect(p.text).toContain("L'organisateur a noté ton absence au match dimanche 15 nov. · 19 h. Si tu peux venir, change ta réponse ici : ");
    expect(p.text).toContain('&v=in');
    const pending = await rows("SELECT id FROM outbox WHERE kind = 'admin_status' AND player_id = ? AND sent_at IS NULL AND cancelled = 0", lea.player_id);
    expect(pending).toHaveLength(1);
  });

  it('nothing changed: no email', async () => {
    const r = await set(lea.player_id, 'out', true);
    expect(r.json).toMatchObject({ notified: 0 });
  });
});

describe('unchecked, and the skips', () => {
  it('unchecked (or not sent): no email', async () => {
    expect((await set(max.player_id, 'in', false)).json).toMatchObject({ ok: true, notified: 0 });
    expect((await set(max.player_id, 'out')).json).toMatchObject({ ok: true, notified: 0 });
    expect(await statusMails(max.player_id)).toEqual([]);
  });

  it('no email address, or off game emails: skipped without error', async () => {
    expect((await set(nomail.player_id, 'in', true)).json).toMatchObject({ ok: true, notified: 0 });
    expect((await set(optout.player_id, 'in', true)).json).toMatchObject({ ok: true, notified: 0 });
    expect(await statusMails(nomail.player_id)).toEqual([]);
    expect(await statusMails(optout.player_id)).toEqual([]);
  });

  it('the daily budget: queued, and held back when the day is spent', async () => {
    await set(max.player_id, 'in', true);
    env.MAIL_HARD_DAILY_CAP = '1';
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare('INSERT INTO mail_daily_count (day, sent, sub_calls) VALUES (?, 5, 0) ON CONFLICT(day) DO UPDATE SET sent = 5').bind(day).run();
    await drain(env);
    const m = await statusMails(max.player_id);
    expect(m.length).toBe(1);
    expect(m[0].sent_at).toBeNull();
    delete env.MAIL_HARD_DAILY_CAP;
  });
});

describe('the checkbox on the game page', () => {
  it('checked for a game to come, unchecked for one that has started', async () => {
    const html = (await a.get(`/league/events/detail?e=${encodeURIComponent(ev.id)}`)).text;
    expect(html).toMatch(/<input type="checkbox" id="notify_player" checked/);
    expect(html).toContain('Aviser le joueur');
    expect(html).toContain("notifiedMsg");
    const old = (await a.get(`/league/events/detail?e=${encodeURIComponent(past.id)}`)).text;
    expect(old).toMatch(/<input type="checkbox" id="notify_player" style=/);
  });
});

describe('the email, rendered', () => {
  const evRow = { id: 'x:2099-11-15', date: '2099-11-15', start_time: '19:30', season: 'S1' };
  it('English', async () => {
    await env.DB.prepare("UPDATE leagues SET language_mode = 'en' WHERE id = ?").bind(league.id).run();
    const c = await one('SELECT * FROM contacts WHERE player_id = ?', lea.player_id);
    const p = (await renderAdminStatusEmail(env, league.id, { ...evRow, id: ev.id }, c, 'in')).mail;
    expect(p.subject).toBe("Ligue Avis: you're confirmed, Sunday Nov 15 · 7:30 PM");
    expect(p.text).toContain("The organizer confirmed you for the game Sunday Nov 15 · 7:30 PM. If that's not right, change your answer here: ");
    const out = (await renderAdminStatusEmail(env, league.id, { ...evRow, id: ev.id }, c, 'out')).mail;
    expect(out.subject).toBe("Ligue Avis: you're marked absent, Sunday Nov 15 · 7:30 PM");
    expect(out.text).toContain('The organizer marked you absent for the game Sunday Nov 15 · 7:30 PM. If you can come, change your answer here: ');
    expect(p.html).toContain('Change my answer');
    expect(p.html).toContain('href="https://notreligue.ca/confidentialite#en"');
    await env.DB.prepare("UPDATE leagues SET language_mode = 'fr' WHERE id = ?").bind(league.id).run();
  });

  it('SMBHL: French then English, its usual subject form', async () => {
    const c = { player_id: 'P2040', name: 'Marc Tremblay', email: 'marc@example.com', token_salt: 's' };
    const p = (await renderAdminStatusEmail(env, 'smbhl', { id: 'smbhl:2099-11-15', date: 'Sunday November 15 2099', start_time: '10:30', season: 'Fall 2099' }, c, 'out')).mail;
    expect(p.subject).toBe("SMBHL : ton absence est notée, dimanche 15 nov. · 10 h 30 / SMBHL: you're marked absent, Sunday Nov 15 · 10:30 AM");
    const [fr, en] = p.text.split('\n\n---\n\n');
    expect(fr).toContain("L'organisateur a noté ton absence au match dimanche 15 nov. · 10 h 30.");
    expect(en).toContain('The organizer marked you absent for the game Sunday Nov 15 · 10:30 AM.');
    expect(p.text).toContain('/rsvp?e=smbhl%3A2099-11-15&p=P2040&t=');
    expect(p.html).toContain('Changer ma réponse / Change my answer');
  });
});

describe('an action that sends its own email', () => {
  it('an SMBHL sub placement: its own email, no second one', async () => {
    env.ADMIN_KEY = 'p204-admin';
    delete env.LEAGUE_PRODUCT;
    await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: 'Fall 2099', seasons: [{ name: 'Fall 2099', config: { teams: [{ name: 'Red' }, { name: 'Blue' }] }, fixtures: [], standings: [] }], players: [] }));
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES ('smbhl:2099-11-22', 'Fall 2099', 1, 'Sunday November 22 2099', 'Aréna', 'open', '10:30', 'smbhl')`).run();
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES ('S2041', 'Sam Sub', 'sam.p204@example.com', 'sub_skater', 1, 0, 's', 'smbhl')`).run();
    const r = await SELF.fetch('http://example.com/admin/subs/reassign', { method: 'POST', headers: { 'x-admin': 'p204-admin', 'content-type': 'application/json' }, body: JSON.stringify({ event_id: 'smbhl:2099-11-22', player_id: 'S2041', team: 'Red' }) });
    expect(r.status).toBe(200);
    expect(await statusMails('S2041')).toEqual([]);
    env.LEAGUE_PRODUCT = 'true';
  });
});

// Payment reminders (src/payment_reminders.js), SMBHL and Notre Ligue:
// sent by hand from the finance page to the checked players who owe money,
// from the finance page's own balances; only that league's admins, only
// that league's players; the preview queues nothing; today's budget is
// checked before anything is queued.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must } from './support/league_season.js';
import { renderPaymentReminder } from '../src/index.js';
import { paymentLine, normalizePhone, formatPhone, cleanNote, paymentReminderLines } from '../src/payment_reminders.js';

const KEY = 'p200-admin';
const SEASON = 'Fall 2099';
let lg, other, original;
const sent = [];
const rows = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then(r => r.results || []);
const reminders = leagueId => rows("SELECT player_id, payload, sent_at, created_at FROM outbox WHERE kind = 'payment_reminder' AND league_id = ? ORDER BY id", leagueId);
const adminPost = (path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { 'x-admin': KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const adminGet = path => SELF.fetch('http://example.com' + path, { headers: { 'x-admin': KEY } });
const contact = (id, name, email, league, role = 'roster') => env.DB.prepare(
  `INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id, is_active) VALUES (?, ?, ?, ?, ?, 0, 's', ?, 1)`
).bind(id, name, email, role, role === 'roster' ? 0 : 1, league).run();
const paid = (league, season, id, amount) => env.DB.prepare(
  `INSERT INTO player_dues (league_id, season, player_id, custom_due, adjustment, amount_paid, notes, updated_at) VALUES (?, ?, ?, NULL, 0, ?, '', '2026-10-01T00:00:00Z')`
).bind(league, season, id, amount).run();

beforeAll(async () => {
  env.AUTH_SECRET = 'p200-auth'; env.RSVP_SECRET = 'p200-rsvp'; env.ADMIN_KEY = KEY; env.RESEND_API_KEY = 'p200-resend';
  env.LEAGUE_PRODUCT = 'true';
  delete env.MAIL_DAILY_CAP; delete env.MAIL_HARD_DAILY_CAP;
  await applyRealSchema(env);
  original = globalThis.fetch;
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) { sent.push(JSON.parse(opts.body)); return new Response('{"id":"x"}', { status: 200 }); }
    return inner(url, opts);
  };

  // SMBHL: three regulars on Red, from data.json; the default season fee (170 $).
  await env.SHEETS_KV.put('data_json', JSON.stringify({
    current_season: SEASON,
    seasons: [{ name: SEASON, config: { teams: [{ name: 'Red' }] }, fixtures: [], standings: [] }],
    players: [
      { id: 'P2001', name: 'Alex Owing', seasons: { [SEASON]: { team: 'Red', gp: 0 } } },
      { id: 'P2002', name: 'Bea Paid', seasons: { [SEASON]: { team: 'Red', gp: 0 } } },
      { id: 'P2003', name: 'Cam Noemail', seasons: { [SEASON]: { team: 'Red', gp: 0 } } },
      { id: 'P2004', name: 'Dee Owing', seasons: { [SEASON]: { team: 'Red', gp: 0 } } }
    ]
  }));
  await contact('P2001', 'Alex Owing', 'alex.p200@example.com', 'smbhl');
  await contact('P2002', 'Bea Paid', 'bea.p200@example.com', 'smbhl');
  await contact('P2003', 'Cam Noemail', null, 'smbhl');
  await contact('P2004', 'Dee Owing', 'dee.p200@example.com', 'smbhl');
  await paid('smbhl', SEASON, 'P2002', 170);

  // Notre Ligue: a French-only league, 85 $ season fee.
  lg = await admin('p200.league');
  lg.league = (await must(lg.post('/leagues/create', { name: 'Ligue Deux Cents', teamNames: ['A', 'B'] }), 'league')).league;
  await must(lg.post('/league/season/publish', { season_name: 'S1' }), 'season');
  await env.DB.prepare("UPDATE leagues SET language_mode = 'fr' WHERE id = ?").bind(lg.league.id).run();
  await must(lg.post('/league/finances/pricing', { season: 'S1', mode: 'season', price_player: 85, price_goalie: 0, price_game_player: 5, price_game_goalie: 0 }), 'pricing');
  await contact(`${lg.league.id}:L1`, 'Léa Doit', 'lea.p200@example.com', lg.league.id);
  await contact(`${lg.league.id}:L2`, 'Max Doit', 'max.p200@example.com', lg.league.id);
  other = await admin('p200.other');
  other.league = (await must(other.post('/leagues/create', { name: 'Autre Ligue', teamNames: ['C', 'D'] }), 'other')).league;
  await contact(`${other.league.id}:O1`, 'Olivier Ailleurs', 'o.p200@example.com', other.league.id);
});
afterAll(() => { globalThis.fetch = original; });

describe('the email', () => {
  it('the payment line: email and mobile, email only, mobile only, in French and English', () => {
    const both = { email: 'paye@ligue.ca', phone: '5145551234' };
    expect(paymentLine('fr', both)).toBe('Envoie ton virement Interac à paye@ligue.ca ou au 514-555-1234.');
    expect(paymentLine('en', both)).toBe('Send your Interac e-Transfer to paye@ligue.ca or 514-555-1234.');
    expect(paymentLine('fr', { email: 'paye@ligue.ca', phone: '' })).toBe('Envoie ton virement Interac à paye@ligue.ca.');
    expect(paymentLine('en', { email: 'paye@ligue.ca', phone: '' })).toBe('Send your Interac e-Transfer to paye@ligue.ca.');
    expect(paymentLine('fr', { email: '', phone: '5145551234' })).toBe('Envoie ton virement Interac au 514-555-1234.');
    expect(paymentLine('en', { email: '', phone: '5145551234' })).toBe('Send your Interac e-Transfer to 514-555-1234.');
  });

  it('the lines, with and without a note', () => {
    expect(paymentReminderLines('fr', { firstName: 'Léa', note: '', amount: '85,00 $', info: { email: 'a@b.ca', phone: '' } }))
      .toEqual(['Bonjour Léa,', 'Solde à payer : 85,00 $', 'Envoie ton virement Interac à a@b.ca.', 'Merci!']);
    expect(paymentReminderLines('en', { firstName: 'Lea', note: 'Season ends soon.', amount: '$85.00', info: { email: '', phone: '5145551234' } }))
      .toEqual(['Hi Lea,', 'Season ends soon.', 'Balance owing: $85.00', 'Send your Interac e-Transfer to 514-555-1234.', 'Thanks!']);
  });

  it('SMBHL: French then English, its usual subject, money in each language, the note escaped', async () => {
    const { mail } = await renderPaymentReminder(env, 'smbhl', { name: 'Alex Owing', balance: 85, note: '<b>Avant le 1er</b> <a href="x">lien</a>', info: { email: 'paye@smbhl.com', phone: '5145551234' }, season: SEASON });
    expect(mail.subject).toBe('SMBHL : solde à payer / Balance owing');
    const [fr, en] = mail.text.split('\n\n---\n\n');
    expect(fr).toContain('Bonjour Alex,');
    expect(fr).toContain('Solde à payer : 85,00 $');
    expect(fr).toContain('Envoie ton virement Interac à paye@smbhl.com ou au 514-555-1234.');
    expect(fr).toContain('Merci!');
    expect(en).toContain('Hi Alex,');
    expect(en).toContain('Balance owing: $85.00');
    expect(en).toContain('Thanks!');
    // Plain text carries the note; the HTML shows it as text, no tag or link.
    expect(mail.text).toContain('<b>Avant le 1er</b> <a href="x">lien</a>');
    expect(mail.html).toContain('&lt;b&gt;Avant le 1er&lt;/b&gt; &lt;a href=&quot;x&quot;&gt;lien&lt;/a&gt;');
    expect(mail.html).not.toContain('<a href="x">');
    // Everything in the HTML is in the text.
    for (const s of ['Bonjour Alex,', 'Solde à payer : 85,00 $', 'Balance owing: $85.00', '514-555-1234']) expect(mail.html).toContain(s);
  });

  it("Notre Ligue: the league's language only, its subject", async () => {
    const { mail } = await renderPaymentReminder(env, lg.league.id, { name: 'Léa Doit', balance: 1234.5, note: '', info: { email: 'paye@ligue.ca', phone: '' }, season: 'S1' });
    expect(mail.subject).toBe('Ligue Deux Cents : solde à payer');
    expect(mail.text).toContain('Bonjour Léa,');
    expect(mail.text).toMatch(/Solde à payer : 1\s234,50 \$/);
    expect(mail.text).not.toMatch(/Balance owing|Hi Léa/);
    await env.DB.prepare("UPDATE leagues SET language_mode = 'en' WHERE id = ?").bind(lg.league.id).run();
    const en = (await renderPaymentReminder(env, lg.league.id, { name: 'Léa Doit', balance: 85, note: '', info: { email: 'paye@ligue.ca', phone: '' }, season: 'S1' })).mail;
    expect(en.subject).toBe('Ligue Deux Cents: balance owing');
    expect(en.text).toContain('Balance owing: $85.00');
    expect(en.text).not.toContain('Solde');
    await env.DB.prepare("UPDATE leagues SET language_mode = 'fr' WHERE id = ?").bind(lg.league.id).run();
  });
});

describe('the settings', () => {
  it('the number: 10 digits, shown as 514-555-1234; the email checked', async () => {
    expect(normalizePhone('(514) 555-1234')).toBe('5145551234');
    expect(normalizePhone('1 514 555 1234')).toBe('5145551234');
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone('555-1234')).toBeNull();
    expect(normalizePhone('014-555-1234')).toBeNull();
    expect(formatPhone('5145551234')).toBe('514-555-1234');
    expect((await adminPost('/admin/finances/payment-settings', { email: 'pas-un-courriel', phone: '' })).status).toBe(400);
    expect((await (await adminPost('/admin/finances/payment-settings', { email: '', phone: '12' })).json()).errorKey).toBe('PAYMENT_PHONE_INVALID');
    expect(cleanNote('x'.repeat(501))).toBeNull();
  });

  it('with neither set, the panel says so and nothing can be sent', async () => {
    const d = await (await adminGet(`/admin/finances/reminders?s=${encodeURIComponent(SEASON)}`)).json();
    expect(d.hasInfo).toBe(false);
    const r = await adminPost('/admin/finances/reminders/send', { season: SEASON, player_ids: ['P2001'], note: '' });
    expect((await r.json()).errorKey).toBe('PAYMENT_INFO_MISSING');
    expect(await reminders('smbhl')).toEqual([]);
  });
});

describe('SMBHL: the panel and the send', () => {
  beforeAll(async () => {
    const r = await (await adminPost('/admin/finances/payment-settings', { email: 'paye@smbhl.com', phone: '514 555 1234' })).json();
    expect(r).toMatchObject({ ok: true, email: 'paye@smbhl.com', phone: '514-555-1234' });
  });

  it('lists who owes, from the finance page balances; no email listed apart; paid players not listed', async () => {
    const d = await (await adminGet(`/admin/finances/reminders?s=${encodeURIComponent(SEASON)}`)).json();
    expect(d.hasInfo).toBe(true);
    expect(d.info).toEqual({ email: 'paye@smbhl.com', phone: '514-555-1234' });
    expect(d.owing.map(p => [p.player_id, p.balance, p.last_reminded])).toEqual([['P2001', 170, null], ['P2004', 170, null]]);
    expect(d.owing[0].email).toBeUndefined();
    expect(d.noEmail.map(p => p.player_id)).toEqual(['P2003']);
  });

  it('the preview shows the first checked player and queues nothing', async () => {
    const before = (await rows('SELECT COUNT(*) AS n FROM outbox'))[0].n;
    const sentBefore = sent.length;
    const d = await (await adminPost('/admin/finances/reminders/preview', { season: SEASON, player_id: 'P2004', note: 'Merci!' })).json();
    expect(d.ok).toBe(true);
    expect(d.to).toBe('dee.p200@example.com');
    expect(d.text).toContain('Bonjour Dee,');
    expect(d.text).toContain('Solde à payer : 170,00 $');
    expect((await rows('SELECT COUNT(*) AS n FROM outbox'))[0].n).toBe(before);
    expect(sent.length).toBe(sentBefore);
  });

  // Batch 4 item 2c: listed, unchecked by default in the panel, still sendable.
  it('a player off game emails is listed, marked, and can still be sent to', async () => {
    await env.DB.prepare('UPDATE contacts SET opted_out = 1 WHERE player_id = ?').bind('P2004').run();
    const d = await (await adminGet(`/admin/finances/reminders?s=${encodeURIComponent(SEASON)}`)).json();
    expect(d.owing.find(p => p.player_id === 'P2004').opted_out).toBe(true);
    expect(d.owing.find(p => p.player_id === 'P2001').opted_out).toBe(false);
    await env.DB.prepare('UPDATE contacts SET opted_out = 0 WHERE player_id = ?').bind('P2004').run();
  });

  // Batch 4 item 2d: PAYMENT_REMINDER_RESERVE stays free for the admin alerts.
  it("the budget keeps the alerts' reserve", async () => {
    env.MAIL_HARD_DAILY_CAP = '50'; env.PAYMENT_REMINDER_RESERVE = '7';
    const sentToday = ((await env.DB.prepare('SELECT sent FROM mail_daily_count WHERE day = ?').bind(new Date().toISOString().slice(0, 10)).first()) || { sent: 0 }).sent;
    const d = await (await adminGet(`/admin/finances/reminders?s=${encodeURIComponent(SEASON)}`)).json();
    expect(d.left).toBe(Math.max(0, 50 - sentToday - 7));
    env.MAIL_HARD_DAILY_CAP = String(sentToday + 7 + 1);
    const r = await adminPost('/admin/finances/reminders/send', { season: SEASON, player_ids: ['P2001', 'P2004'], note: '' });
    expect(await r.json()).toMatchObject({ errorKey: 'PAYMENT_OVER_BUDGET', n: 2, left: 1 });
    delete env.MAIL_HARD_DAILY_CAP; delete env.PAYMENT_REMINDER_RESERVE;
  });

  it("today's budget too small: nothing at all is queued", async () => {
    env.MAIL_HARD_DAILY_CAP = '1';
    const r = await adminPost('/admin/finances/reminders/send', { season: SEASON, player_ids: ['P2001', 'P2004'], note: '' });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ errorKey: 'PAYMENT_OVER_BUDGET', n: 2 });
    expect(await reminders('smbhl')).toEqual([]);
    delete env.MAIL_HARD_DAILY_CAP;
  });

  it('only the checked players get a row; a paid player is skipped and named', async () => {
    const r = await (await adminPost('/admin/finances/reminders/send', { season: SEASON, player_ids: ['P2001', 'P2002'], note: 'Avant le 15.' })).json();
    expect(r).toEqual({ ok: true, sent: 1, skipped: ['Bea Paid'] });
    const got = await reminders('smbhl');
    expect(got.map(x => x.player_id)).toEqual(['P2001']);
    const p = JSON.parse(got[0].payload).prerendered;
    expect(p.to).toBe('alex.p200@example.com');
    expect(p.text).toContain('Avant le 15.');
  });

  it('"Last reminded" shows the latest send', async () => {
    const d = await (await adminGet(`/admin/finances/reminders?s=${encodeURIComponent(SEASON)}`)).json();
    const alex = d.owing.find(p => p.player_id === 'P2001');
    const latest = (await rows("SELECT MAX(COALESCE(sent_at, created_at)) AS at FROM outbox WHERE kind = 'payment_reminder' AND player_id = 'P2001'"))[0].at;
    expect(alex.last_reminded).toBe(latest);
    expect(d.owing.find(p => p.player_id === 'P2004').last_reminded).toBeNull();
    await env.DB.prepare("UPDATE outbox SET sent_at = '2026-01-01T00:00:00Z', created_at = '2026-01-01T00:00:00Z' WHERE kind = 'payment_reminder' AND player_id = 'P2001'").run();
    await adminPost('/admin/finances/reminders/send', { season: SEASON, player_ids: ['P2001'], note: '' });
    const again = (await (await adminGet(`/admin/finances/reminders?s=${encodeURIComponent(SEASON)}`)).json()).owing.find(p => p.player_id === 'P2001');
    expect(again.last_reminded > '2026-01-01T00:00:00Z').toBe(true);
  });

  it('a player from another league is refused, and nothing is queued', async () => {
    const before = (await reminders('smbhl')).length;
    const r = await adminPost('/admin/finances/reminders/send', { season: SEASON, player_ids: ['P2004', `${lg.league.id}:L1`], note: '' });
    expect(r.status).toBe(400);
    expect((await r.json()).errorKey).toBe('PAYMENT_PLAYER_NOT_IN_LEAGUE');
    expect((await reminders('smbhl')).length).toBe(before);
    expect((await reminders(lg.league.id)).length).toBe(0);
  });

  it('without the admin key: refused', async () => {
    const r = await SELF.fetch('http://example.com/admin/finances/reminders/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ season: SEASON, player_ids: ['P2004'] }) });
    expect([401, 403]).toContain(r.status);
  });
});

describe('Notre Ligue: the panel and the send', () => {
  beforeAll(async () => {
    await must(lg.post('/league/settings/payment', { email: 'paye@ligue.ca', phone: '' }), 'payment settings');
  });

  it('lists the players who owe the season fee', async () => {
    const d = (await lg.get('/league/finances/reminders?season=S1')).json;
    expect(d.ok).toBe(true);
    expect(d.owing.map(p => [p.name, p.balance]).sort()).toEqual([['Léa Doit', 85], ['Max Doit', 85]]);
  });

  it('only the checked player gets a row, in French only', async () => {
    const r = await lg.post('/league/finances/reminders/send', { season: 'S1', player_ids: [`${lg.league.id}:L1`], note: '' });
    expect(r.json).toEqual({ ok: true, sent: 1, skipped: [] });
    const got = await reminders(lg.league.id);
    expect(got.map(x => x.player_id)).toEqual([`${lg.league.id}:L1`]);
    const p = JSON.parse(got[0].payload).prerendered;
    expect(p.subject).toBe('Ligue Deux Cents : solde à payer');
    expect(p.text).toContain('Envoie ton virement Interac à paye@ligue.ca.');
  });

  it("another league's admin cannot see or send for this league's players", async () => {
    const r = await other.post('/league/finances/reminders/send', { season: 'S1', player_ids: [`${lg.league.id}:L2`], note: '' });
    expect(r.status).toBe(409); // their own league has no payment details yet
    await must(other.post('/league/settings/payment', { email: 'o@ligue.ca', phone: '' }), 'other settings');
    const again = await other.post('/league/finances/reminders/send', { season: 'S1', player_ids: [`${lg.league.id}:L2`], note: '' });
    expect(again.status).toBe(400);
    expect(again.json.errorKey).toBe('PAYMENT_PLAYER_NOT_IN_LEAGUE');
    expect((await reminders(lg.league.id)).map(x => x.player_id)).toEqual([`${lg.league.id}:L1`]);
    const list = (await other.get('/league/finances/reminders?season=S1')).json;
    expect(JSON.stringify(list)).not.toContain('Doit');
  });

  it('without a session or CSRF token: refused', async () => {
    const r = await SELF.fetch('http://example.com/league/finances/reminders/send', { method: 'POST', headers: { cookie: lg.s.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ season: 'S1', player_ids: [`${lg.league.id}:L2`] }) });
    expect(r.status).toBe(403);
  });

  it('the settings page shows the fields with their help text', async () => {
    const html = (await lg.get('/league/settings')).text;
    expect(html).toContain('id="section-payment"');
    expect(html).toContain('Courriel pour virement Interac');
    expect(html).toContain('Affiché dans les rappels de paiement. Laisse vide pour masquer.');
    expect(html).toContain('value="paye@ligue.ca"');
  });
});

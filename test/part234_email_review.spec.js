// Email review (Roberto's review of copy-audit/screens), items 1 to 3.
//   1a a league's sub call in Notre Ligue's card; SMBHL's keeps SMBHL's
//   1b the admin alerts' small tag, text only
//   1c SMBHL's game-day morning email never goes out without a team note
//   1d SMBHL's invite: cash or Interac, the payment reminder's variants
//   1e one footer rule for Notre Ligue
//   2  the wording
//   3  SMBHL's answer buttons: one bilingual pair after both languages
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { body, renderLateReversalAdminAlert, renderLeagueLogisticsEmail, renderAdminStatusEmail, renderPaymentReminder, drain } from '../src/index.js';
import { buildInviteEmail } from '../src/leagues.js';

const LEAGUE_EV = { id: 'lg234:2099-03-03', league_id: 'lg234', date: '2099-03-03', start_time: '19:00', venue: 'Aréna Nord', season: 'S1' };
const SMBHL_EV = { id: '2099-01-11', date: 'Sunday January 11 2099', start_time: '10:30', venue: 'Aréna Golden', season: 'Fall 2099' };
const leagueCfg = { name: 'Ligue 234', languageMode: 'both', siteUrl: 'https://rsvp.example.com' };
const call = (ev, extra = {}) => body('sub_call', { ev, name: 'Sam', team: null, payload: { need: 'skater', yes: 'https://x/yes', no: 'https://x/no' }, ...extra });
const DASHES = /\u2014/;

let originalFetch;
beforeAll(async () => {
  originalFetch = globalThis.fetch;
  // Nothing leaves: no mail key, and any fetch answers locally.
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  delete env.RESEND_API_KEY; delete env.MAIL_PROVIDER;
  env.RSVP_SECRET = 'p234-rsvp'; env.AUTH_SECRET = 'p234-auth';
  await applyRealSchema(env);
});
afterAll(() => { globalThis.fetch = originalFetch; });

describe('1a: the league sub call', () => {
  it("Notre Ligue's card, the league colour, « J'embarque » as the button, « Pas cette fois » as a link, the player footer; no emoji", () => {
    const m = call(LEAGUE_EV, { leagueCfg, leagueColor: '#2a5fa8' });
    expect(m.html).toContain('max-width:560px');
    expect(m.html).toContain('Ligue 234');
    expect(m.html).toContain('#2a5fa8');
    expect(m.html).toMatch(/J(&#39;|')embarque<\/a>/);
    expect(m.html).toContain('>Pas cette fois</a>');
    expect(m.html).toContain('Propulsé par Notre Ligue pour Ligue 234');
    expect(m.html).toMatch(/confidentialite|privacy/);
    expect(m.html + m.text).not.toMatch(/🏒|✅|❌|#15803d/);
    expect(m.text).toContain("J'embarque : https://x/yes\nPas cette fois : https://x/no");
    expect(m.text).toContain('Tu ne veux plus être sur la liste des remplaçants? Réponds à ce courriel.');
    expect(m.html.indexOf('liste des remplaçants')).toBeGreaterThan(m.html.indexOf('Pas cette fois'));
  });
  it("SMBHL's sub call keeps SMBHL's template", () => {
    const m = call(SMBHL_EV);
    expect(m.html).not.toContain('max-width:560px');
    expect(m.html).not.toContain('Propulsé par Notre Ligue');
  });
});

describe('1b: the alert tag', () => {
  it('the late drop-out tag is the small text tag, no icon', () => {
    const m = renderLateReversalAdminAlert({ leagueName: 'Ligue 234', playerName: 'Léa', team: 'Rouges', ev: LEAGUE_EV, dashboardLink: 'https://x/d', languageMode: 'both', hoursLeft: 5 });
    expect(m.html).not.toContain('<svg');
    expect(m.html).toMatch(/padding:4px 10px;font:700 13px\/18px[^"]*white-space:nowrap;">Désistement de dernière minute<\/td>/);
    expect(m.html).toContain('>Late drop-out</td>');
  });
});

describe('1c: the game-day morning email', () => {
  it('is not sent without a team note: the drain cancels it', async () => {
    await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: 'Fall 2099', seasons: [{ name: 'Fall 2099', config: { teams: [{ name: 'Red' }, { name: 'Blue' }], goaliesPerTeam: 1, skatersPerTeam: 8, minSkaters: 2 }, fixtures: [], standings: [] }], players: [] }));
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time) VALUES ('2099-01-11', 'Fall 2099', 1, 'Sunday January 11 2099', 'Aréna Golden', 'open', '10:30')`).run();
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, token_salt) VALUES ('P234', 'Marc Tremblay', 'p234@example.com', 'roster', 0, 's')`).run();
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at) VALUES ('gameday_morning', '2099-01-11', 'P234', 'Red', 'gm234', '{}', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')`).run();
    await drain(env);
    const row = await env.DB.prepare(`SELECT cancelled, sent_at, error FROM outbox WHERE dedup_key = 'gm234'`).first();
    expect(row.sent_at).toBeNull();
    expect(row.cancelled).toBe(1);
  });
  it('with notes, the box shows them', () => {
    const m = body('gameday_morning', { ev: SMBHL_EV, name: 'Marc', team: 'Red', link: 'https://x/l', payload: { teamMessages: [{ player_name: 'Léa', message: 'Je serai en retard.', created_at: '2099-01-11T13:00:00Z' }] } });
    expect(m.html).toContain('Je serai en retard.');
    expect(m.text).toContain('Léa');
  });
});

describe('1d: cash or Interac in the invite', () => {
  const invite = pay => body('invite', { ev: SMBHL_EV, name: 'Marc', team: 'Red', link: 'L', payload: { yes: 'Y', no: 'N', duesReminder: { balance: 170, ...pay } } }).text;
  it('email and mobile, email only, mobile only, and cash only when nothing is set', () => {
    expect(invite({ email: 'paie@x.ca', phone: '514-555-1234' })).toContain('Paiement de 170,00 $ comptant sur place, ou par virement Interac à paie@x.ca ou au 514-555-1234.');
    expect(invite({ email: 'paie@x.ca', phone: '514-555-1234' })).toContain('Pay $170.00 in cash at the gym, or by Interac e-Transfer to paie@x.ca or 514-555-1234.');
    expect(invite({ email: 'paie@x.ca', phone: '' })).toContain('Paiement de 170,00 $ comptant sur place, ou par virement Interac à paie@x.ca.');
    expect(invite({ email: '', phone: '514-555-1234' })).toContain('Paiement de 170,00 $ comptant sur place, ou par virement Interac au 514-555-1234.');
    expect(invite({ email: '', phone: '' })).toContain('Paiement de 170,00 $ en argent comptant sur place.');
    expect(invite({ email: '', phone: '' })).toContain('Please bring $170.00 in cash to the gym.');
  });
});

describe('1e: one footer rule', () => {
  it('the co-admin invitation (to an admin) ends with « Notre Ligue », its heading matches its text', () => {
    const m = buildInviteEmail('Ligue 234', 'https://x/accept', '#b3122e', 'fr');
    expect(m.html).toContain('Notre Ligue<br>');
    expect(m.html).not.toMatch(/Envoyé par|Propulsé/);
    expect(m.html).toContain('>Invitation à coadministrer</h1>');
  });
});

describe('2: the wording', () => {
  const args = { leagueName: 'Ligue 234', leagueColor: '#2a5fa8', firstName: 'Lea', dayLabel: { fr: 'mercredi', en: 'Wednesday' }, ev: LEAGUE_EV, team: 'Rouges', optOutLink: 'https://x.test/o', forcedLang: null };
  it('sub placed: one heading, the fee and how to pay by Interac', () => {
    const m = renderLeagueLogisticsEmail({ ...args, subPlaced: true, subFee: 7, payInfo: { email: 'paie@x.ca', phone: '5145551234' } });
    expect(m.text).toContain("Tu es dans l'équipe Rouges\n");
    expect(m.text).toContain('Frais de remplaçant : 7,00 $ pour ce match. Paie par virement Interac à paie@x.ca ou au 514-555-1234.');
    expect(m.text).toContain('Sub fee: $7.00 for this game. Pay by Interac e-Transfer to paie@x.ca or 514-555-1234.');
    expect(m.text).not.toMatch(/Équipe : Rouges|Tu joues avec|Détails du match/);
    const mobileOnly = renderLeagueLogisticsEmail({ ...args, subPlaced: true, subFee: 7, payInfo: { email: '', phone: '5145551234' } });
    expect(mobileOnly.text).toContain('Paie par virement Interac au 514-555-1234.');
    const none = renderLeagueLogisticsEmail({ ...args, subPlaced: true, subFee: 7, payInfo: null });
    expect(none.text).not.toContain('Interac');
  });
  it('the 72 h ask names the day: « Tu joues mardi? » / "Playing Tuesday?" (2099-03-03 is a Tuesday)', async () => {
    const { renderLeagueReminderEmail } = await import('../src/index.js');
    const m = renderLeagueReminderEmail({ kind: 'reminder_72h', leagueName: 'Ligue 234', leagueColor: '#2a5fa8', firstName: 'Lea', dayLabel: { fr: 'mercredi 3 mars', en: 'Wednesday, Mar 3' }, ev: LEAGUE_EV, inLink: 'https://x/in', outLink: 'https://x/out', forcedLang: null });
    expect(m.text).toContain('Tu joues mardi?');
    expect(m.text).toContain('Playing Tuesday?');
    expect(m.text).not.toMatch(/As-tu décidé\?\n|Have you decided\?\n/);
  });
  it('admin status: a heading, present and absent', async () => {
    await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at) VALUES ('u234', 'owner234@example.com', 'x', '2026-01-01T00:00:00Z')`).run();
    await env.DB.prepare(`INSERT INTO leagues (id, name, team_count, team_names, created_by, created_at, language_mode) VALUES ('lg234', 'Ligue 234', 2, '["Rouges","Bleus"]', 'u234', '2026-01-01T00:00:00Z', 'both')`).run();
    const c = { player_id: 'lg234:P1', name: 'Léa Joueuse', email: 'lea@example.com', token_salt: 's' };
    const inn = (await renderAdminStatusEmail(env, 'lg234', LEAGUE_EV, c, 'in')).mail;
    expect(inn.text).toContain('Ta présence est confirmée\n');
    expect(inn.text).toContain("You're confirmed\n");
    const out = (await renderAdminStatusEmail(env, 'lg234', LEAGUE_EV, c, 'out')).mail;
    expect(out.text).toContain('Ton absence est notée\n');
    expect(out.text).toContain("You're marked absent\n");
  });
  it('payment reminder: « Salut » in Notre Ligue, « Bonjour » kept in SMBHL', async () => {
    const nl = (await renderPaymentReminder(env, 'lg234', { name: 'Léa Doit', balance: 50, note: '', info: { email: 'p@x.ca', phone: '' }, season: 'S1' })).mail;
    expect(nl.text).toContain('Salut Léa,');
    const sm = (await renderPaymentReminder(env, 'smbhl', { name: 'Léa Doit', balance: 50, note: '', info: { email: 'p@x.ca', phone: '' }, season: 'Fall 2099' })).mail;
    expect(sm.text).toContain('Bonjour Léa,');
  });
});

describe('3: SMBHL answer buttons', () => {
  it('the chase: the French text, the English text, then « Oui / Yes » and « Non / No »; no capitals, no emoji', () => {
    const m = body('chase', { ev: SMBHL_EV, name: 'Marc', team: 'Red', link: 'L', payload: { stage: '72', yes: 'https://x/yes', no: 'https://x/no' } });
    expect(m.text).toContain('Oui / Yes : https://x/yes\nNon / No : https://x/no');
    expect(m.text.indexOf('We still do not have')).toBeLessThan(m.text.indexOf('Oui / Yes'));
    expect(m.html.split('>Oui / Yes</a>').length - 1).toBe(1);
    expect(m.html).toContain('>Non / No</a>');
    expect(m.text + m.html).not.toMatch(/OUI \(|NON \(|YES \(|NO +\(|✅|❌/);
    expect(m.html.indexOf('We still do not have')).toBeLessThan(m.html.indexOf('>Oui / Yes</a>'));
  });
  it('the sub call and its reminder: « J\'embarque / I\'m in », « Pas cette fois / Not this time », once', () => {
    for (const reminder of [false, true]) {
      const m = body('sub_call', { ev: SMBHL_EV, name: 'Sam', team: null, payload: { need: 'skater', reminder, yes: 'https://x/yes', no: 'https://x/no' } });
      expect(m.html.split('Pas cette fois / Not this time').length - 1).toBe(1);
      expect(m.html.indexOf('Are you in?')).toBeLessThan(m.html.indexOf('Pas cette fois / Not this time'));
    }
  });
});

describe('nothing new carries an em dash', () => {
  it('in any email rendered here', () => {
    const all = [call(LEAGUE_EV, { leagueCfg }), call(SMBHL_EV), body('chase', { ev: SMBHL_EV, name: 'M', team: 'Red', link: 'L', payload: { stage: '24', yes: 'y', no: 'n' } })];
    for (const m of all) expect(m.subject + m.text + m.html).not.toMatch(DASHES);
  });
});

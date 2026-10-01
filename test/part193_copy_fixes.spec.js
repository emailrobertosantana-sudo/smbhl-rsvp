// The copy fixes from the audit (item 5), on the real email renderers.
//  5b  zero and one read naturally in the short-team notice
//  5c  the venue follows a label (« (lieu : X) » / "(venue: X)"), never "au X"
//  5d  the 72 h reminder gives the date once
//  5e  one time format per language: 10 h 30 / 10:30 AM
//  5g  no space before « ? » or « ! » in French
//  5h  no « (e) » or « ·e »
//  5k  the late drop-out alert says the time actually left
//  5l  no "(s)" plural
//  5m  a Notre Ligue sub call's heading stands apart from its date
// SMBHL's own output is pinned by the golden recordings; the account
// emails (5n) are tested in test/part194_account_email_language.spec.js.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { body, renderLeagueReminderEmail, renderLeagueLogisticsEmail, renderLateReversalAdminAlert } from '../src/index.js';

const SMBHL_EV = { id: 'smbhl:2099-11-15', date: 'Sunday November 15 2099', start_time: '10:30', venue: 'Aréna Golden', week: 6, season: 'Fall 2099', league_id: 'smbhl' };
const LEAGUE_EV = { id: 'lg:2099-11-15', date: '2099-11-15', start_time: '19:30', venue: 'Aréna Saint-Michel', season: 'S1', league_id: 'lg' };
const leagueCfg = { name: 'Ligue du mercredi', tagline: '', siteUrl: 'https://rsvp.notreligue.ca', languageMode: 'both' };
const frenchSpaceBeforeMark = /[a-zà-ÿ0-9»)>] [?!](?![a-z])/i;

afterEach(() => { vi.useRealTimers(); });

describe('SMBHL emails', () => {
  it('5c and 5e: the sub call names the time and the venue after a label', () => {
    const m = body('sub_call', { ev: SMBHL_EV, name: 'Sam', team: null, payload: { need: 'skater', yes: 'https://x/yes', no: 'https://x/no' } });
    expect(m.text).toContain('SMBHL cherche un joueur dimanche 10 h 30 (lieu : Aréna Golden).');
    expect(m.text).toContain('SMBHL needs a skater Sunday 10:30 AM (venue: Aréna Golden).');
    expect(m.text).not.toMatch(/ au Aréna| at Aréna/);
  });

  it('5b: zero, one and many skaters in the short-team notice', () => {
    const notice = n => body('team_short', { ev: SMBHL_EV, name: 'Gus', team: 'Red', payload: { needSkaters: true, skaters: n, teamLink: 'https://x/team' } });
    expect(notice(0).text).toContain("Rouge n'a aucun joueur confirmé pour");
    expect(notice(0).text).toContain('Red has no skaters confirmed for');
    expect(notice(0).subject).toBe('Rouge est incomplète (aucun joueur) / Red is short');
    expect(notice(1).text).toContain("Rouge n'a qu'un joueur confirmé pour");
    expect(notice(1).text).toContain('Red has only 1 skater confirmed for');
    expect(notice(1).subject).toBe('Rouge est incomplète (1 joueur) / Red is short');
    expect(notice(3).text).toContain("Rouge n'a que 3 joueurs confirmés pour");
    expect(notice(3).text).toContain('Red has only 3 skaters confirmed for');
  });

  it('5g: no space before ? or ! in the French of the sub call and the game-day email', () => {
    const call = body('sub_call', { ev: SMBHL_EV, name: 'Sam', team: null, payload: { need: 'skater', yes: 'y', no: 'n' } });
    expect(call.text).toContain('Disponible?');
    expect(call.text).toContain('Tu ne veux plus être sur la liste de substituts? Réponds à ce courriel.');
    const gameday = body('gameday', { ev: SMBHL_EV, name: 'Gus', team: 'Red', link: 'https://x', payload: {} });
    expect(gameday.subject).toBe('À demain pour le match! / See you at the gym tomorrow!');
    const fr = gameday.text.split('\n---\n')[0];
    expect(fr).not.toMatch(frenchSpaceBeforeMark);
  });
});

describe('Notre Ligue emails', () => {
  it('5d and 5h: the 72 h reminder gives the date once; the details are neutral', () => {
    const r = renderLeagueReminderEmail({ kind: 'reminder_72h', leagueName: 'Ligue du mercredi', firstName: 'Léa', dayLabel: { fr: 'dimanche 15 nov', en: 'Sunday Nov 15' }, ev: LEAGUE_EV, inLink: 'i', outLink: 'o', forcedLang: 'fr' });
    expect(r.text).toContain("On n'a pas encore ta réponse pour ce match. Dim 15 nov · 19 h 30 · Aréna Saint-Michel.");
    expect(r.text.match(/15 nov/g).length).toBe(1);
    const d = renderLeagueLogisticsEmail({ leagueName: 'Ligue du mercredi', firstName: 'Léa', dayLabel: 'dimanche 15 nov', ev: LEAGUE_EV, team: 'Loutres', optOutLink: 'x', forcedLang: 'fr' });
    expect(d.text).toContain('Ta présence est confirmée. Dim 15 nov · 19 h 30 · Aréna Saint-Michel · Équipe Loutres.');
    expect(d.text + d.html).not.toMatch(/·e\b|\(e\)/);
  });

  it('5m and 5c: the sub call heading, then the date and the venue after a label', () => {
    const m = body('sub_call', { ev: LEAGUE_EV, name: 'Sam', team: null, leagueCfg, payload: { need: 'skater', yes: 'y', no: 'n' } });
    expect(m.text).toContain('Ligue du mercredi cherche un joueur.\nDimanche 15 nov · 19 h 30 (lieu : Aréna Saint-Michel).');
    expect(m.text).toContain('Ligue du mercredi needs a skater.\nSunday Nov 15 · 7:30 PM (venue: Aréna Saint-Michel).');
    expect(m.html).toContain('cherche un joueur.<br><b>Dimanche 15 nov · 19 h 30 (lieu : Aréna Saint-Michel)</b>.');
  });

  it('5k and 5h: the late drop-out alert says the time actually left, neutrally', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2099, 10, 16, 0, 30); // 19:30 Montreal on the 15th
    const alert = hoursBefore => {
      vi.setSystemTime(new Date(start - hoursBefore * 3600000));
      return renderLateReversalAdminAlert({ leagueName: 'Ligue du mercredi', playerName: 'Léa Joueuse', team: 'Loutres', ev: LEAGUE_EV, dashboardLink: 'https://x', languageMode: 'both' });
    };
    const seven = alert(7);
    expect(seven.subject).toContain('vient de se désister · 7 h avant le match');
    expect(seven.text).toContain('vient de se désister, 7 heures avant le match');
    expect(seven.text).toContain('just dropped out, 7 hours before the game');
    expect(seven.html).toContain('avait confirmé sa présence avec <b>Loutres</b>');
    expect(seven.text + seven.html).not.toMatch(/12 heures|12h before|·e\b/);
    expect(alert(1).text).toContain('1 heure avant le match');
    expect(alert(0.4).text).toContain("moins d'une heure avant le match");
    expect(alert(0.4).text).toContain('less than an hour before the game');
  });
});

describe('5l: no "(s)" plural in what these emails say', () => {
  it('none in any of them', () => {
    const all = [
      body('sub_call', { ev: SMBHL_EV, name: 'S', team: null, payload: { need: 'goalie', yes: 'y', no: 'n' } }),
      body('team_short', { ev: SMBHL_EV, name: 'G', team: 'Blue', payload: { needGoalie: true, needSkaters: true, skaters: 2, teamLink: 'l' } }),
      renderLeagueReminderEmail({ kind: 'reminder_24h', leagueName: 'L', firstName: 'A', dayLabel: 'lundi', ev: LEAGUE_EV, inLink: 'i', outLink: 'o', forcedLang: null })
    ];
    for (const m of all) expect(m.subject + m.text).not.toMatch(/[A-Za-zÀ-ÿ]\(s\)/);
  });
});

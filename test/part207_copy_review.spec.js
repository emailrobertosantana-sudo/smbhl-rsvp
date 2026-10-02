// Batch 7 item 5: copy fixes from Roberto's email review.
//   5a  the sub call: « SMBHL cherche un joueur pour dimanche 11 janv., 10 h 30. »,
//       the venue on its own line, the two buttons, no « Disponible? ».
//   5c  date and time in a sentence joined with « à » / "at".
//   5d  the venue on its own line, « Lieu : X » / "Venue: X".
//   5g  the late drop-out alert: tag, heading, sentence, the delay in words
//       (minutes, hours, days), a subs sentence true in each state.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { body, renderLateReversalAdminAlert, lateReversalSubsState } from '../src/index.js';
import { delayText, sentenceWhen, venueLine } from '../src/date_format.js';

const SMBHL_EV = { id: 'smbhl:2099-01-11', date: 'Sunday January 11 2099', start_time: '10:30', venue: 'Aréna Golden', week: 6, season: 'Fall 2098', league_id: 'smbhl' };
const LEAGUE_EV = { id: 'lg:2099-11-15', date: '2099-11-15', start_time: '19:30', venue: 'Aréna Saint-Michel', season: 'S1', league_id: 'lg' };

afterEach(() => { vi.useRealTimers(); });

describe('date_format: in a sentence', () => {
  it('« à » / "at" between the date and the time; the venue line', () => {
    expect(sentenceWhen('2099-11-15', '10:30', 'fr')).toBe('dimanche 15 nov. à 10 h 30');
    expect(sentenceWhen('2099-11-15', '10:30', 'en')).toBe('Sunday, Nov 15 at 10:30 AM');
    expect(venueLine('Aréna Golden', 'fr')).toBe('Lieu : Aréna Golden');
    expect(venueLine('Aréna Golden', 'en')).toBe('Venue: Aréna Golden');
    expect(venueLine('', 'fr')).toBe('');
  });

  it('a delay before a game: minutes under 1 h, hours under 48 h, then days, with plurals', () => {
    expect(delayText(40 / 60, 'fr')).toBe('40 minutes');
    expect(delayText(1 / 60, 'fr')).toBe('1 minute');
    expect(delayText(1 / 60, 'en')).toBe('1 minute');
    expect(delayText(1, 'fr')).toBe('1 heure');
    expect(delayText(1, 'en')).toBe('1 hour');
    expect(delayText(5, 'fr')).toBe('5 heures');
    expect(delayText(5, 'en')).toBe('5 hours');
    expect(delayText(47, 'fr')).toBe('47 heures');
    expect(delayText(48, 'fr')).toBe('2 jours');
    expect(delayText(72, 'fr')).toBe('3 jours');
    expect(delayText(72, 'en')).toBe('3 days');
    expect(delayText(24, 'en')).toBe('24 hours');
  });
});

describe('5a: the sub call', () => {
  const call = (ev, need, extra = {}) => body('sub_call', { ev, name: 'Sam', team: null, payload: { need, yes: 'https://x/yes', no: 'https://x/no' }, ...extra });

  it('SMBHL: the sentence, the venue, the buttons, the wait and off lines, both languages', () => {
    const m = call(SMBHL_EV, 'skater');
    // Batch 8 item 1c: the short call.
    expect(m.text).toContain("SMBHL a besoin d'un substitut dimanche 11 janv. à 10 h 30. Tu embarques?\nLieu : Aréna Golden");
    expect(m.text).toContain('SMBHL needs a sub on Sunday, Jan 11 at 10:30 AM. Are you in?\nVenue: Aréna Golden');
    for (const b of ['✅ J', '❌ Pas cette fois', '✅ I', '❌ Not this time']) {
      expect(m.text).toContain(b);
      expect(m.html).toContain(b);
    }
    expect(m.text).toContain("✅ J'embarque : https://x/yes");
    expect(m.text).toContain("✅ I'm in: https://x/yes");
    expect(m.text).toContain('Tu ne veux plus être sur la liste de substituts? Réponds à ce courriel.');
    expect(m.text).toContain('Want off the sub list? Just reply to this email.');
    expect(m.text + m.html).not.toMatch(/décidée|decided yet|liste d'attente|waitlist|Disponible\?|Available\?/);
    expect(m.subject).toBe("SMBHL a besoin d'un substitut dimanche 11 janv. / SMBHL needs a sub on Sunday, Jan 11");
  });

  it('a goalie call says « un gardien » / "a goalie"', () => {
    const m = call(SMBHL_EV, 'goalie');
    expect(m.text).toContain("SMBHL a besoin d'un gardien dimanche 11 janv. à 10 h 30. Tu embarques?");
    expect(m.text).toContain('SMBHL needs a goalie on Sunday, Jan 11 at 10:30 AM. Are you in?');
    const team = body('sub_call', { ev: SMBHL_EV, name: 'Sam', team: 'Red', payload: { need: 'goalie', yes: 'y', no: 'n' } });
    expect(team.text).toContain("Rouge a besoin d'un gardien dimanche 11 janv. à 10 h 30. Tu embarques?");
    expect(team.text).toContain('Red needs a goalie on Sunday, Jan 11 at 10:30 AM. Are you in?');
  });

  it('Notre Ligue: the same pattern, with the league name, « remplaçants »', () => {
    const leagueCfg = { name: 'Ligue du mercredi', tagline: '', siteUrl: 'https://rsvp.notreligue.ca', languageMode: 'both' };
    const m = call(LEAGUE_EV, 'skater', { leagueCfg });
    expect(m.text).toContain("Ligue du mercredi a besoin d'un remplaçant dimanche 15 nov. à 19 h 30. Tu embarques?\nLieu : Aréna Saint-Michel");
    expect(m.text).toContain('Ligue du mercredi needs a sub on Sunday, Nov 15 at 7:30 PM. Are you in?\nVenue: Aréna Saint-Michel');
    expect(m.text).toContain('Tu ne veux plus être sur la liste des remplaçants? Réponds à ce courriel.');
    expect(m.text).not.toMatch(/\(lieu|\(venue/);
  });
});

describe('5g: the late drop-out alert', () => {
  const start = Date.UTC(2099, 10, 16, 0, 30); // 19:30 Montreal on the 15th
  const alert = (hoursBefore, opts = {}) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(start - hoursBefore * 3600000));
    return renderLateReversalAdminAlert({ leagueName: 'Ligue', playerName: 'Léa', team: 'Loutres', ev: LEAGUE_EV, dashboardLink: 'https://x.test/g', languageMode: 'both', ...opts });
  };

  it('tag, heading, the sentence with the delay, then the team and the venue on lines of their own', () => {
    const m = alert(5);
    expect(m.html).toContain('Désistement de dernière minute');
    expect(m.html).toContain('Late drop-out');
    expect(m.text).toContain('Léa ne peut plus venir');
    expect(m.text).toContain("Léa can't make it");
    expect(m.text).toContain('Léa avait confirmé sa présence pour dimanche 15 nov. à 19 h 30 et vient de changer sa réponse, 5 heures avant le match.\nÉquipe : Loutres\nLieu : Aréna Saint-Michel');
    expect(m.text).toContain('Léa had confirmed for Sunday, Nov 15 at 7:30 PM and just changed their answer, 5 hours before the game.\nTeam: Loutres\nVenue: Aréna Saint-Michel');
    expect(m.subject).toBe('Loutres: Léa vient de se désister · 5 heures avant le match / Loutres: Léa just dropped out, 5 hours before the game');
  });

  it('the delay: minutes under an hour, one hour singular', () => {
    expect(alert(40 / 60).text).toContain('40 minutes avant le match');
    expect(alert(40 / 60).text).toContain('40 minutes before the game');
    expect(alert(1).text).toContain('1 heure avant le match');
    expect(alert(1).text).toContain('1 hour before the game');
  });

  it('the subs sentence, true in each state', () => {
    const t = subs => alert(5, { subs, subCallHours: 48 }).text;
    expect(t('invited')).toContain('Des remplaçants ont déjà été invités automatiquement.');
    expect(t('invited')).toContain('Subs have already been invited automatically.');
    expect(t('none_left')).toContain("Il ne reste aucun remplaçant à appeler.");
    expect(t('none_left')).toContain('No sub is left to call.');
    expect(t('held')).toContain('Les appels aux remplaçants sont en attente : ils partiront automatiquement 48 heures avant le match.');
    expect(t('held')).toContain('Sub calls are on hold: they go out automatically 48 hours before the game.');
    expect(t('not_needed')).toContain("Aucun remplaçant n'est nécessaire pour l'instant.");
    expect(t('not_needed')).toContain('No sub is needed for now.');
    expect(t(null)).not.toMatch(/remplaçant|sub/i);
  });

  it('the state comes from what the sub call did, invited first', () => {
    expect(lateReversalSubsState([{ invited: 2, reason: 'invited' }, { invited: 0, reason: 'no-eligible-subs' }])).toBe('invited');
    expect(lateReversalSubsState([{ invited: 0, reason: 'recently-invited' }])).toBe('invited');
    expect(lateReversalSubsState([{ invited: 0, reason: 'no-eligible-subs' }])).toBe('none_left');
    expect(lateReversalSubsState([{ invited: 0, reason: 'before-window' }])).toBe('held');
    expect(lateReversalSubsState([{ invited: 0, reason: 'not-short' }])).toBe('not_needed');
    expect(lateReversalSubsState([{ invited: 0, reason: 'no-team-on-file' }])).toBe(null);
    expect(lateReversalSubsState([])).toBe(null);
  });

  it('the Comms preview: a sample 12 hours, never the time to the next real game', () => {
    const m = renderLateReversalAdminAlert({ leagueName: 'Ligue', playerName: 'Léa', team: '', ev: { ...LEAGUE_EV, date: '2199-01-01', id: 'lg:2199-01-01' }, dashboardLink: 'https://x', languageMode: 'en', hoursLeft: 12 });
    expect(m.text).toContain('12 hours before the game');
  });
});

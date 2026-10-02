// Batch 8 item 2d: Notre Ligue text parts put a space before « : » in
// French (« Je joue : »), never in English. 2a to 2c (dead-man alert,
// admin summary, "created" notice) are checked by part197 and the golden
// recordings.
import { describe, it, expect } from 'vitest';
import { renderLeagueReminderEmail, renderLeagueLogisticsEmail } from '../src/index.js';

const ev = { id: 'lg:2099-11-15', date: '2099-11-15', start_time: '19:00', venue: 'Gym' };
const base = { leagueName: 'Ligue', firstName: 'Léa', dayLabel: { fr: 'dimanche', en: 'Sunday' }, ev };

describe('a space before « : » in French text parts', () => {
  it('the reminders', () => {
    const fr = renderLeagueReminderEmail({ ...base, kind: 'reminder_72h', inLink: 'https://x/in', outLink: 'https://x/out', forcedLang: 'fr' });
    expect(fr.text).toContain('Je joue : https://x/in');
    expect(fr.text).toContain('Je ne peux pas : https://x/out');
    const en = renderLeagueReminderEmail({ ...base, kind: 'reminder_24h', inLink: 'https://x/in', outLink: 'https://x/out', forcedLang: 'en' });
    expect(en.text).toContain("I'm in: https://x/in");
  });

  it('the 12 h details', () => {
    const fr = renderLeagueLogisticsEmail({ ...base, team: 'Otters', optOutLink: 'https://x/o', forcedLang: 'fr' });
    expect(fr.text).toContain('Je ne peux plus jouer : https://x/o');
    const en = renderLeagueLogisticsEmail({ ...base, team: 'Otters', optOutLink: 'https://x/o', forcedLang: 'en' });
    expect(en.text).toMatch(/ \S+: https:\/\/x\/o/);
  });
});

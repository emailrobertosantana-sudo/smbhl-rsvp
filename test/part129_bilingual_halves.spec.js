// Group B: an English reader gets what a French reader gets. Each test
// renders the real template and checks the English half (after the
// FR/EN separator) carries the information the French half carries.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import {
  body, formatFixtureText, formatMsgTime, renderCancellationEmail, renderGoalieCancelEmail,
  renderLeagueReminderEmail, renderLeagueLogisticsEmail
} from '../src/index.js';
import { renderHighlightsHtml, renderHighlightsText } from '../src/highlights.js';
import { nlSentByFooter } from '../src/design_system.js';

const HR = '<hr style="border:none; border-top:1px solid #e2e8f0; margin:22px 0;">';
const halves = html => { const i = html.indexOf(HR); expect(i).toBeGreaterThan(0); return [html.slice(0, i), html.slice(i)]; };
const textHalves = text => { const i = text.indexOf('\n---\n'); expect(i).toBeGreaterThan(0); return [text.slice(0, i), text.slice(i)]; };

const ev = { id: 'smbhl:2026-09-28', season: 'Fall 2026', week: 4, date: 'Sunday September 28 2026', start_time: '10:30', venue: 'Collège Laval', state: 'open' };
const matches = [{ time: '10:30 AM', opp: 'Blue', oppFR: 'Bleu', venue: 'Collège Laval' }, { time: '11:30 AM', opp: 'Black', oppFR: 'Noir', venue: 'Collège Laval' }];
const fixtures = { fixtureText: formatFixtureText(matches, 'Red', false), fixtureTextEn: formatFixtureText(matches, 'Red', false, 'en') };
// A Monday-evening message (19:05 Montreal = 23:05 UTC in September).
const msgs = [{ player_name: 'Marc Tremblay', message: 'Running 10 mins late', created_at: '2026-09-21T23:05:00Z' }];

describe('B1 + B4: matchups in each half, in that half\'s language', () => {
  it('formatFixtureText: French uses "contre" and the French opponent; English "vs." and the English one; goalie line in both', () => {
    expect(fixtures.fixtureText).toContain('10:30 AM contre Bleu');
    expect(fixtures.fixtureText).toContain('Chandail rouge requis.');
    expect(fixtures.fixtureText).not.toMatch(/vs\.|shirt/);
    expect(fixtures.fixtureTextEn).toContain('10:30 AM vs. Blue');
    expect(fixtures.fixtureTextEn).toContain('Red shirt required.');
    expect(fixtures.fixtureTextEn).not.toMatch(/contre|Chandail/);
    expect(formatFixtureText(matches, 'Red', true)).toContain('Équipement de gardien (pas de chandail requis).');
    expect(formatFixtureText(matches, 'Red', true, 'en')).toContain('Goalie gear (no shirt required).');
  });

  it('the 72/49/24 h chases carry the matchups in the English half too (HTML and text)', () => {
    for (const stage of ['72', '49', '24']) {
      const m = body('chase', { ev, name: 'Marc', team: 'Red', link: 'L', payload: { stage, yes: 'Y', no: 'N', ...fixtures } });
      const [frH, enH] = halves(m.html);
      expect(frH).toContain('10:30 AM contre Bleu');
      expect(enH).toContain('10:30 AM vs. Blue');
      expect(enH).toContain('11:30 AM vs. Black');
      const [frT, enT] = textHalves(m.text);
      expect(frT).toContain('contre Noir');
      expect(enT).toContain('vs. Black');
    }
  });

  it('gameday (one shared layout) shows the matchups in both languages', () => {
    const m = body('gameday', { ev, name: 'Marc', team: 'Red', link: 'L', payload: { ...fixtures } });
    expect(m.html).toContain('10:30 AM contre Bleu');
    expect(m.html).toContain('10:30 AM vs. Blue');
    expect(m.text).toContain('Red shirt required.');
  });
});

describe('B2: the Friday board and game-morning list the messages in the English half too', () => {
  for (const kind of ['friday_board', 'gameday_morning']) {
    it(`${kind}: English half has every message; subject's French part uses the French team name`, () => {
      const m = body(kind, { ev, name: 'Marc', team: 'Red', link: 'L', payload: { teamLink: 'T', teamMessages: msgs, ...fixtures } });
      const [frH, enH] = halves(m.html);
      expect(frH).toContain('Running 10 mins late');
      expect(enH).toContain('Running 10 mins late');
      expect(enH).toContain('Marc Tremblay');
      const [, enT] = textHalves(m.text);
      expect(enT).toContain('Running 10 mins late');
      expect(m.subject).toMatch(/: Rouge \/ .*: Red$/);
    });
  }

  it('the Friday board\'s English half carries the matchups', () => {
    const m = body('friday_board', { ev, name: 'Marc', team: 'Red', link: 'L', payload: { teamLink: 'T', teamMessages: msgs, ...fixtures } });
    const [, enH] = halves(m.html);
    expect(enH).toContain('vs. Blue');
  });
});

describe('B3: no French inside English halves', () => {
  it('message timestamps: French day names in the French half, English in the English half', () => {
    expect(formatMsgTime('2026-09-21T23:05:00Z', 'fr')).toBe('Lun 19:05');
    expect(formatMsgTime('2026-09-21T23:05:00Z', 'en')).toBe('Mon 19:05');
    expect(formatMsgTime('2026-09-21T23:05:00Z', 'both')).toBe('Lun/Mon 19:05');
    const m = body('friday_board', { ev, name: 'Marc', team: 'Red', link: 'L', payload: { teamLink: 'T', teamMessages: msgs } });
    const [frH, enH] = halves(m.html);
    expect(frH).toContain('(Lun 19:05)');
    expect(enH).toContain('(Mon 19:05)');
    expect(enH).not.toContain('Lun 19:05');
  });

  it('the game-day website link reads "Team page on <site>", not "Team page sur"', () => {
    const m = body('gameday', { ev, name: 'Marc', team: 'Red', link: 'L', payload: { websiteTeamLink: 'https://smbhl.com/#/team/x/Red' } });
    expect(m.html).toContain('Team page on smbhl.com');
    expect(m.html).not.toContain('Team page sur');
  });

  it('money: each language its own format, and the English payment sentence carries the amount', () => {
    const inv = body('invite', { ev, name: 'Marc', team: 'Red', link: 'L', payload: { yes: 'Y', no: 'N', duesReminder: { balance: 170, phone: '514-555-0000' } } });
    expect(inv.text).toContain('Montant dû : 170,00 $ / Amount due: $170.00');
    expect(inv.text).toContain('Please bring $170.00 in cash to the gym or send it by Interac e-Transfer to 514-555-0000.');
    expect(inv.html).toContain('$170.00');
    const gd = body('gameday', { ev, name: 'Marc', team: 'Red', link: 'L', payload: { subFee: { perGame: 5, total: 10, phone: '514-555-0000' } } });
    expect(gd.text).toContain('Please bring $10.00 in cash to the gym');
    expect(gd.html).toContain('Please bring <b>$10.00 in cash</b>');
  });

  it('highlights: English units beside the French ones', () => {
    const h = {
      starsWeek: 3,
      goalieOfTheWeek: { name: 'Sean Pichette', gaa: 3.5 },
      achievements: [
        { name: 'A Scorer', mark: 100, statType: 'g' },
        { name: 'A Passer', mark: 300, statType: 'a' },
        { name: 'A Mover', statType: 'rank', subType: 'skater_points', rank: 2, currentVal: 810, passedNames: ['X'] }
      ],
      firsts: { goals: [], assists: [] },
      closingIn: [{ name: 'Close One', need: 2, type: 'g', target: 50 }]
    };
    for (const out of [renderHighlightsHtml(h), renderHighlightsText(h)]) {
      expect(out).toContain('3.50 MOY / GAA');
      expect(out).toContain('100 buts / goals');
      expect(out).toContain('300 passes / assists');
      expect(out).toContain('2e rang historique / 2nd all-time · 810 pts (dépasse / passes X)');
      expect(out).toContain('50 buts / goals (-2)');
    }
  });
});

describe('B5: French dates in French sentences', () => {
  it('cancellation: French subject part and French text carry the French date', () => {
    const m = renderCancellationEmail(ev);
    expect(m.subject).toBe('Match annulé : dimanche 28 septembre / Game Cancelled: Sunday September 28 2026');
    expect(m.text).toContain('prévus le dimanche 28 septembre');
    expect(m.text).not.toContain('prévus le Sunday');
    expect(m.html).toContain('prévus pour le <b>dimanche 28 septembre</b>');
    expect(m.html).toContain('Game cancelled · Week 4 (Sunday September 28 2026)');
    expect(m.html).toContain('Lieu / Venue');
  });
});

describe('B6 + B9 footers: each language\'s own footer', () => {
  it('nlSentByFooter: fr, en, both', () => {
    expect(nlSentByFooter('fr', { forName: 'Otters' })).toBe('Envoyé par Notre Ligue pour Otters');
    expect(nlSentByFooter('en', { forName: 'Otters' })).toBe('Sent by Notre Ligue for Otters');
    expect(nlSentByFooter('both', { forName: 'Otters' })).toBe('Envoyé par Notre Ligue pour Otters · Sent by Notre Ligue for Otters');
  });

  const lev = { id: 'e1', date: '2026-09-27', start_time: '10:00', venue: 'Parc' };
  const dayLabel = { fr: 'dimanche 27 sept', en: 'Sunday Sept 27' };
  it('league reminders in "both": the English subject has the English date; the footer is in both languages', () => {
    const m = renderLeagueReminderEmail({ kind: 'reminder_72h', leagueName: 'Otters', firstName: 'Ana', dayLabel, ev: lev, inLink: 'I', outLink: 'O', forcedLang: null });
    expect(m.subject).toBe('Ana, as-tu décidé pour dimanche 27 sept? / Ana, have you decided for Sunday Sept 27?');
    expect(m.html).toContain('Propulsé par Notre Ligue pour Otters · Powered by Notre Ligue for Otters');
  });
  it('league reminders in "en": "Powered by Notre Ligue for X", never "pour"', () => {
    const m = renderLeagueLogisticsEmail({ leagueName: 'Otters', firstName: 'Ana', dayLabel, ev: lev, team: 'A', optOutLink: 'O', forcedLang: 'en' });
    expect(m.subject).toBe('Ana, details for Sunday Sept 27');
    expect(m.html).toContain('Powered by Notre Ligue for Otters');
    expect(m.html).not.toContain(' pour Otters');
  });
});

describe('B7: the goalie-cancel alert\'s HTML carries its English half', () => {
  it('game row, "by" row and all three buttons in both languages; French subject date', async () => {
    await applyRealSchema(env);
    env.RSVP_SECRET = 'p129';
    const m = await renderGoalieCancelEmail(env, ev, { name: 'Sean Pichette' }, 'Red', 'self', 'in');
    expect(m.subject).toBe('Alerte Gardien : Sean Pichette absent pour Rouge (dimanche 28 septembre) / Goalie Cancelled: Sean Pichette, Red (Sunday September 28 2026)');
    expect(m.html).toContain('Sunday 10:30 AM (venue: Collège Laval)');
    expect(m.html).toContain('The goalie himself (direct email link / web)');
    expect(m.html).toContain('Manage and call subs');
    expect(m.html).toContain('Team lineup');
    expect(m.html).toContain('Master board');
  });
});

describe('B8: the season recap\'s French text uses the French team name', () => {
  it('no "TEAM Red" in French; overall language unchanged', () => {
    const m = body('season_recap', { ev, name: 'Alex', team: 'Red', payload: { season: 'Fall 2026', champion: 'Red', awards: {} } });
    expect(m.text).toContain('ÉQUIPE ROUGE');
    expect(m.text).not.toContain('TEAM RED');
    expect(m.subject).toContain('Champions (Rouge)');
    expect(m.html).toContain('Équipe Rouge / Team Red');
  });
});

describe('B9: account emails follow one rule', () => {
  const signup = async (email, ip, lang) => {
    const r = await SELF.fetch('http://example.com/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ email, password: 'a-strong-password-1', lang }) });
    return r.json();
  };
  let sent;
  beforeAll(async () => {
    env.AUTH_SECRET = 'p129-auth'; env.RESEND_API_KEY = 'p129';
    await applyRealSchema(env);
    sent = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('api.resend.com')) { sent.push(JSON.parse(opts.body)); return new Response('{"id":"x"}', { status: 200 }); }
      return orig(url, opts);
    };
  });
  const reset = email => SELF.fetch('http://example.com/auth/request-password-reset', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.129.9' }, body: JSON.stringify({ email }) });

  it('no league and no usable signup language: both languages (never French only)', async () => {
    const { userId } = await signup('p129.none@example.com', '203.0.129.1', 'fr');
    await env.DB.prepare("UPDATE users SET signup_lang = '' WHERE id = ?").bind(userId).run();
    sent.length = 0;
    await reset('p129.none@example.com');
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain('Réinitialise ton mot de passe');
    expect(sent[0].html).toContain('Reset your password');
    expect(sent[0].html).toContain('Envoyé par Notre Ligue · Sent by Notre Ligue');
  });

  it('asked from an English page: English only, whatever the account signed up in', async () => {
    await signup('p129.en@example.com', '203.0.129.2', 'fr');
    sent.length = 0;
    await SELF.fetch('http://example.com/auth/request-password-reset', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.129.9' }, body: JSON.stringify({ email: 'p129.en@example.com', lang: 'en' }) });
    expect(sent[0].html).toContain('Reset your password');
    expect(sent[0].html).not.toContain('Réinitialise');
  });
});

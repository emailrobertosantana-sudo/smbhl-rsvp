// The "short of players" email to a league's admins: what it says, in
// which language, and when it is sent.
//
// Copy: "Action needed" / "Short of players", one line per shortage
// ("Bulls, goalies: 0 of 1 needed (confirmed or no reply yet)."), and a
// closing line that says what is true when it goes out. No "(s)", no em
// dash, at 0, 1 and many.
// Language: the league's own setting. One language when the league has
// one; both, French first, only for a bilingual league.
// When: never for a league still being set up (a team with no player on
// it; nobody asked yet, which is more than 72 hours before the game), and
// once per game for a real shortage, however often it is checked.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { H, DAY, local, mail, installMailCapture, removeMailCapture, admin, must, one, rows } from './support/league_season.js';
import { callSubsForShortfall, drain } from '../src/index.js';

const START = Date.UTC(2027, 2, 1, 16, 0);
beforeAll(async () => {
  env.LEAGUE_PRODUCT = 'true'; env.RESEND_API_KEY = 'x'; env.RSVP_SECRET = 'p181'; env.AUTH_SECRET = 'p181-auth'; env.MAIL_DAILY_CAP = ''; env.PUBLIC_URL = 'https://rsvp.example.com';
  vi.useFakeTimers({ toFake: ['Date'] });
  await applyRealSchema(env);
  installMailCapture();
});
beforeEach(() => { vi.setSystemTime(new Date(START)); mail.sent.length = 0; });
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

const EM_DASH = '—';
async function game(leagueId, home, away, at) {
  const { date, time } = local(at);
  const id = `${leagueId}:g:${date}`;
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, home_team, away_team, auto_reminders_enabled) VALUES (?, 'S1', 1, ?, 'Gym', 'open', ?, ?, ?, ?, 1)`).bind(id, date, time, leagueId, home, away).run();
  return one('SELECT * FROM events WHERE id = ?', id);
}
const alertRows = evId => rows(`SELECT id FROM outbox WHERE event_id = ? AND kind = 'short_alert'`, evId);
const alertsTo = tag => mail.sent.filter(m => m.to === `admin.${tag}@example.com` && /Short of players|Manque de joueurs/.test(m.subject));
// A fixed-teams league (minimum 1 goalie and 5 players a team, the default),
// with `bulls` and `parade` = [goalies, players] on each team.
async function fixed(tag, { bulls = [0, 0], parade = [0, 0], teamless = 0, lang = null } = {}) {
  const a = await admin(tag);
  const lg = (await must(a.post('/leagues/create', { name: `P181 ${tag}`, teamNames: ['Bulls', 'Parade'] }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  if (lang) await env.DB.prepare('UPDATE leagues SET language_mode = ? WHERE id = ?').bind(lang, lg.id).run();
  let n = 0;
  for (const [team, [g, p]] of [['Bulls', bulls], ['Parade', parade]]) {
    for (let i = 0; i < g; i++) await must(a.post('/league/contacts', { name: `${team} Goalie${String.fromCharCode(65 + i)}`, email: `${tag}.${++n}@example.com`, team, is_goalie: true }), 'g');
    for (let i = 0; i < p; i++) await must(a.post('/league/contacts', { name: `${team} Player${String.fromCharCode(65 + i)}`, email: `${tag}.${++n}@example.com`, team }), 'p');
  }
  for (let i = 0; i < teamless; i++) await must(a.post('/league/contacts', { name: `Nobody Team${String.fromCharCode(65 + i)}`, email: `${tag}.${++n}@example.com` }), 't');
  return { a, lg };
}
const min = async lg => { const r = await one('SELECT min_players, min_goalies FROM leagues WHERE id = ?', lg.id); return r; };

const FR = {
  subject: /^Manque de joueurs · /,
  // Email review item 2: who is counted, once after the lines.
  lines: ['Bulls, gardiens : 0 sur 1 requis.', 'Bulls, joueurs : 1 sur 5 requis.', 'Parade, joueurs : 4 sur 5 requis.', 'Comptés : les joueurs confirmés ou sans réponse.'],
  close: "Il ne reste aucun remplaçant à appeler. Tes joueurs n'ont pas été avisés de ce manque.",
  tag: 'Action requise', heading: 'Manque de joueurs', button: 'Voir le match'
};
const EN = {
  subject: /Short of players · /,
  lines: ['Bulls, goalies: 0 of 1 needed.', 'Bulls, players: 1 of 5 needed.', 'Parade, players: 4 of 5 needed.', 'Counted: players confirmed or not yet answered.'],
  close: 'No substitutes are left to call. Your players have not been told about this shortage.',
  tag: 'Action needed', heading: 'Short of players', button: 'View the game'
};
const has = (m, L) => { for (const l of [...L.lines, L.close]) expect(m.text).toContain(l); for (const x of [L.tag, L.heading, L.button]) expect(m.html).toContain(x); };
const hasNot = (m, L) => { for (const l of [...L.lines, L.close]) expect(m.text).not.toContain(l); expect(m.html).not.toContain(`>${L.button}<`); expect(m.html).not.toContain(L.close.replace("'", '&#39;')); };

describe('Short of players: the copy, in the league\'s language', () => {
  // Bulls: no goalie, 1 player. Parade: 1 goalie, 4 players. Counts 0, 1 and 4.
  const shape = { bulls: [0, 1], parade: [1, 4] };

  for (const [lang, present, absent] of [['en', [EN], [FR]], ['fr', [FR], [EN]], ['both', [FR, EN], []]]) {
    it(`a league set to ${lang}: ${present.length === 2 ? 'both languages, French first' : 'that language only'}; 0, 1 and many; no "(s)", no em dash`, async () => {
      const tag = `copy.${lang}`;
      const { lg } = await fixed(tag, { ...shape, lang });
      expect(await min(lg)).toBeTruthy();
      const ev = await game(lg.id, 'Bulls', 'Parade', START + 2 * DAY);
      await callSubsForShortfall(env, ev);
      await drain(env);
      const sent = alertsTo(tag);
      expect(sent).toHaveLength(1);
      const m = sent[0];
      for (const L of present) { expect(m.subject).toMatch(L.subject); has(m, L); }
      for (const L of absent) hasNot(m, L);
      if (lang === 'both') {
        expect(m.subject).toMatch(/^Manque de joueurs · .+ \/ Short of players · /);
        expect(m.html.indexOf('Action requise')).toBeLessThan(m.html.indexOf('Action needed'));
        expect(m.text.indexOf(FR.close)).toBeLessThan(m.text.indexOf(EN.close));
      }
      if (lang === 'en') expect(m.subject).toMatch(/^Short of players · /);
      // The goalie who is there is not reported, and nothing is approximate.
      expect(m.text).not.toContain('Parade, goalies');
      expect(m.text).not.toContain('Parade, gardiens');
      for (const part of [m.subject, m.text, m.html]) {
        expect(part).not.toMatch(/\((s|es|e)\)/);
        expect(part).not.toContain(EM_DASH);
      }
      // The old wording is gone.
      for (const old of ['Short game', 'Match incomplet', 'Il manque des joueurs', 'no sub left to call', 'against a minimum', 'pour un minimum']) expect(m.text + m.html).not.toContain(old);
      // The button goes to this game's page.
      expect(m.html).toContain(`href="https://rsvp.example.com/league/events/detail?e=${encodeURIComponent(ev.id)}"`);
    });
  }

  it('inside the last 24 hours, in a league with no substitute, only those who said yes count: "(confirmed)"', async () => {
    const { lg } = await fixed('copy.late', { bulls: [1, 6], parade: [1, 6] });
    const at = START + 2 * DAY;
    const ev = await game(lg.id, 'Bulls', 'Parade', at);
    await callSubsForShortfall(env, ev); // full rosters, nobody has answered: not short
    expect(await alertRows(ev.id)).toHaveLength(0);
    vi.setSystemTime(new Date(at - 20 * H));
    await callSubsForShortfall(env, ev);
    await drain(env);
    const m = alertsTo('copy.late')[0];
    expect(m.text).toContain('Bulls, goalies: 0 of 1 needed.');
    expect(m.text).toContain('Bulls, players: 0 of 5 needed.');
    expect(m.text).toContain('Parade, joueurs : 0 sur 5 requis.');
    expect(m.text).toContain('Counted: confirmed players.');
    expect(m.text).toContain('Comptés : les joueurs confirmés.');
    expect(m.text).toContain(EN.close);
    expect(m.text).not.toMatch(/\((s|es|e)\)/);
  });
});

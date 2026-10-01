// D8 (decided 2026-09-29): a sub call from a league with no teams said
// "we place you on a team" -- false with no teams, and the no-teams
// structure now also serves a single team. The team sentence is dropped
// entirely there; a fixed-teams league's generic call keeps it.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { wideSubCallWindow } from './support/wide_sub_call_window.js'; // the 8-day sub-call window these tests were written for
import { DAY, local, mail, installMailCapture, removeMailCapture, admin, must, one } from './support/league_season.js';
import { callSubsForShortfall, drain } from '../src/index.js';

const START = Date.UTC(2026, 9, 5, 16, 0);
beforeAll(async () => {
  env.LEAGUE_PRODUCT = 'true'; env.RESEND_API_KEY = 'x'; env.RSVP_SECRET = 'p156'; env.AUTH_SECRET = 'p156-auth'; env.MAIL_DAILY_CAP = ''; env.PUBLIC_URL = 'https://rsvp.example.com';
  vi.useFakeTimers({ toFake: ['Date'] });
  await applyRealSchema(env); await wideSubCallWindow(env);
  installMailCapture();
});
beforeEach(() => { vi.setSystemTime(new Date(START)); mail.sent.length = 0; });
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

async function subCallText(tag, structure, create) {
  const a = await admin(tag);
  const lg = (await must(a.post('/leagues/create', { name: `P156 ${tag}`, teamStructure: structure, ...create }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  await must(a.post('/league/contacts', { name: `${tag} Sub`, email: `${tag}.sub@example.com`, role: 'sub_skater' }), 'sub');
  const { date, time } = local(START + 4 * DAY);
  const id = `${lg.id}:g:${date}`;
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, home_team, away_team, auto_reminders_enabled) VALUES (?, 'S1', 1, ?, 'Gym', 'open', ?, ?, ?, ?, 1)`)
    .bind(id, date, time, lg.id, structure === 'fixed' ? 'Red' : null, structure === 'fixed' ? 'Blue' : null).run();
  expect(await callSubsForShortfall(env, await one('SELECT * FROM events WHERE id = ?', id))).toBe(1);
  await drain(env);
  const m = mail.sent.find(x => x.to === `${tag}.sub@example.com`);
  expect(m).toBeTruthy();
  return m;
}

describe('The no-teams sub call', () => {
  it('has no team sentence, in either language', async () => {
    const m = await subCallText('noteams', 'headcount', { minPlayers: 8, maxPlayers: 12, minGoalies: 0 });
    for (const part of [m.text, m.html]) {
      expect(part).not.toContain("L'équipe n'est pas encore décidée");
      expect(part).not.toContain("L&#39;équipe n&#39;est pas encore décidée");
      expect(part).not.toContain("The team isn't decided yet");
      expect(part).not.toContain('The team isn&#39;t decided yet');
      expect(part).not.toMatch(/place (you on|dans) une? (team|équipe)/);
    }
    expect(m.text).toContain('P156 noteams cherche un joueur');
    expect(m.text).toContain('P156 noteams needs a player');
  });

  it('a fixed-teams league\'s generic call keeps it', async () => {
    const m = await subCallText('fixed', 'fixed', { teamNames: ['Red', 'Blue'] });
    expect(m.text).toContain("L'équipe n'est pas encore décidée : si tu es disponible, on te place dans une équipe, et tu reçois ton équipe finale avant le match.");
    expect(m.text).toContain("The team isn't decided yet: if you're available, we place you on a team, and you get your final team before the game.");
  });
});

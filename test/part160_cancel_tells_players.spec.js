// D4 (decided 2026-09-29): cancelling a game emailed nobody, so confirmed
// players turned up to a cancelled game. Everyone who said IN and everyone
// who has NOT ANSWERED is now emailed; those who said out already know.
// Only players of the game's teams (a fixed-teams game) -- the same
// audiences the league's own reminders use.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { DAY, local, mail, installMailCapture, removeMailCapture, admin, must, one } from './support/league_season.js';

const START = Date.UTC(2026, 9, 5, 16, 0);
beforeAll(async () => {
  env.LEAGUE_PRODUCT = 'true'; env.RESEND_API_KEY = 'x'; env.RSVP_SECRET = 'p160'; env.AUTH_SECRET = 'p160-auth'; env.MAIL_DAILY_CAP = ''; env.PUBLIC_URL = 'https://rsvp.example.com';
  vi.useFakeTimers({ toFake: ['Date'] });
  await applyRealSchema(env);
  installMailCapture();
});
beforeEach(() => { vi.setSystemTime(new Date(START)); mail.sent.length = 0; });
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

describe('Cancelling a game tells the players who would come', () => {
  it('in and no-reply get the email; out, and a team not in the game, do not', async () => {
    const a = await admin('d4');
    const lg = (await must(a.post('/leagues/create', { name: 'P160 League', teamNames: ['Red', 'Blue', 'Green'] }), 'create')).league;
    await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
    const add = async (name, team, role = 'roster') => (await must(a.post('/league/contacts', { name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`, team: team || '', role }), 'c')).contact.player_id;
    const ids = { redIn: await add('Red In', 'Red'), redOut: await add('Red Out', 'Red'), redQuiet: await add('Red Quiet', 'Red'), blueIn: await add('Blue In', 'Blue'), greenQuiet: await add('Green Quiet', 'Green'), sub: await add('Placed Sub', null, 'sub_skater') };
    const { date, time } = local(START + 3 * DAY);
    const evId = `${lg.id}:g:${date}`;
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, home_team, away_team, auto_reminders_enabled) VALUES (?, 'S1', 1, ?, 'Aréna Nord', 'open', ?, ?, 'Red', 'Blue', 1)`).bind(evId, date, time, lg.id).run();
    const rsvp = (pid, team, status, role = 'roster') => env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, ?, ?, ?, 'self', ?, ?)`).bind(evId, pid, team, status, role, new Date().toISOString(), lg.id).run();
    await rsvp(ids.redIn, 'Red', 'in'); await rsvp(ids.redOut, 'Red', 'out'); await rsvp(ids.blueIn, 'Blue', 'in'); await rsvp(ids.sub, 'Blue', 'in', 'sub');
    mail.sent.length = 0;
    const res = await a.post('/league/events/cancel', { event_id: evId });
    expect(res.status).toBe(200);
    expect((await one('SELECT state FROM events WHERE id = ?', evId)).state).toBe('cancelled');
    const told = mail.sent.filter(m => /annulé|cancelled/.test(m.subject)).map(m => m.to).sort();
    expect(told).toEqual(['blue.in@example.com', 'placed.sub@example.com', 'red.in@example.com', 'red.quiet@example.com']);
    const m = mail.sent.find(x => x.to === 'red.in@example.com');
    expect(m.subject).toMatch(/^Match annulé · .+ \/ Game cancelled · /);
    expect(m.text).toContain('Bonjour Red,\nLe match de ');
    expect(m.text).toContain(' est annulé.\nLieu : Aréna Nord\nPas besoin de te présenter.');
    expect(m.text).toContain('Hi Red,\nThe game on ');
    expect(m.text).toContain(' is cancelled.\nVenue: Aréna Nord\nNo need to come.');
    // Once only, even if cancel is pressed again.
    mail.sent.length = 0;
    await a.post('/league/events/cancel', { event_id: evId });
    expect(mail.sent.filter(x => /annulé|cancelled/.test(x.subject))).toEqual([]);
  });

  it('the schedule asks first, saying who will be emailed', async () => {
    const a = await admin('d4copy');
    await must(a.post('/leagues/create', { name: 'P160 Copy', teamNames: ['A', 'B'] }), 'create');
    await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
    const html = (await a.get('/league/schedule')).text;
    const d = JSON.parse(html.match(/var __I18N = (\{[\s\S]*?\});\n/)[1]);
    expect(d.fr.cancelEventConfirm).toBe("Annuler ce match? Les joueurs qui ont dit qu'ils seraient là et ceux qui n'ont pas répondu recevront un courriel.");
    expect(d.en.cancelEventConfirm).toBe("Cancel this game? Players who said they're in, and those who haven't answered, will get an email.");
    expect(html).toContain('if (!window.confirm(window.__pageDict().cancelEventConfirm)) return;');
  });
});

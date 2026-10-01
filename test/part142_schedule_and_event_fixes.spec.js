// Follow-up batch: the bye note, the Schedule page's nudge and order,
// bulk-created times, the event page's result/stats card, and the Players
// table's team control.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { computePlayoffSlots } from '../src/leagues.js';
import { withGameTimes } from './support/game_times.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.142.${++ip}` },
    body: JSON.stringify({ accept_terms: true, email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = async (s, path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const page = async (s, path) => (await SELF.fetch('http://example.com' + path, { headers: s ? { cookie: s.cookie } : {}, redirect: 'manual' })).text();

beforeAll(async () => {
  env.AUTH_SECRET = 'p142-auth';
  await applyRealSchema(env);
});

describe('2. The bye note agrees with the slot arithmetic', () => {
  it('an odd team count reserves no extra slot, and the note says a bye uses none', async () => {
    const odd = computePlayoffSlots({ format: 'single_elimination', numTeams: 5, thirdPlace: false });
    expect(odd.hasBye).toBe(true);
    expect(odd.playoffSlots).toBe(4); // numTeams - 1: real games only
    const s = await signup('p142.bye@example.com');
    await post(s, '/leagues/create', { name: 'P142 Bye', teamNames: ['A', 'B', 'C', 'D', 'E'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const html = await page(s, '/onboarding/season?step=3');
    expect(html).toContain('id="ob_bye_note"');
    expect(html).toContain("Un bye n'est pas un match : il n'utilise aucun créneau.");
    expect(html).toContain('A bye is not a game: it uses no slot.');
    expect(html).not.toContain('créneau de plus');
    expect(html).not.toContain('extra slot');
  });
});

const createEventAt = (s, date) => post(s, '/league/events', withGameTimes({ date }));
const i18n = html => JSON.parse(html.match(/var __I18N = (\{[\s\S]*?\});\n/)[1]);

describe('3. The Schedule page lets you do what you came for, and names the real next step', () => {
  it('no games yet: no nudge -- the create buttons are the step, and Create an event stays primary', async () => {
    const s = await signup('p142.sched.empty@example.com');
    await post(s, '/leagues/create', { name: 'P142 Sched Empty', teamNames: ['A', 'B'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const html = await page(s, '/league/schedule');
    expect(html).not.toContain('id="sc_next_step"');
    expect(html).toContain('class="nl-btn nl-btn--primary" onclick="openSchedulePanel()" data-i18n="createEvent"');
  });

  it('fixed teams with games and no matchups: the next step is Assign matchups, named and explained, and secondary', async () => {
    const s = await signup('p142.sched.fixed@example.com');
    await post(s, '/leagues/create', { name: 'P142 Sched Fixed', teamNames: ['Red', 'Blue', 'White'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    for (const d of ['2099-06-01', '2099-06-08', '2099-06-15']) await createEventAt(s, d);
    const html = await page(s, '/league/schedule');
    expect(html).toContain('data-next-step="matchups"');
    expect(html).toContain('data-i18n="matchupsNudgeTitle">Assigne les affrontements.<');
    const nudge = html.slice(html.indexOf('id="sc_next_step"'), html.indexOf('</section>', html.indexOf('id="sc_next_step"')));
    expect(nudge).not.toContain('nl-btn--primary');
    expect(nudge).toContain('onclick="toggleMatchupsPanel()"');
    expect(nudge).not.toContain('/league/roster'); // not "add players" while matchups are the real next step
    const dict = i18n(html);
    expect(dict.fr.matchupsNudgeDesc).toBe("Choisis qui joue contre qui dans chacun de tes matchs. Tu vois l'aperçu avant de confirmer ; aucun match n'est créé.");
    expect(dict.en.matchupsNudgeDesc).toBe('Choose who plays whom in each of your games. You see a preview before confirming; no game is created.');
  });

  it('pickup with games and no players: the next step is Add players -- never matchups', async () => {
    const s = await signup('p142.sched.pickup@example.com');
    await post(s, '/leagues/create', { name: 'P142 Sched Pickup', teamStructure: 'weekly_draw', teamNames: ['A', 'B'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    await createEventAt(s, '2099-06-01');
    const html = await page(s, '/league/schedule');
    expect(html).toContain('data-next-step="players"');
    expect(html).not.toContain('matchupsNudgeTitle">');
  });

  it('the nudge says one thing once -- no "players first ... add your roster"', async () => {
    const s = await signup('p142.sched.copy@example.com');
    await post(s, '/leagues/create', { name: 'P142 Sched Copy', teamNames: ['A', 'B'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const dict = i18n(await page(s, '/league/schedule'));
    expect(dict.fr.scheduleNudgeTitle).toBe('Ajoute tes joueurs.');
    expect(dict.en.scheduleNudgeTitle).toBe('Add your players.');
    expect(dict.fr.scheduleNudgeDesc).toBe("Tes matchs sont créés. Ajoute tes joueurs pour qu'ils puissent commencer à répondre.");
    expect(dict.en.scheduleNudgeDesc).toBe('Your games are created. Add your players so they can start responding.');
  });

  it('every surface agrees the schedule comes first: dashboard checklist, Players, Schedule', async () => {
    const s = await signup('p142.sched.order@example.com');
    await post(s, '/leagues/create', { name: 'P142 Sched Order', teamNames: ['A', 'B'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const dash = await page(s, '/dashboard');
    expect(dash.indexOf('data-i18n="nsCreateSchedule"')).toBeGreaterThan(-1);
    expect(dash.indexOf('data-i18n="nsCreateSchedule"')).toBeLessThan(dash.indexOf('data-i18n="nsAddPlayers"'));
    const roster = await page(s, '/league/roster');
    expect(roster).toContain('data-i18n="rosterNudgeTitle">Crée ton horaire.<');
    expect(roster).toContain('<a class="nl-btn nl-btn--secondary nl-btn--sm" href="/league/schedule" data-i18n="rosterNudgeBtn">');
    const rd = i18n(roster);
    expect(rd.fr.rosterNudgeDesc).toBe("L'horaire vient en premier : crée tes matchs, puis complète ta liste de joueurs.");
    expect(rd.en.rosterNudgeDesc).toBe('The schedule comes first: create your games, then finish your player list.');
    expect(await page(s, '/league/schedule')).not.toContain('scheduleNudgeTitle">'); // no "add players first"
  });
});

describe('4. Bulk-created games keep the time the form sent', () => {
  it('a 10:30 series is stored at 10:30 (and a 22:30 one at 22:30) -- no AM/PM conversion anywhere', async () => {
    const s = await signup('p142.bulk.time@example.com');
    const league = (await (await post(s, '/leagues/create', { name: 'P142 Bulk Time', teamNames: ['A', 'B'] })).json()).league;
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const res = await (await post(s, '/league/events/bulk', withGameTimes({ startDate: '2099-03-01', occurrences: 3, start_time: '10:30', end_time: '11:30', venue: 'Rink' }))).json();
    expect(res.createdCount).toBe(3);
    await post(s, '/league/events/bulk', withGameTimes({ startDate: '2099-03-01', occurrences: 1, start_time: '22:30', end_time: '23:30', venue: 'Rink' }));
    const rows = (await env.DB.prepare('SELECT start_time, end_time FROM events WHERE league_id = ? ORDER BY date, start_time').bind(league.id).all()).results;
    expect(rows.map(r => `${r.start_time}-${r.end_time}`)).toEqual(['10:30-11:30', '22:30-23:30', '10:30-11:30', '10:30-11:30']);
  });
});

describe('5. Result and player stats: only once the game has started, the form closed until asked for, one scoreline', () => {
  const setup = async (email, date, start_time) => {
    const s = await signup(email);
    await post(s, '/leagues/create', { name: `P142 ${email}`, teamNames: ['Blue', 'White'], tracksStats: true });
    await post(s, '/league/settings/identity', { tracksResults: true, tracksPlayerStats: true });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const ev = (await (await post(s, '/league/events', withGameTimes({ date, season: 'S1', start_time }))).json()).event;
    const html = await page(s, `/league/events/detail?e=${encodeURIComponent(ev.id)}`);
    return { s, ev, html };
  };

  it('a future game: no Result, no Player stats -- and the routes refuse it', async () => {
    const { s, ev, html } = await setup('p142.future@example.com', '2099-05-03', '19:00');
    expect(html).not.toContain('id="result_card"');
    expect(html).not.toContain('id="score_section"');
    expect(html).not.toContain('id="player_stats_section"');
    const score = await post(s, '/league/events/score', { event_id: ev.id, home_score: 5, away_score: 3 });
    expect(score.status).toBe(409);
    expect((await score.json()).errorKey).toBe('GAME_NOT_STARTED');
    const stats = await post(s, '/league/events/player-stats', { event_id: ev.id, entries: [] });
    expect((await stats.json()).errorKey).toBe('GAME_NOT_STARTED');
  });

  it('a past game: one card, the form closed with its button showing, the scoreline on one row', async () => {
    const { html } = await setup('p142.past@example.com', '2020-05-03', '19:00');
    const card = html.slice(html.indexOf('id="result_card"'), html.indexOf('</section>', html.indexOf('id="result_card"')));
    expect(card).toContain('id="score_section"');
    expect(card).toContain('id="player_stats_section"'); // same card: the two halves of one task
    expect(card).toContain('<div id="score_form" class="ev-scoreline" hidden');
    expect(card).toMatch(/<div style="margin-top:8px" id="score_toggle_wrap"><button[^>]*data-i18n="scoreEnterBtn"/);
    // Blue [ ] — [ ] White, Save beside it: label, input, dash, input, label, then the buttons.
    const line = card.slice(card.indexOf('id="score_form"'), card.indexOf('id="score_toggle_wrap"'));
    const order = ['id="score_home_label">Blue<', 'id="score_home"', 'ev-score-dash', 'id="score_away"', 'id="score_away_label">White<', 'data-i18n="scoreSaveBtn"'].map(m => line.indexOf(m));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('started means started: later today is not, earlier today is', async () => {
    const { eventHasStarted } = await import('../src/league_ids.js');
    const now = Date.parse('2026-09-28T16:00:00Z'); // 12:00 in Montreal
    expect(eventHasStarted({ id: 'x:2026-09-28', date: '2026-09-28', start_time: '19:00' }, now)).toBe(false);
    expect(eventHasStarted({ id: 'x:2026-09-28', date: '2026-09-28', start_time: '10:30' }, now)).toBe(true);
    expect(eventHasStarted({ id: 'x:2026-09-28', date: '2026-09-28', start_time: null }, now)).toBe(true);
    expect(eventHasStarted({ id: 'x:2026-09-29', date: '2026-09-29', start_time: null }, now)).toBe(false);
  });
});

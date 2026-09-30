// D1 (nights), decided 2026-09-30: every game needs an end time -- it is
// how the app tells which games overlap -- and a start time with it. The
// create, bulk-create, edit and duplicate routes refuse a game without
// them, the forms mark both required, and games that already exist
// without an end time are not guessed at: the schedule asks for it.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must } from './support/league_season.js';

beforeAll(async () => { env.AUTH_SECRET = 'p164'; env.RSVP_SECRET = 'p164r'; await applyRealSchema(env); });

const visible = html => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const unesc = t => t.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const dictOf =html => { const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/); return m ? JSON.parse(m[1]) : null; };

async function league(tag) {
  const a = await admin(tag);
  const lg = (await must(a.post('/leagues/create', { name: 'Times ' + tag, teamNames: ['Bears', 'Otters'] }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
  return { a, lg };
}

describe('The routes refuse a game without its times', () => {
  it('create, bulk create and edit: start and end are both required, with the error in both languages', async () => {
    const { a } = await league('p164routes');
    const noStart = await a.post('/league/events', { date: '2099-05-05', season: 'S1', end_time: '20:00' });
    expect([noStart.status, noStart.json.errorKey]).toEqual([400, 'START_TIME_REQUIRED']);
    const noEnd = await a.post('/league/events', { date: '2099-05-05', season: 'S1', start_time: '19:00' });
    expect([noEnd.status, noEnd.json.errorKey]).toEqual([400, 'END_TIME_REQUIRED']);
    const bulk = await a.post('/league/events/bulk', { startDate: '2099-05-12', occurrences: 2, season: 'S1', start_time: '19:00' });
    // The bulk form's own key for the same rule (beside the field).
    expect([bulk.status, bulk.json.errorKey]).toEqual([400, 'BULK_END_TIME_REQUIRED']);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM events WHERE date IN ('2099-05-05', '2099-05-12', '2099-05-19')").first()).n).toBe(0);

    const ok = await must(a.post('/league/events', { date: '2099-05-05', season: 'S1', start_time: '19:00', end_time: '20:00' }), 'with times');
    const edit = await a.post('/league/events/update', { event_id: ok.event.id, start_time: '19:00', end_time: '' });
    expect([edit.status, edit.json.errorKey]).toEqual([400, 'END_TIME_REQUIRED']);
    const row = await env.DB.prepare('SELECT start_time, end_time FROM events WHERE id = ?').bind(ok.event.id).first();
    expect(row).toEqual({ start_time: '19:00', end_time: '20:00' });

    const errs = (await a.get('/league/schedule')).text.match(/window\.__ERROR_I18N = (\{[\s\S]*?\});/);
    const e = JSON.parse(errs[1]);
    expect(e.START_TIME_REQUIRED).toEqual({ fr: "Indique l'heure de début du match.", en: "Add the game's start time." });
    expect(e.END_TIME_REQUIRED).toEqual({ fr: "Indique l'heure de fin du match : elle sert à savoir quels matchs se chevauchent.", en: "Add the game's end time: it's how we tell which games overlap." });
  });

  it('duplicating an old game with no end time is refused until the end time is added', async () => {
    const { a, lg } = await league('p164dup');
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'S1', 1, '2099-06-02', 'Gym', 'open', '19:00', ?)`).bind(lg.id + ':2099-06-02', lg.id).run();
    const dup = await a.post('/league/events/duplicate', { event_id: lg.id + ':2099-06-02', date: '2099-06-09' });
    expect([dup.status, dup.json.errorKey]).toEqual([400, 'END_TIME_REQUIRED']);
    await must(a.post('/league/events/update', { event_id: lg.id + ':2099-06-02', start_time: '19:00', end_time: '20:30' }), 'add end');
    const dup2 = await must(a.post('/league/events/duplicate', { event_id: lg.id + ':2099-06-02', date: '2099-06-09' }), 'dup');
    expect([dup2.event.start_time, dup2.event.end_time]).toEqual(['19:00', '20:30']);
  });
});

describe('The forms mark both times required', () => {
  it('schedule (one game, several games) and the game page: no "(optional)", and the inputs are required', async () => {
    const { a } = await league('p164forms');
    const html = (await a.get('/league/schedule')).text;
    for (const id of ['e_start', 'e_end', 'be_start', 'be_end']) expect(html).toMatch(new RegExp(`id="${id}"[^>]*\\brequired\\b`));
    const d = dictOf(html);
    expect([d.fr.startOpt, d.fr.endOpt, d.en.startOpt, d.en.endOpt]).toEqual(['Heure de début', 'Heure de fin', 'Start time', 'End time']);
    expect(visible(html)).not.toMatch(/Heure de (début|fin) \(optionnel\)/);
    const ev = (await must(a.post('/league/events', { date: '2099-07-07', season: 'S1', start_time: '19:00', end_time: '20:00' }), 'ev')).event;
    const detail = (await a.get('/league/events/detail?e=' + encodeURIComponent(ev.id))).text;
    for (const id of ['ev_edit_start', 'ev_edit_end']) expect(detail).toMatch(new RegExp(`id="${id}"[^>]*\\brequired\\b`));
    expect(visible(detail)).not.toMatch(/Heure de (début|fin) \(optionnel\)/);
  });
});

describe('Games that already exist without an end time', () => {
  it('are left as they are, and the schedule asks for the end time -- only for upcoming open games', async () => {
    const { a, lg } = await league('p164legacy');
    const ins = (date, state, end) => env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, end_time, league_id) VALUES (?, 'S1', 1, ?, 'Gym', ?, '19:00', ?, ?)`).bind(`${lg.id}:${date}`, date, state, end, lg.id).run();
    await ins('2099-08-04', 'open', null);
    await ins('2099-08-11', 'open', null);
    await ins('2099-08-18', 'cancelled', null);
    await ins('2099-08-25', 'open', '20:00');
    await ins('2020-08-04', 'open', null); // past: not asked for
    const html = (await a.get('/league/schedule')).text;
    const notice = html.match(/<section class="nl-card" id="sc_no_end">[\s\S]*?<\/section>/)[0];
    const attr = name => unesc(notice.match(new RegExp(name + '="([^"]*)"'))[1]);
    expect(attr('data-date-fr')).toBe("2 matchs à venir n'ont pas d'heure de fin. Ajoute-la sur la page du match : elle sert à savoir quels matchs se chevauchent. D'ici là, deux matchs ne comptent comme simultanés que s'ils commencent à la même heure.");
    expect(attr('data-date-en')).toBe("2 upcoming games have no end time. Add it on the game's page: it's how we tell which games overlap. Until then, two games only count as at the same time when they start at the same time.");
    expect((html.match(/data-i18n="noEndTag"/g) || []).length).toBe(2);
    const d = dictOf(html);
    expect([d.fr.noEndTag, d.en.noEndTag, d.fr.noEndNoticeTitle, d.en.noEndNoticeTitle]).toEqual(['Heure de fin à ajouter', 'End time needed', "Des matchs n'ont pas d'heure de fin", 'Some games have no end time']);
    // Nothing was written to the old games.
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM events WHERE league_id = ? AND end_time IS NULL').bind(lg.id).first()).n).toBe(4);
  });

  it('no notice when every upcoming game has its end time', async () => {
    const { a } = await league('p164clean');
    await must(a.post('/league/events', { date: '2099-09-01', season: 'S1', start_time: '19:00', end_time: '20:00' }), 'ev');
    expect((await a.get('/league/schedule')).text).not.toContain('id="sc_no_end"');
  });
});

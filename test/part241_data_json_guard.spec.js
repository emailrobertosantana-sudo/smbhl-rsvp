// The data_json guard (data_json guard batch, item 2): SMBHL's data_json is
// never written with garbled text (UTF-8 read through code page 850 or
// Windows-1252). Refused: nothing written, the current value kept, one
// operator alert listing each damaged string and its path, an error for the
// admin. Real French goes through; SMBHL's normal publish still writes.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { isMojibake, findMojibake } from '../src/mojibake.js';
import { putDataJson, DataJsonDamagedError } from '../src/data_json_guard.js';

const ADMIN_KEY = 'test-part241-admin';
const HOOK = 'https://ntfy.sh/p241-topic';
const SEASON = 'P241 Season';
const hooks = [];
let originalFetch;

const label = days => new Date(Date.now() + days * 86400000).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' }).replace(/,/g, '');
const isoOf = days => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() + days * 86400000)); const g = t => p.find(x => x.type === t).value; return `${g('year')}-${g('month')}-${g('day')}`; };
const CLEAN = () => ({ current_season: SEASON, seasons: [{ name: SEASON, config: { teams: [{ name: 'Red' }, { name: 'Blue' }] }, standings: [], fixtures: [
  { week: 3, date: label(-1), time: '10:30 AM', home: 'Red', away: 'Blue', venue: 'Collège Letendre' }
] }], players: [{ id: 'P0001', name: 'Élodie Âgé-Côté', seasons: {}, gseasons: {} }] });
const admin = (path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const kvText = () => env.SHEETS_KV.get('data_json');

beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  env.ALERT_WEBHOOK_URL = HOOK;
  delete env.LEAGUE_PRODUCT;
  delete env.OPERATOR_ALERT_EMAIL;
  await applyRealSchema(env);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url && url.url ? url.url : url);
    if (u === HOOK) { hooks.push({ title: decodeURIComponent((opts.headers && opts.headers.Title) || ''), body: String(opts.body || '') }); return new Response('ok', { status: 200 }); }
    if (u.includes('api.resend.com')) return new Response('{"id":"x"}', { status: 200 });
    return new Response('{}', { status: 404 });
  };
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, state, start_time, league_id) VALUES (?, ?, 3, ?, 'locked', '10:30', 'smbhl')`).bind(`smbhl:${isoOf(-1)}`, SEASON, label(-1)).run();
});
afterAll(() => { globalThis.fetch = originalFetch; delete env.ALERT_WEBHOOK_URL; });
beforeEach(async () => { hooks.length = 0; await env.SHEETS_KV.put('data_json', JSON.stringify(CLEAN(), null, 2)); });

describe('the detector', () => {
  it('each damage pattern is caught', () => {
    const damaged = {
      'code page 850, accents': ['Fran├ºois', 'Coll├¿ge', 'jou├®e', 'Tout premier tournoi ┬½ King ┬╗'],
      'Windows-1252': ['FranÃ§ois', 'jouÃ©e', 'CollÃ¨ge', 'Blueâ€™s', 'Ã‰quipe', 'Â° degré', 'Â« guillemets'],
      'code page 850 once, three and four bytes': ['Team BlueÔÇÖs', 'Ô¡É', '­ƒÑû'],
      'emoji damaged twice': ['┬¡ãÆ├æ├╗', '├ö┬í├ë']
    };
    for (const [kind, list] of Object.entries(damaged)) for (const s of list) expect(isMojibake(s), `${kind}: ${s}`).toBe(true);
  });

  it('real French and real symbols go through', () => {
    for (const s of ['Âge', 'À la', 'Équipe', 'Élodie', 'Ô Canada', 'HÔTEL', 'Ça', 'Où', 'Noël', 'Œuvre', 'Fête', '« guillemets »', 'naïf', 'Côte-Saint-Luc', 'Île', 'Âme', '⭐', '🥖', '’', '°', 'François Beaucaire-Gaudreau', 'Collège Laval', 'Vézina', 'Défenseur (Égalité)'])
      expect(isMojibake(s), s).toBe(false);
  });

  it('every damaged string with its path, keys included', () => {
    expect(findMojibake({ players: [{ name: 'Fran├ºois' }, { name: 'Élodie' }], 'cl├®': 1 })).toEqual([
      { path: '$.players[0].name', value: 'Fran├ºois' },
      { path: '$ (key)', value: 'cl├®' }
    ]);
  });
});

describe('putDataJson', () => {
  it('refuses damaged text: nothing written, one alert with each string and its path', async () => {
    const before = await kvText();
    const d = CLEAN(); d.players[0].name = 'Fran├ºois Beaucaire'; d.seasons[0].fixtures[0].venue = 'Coll├¿ge Laval';
    const err = await putDataJson(env, JSON.stringify(d), 'test').catch(e => e);
    expect(err).toBeInstanceOf(DataJsonDamagedError);
    expect(err.damaged.map(x => x.path)).toEqual(['$.seasons[0].fixtures[0].venue', '$.players[0].name']);
    expect(await kvText()).toBe(before);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].title).toBe('SMBHL : data_json refusé, texte endommagé / data_json refused, damaged text');
    expect(hooks[0].body).toContain('$.players[0].name : "Fran├ºois Beaucaire"');
    expect(hooks[0].body).toContain('$.seasons[0].fixtures[0].venue : "Coll├¿ge Laval"');
    expect(hooks[0].body).toContain('(test)');
    // The same damaged text again: refused again, not alerted again.
    await expect(putDataJson(env, JSON.stringify(d), 'test')).rejects.toBeInstanceOf(DataJsonDamagedError);
    expect(hooks).toHaveLength(1);
  });

  it('clean text is written as given', async () => {
    const d = CLEAN(); d.players[0].name = 'François Âge';
    await putDataJson(env, JSON.stringify(d), 'test');
    expect(JSON.parse(await kvText()).players[0].name).toBe('François Âge');
    expect(hooks).toHaveLength(0);
  });
});

describe('the routes that write data_json', () => {
  it('a team add with a garbled name: 422 for the admin, data_json and contacts unchanged', async () => {
    const before = await kvText();
    const res = await admin('/admin/teams/add', { name: 'Fran├ºois Testeur', season: SEASON, target_team: 'Red', position: 'A' });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errorKey).toBe('DATA_JSON_DAMAGED');
    expect(body.error).toContain('Pas enregistré');
    expect(body.error).toContain('Not saved');
    expect(await kvText()).toBe(before);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM contacts WHERE name LIKE ?').bind('%Testeur%').first()).n).toBe(0);
    expect(hooks).toHaveLength(1);
  });

  it('a team add with a real French name is written', async () => {
    const res = await admin('/admin/teams/add', { name: 'François Côté', season: SEASON, target_team: 'Red', position: 'A' });
    expect(res.status).toBe(200);
    expect(JSON.parse(await kvText()).players.map(p => p.name)).toContain('François Côté');
    expect(hooks).toHaveLength(0);
  });

  it("SMBHL's normal scoresheet publish still writes; a garbled one is refused and data_json kept", async () => {
    const start = async () => (await (await admin('/admin/review/manual-start', { season: SEASON, week: 3 })).json()).id;
    const game = home => ({ home_team: 'Red', away_team: 'Blue', home_score: 2, away_score: 1, home_players: home, away_players: [] });
    // Garbled player name in the sheet: refused.
    const before = await kvText();
    const bad = await admin('/admin/review/publish', { review_id: await start(), week: 3, games: [game([{ name: 'Fran├ºois Nouveau', goals: 1, assists: 0 }])] });
    expect(bad.status).toBe(422);
    expect((await bad.json()).errorKey).toBe('DATA_JSON_DAMAGED');
    expect(await kvText()).toBe(before);
    // The normal publish writes.
    const ok = await admin('/admin/review/publish', { review_id: await start(), week: 3, games: [game([])] });
    expect((await ok.json()).ok).toBe(true);
    expect(await kvText()).not.toBe(before);
    expect(JSON.parse(await kvText()).players[0].name).toBe('Élodie Âgé-Côté');
  });
});

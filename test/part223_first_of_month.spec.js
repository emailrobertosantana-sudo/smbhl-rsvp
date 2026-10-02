// Item 7 (onboarding batch, 2026-10-02): French dates write « 1er » for the
// first day of a month (« dimanche 1er nov. », « lundi 1er mars 2027 »),
// in the shared formatter (src/date_format.js), so pages, the pages' own
// scripts and emails all follow. Every other day is the plain number;
// English is unchanged ("Sun Nov 1").
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { withGameTimes } from './support/game_times.js';
import { formatEventDate, formatEventDateFull, formatPageDate, formatPageDateTime, sentenceDate, sentenceWhen, PAGE_DATE_JS } from '../src/date_format.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.223.${++ip}` },
    body: JSON.stringify({ accept_terms: true, email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = (s, path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const html = async (s, path) => (await SELF.fetch('http://example.com' + path, { headers: { cookie: s.cookie } })).text();

beforeAll(async () => {
  env.AUTH_SECRET = 'p223-auth'; env.RSVP_SECRET = 'p223-rsvp'; env.LEAGUE_PRODUCT = 'true';
  await applyRealSchema(env);
});
afterAll(() => { delete env.LEAGUE_PRODUCT; });

describe('the formatter', () => {
  it('the 1st, the 2nd and the 31st, every French form', () => {
    expect(formatPageDate('2099-11-01', 'fr')).toBe('dimanche 1er nov.');
    expect(formatPageDate('2099-11-02', 'fr')).toBe('lundi 2 nov.');
    expect(formatPageDate('2099-10-31', 'fr')).toBe('samedi 31 oct.');
    expect(formatPageDate('2027-03-01', 'fr', 'long')).toBe('lundi 1er mars 2027');
    expect(formatPageDateTime('2099-11-01', '19:00', 'fr')).toBe('dimanche 1er nov. · 19 h');
    expect(formatEventDate('2099-11-01', 'fr')).toBe('Dim 1er nov.');
    expect(formatEventDate('2099-11-02', 'fr')).toBe('Lun 2 nov.');
    expect(formatEventDateFull('2099-11-01', 'fr')).toBe('Dimanche 1er novembre');
    expect(sentenceDate('2099-11-01', 'fr')).toBe('dimanche 1er nov.');
    expect(sentenceWhen('2099-11-01', '10:30', 'fr')).toBe('dimanche 1er nov. à 10 h 30');
    expect(sentenceWhen('2099-10-31', '10:30', 'fr')).toBe('samedi 31 oct. à 10 h 30');
  });

  it('English is unchanged', () => {
    expect(formatPageDate('2099-11-01', 'en')).toBe('Sun Nov 1');
    expect(sentenceDate('2099-11-01', 'en')).toBe('Sunday, Nov 1');
    expect(formatEventDateFull('2099-11-01', 'en')).toBe('Sunday, November 1');
  });

  it("the pages' own scripts (window.__nlDate) say the same", () => {
    const window = {};
    new Function('window', PAGE_DATE_JS)(window);
    expect(window.__nlDate('2099-11-01')).toBe('dimanche 1er nov.');
    expect(window.__nlDate('2099-11-02')).toBe('lundi 2 nov.');
    expect(window.__nlDate('2099-10-31')).toBe('samedi 31 oct.');
    expect(window.__nlDate('2027-03-01', 'long')).toBe('lundi 1er mars 2027');
  });
});

describe('pages and emails', () => {
  let s, first;
  beforeAll(async () => {
    s = await signup('p223.owner@example.com');
    await post(s, '/leagues/create', { name: 'P223 League', teamNames: ['A', 'B'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    await post(s, '/league/contacts', { name: 'Lea Player', email: 'lea.p223@example.com', role: 'roster', team: 'A' });
    first = (await (await post(s, '/league/events', withGameTimes({ date: '2099-11-01', season: 'S1', venue: 'Parc', start_time: '19:00' }))).json()).event;
    await post(s, '/league/events', withGameTimes({ date: '2099-11-02', season: 'S1', venue: 'Parc', start_time: '19:00' }));
    await post(s, '/league/events', withGameTimes({ date: '2099-10-31', season: 'S1', venue: 'Parc', start_time: '19:00' }));
  });

  it('the schedule list', async () => {
    const page = await html(s, '/league/schedule');
    expect(page).toContain('>dimanche 1er nov.<');
    expect(page).toContain('>lundi 2 nov.<');
    expect(page).toContain('>samedi 31 oct.<');
    expect(page).toContain('data-date-en="Sun Nov 1"');
  });

  it("a game's page heading", async () => {
    const page = await html(s, `/league/events/detail?e=${encodeURIComponent(first.id)}`);
    expect(page).toMatch(/1er nov/);
    expect(page).not.toMatch(/dimanche 1 nov/);
  });

  it('an email (the 72-hour reminder, previewed)', async () => {
    const res = await post(s, '/league/comms/preview', { kind: 'reminder_72h', event_id: first.id });
    const d = await res.json();
    expect(d.ok).toBe(true);
    expect(`${d.subject}\n${d.text}`).toMatch(/1er nov/);
    expect(`${d.subject}\n${d.text}`).not.toMatch(/ 1 nov/);
  });
});

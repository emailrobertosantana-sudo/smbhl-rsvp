// "Create multiple events": every rule is checked on the server before
// anything is created (src/bulk_events_validation.js), and each problem
// comes back with its field. Before this, 2026-09-31 created a game on a
// date that does not exist, a count of 60 was cut to 52 without a word,
// 25:99 was accepted, and equal times answered 200 with no game created.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must, rows } from './support/league_season.js';
import { validateBulkEvents, isRealDate, isRealTime } from '../src/bulk_events_validation.js';
import { ERROR_I18N } from '../src/error_i18n.js';

let a, leagueId;
beforeAll(async () => {
  env.AUTH_SECRET = 'p179'; env.RSVP_SECRET = 'p179r';
  await applyRealSchema(env);
  a = await admin('p179');
  leagueId = (await must(a.post('/leagues/create', { name: 'Bulk rules', teamStructure: 'headcount', minPlayers: 1, maxPlayers: 10, minGoalies: 0 }), 'create')).league.id;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'publish');
});

const T = { start_time: '19:00', end_time: '20:00' };
const games = async () => (await rows('SELECT date FROM events WHERE league_id = ? ORDER BY date', leagueId)).map(r => r.date);
async function refused(body, fields) {
  const before = await games();
  const r = await a.post('/league/events/bulk', body);
  expect(r.status).toBe(400);
  expect(r.json.ok).toBe(false);
  expect(r.json.fields).toEqual(fields);
  expect(r.json.errorKey).toBe(fields[0].errorKey);
  expect(await games()).toEqual(before); // nothing created
}

describe('The server refuses each problem, with its field, and creates nothing', () => {
  it('a first date that does not exist (sent directly), or none', async () => {
    await refused({ startDate: '2026-09-31', occurrences: 2, ...T }, [{ field: 'startDate', errorKey: 'BULK_DATE_INVALID' }]);
    await refused({ startDate: '2027-02-30', occurrences: 2, ...T }, [{ field: 'startDate', errorKey: 'BULK_DATE_INVALID' }]);
    await refused({ startDate: '', startDateInvalid: true, occurrences: 2, ...T }, [{ field: 'startDate', errorKey: 'BULK_DATE_INVALID' }]);
    await refused({ startDate: '', occurrences: 2, ...T }, [{ field: 'startDate', errorKey: 'BULK_FIRST_DATE_REQUIRED' }]);
  });
  it('neither a count nor an end date', async () => {
    await refused({ startDate: '2027-01-05', ...T }, [{ field: 'occurrences', errorKey: 'BULK_COUNT_OR_END_REQUIRED' }]);
  });
  it('a count outside 1 to 52: refused, never capped', async () => {
    for (const n of [0, -3, 53, 60, 2.5, 'ten']) await refused({ startDate: '2027-01-05', occurrences: n, ...T }, [{ field: 'occurrences', errorKey: 'BULK_COUNT_RANGE' }]);
    // An end date more than 52 weeks away is the same thing.
    await refused({ startDate: '2027-01-05', endDate: '2028-06-01', ...T }, [{ field: 'endDate', errorKey: 'BULK_COUNT_RANGE' }]);
  });
  it('an end date before the first date, or one that does not exist', async () => {
    await refused({ startDate: '2027-03-02', endDate: '2027-02-01', ...T }, [{ field: 'endDate', errorKey: 'BULK_END_BEFORE_START' }]);
    await refused({ startDate: '2027-03-02', endDate: '2027-02-30', ...T }, [{ field: 'endDate', errorKey: 'BULK_DATE_INVALID' }]);
    // Typed but unreadable in the browser (sent empty, flagged).
    await refused({ startDate: '2027-03-02', endDate: '', endDateInvalid: true, ...T }, [{ field: 'endDate', errorKey: 'BULK_DATE_INVALID' }]);
  });
  it('times: missing, not a real HH:MM, or equal', async () => {
    await refused({ startDate: '2027-04-06', occurrences: 1, start_time: '', end_time: '' }, [{ field: 'startTime', errorKey: 'BULK_START_TIME_REQUIRED' }, { field: 'endTime', errorKey: 'BULK_END_TIME_REQUIRED' }]);
    await refused({ startDate: '2027-04-06', occurrences: 1, start_time: '25:99', end_time: '20:00' }, [{ field: 'startTime', errorKey: 'BULK_TIME_INVALID' }]);
    await refused({ startDate: '2027-04-06', occurrences: 1, start_time: '19:00', end_time: '19:60' }, [{ field: 'endTime', errorKey: 'BULK_TIME_INVALID' }]);
    await refused({ startDate: '2027-04-06', occurrences: 1, start_time: '19:00', end_time: '19:00' }, [{ field: 'endTime', errorKey: 'BULK_TIMES_EQUAL' }]);
  });
  it('several problems at once: all of them, in the form\'s order', async () => {
    await refused({ startDate: '2026-09-31', occurrences: 99, start_time: '19:00', end_time: '19:00' }, [
      { field: 'startDate', errorKey: 'BULK_DATE_INVALID' }, { field: 'occurrences', errorKey: 'BULK_COUNT_RANGE' }, { field: 'endTime', errorKey: 'BULK_TIMES_EQUAL' }
    ]);
  });
});

describe('What is still allowed', () => {
  it('a valid series; an end date on the first date (one game); a game past midnight', async () => {
    const r = await must(a.post('/league/events/bulk', { startDate: '2027-01-05', occurrences: 2, ...T }), 'valid');
    expect(r.results.map(x => x.event.date)).toEqual(['2027-01-05', '2027-01-12']);
    expect((await must(a.post('/league/events/bulk', { startDate: '2027-05-04', endDate: '2027-05-04', ...T }), 'one')).createdCount).toBe(1);
    const late = await must(a.post('/league/events/bulk', { startDate: '2027-06-01', occurrences: 1, start_time: '23:30', end_time: '00:30' }), 'past midnight');
    expect(late.createdCount).toBe(1);
    expect((await must(a.post('/league/events/bulk', { startDate: '2027-07-06', occurrences: 52, ...T }), '52')).createdCount).toBe(52);
  });
});

describe('The rules themselves, and their messages', () => {
  it('real dates and times', () => {
    expect(['2026-09-30', '2028-02-29', '2027-12-31'].map(isRealDate)).toEqual([true, true, true]);
    expect(['2026-09-31', '2027-02-29', '2027-13-01', '2027-1-5', ''].map(isRealDate)).toEqual([false, false, false, false, false]);
    expect(['00:00', '23:59', '19:30'].map(isRealTime)).toEqual([true, true, true]);
    expect(['24:00', '25:99', '19:60', '7:30', ''].map(isRealTime)).toEqual([false, false, false, false, false]);
    expect(validateBulkEvents({ startDate: '2027-01-05', occurrences: '3', start_time: '19:00', end_time: '20:00' })).toEqual({ ok: true, value: { startDate: '2027-01-05', occurrences: 3, startTime: '19:00', endTime: '20:00' } });
  });
  it('every key has its copy, verbatim, FR and EN, with no em dash', () => {
    const want = {
      BULK_DATE_INVALID: ["Cette date n'existe pas. Veuillez choisir une date valide.", 'This date does not exist. Please choose a valid date.'],
      BULK_COUNT_OR_END_REQUIRED: ["Indiquez un nombre d'événements ou une date de fin.", 'Enter a number of events or an end date.'],
      BULK_COUNT_RANGE: ["Le nombre d'événements doit être entre 1 et 52.", 'The number of events must be between 1 and 52.'],
      BULK_END_BEFORE_START: ['La date de fin doit être postérieure à la première date.', 'The end date must be after the first date.'],
      BULK_START_TIME_REQUIRED: ['Choisissez une heure de début.', 'Choose a start time.'],
      BULK_END_TIME_REQUIRED: ['Choisissez une heure de fin.', 'Choose an end time.'],
      BULK_TIMES_EQUAL: ["L'heure de fin doit être différente de l'heure de début.", 'The end time must be different from the start time.'],
      BULK_TIME_INVALID: ["Cette heure n'est pas valide.", 'This time is not valid.'],
      BULK_FIRST_DATE_REQUIRED: ['Choisissez une première date.', 'Choose a first date.'],
      BULK_NETWORK_ERROR: ['La connexion a échoué. Vérifiez votre connexion Internet et réessayez.', 'The connection failed. Check your internet connection and try again.']
    };
    for (const [k, [fr, en]] of Object.entries(want)) {
      expect(ERROR_I18N[k], k).toEqual({ fr, en });
      expect(fr + en).not.toMatch(/—/);
    }
  });
});

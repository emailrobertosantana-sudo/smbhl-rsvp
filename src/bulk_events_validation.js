// The "Create multiple events" form's rules, in one place. The server runs
// them before creating anything (it is the source of truth) and returns
// every problem with the field it belongs to; the page shows each one next
// to its field. There is no second copy for the browser to drift from: the
// browser sends what only it can know (a date field whose text is not a
// real date comes back empty, with the input's badInput flag set) and
// shows what comes back.
//
// Fields: startDate, occurrences, endDate, startTime, endTime.
// An end time before the start time is allowed: the game crosses midnight
// (23:30 to 00:30 is a 60 minute game, the rule league_nights.js uses). An
// end time equal to the start time is not.

export const BULK_MAX_EVENTS = 52;
export const BULK_INTERVAL_DAYS = 7;

// A real calendar date in YYYY-MM-DD (2026-09-31 is not).
export function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// A real clock time in HH:MM (25:99 is not).
export function isRealTime(s) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(s || ''));
  return !!m && Number(m[1]) < 24 && Number(m[2]) < 60;
}

const blank = v => v === undefined || v === null || String(v).trim() === '';

// input: the request body. startDateInvalid / endDateInvalid: the browser
// flagged the field's text as not a date (its value is then empty).
// Returns { ok: true, value } or { ok: false, errors: [{ field, errorKey }] }
// in the form's field order.
export function validateBulkEvents(input = {}) {
  const errors = [];
  const add = (field, errorKey) => errors.push({ field, errorKey });
  const startDate = String(input.startDate || '').trim();
  const endDate = String(input.endDate || '').trim();

  if (input.startDateInvalid || (!blank(startDate) && !isRealDate(startDate))) add('startDate', 'BULK_DATE_INVALID');
  else if (blank(startDate)) add('startDate', 'BULK_FIRST_DATE_REQUIRED');

  let occurrences = null;
  if (!blank(input.occurrences)) {
    const n = Number(input.occurrences);
    if (!Number.isInteger(n) || n < 1 || n > BULK_MAX_EVENTS) add('occurrences', 'BULK_COUNT_RANGE');
    else occurrences = n;
  } else if (input.endDateInvalid || (!blank(endDate) && !isRealDate(endDate))) {
    add('endDate', 'BULK_DATE_INVALID');
  } else if (blank(endDate)) {
    add('occurrences', 'BULK_COUNT_OR_END_REQUIRED');
  } else if (isRealDate(startDate)) {
    const spanDays = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000;
    if (spanDays < 0) add('endDate', 'BULK_END_BEFORE_START');
    else {
      occurrences = Math.floor(spanDays / BULK_INTERVAL_DAYS) + 1;
      if (occurrences > BULK_MAX_EVENTS) add('endDate', 'BULK_COUNT_RANGE');
    }
  }

  const startTime = String(input.start_time || '').trim();
  const endTime = String(input.end_time || '').trim();
  if (blank(startTime)) add('startTime', 'BULK_START_TIME_REQUIRED');
  else if (!isRealTime(startTime)) add('startTime', 'BULK_TIME_INVALID');
  if (blank(endTime)) add('endTime', 'BULK_END_TIME_REQUIRED');
  else if (!isRealTime(endTime)) add('endTime', 'BULK_TIME_INVALID');
  else if (isRealTime(startTime) && startTime === endTime) add('endTime', 'BULK_TIMES_EQUAL');

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { startDate, occurrences, startTime, endTime } };
}

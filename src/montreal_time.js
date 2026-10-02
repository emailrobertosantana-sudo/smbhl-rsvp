// Montreal time (America/Toronto, the league time of src/league_ids.js) for
// Notre Ligue billing (Roberto, 2026-10-02): every date or "today" a person
// sees (the billing page, the notices and their "on the day" timing, trial
// ends, the super-admin pages, the operator's digest) is a Montreal calendar
// day, never a UTC one. Timestamps are still stored as UTC ISO strings.
//
// Dates here are 'YYYY-MM-DD' strings, Montreal calendar days. Date.UTC is
// used only as a calendar calculator on those components.
import { localParts } from './league_ids.js';

const DAY_MS = 86400000;
const pad = n => String(n).padStart(2, '0');
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// The Montreal calendar day of an instant (ISO text, Date or ms). A bare
// date ('2026-12-01') is already a day and is returned as it is.
export function montrealDate(t) {
  if (typeof t === 'string' && DATE_ONLY.test(t.trim())) return t.trim();
  const ms = t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(String(t || ''));
  if (!Number.isFinite(ms)) return '';
  return localParts(new Date(ms)).date;
}

function parts(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}
const fmt = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };

export function addDays(dateStr, n) {
  const p = parts(dateStr);
  return p ? fmt(Date.UTC(p.y, p.m - 1, p.d + n)) : '';
}

// Calendar months, the day kept or clamped to the month's last day
// (2026-12-31 + 2 months is 2027-02-28).
export function addCalendarMonths(dateStr, n) {
  const p = parts(dateStr);
  if (!p) return '';
  const first = new Date(Date.UTC(p.y, p.m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return fmt(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(p.d, last)));
}

// Whole days from one Montreal day to another (b - a).
export function dayDiff(a, b) {
  const pa = parts(a), pb = parts(b);
  if (!pa || !pb) return NaN;
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / DAY_MS);
}

// The instant a Montreal day starts (00:00 local; daylight saving changes at
// 2 am, so midnight is never skipped or repeated): 04:00 or 05:00 UTC.
export function montrealMidnight(dateStr) {
  const p = parts(dateStr);
  if (!p) return null;
  const base = Date.UTC(p.y, p.m - 1, p.d);
  for (const h of [4, 5]) {
    const t = base + h * 3600000;
    const lp = localParts(new Date(t));
    if (lp.date === dateStr && lp.hour === 0 && lp.minute === 0) return new Date(t);
  }
  return new Date(base + 5 * 3600000);
}

// The last day of a period that ends at an instant: the Montreal day of
// the instant just before it. A trial ending at 00:00 on December 6 has
// December 5 as its last day.
export function lastDayBefore(endIso) {
  const ms = Date.parse(String(endIso || ''));
  return Number.isFinite(ms) ? montrealDate(ms - 1) : '';
}

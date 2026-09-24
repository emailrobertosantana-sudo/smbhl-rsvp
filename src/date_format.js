/**
 * date_format.js — shared event date/time formatting for the new
 * "Notre Ligue" league product, per the design system's own voice
 * spec (notre-ligue-design-system/README.md): "Numbers as digits,
 * times in Quebec style: 9 h, 10 h 30, dim 28 sept. English: 9 AM,
 * Sun Sep 28."
 *
 * Live-testing task (batch 2), Part 6: dates were rendering in raw
 * ISO format ("2026-11-21") everywhere -- this is the single shared
 * formatter every league-product page (and email) that shows an event
 * date/time now goes through, so the fix lands everywhere at once
 * instead of page by page. SMBHL's own legacy pages/emails have their
 * own pre-existing date representation (a human-readable string, not
 * ISO) and formatting helpers (dateFR/whenLine/dayNames, index.js) --
 * completely separate, untouched, out of scope.
 */

const DAY_ABBR_FR = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
const DAY_ABBR_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const DAY_FULL_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_ABBR_FR = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juill', 'août', 'sept', 'oct', 'nov', 'déc'];
const MONTH_ABBR_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MONTH_FULL_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// dateISO: 'YYYY-MM-DD' (every league-product event.date column, see
// createLeagueEventRow's own validation, leagues.js). Parsed as plain
// calendar components -- Date.UTC is used ONLY as a day-of-week
// calculator (never read back a Y/M/D component from it), so this is
// immune to whatever timezone the runtime happens to be in, matching
// the "no timezone conversion for a date-only value" discipline this
// app's own event scheduling already depends on elsewhere.
function dateParts(dateISO) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateISO || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return { y, m: mo, d, dow };
}

/**
 * style: 'short' ("dim 28 sept" / "Sun Sep 28") or 'long' ("dimanche
 * 28 sept" / "Sunday Sep 28") -- 'long' only changes the DAY name to
 * its full form, the month stays abbreviated in both (matches the
 * design system's own event-status/RSVP page headings, which use the
 * full day name with an abbreviated month: "Dimanche 28 sept").
 * capitalizeFirst: true (default) for a sentence-initial/heading use;
 * false for text that's already lowercase-led inline.
 */
export function formatEventDate(dateISO, lang = 'fr', style = 'short', capitalizeFirst = true) {
  const p = dateParts(dateISO);
  if (!p) return '';
  const isEn = lang === 'en';
  const dayList = style === 'long' ? (isEn ? DAY_FULL_EN : DAY_FULL_FR) : (isEn ? DAY_ABBR_EN : DAY_ABBR_FR);
  const month = (isEn ? MONTH_ABBR_EN : MONTH_ABBR_FR)[p.m - 1];
  let day = dayList[p.dow];
  if (capitalizeFirst || isEn) day = capitalize(day);
  return isEn ? `${day} ${month} ${p.d}` : `${day} ${p.d} ${month}`;
}

// A full day + full month, used sparingly (e.g. a formal confirmation
// line) -- "dimanche 28 septembre" / "Sunday, September 28".
export function formatEventDateFull(dateISO, lang = 'fr', capitalizeFirst = true) {
  const p = dateParts(dateISO);
  if (!p) return '';
  const isEn = lang === 'en';
  let day = (isEn ? DAY_FULL_EN : DAY_FULL_FR)[p.dow];
  if (capitalizeFirst || isEn) day = capitalize(day);
  const month = (isEn ? MONTH_FULL_EN : MONTH_FULL_FR)[p.m - 1];
  return isEn ? `${day}, ${month} ${p.d}` : `${day} ${p.d} ${month}`;
}

// timeHHMM: 'HH:MM', 24-hour, as stored throughout this app.
export function formatEventTime(timeHHMM, lang = 'fr') {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(timeHHMM || ''));
  if (!m) return '';
  const h24 = Number(m[1]);
  const min = Number(m[2]);
  if (lang === 'en') {
    const period = h24 < 12 ? 'AM' : 'PM';
    let h12 = h24 % 12;
    if (h12 === 0) h12 = 12;
    return min === 0 ? `${h12} ${period}` : `${h12}:${String(min).padStart(2, '0')} ${period}`;
  }
  return min === 0 ? `${h24} h` : `${h24} h ${String(min).padStart(2, '0')}`;
}

// Combines date + time with the design system's own " · " separator
// (every preview file joins them this way -- "Dim 28 sept · 9 h").
export function formatEventDateTime(dateISO, timeHHMM, lang = 'fr', style = 'short', capitalizeFirst = true) {
  const d = formatEventDate(dateISO, lang, style, capitalizeFirst);
  const t = timeHHMM ? formatEventTime(timeHHMM, lang) : '';
  return t ? `${d} · ${t}` : d;
}

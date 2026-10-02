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

// French writes the first day of a month « 1er » (« dimanche 1er nov. »,
// « samedi 1er mars 2027 »); every other day is the plain number. English
// is unchanged ("Sunday, Nov 1").
function dayFr(d) {
  return d === 1 ? '1er' : String(d);
}

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
  // French: an abbreviated month takes a period (« 15 nov. »); a month
  // written in full does not (« 5 mars »).
  const month = isEn ? MONTH_ABBR_EN[p.m - 1] : monthAbbrFrDot(p.m);
  let day = dayList[p.dow];
  if (capitalizeFirst || isEn) day = capitalize(day);
  return isEn ? `${day} ${month} ${p.d}` : `${day} ${dayFr(p.d)} ${month}`;
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
  return isEn ? `${day}, ${month} ${p.d}` : `${day} ${dayFr(p.d)} ${month}`;
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

// ---- in a sentence (batch 7 item 5) ----
// The date and the time are joined with « à » / "at" (« dimanche 15 nov. à
// 10 h 30 », "Sunday, Nov 15 at 10:30 AM"); the « · » separator stays for
// headings, subjects and lists. The venue is a line of its own, « Lieu : X »
// / "Venue: X", never in parentheses inside a sentence.
// ISO date of an event: its date column, or the one in its id (SMBHL's date
// column is a label, its id carries the ISO date).
export function eventIso(ev) {
  const m = /^\d{4}-\d{2}-\d{2}/.exec(String((ev && ev.date) || '')) || /\d{4}-\d{2}-\d{2}/.exec(String((ev && ev.id) || ''));
  return m ? m[0] : '';
}
// « dimanche 15 nov. » / "Sunday, Nov 15"
export function sentenceDate(dateISO, lang = 'fr') {
  const p = dateParts(dateISO);
  if (!p) return '';
  return lang === 'en'
    ? `${DAY_FULL_EN[p.dow]}, ${MONTH_ABBR_EN[p.m - 1]} ${p.d}`
    : `${DAY_FULL_FR[p.dow]} ${dayFr(p.d)} ${monthAbbrFrDot(p.m)}`;
}
// « dimanche 15 nov. à 10 h 30 » / "Sunday, Nov 15 at 10:30 AM"; joiner
// ', ' gives « dimanche 11 janv., 10 h 30 » (the sub call's own form).
export function sentenceWhen(dateISO, timeHHMM, lang = 'fr', joiner = null) {
  const d = sentenceDate(dateISO, lang);
  const t = timeHHMM ? formatEventTime(timeHHMM, lang) : '';
  if (!t) return d;
  return `${d}${joiner != null ? joiner : (lang === 'en' ? ' at ' : ' à ')}${t}`;
}
// « Lieu : X » / "Venue: X", or '' without a venue.
export function venueLine(venue, lang = 'fr') {
  const v = String(venue || '').trim();
  if (!v) return '';
  return lang === 'en' ? `Venue: ${v}` : `Lieu : ${v}`;
}

// A delay before a game, in words: under an hour in minutes (« 40 minutes »),
// under 48 hours in hours (« 5 heures »), otherwise in days (« 3 jours »),
// each with its plural (« 1 heure », "1 hour").
export function delayText(hours, lang = 'fr') {
  const en = lang === 'en';
  const unit = (n, fr1, frN, en1, enN) => `${n} ${n === 1 ? (en ? en1 : fr1) : (en ? enN : frN)}`;
  const h = Math.max(0, Number(hours) || 0);
  const min = Math.max(1, Math.round(h * 60));
  if (min < 60) return unit(min, 'minute', 'minutes', 'minute', 'minutes');
  if (h < 48) return unit(Math.max(1, Math.round(h)), 'heure', 'heures', 'hour', 'hours');
  return unit(Math.round(h / 24), 'jour', 'jours', 'day', 'days');
}

// A sentence that ends on a date: the period is added only when the text
// does not already end with one (« ne joue plus le vendredi 10 avr. »,
// never « avr.. »).
export function endSentence(text) {
  const s = String(text == null ? '' : text);
  return s.endsWith('.') ? s : `${s}.`;
}

// Combines date + time with the design system's own " · " separator
// (every preview file joins them this way -- "Dim 28 sept · 9 h").
export function formatEventDateTime(dateISO, timeHHMM, lang = 'fr', style = 'short', capitalizeFirst = true) {
  const d = formatEventDate(dateISO, lang, style, capitalizeFirst);
  const t = timeHHMM ? formatEventTime(timeHHMM, lang) : '';
  return t ? `${d} · ${t}` : d;
}

// ---- pages (batch 4 item 4) ----
// French pages write the date in words: « jeudi 15 oct. » in lists and
// panels ('short'), « jeudi 15 octobre 2026 » where there is room
// ('long'). An abbreviated month takes a period; a month written in full
// (mars, mai, juin, août) does not. English pages keep formatEventDate's
// own forms ("Thu Oct 15", "Thursday Oct 15"). Times are formatEventTime
// for both pages and emails: « 18 h 08 », « 18 h » for a whole hour.
// Emails keep formatEventDate: these are for pages only.
function monthAbbrFrDot(m) {
  const a = MONTH_ABBR_FR[m - 1];
  return a === MONTH_FULL_FR[m - 1] ? a : `${a}.`;
}
export function formatPageDate(dateISO, lang = 'fr', style = 'short') {
  if (lang === 'en') return formatEventDate(dateISO, 'en', style);
  const p = dateParts(dateISO);
  if (!p) return '';
  return style === 'long'
    ? `${DAY_FULL_FR[p.dow]} ${dayFr(p.d)} ${MONTH_FULL_FR[p.m - 1]} ${p.y}`
    : `${DAY_FULL_FR[p.dow]} ${dayFr(p.d)} ${monthAbbrFrDot(p.m)}`;
}
export function formatPageDateTime(dateISO, timeHHMM, lang = 'fr', style = 'short') {
  const d = formatPageDate(dateISO, lang, style);
  const t = timeHHMM ? formatEventTime(timeHHMM, lang) : '';
  return t ? `${d} · ${t}` : d;
}

// The same French page format for the pages' own scripts (lists drawn in
// the browser): window.__nlDate(iso, style) and window.__nlTime(hhmm), from
// the same tables, so the two cannot drift (test/rendered/page_dates.spec.mjs
// runs both over the same dates). French only: the English branches of
// those scripts are unchanged. No backslash, backtick or dollar-brace in the
// browser text.
export const PAGE_DATE_JS = `(function() {
  var DAYS = ${JSON.stringify(DAY_FULL_FR)}, ABBR = ${JSON.stringify(MONTH_ABBR_FR)}, FULL = ${JSON.stringify(MONTH_FULL_FR)};
  window.__nlDate = function(iso, style) {
    var s = String(iso || '');
    if (s.length < 10 || s.charAt(4) !== '-' || s.charAt(7) !== '-') return '';
    var y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
    if (!y || !m || !d) return '';
    var dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    var dd = d === 1 ? '1er' : String(d);
    if (style === 'long') return DAYS[dow] + ' ' + dd + ' ' + FULL[m - 1] + ' ' + y;
    return DAYS[dow] + ' ' + dd + ' ' + (ABBR[m - 1] === FULL[m - 1] ? ABBR[m - 1] : ABBR[m - 1] + '.');
  };
  window.__nlTime = function(t) {
    var s = String(t || ''), i = s.indexOf(':');
    if (i < 1) return '';
    var h = Number(s.slice(0, i)), mi = Number(s.slice(i + 1, i + 3));
    if (isNaN(h) || isNaN(mi)) return '';
    return mi === 0 ? h + ' h' : h + ' h ' + (mi < 10 ? '0' : '') + mi;
  };
})();`;

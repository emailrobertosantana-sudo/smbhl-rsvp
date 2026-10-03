// Garbled text (mojibake): UTF-8 read through the wrong code page and
// written back. SMBHL's data_json was damaged this way twice in
// September 2026 by a PowerShell redirect (code page 850, the Windows
// console's): « Fran├ºois » for « François », « Coll├¿ge » for « Collège »,
// « ÔÇÖ » for ’, « Ô¡É » for ⭐, « ­ƒÑû » for 🥖, and emoji damaged twice.
// Windows-1252 gives « FranÃ§ois » and « â€™ ».
//
// Pure (no Worker API): the Worker's guard (src/data_json_guard.js) and the
// repo's scripts (scripts/smbhl_season_config.mjs) share it.
//
// Real French never matches: « Âge », « À », « É », « Ô », « Ça » are fine.
// Only sequences no French or English text contains are refused:
//   - box drawing characters (code page 850's view of UTF-8 lead bytes);
//   - Ã or Â followed by a character from U+0080 to U+00BF or one of
//     Windows-1252's punctuation characters, and « â€ » (Windows-1252);
//   - Ô followed by two, or a soft hyphen followed by three, of code page
//     850's views of UTF-8 continuation bytes (a three or four byte
//     character, ’ or an emoji, through code page 850 once).
const ch = c => String.fromCharCode(c);
const range = (a, b) => ch(a) + '-' + ch(b);

// Code page 850's characters for the bytes 0x80 to 0xBF (UTF-8's
// continuation bytes), as a character class body.
const CP850_CONT = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐';
// Windows-1252's characters for 0x80 to 0x9F.
const CP1252_PUNCT = [0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017D,
  0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178].map(ch).join('');

const esc = s => s.replace(/[\\\]^-]/g, m => '\\' + m);
export const MOJIBAKE = new RegExp([
  '[' + range(0x2500, 0x257F) + ']',
  '[' + ch(0xC3) + ch(0xC2) + '][' + range(0x80, 0xBF) + esc(CP1252_PUNCT) + ']',
  ch(0xE2) + ch(0x20AC),
  ch(0xD4) + '[' + esc(CP850_CONT) + ']{2}',
  ch(0xAD) + '[' + esc(CP850_CONT) + ']{3}'
].join('|'));

export function isMojibake(s) {
  return typeof s === 'string' && MOJIBAKE.test(s);
}

// Every damaged string (and key) in a parsed value, with its path:
// [{ path, value }], at most `limit`.
export function findMojibake(value, { limit = 200 } = {}) {
  const out = [];
  (function walk(v, path) {
    if (out.length >= limit) return;
    if (typeof v === 'string') { if (MOJIBAKE.test(v)) out.push({ path, value: v }); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (MOJIBAKE.test(k) && out.length < limit) out.push({ path: `${path} (key)`, value: k });
        walk(x, `${path}.${k}`);
      }
    }
  })(value, '$');
  return out;
}

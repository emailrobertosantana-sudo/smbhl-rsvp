// Plural forms inside a translated string, so no copy needs "game(s)".
//
//   {n}                           the value
//   {n|# game|# games}            one, many
//   {n|no game|# game|# games}    zero, one, many
//
// "#" is the number. French counts 0 and 1 as singular ("0 match",
// "1 match", "2 matchs"); English only 1 ("0 games", "1 game"). A name
// that is not in `vars` is left as written.
//
// Two copies of the same few lines: pluralText for the server, and
// PLURAL_TEXT_JS, the text the league pages embed as window.__pluralText
// (a String.raw literal, never a function's toString: the bundler adds
// __name() calls). test/rendered/plural_text.spec.mjs runs both over the
// same cases and fails if they ever differ.
export function pluralText(template, vars, lang) {
  var s = String(template == null ? '' : template), out = '', i = 0;
  while (i < s.length) {
    var a = s.indexOf('{', i);
    var b = a === -1 ? -1 : s.indexOf('}', a);
    if (b === -1) { out += s.slice(i); break; }
    out += s.slice(i, a);
    var parts = s.slice(a + 1, b).split('|');
    if (!vars || !Object.prototype.hasOwnProperty.call(vars, parts[0])) out += s.slice(a, b + 1);
    else if (parts.length === 1) out += String(vars[parts[0]]);
    else {
      var n = Number(vars[parts[0]]);
      var one = lang === 'en' ? n === 1 : n < 2;
      var form = parts.length === 4 ? (n === 0 ? parts[1] : one ? parts[2] : parts[3]) : (one ? parts[1] : parts[2]);
      out += String(form == null ? '' : form).split('#').join(String(vars[parts[0]]));
    }
    i = b + 1;
  }
  return out;
}

export const PLURAL_TEXT_JS = String.raw`window.__pluralText = function(template, vars) {
  var lang = window.__currentLang === 'en' ? 'en' : 'fr';
  var s = String(template == null ? '' : template), out = '', i = 0;
  while (i < s.length) {
    var a = s.indexOf('{', i);
    var b = a === -1 ? -1 : s.indexOf('}', a);
    if (b === -1) { out += s.slice(i); break; }
    out += s.slice(i, a);
    var parts = s.slice(a + 1, b).split('|');
    if (!vars || !Object.prototype.hasOwnProperty.call(vars, parts[0])) out += s.slice(a, b + 1);
    else if (parts.length === 1) out += String(vars[parts[0]]);
    else {
      var n = Number(vars[parts[0]]);
      var one = lang === 'en' ? n === 1 : n < 2;
      var form = parts.length === 4 ? (n === 0 ? parts[1] : one ? parts[2] : parts[3]) : (one ? parts[1] : parts[2]);
      out += String(form == null ? '' : form).split('#').join(String(vars[parts[0]]));
    }
    i = b + 1;
  }
  return out;
};`;

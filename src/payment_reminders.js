// Payment reminders: one email to a player who owes money, sent by hand
// from the finance page (SMBHL /admin/finances, Notre Ligue's Finances
// tab). Built once for both products; index.js does the balances (the
// finance pages' own calculation), the rendering and the queue.
//
// The league's payment details live in the settings table, one row per
// league (SMBHL included, under its league id), no migration:
//   key    payment_info:<league id>
//   value  { "email": "<e-Transfer email>" | "", "phone": "<10 digits>" | "" }
// Either, both or neither may be set. With neither, no reminder can go out.
//
// The sent reminders are outbox rows of kind 'payment_reminder' (one per
// player and send): "Last reminded" is read from them.

export const PAYMENT_REMINDER_KIND = 'payment_reminder';
export const PAYMENT_NOTE_MAX = 500;
export const paymentInfoKey = leagueId => `payment_info:${leagueId}`;

export async function getPaymentInfo(db, leagueId) {
  const out = { email: '', phone: '' };
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(paymentInfoKey(leagueId)).first();
    if (row && row.value) {
      const v = JSON.parse(row.value);
      if (v && typeof v.email === 'string') out.email = v.email;
      if (v && typeof v.phone === 'string' && /^\d{10}$/.test(v.phone)) out.phone = v.phone;
    }
  } catch (_) {}
  return out;
}

export async function savePaymentInfo(db, leagueId, { email, phone }) {
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(paymentInfoKey(leagueId), JSON.stringify({ email: email || '', phone: phone || '' })).run();
}

export const hasPaymentInfo = info => !!(info && (info.email || info.phone));

// A North American number: 10 digits (a leading 1 is dropped), area code
// and exchange not starting with 0 or 1. Returns the 10 digits, '' for an
// empty value, or null when it is not a valid number.
export function normalizePhone(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return '';
  if (/[^\d\s().+-]/.test(raw)) return null;
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return null;
  return d;
}

// 5145551234 -> 514-555-1234
export function formatPhone(digits) {
  const d = String(digits || '');
  return /^\d{10}$/.test(d) ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d;
}

// The line that says where to send the money, in one language.
export function paymentLine(lang, { email, phone }) {
  const mobile = phone ? formatPhone(phone) : '';
  if (lang === 'fr') {
    if (email && mobile) return `Envoie ton virement Interac à ${email} ou au ${mobile}.`;
    if (email) return `Envoie ton virement Interac à ${email}.`;
    if (mobile) return `Envoie ton virement Interac au ${mobile}.`;
    return '';
  }
  if (email && mobile) return `Send your Interac e-Transfer to ${email} or ${mobile}.`;
  if (email) return `Send your Interac e-Transfer to ${email}.`;
  if (mobile) return `Send your Interac e-Transfer to ${mobile}.`;
  return '';
}

// The email's lines in one language, as plain text (the HTML escapes them).
// amount: already formatted for that language.
// frHello: the French greeting (email review item 2: « Salut » for Notre
// Ligue; SMBHL keeps « Bonjour »).
export function paymentReminderLines(lang, { firstName, note, amount, info, frHello = 'Bonjour' }) {
  const fr = lang === 'fr';
  const lines = [fr ? `${frHello} ${firstName},` : `Hi ${firstName},`];
  if (note) lines.push(note);
  lines.push(fr ? `Solde à payer : ${amount}` : `Balance owing: ${amount}`);
  lines.push(paymentLine(lang, info));
  lines.push(fr ? 'Merci!' : 'Thanks!');
  return lines;
}

// The admin's note: plain text, trimmed, at most PAYMENT_NOTE_MAX
// characters. null when it is too long.
export function cleanNote(input) {
  const s = String(input == null ? '' : input).replace(/\r\n?/g, '\n').trim();
  return s.length > PAYMENT_NOTE_MAX ? null : s;
}

// The finance page's "Send payment reminders" panel, one script for both
// products. The page sets window.__payCfg first:
//   list, send, preview   the routes (GET list?<seasonParam>=, POST send, POST preview)
//   seasonParam, seasonSelect   the list's season parameter and the page's season <select> id
//   btnCls, primaryCls, cardCls   the page's own button and card classes
//   T   optional { fr: {...}, en: {...} } replacing some of the wording
// A String.raw literal with no backslash, backtick or dollar-brace inside,
// never a function's toString (the bundler adds __name() calls).
export const PAYMENT_PANEL_JS = String.raw`(function () {
  var C = window.__payCfg || {};
  var T = {
    fr: {
      open: 'Envoyer des rappels de paiement', colName: 'Joueur', colBalance: 'Solde', colLast: 'Dernier rappel', never: 'Jamais',
      noEmailTitle: 'Sans adresse courriel', noEmail: 'Aucune adresse courriel', note: 'Note (facultative)', preview: 'Aperçu',
      optedOut: 'Désabonné des courriels de match',
      sendOne: 'Envoyer à {n} joueur', sendMany: 'Envoyer à {n} joueurs', close: 'Fermer',
      noInfo: "Ajoute d'abord ton courriel ou ton cellulaire pour virement Interac dans les Paramètres.",
      overBudget: "Ça enverrait {n} courriels, mais il n'en reste que {left} pour aujourd'hui.",
      sentOne: '{n} rappel envoyé.', sentMany: '{n} rappels envoyés.',
      skipped: "Pas envoyé, le solde est maintenant à zéro : {names}", nobody: 'Personne ne doit rien pour cette saison.',
      loading: 'Chargement…', error: 'Une erreur est survenue. Réessaie.'
    },
    en: {
      open: 'Send payment reminders', colName: 'Player', colBalance: 'Balance', colLast: 'Last reminded', never: 'Never',
      noEmailTitle: 'No email address', noEmail: 'No email address', note: 'Note (optional)', preview: 'Preview',
      optedOut: 'Opted out of game emails',
      sendOne: 'Send to {n} player', sendMany: 'Send to {n} players', close: 'Close',
      noInfo: 'Add your e-Transfer email or mobile number in Settings first.',
      overBudget: 'This would send {n} emails, but only {left} can go out today.',
      sentOne: '{n} reminder sent.', sentMany: '{n} reminders sent.',
      skipped: 'Not sent, the balance is now zero: {names}', nobody: 'Nobody owes anything this season.',
      loading: 'Loading…', error: 'Something went wrong. Try again.'
    }
  };
  // A page's own wording (SMBHL: its admin pages say « vous »).
  if (C.T) ['fr', 'en'].forEach(function (l) { for (var k in (C.T[l] || {})) T[l][k] = C.T[l][k]; });
  var state = { open: false, data: null, msg: '', msgKind: '' };
  function lang() {
    var l = window.__currentLang || document.documentElement.getAttribute('lang') || 'fr';
    return String(l).slice(0, 2) === 'en' ? 'en' : 'fr';
  }
  function t(k) { return T[lang()][k]; }
  function fill(s, vars) { for (var k in vars) s = s.split('{' + k + '}').join(String(vars[k])); return s; }
  function plural(n, one, many) { var isOne = lang() === 'en' ? n === 1 : n < 2; return fill(t(isOne ? one : many), { n: n }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(n) { return new Intl.NumberFormat(lang() === 'en' ? 'en-CA' : 'fr-CA', { style: 'currency', currency: 'CAD' }).format(Number(n || 0)); }
  function day(iso) {
    if (!iso) return t('never');
    var d = new Date(iso);
    if (isNaN(d.getTime())) return t('never');
    return d.toLocaleDateString(lang() === 'en' ? 'en-CA' : 'fr-CA', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function headers() {
    var h = { 'content-type': 'application/json' };
    try { if (window.__csrfHeader) { var c = window.__csrfHeader(); for (var k in c) h[k] = c[k]; } } catch (e) {}
    try { if (typeof K === 'string' && K) h['x-admin'] = K; } catch (e) {}
    return h;
  }
  function season() { var s = document.getElementById(C.seasonSelect); return s ? s.value : ''; }
  function root() { return document.getElementById('pay-root'); }
  function checked() {
    return Array.prototype.slice.call(document.querySelectorAll('#pay-root input[data-pay-player]:checked')).map(function (b) { return b.getAttribute('data-pay-player'); });
  }
  function refreshControls() {
    var ids = checked();
    var send = document.getElementById('pay-send');
    if (send) {
      send.textContent = plural(ids.length, 'sendOne', 'sendMany');
      send.disabled = !ids.length || !(state.data && state.data.hasInfo);
    }
    var pv = document.getElementById('pay-preview');
    if (pv) {
      pv.disabled = !ids.length || !(state.data && state.data.hasInfo);
      pv.setAttribute('data-preview-params', JSON.stringify({ season: (state.data && state.data.season) || season(), player_id: ids[0] || '' }));
    }
  }
  function render() {
    var r = root();
    if (!r) return;
    var btn = '<button type="button" class="' + esc(C.btnCls) + '" id="pay-open" aria-expanded="' + (state.open ? 'true' : 'false') + '">' + esc(t('open')) + '</button>';
    if (!state.open) { r.innerHTML = btn; return; }
    var d = state.data;
    var h = btn + '<div class="' + esc(C.cardCls) + '" id="pay-panel" style="margin-top:10px">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><strong>' + esc(t('open')) + '</strong>'
      + '<button type="button" class="' + esc(C.btnCls) + '" id="pay-close">' + esc(t('close')) + '</button></div>';
    if (!d) { r.innerHTML = h + '<p>' + esc(t('loading')) + '</p></div>'; return; }
    if (!d.hasInfo) h += '<p id="pay-noinfo" role="status" style="margin:10px 0;padding:8px 10px;border:1px solid #fde68a;background:#fffbeb;border-radius:4px">' + esc(t('noInfo')) + '</p>';
    if (!d.owing.length && !d.noEmail.length) h += '<p id="pay-nobody" style="margin:10px 0">' + esc(t('nobody')) + '</p>';
    if (d.owing.length) {
      h += '<div style="overflow-x:auto;margin-top:10px"><table id="pay-table" style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr>'
        + '<th style="width:32px"></th><th style="text-align:left;padding:6px">' + esc(t('colName')) + '</th>'
        + '<th style="text-align:right;padding:6px">' + esc(t('colBalance')) + '</th><th style="text-align:left;padding:6px">' + esc(t('colLast')) + '</th></tr></thead><tbody>';
      d.owing.forEach(function (p) {
        h += '<tr><td style="padding:6px"><input type="checkbox"' + (p.opted_out ? '' : ' checked') + ' data-pay-player="' + esc(p.player_id) + '" aria-label="' + esc(p.name) + '"></td>'
          + '<td style="padding:6px">' + esc(p.name) + (p.opted_out ? ' <span data-pay-optout style="font-size:12px;opacity:.75">(' + esc(t('optedOut')) + ')</span>' : '') + '</td><td style="padding:6px;text-align:right;font-variant-numeric:tabular-nums">' + esc(money(p.balance)) + '</td>'
          + '<td style="padding:6px" data-pay-last="' + esc(p.player_id) + '">' + esc(day(p.last_reminded)) + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }
    if (d.noEmail.length) {
      h += '<div id="pay-noemail" style="margin-top:10px"><div style="font-weight:600">' + esc(t('noEmailTitle')) + '</div><ul style="margin:6px 0;padding-left:20px">';
      d.noEmail.forEach(function (p) {
        h += '<li><input type="checkbox" disabled aria-label="' + esc(p.name) + '"> ' + esc(p.name) + ', ' + esc(money(p.balance)) + ' : ' + esc(t('noEmail')) + '</li>';
      });
      h += '</ul></div>';
    }
    h += '<div style="margin-top:10px"><label for="pay-note" style="display:block;font-weight:600;margin-bottom:4px">' + esc(t('note')) + '</label>'
      + '<textarea id="pay-note" maxlength="500" rows="3" style="width:100%;box-sizing:border-box;font:inherit"></textarea></div>';
    h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center">'
      + '<button type="button" class="' + esc(C.btnCls) + '" id="pay-preview" data-email-preview="payment_reminder" data-preview-endpoint="' + esc(C.preview) + '" data-preview-fields="note=pay-note">' + esc(t('preview')) + '</button>'
      + '<button type="button" class="' + esc(C.primaryCls) + '" id="pay-send"></button>'
      + '<span id="pay-msg" role="status" style="font-weight:600' + (state.msgKind === 'err' ? ';color:#b91c1c' : '') + '">' + esc(state.msg) + '</span></div>';
    var note = document.getElementById('pay-note');
    var kept = note ? note.value : '';
    r.innerHTML = h + '</div>';
    if (kept) document.getElementById('pay-note').value = kept;
    refreshControls();
  }
  function load() {
    state.data = null; render();
    var q = encodeURIComponent(C.seasonParam || 'season') + '=' + encodeURIComponent(season());
    fetch(C.list + '?' + q, { credentials: 'same-origin', headers: headers() }).then(function (res) {
      return res.json().then(function (d) {
        if (!res.ok || !d.ok) { state.data = { hasInfo: false, owing: [], noEmail: [] }; state.msg = t('error'); state.msgKind = 'err'; }
        else state.data = d;
        render();
      });
    }).catch(function () { state.data = { hasInfo: false, owing: [], noEmail: [] }; state.msg = t('error'); state.msgKind = 'err'; render(); });
  }
  function send() {
    var ids = checked();
    if (!ids.length) return;
    var btn = document.getElementById('pay-send');
    btn.disabled = true;
    var note = document.getElementById('pay-note').value;
    fetch(C.send, { method: 'POST', credentials: 'same-origin', headers: headers(), body: JSON.stringify({ season: state.data.season, player_ids: ids, note: note }) })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (d) {
          if (d.ok) {
            var m = plural(d.sent, 'sentOne', 'sentMany');
            if (d.skipped && d.skipped.length) m += ' ' + fill(t('skipped'), { names: d.skipped.join(', ') });
            state.msg = m; state.msgKind = 'ok';
            load();
            return;
          }
          if (d.errorKey === 'PAYMENT_OVER_BUDGET') state.msg = fill(t('overBudget'), { n: d.n, left: d.left });
          else if (d.errorKey === 'PAYMENT_INFO_MISSING') state.msg = t('noInfo');
          else state.msg = (window.__errorText && d.errorKey) ? window.__errorText(d.errorKey, d.error) : (d.error || t('error'));
          state.msgKind = 'err';
          render();
        });
      }).catch(function () { state.msg = t('error'); state.msgKind = 'err'; render(); });
  }
  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el || !el.closest) return;
    if (el.closest('#pay-open')) { state.open = !state.open; state.msg = ''; if (state.open) load(); else render(); return; }
    if (el.closest('#pay-close')) { state.open = false; state.msg = ''; render(); return; }
    if (el.closest('#pay-send')) { send(); }
  });
  document.addEventListener('change', function (e) {
    if (e.target && e.target.matches && e.target.matches('#pay-root input[data-pay-player]')) refreshControls();
    if (e.target && e.target.id === C.seasonSelect && state.open) { state.msg = ''; load(); }
  });
  window.addEventListener('admin_lang_changed', render);
  window.addEventListener('nl_lang_changed', render);
  render();
})();`;

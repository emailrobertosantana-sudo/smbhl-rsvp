// The super-admin pages on the Notre Ligue product (stage 2): the league
// list (/super-admin/leagues) and one league's page (/super-admin/league).
// Notre Ligue branding through the product switch: index.js serves these
// only when LEAGUE_PRODUCT is 'true'; SMBHL keeps its own super-admin page
// (superAdminPage in src/index.js) unchanged.
//
// Built on nlDocument (src/design_system.js) with the Notre Ligue wordmark,
// the design system's tokens and components, titles « Page | Notre Ligue ».
// French and English through the page's FR/EN toggle (the same dictionary
// mechanism as the other Notre Ligue pages, nlAuthScript in src/index.js,
// passed in as authScript).
//
// The browser code is String.raw text (never a function's toString: the
// bundler adds __name() calls), with no backtick and no dollar-brace inside.
import { nlDocument } from './design_system.js';
import { CAPABILITY_FLAGS, PLAN_TIERS } from './super_admin.js';
import { HEALTH_RULES } from './league_health.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const COMMON = {
  fr: {
    brandSuffix: 'Super-admin',
    keyTitle: 'Clé admin', keyPh: 'clé', keyBtn: 'Ouvrir', keyEmpty: 'Entre la clé.', keyBad: 'Clé refusée.',
    err: 'Erreur : ',
    red: 'Rouge', yellow: 'Jaune', green: 'Vert', deactivated: 'Désactivée',
    none: 'Aucun', never: 'Jamais', noInvites: 'Aucune invitation',
    tier_free: 'Gratuit', tier_standard: 'Standard', tier_plus: 'Plus', tier_custom: 'Sur mesure',
    st_exempt: 'Exemptée', st_off: 'Facturation désactivée', st_trial: 'Essai', st_free: 'Gratuite', st_active: 'Abonnée',
    st_past_due: 'Paiement en retard', st_paused: 'En pause', st_inactive: 'Inactive', st_unpaid: 'Sans abonnement', st_grace: 'Délai de grâce',
    trialDays1: 'Essai : 1 jour restant', trialDaysN: 'Essai : {n} jours restants'
  },
  en: {
    brandSuffix: 'Super-admin',
    keyTitle: 'Admin key', keyPh: 'key', keyBtn: 'Open', keyEmpty: 'Enter the key.', keyBad: 'Key rejected.',
    err: 'Error: ',
    red: 'Red', yellow: 'Yellow', green: 'Green', deactivated: 'Deactivated',
    none: 'None', never: 'Never', noInvites: 'No invitations',
    tier_free: 'Free', tier_standard: 'Standard', tier_plus: 'Plus', tier_custom: 'Custom',
    st_exempt: 'Exempt', st_off: 'Billing off', st_trial: 'Trial', st_free: 'Free', st_active: 'Subscribed',
    st_past_due: 'Payment past due', st_paused: 'Paused', st_inactive: 'Inactive', st_unpaid: 'No subscription', st_grace: 'Grace period',
    trialDays1: 'Trial: 1 day left', trialDaysN: 'Trial: {n} days left'
  }
};

export const LIST_I18N = {
  fr: {
    ...COMMON.fr,
    title: 'Ligues', intro: 'Chaque ligue Notre Ligue et son état. Le rouge et le jaune en premier.',
    filterLabel: 'État', all: 'Toutes', searchLabel: 'Chercher', searchPh: 'Nom de la ligue',
    colLight: 'État', colName: 'Ligue', colOwner: 'Propriétaire', colSignup: 'Inscription', colPlayers: 'Joueurs réguliers (palier)',
    colBilling: 'Essai ou abonnement', colSignin: 'Dernière connexion admin', colAnswers: 'Réponses (14 jours)', colNext: 'Prochain match',
    empty: 'Aucune ligue ne correspond.', liveMark: 'Calcul en direct, pas encore enregistré'
  },
  en: {
    ...COMMON.en,
    title: 'Leagues', intro: 'Every Notre Ligue league and its state. Red and yellow first.',
    filterLabel: 'State', all: 'All', searchLabel: 'Search', searchPh: 'League name',
    colLight: 'State', colName: 'League', colOwner: 'Owner', colSignup: 'Signed up', colPlayers: 'Regular players (tier)',
    colBilling: 'Trial or subscription', colSignin: 'Last admin sign-in', colAnswers: 'Answers (14 days)', colNext: 'Next game',
    empty: 'No league matches.', liveMark: 'Computed live, not stored yet'
  }
};

export const LEAGUE_I18N = {
  fr: {
    ...COMMON.fr,
    back: 'Retour aux ligues', viewAs: "Voir comme l'admin",
    viewAsHelp: 'Ouvre les pages admin de la ligue en lecture seule. Chaque visite est enregistrée.',
    computedAt: 'Calculé le {d}', computedLive: "Calcul en direct : la vérification quotidienne ne l'a pas encore enregistré.",
    hSignals: 'Santé', colRule: 'Règle', colResult: 'Résultat', colLevel: 'Si non respectée', colValue: 'Valeur',
    met: 'Respectée', notMet: 'Non respectée',
    hTimeline: "Chronologie de l'essai", notYet: 'Pas encore', observed: '(constaté par la vérification quotidienne)',
    tl_signed_up: 'Inscription', tl_first_player: 'Premier joueur ajouté', tl_first_game: 'Premier match prévu',
    tl_first_invitation: 'Première invitation envoyée', tl_first_answers: 'Premières réponses', tl_subscribed: 'Abonnement',
    hBilling: 'Facturation', bCount: 'Joueurs réguliers', bCountTier: 'Palier selon le nombre', bStatus: 'État de la facturation',
    bTier: 'Palier facturé', bTrialEnd: "Fin de l'essai", bFree: 'Exception gratuite',
    bFreeHelp: 'Gratuite même si le propriétaire a déjà une ligue gratuite.',
    hSettings: 'Réglages', sSlug: 'Adresse', sAdmins: 'Admins', sPublic: 'Page publique', yes: 'Oui', no: 'Non',
    sPlan: 'Palier (étiquette)', sFlags: 'Indicateurs', sDelete: 'Supprimer la ligue',
    deleteProtected: 'Cette ligue ne peut pas être supprimée.', deletePrompt: 'Tape « SUPPRIMER {name} » pour confirmer :',
    hLog: 'Accès de soutien', logStarted: 'Début', logEnded: 'Fin', logWho: 'Qui', logBrowser: 'Navigateur', logSession: 'Session',
    logEmpty: 'Aucun accès de soutien.', logOpen: 'En cours', logExpired: 'Expiré', who_super_admin: 'Super-admin',
    v_players_games: '{p} joueurs, {g} matchs', v_failures: '{n} en 7 jours', v_noTrial: "Pas d'essai en cours",
    notFound: 'Ligue introuvable.'
  },
  en: {
    ...COMMON.en,
    back: 'Back to leagues', viewAs: 'View as admin',
    viewAsHelp: "Opens the league's admin pages read-only. Every visit is logged.",
    computedAt: 'Computed on {d}', computedLive: 'Computed live: the daily check has not stored it yet.',
    hSignals: 'Health', colRule: 'Rule', colResult: 'Result', colLevel: 'When not met', colValue: 'Value',
    met: 'Met', notMet: 'Not met',
    hTimeline: 'Trial timeline', notYet: 'Not yet', observed: '(seen by the daily check)',
    tl_signed_up: 'Signed up', tl_first_player: 'First player added', tl_first_game: 'First game scheduled',
    tl_first_invitation: 'First invitation sent', tl_first_answers: 'First answers', tl_subscribed: 'Subscribed',
    hBilling: 'Billing', bCount: 'Regular players', bCountTier: 'Tier from the count', bStatus: 'Billing status',
    bTier: 'Billed tier', bTrialEnd: 'Trial end', bFree: 'Free exception',
    bFreeHelp: 'Free even when the owner already has a free league.',
    hSettings: 'Settings', sSlug: 'Address', sAdmins: 'Admins', sPublic: 'Public page', yes: 'Yes', no: 'No',
    sPlan: 'Plan tier (label)', sFlags: 'Flags', sDelete: 'Delete the league',
    deleteProtected: 'This league cannot be deleted.', deletePrompt: 'Type "DELETE {name}" to confirm:',
    hLog: 'Support access', logStarted: 'Started', logEnded: 'Ended', logWho: 'Who', logBrowser: 'Browser', logSession: 'Session',
    logEmpty: 'No support access.', logOpen: 'Open', logExpired: 'Expired', who_super_admin: 'Super-admin',
    v_players_games: '{p} players, {g} games', v_failures: '{n} in 7 days', v_noTrial: 'No trial running',
    notFound: 'League not found.'
  }
};
for (const r of HEALTH_RULES) {
  LEAGUE_I18N.fr[`rule_${r.key}`] = r.fr;
  LEAGUE_I18N.en[`rule_${r.key}`] = r.en;
}
for (const f of CAPABILITY_FLAGS) {
  const [fr, en] = f.label.split(' / ');
  LEAGUE_I18N.fr[`flag_${f.key}`] = fr;
  LEAGUE_I18N.en[`flag_${f.key}`] = en || fr;
}

const STYLE = `<style>
  body.nl { margin: 0; background: var(--surface); }
  .sa-brand-sub { font: 600 14px/20px var(--font-sans); color: var(--ink-muted); }
  .sa-page { max-width: 1240px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }
  .sa-page h1 { font: 800 30px/36px var(--font-display); font-stretch: 118%; margin: 0 0 var(--space-2); }
  .sa-page h2 { font: 800 20px/28px var(--font-display); font-stretch: 118%; margin: var(--space-6) 0 var(--space-3); }
  .sa-muted { color: var(--ink-muted); font-size: 14px; }
  .sa-tools { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: flex-end; margin: var(--space-4) 0; }
  .sa-tools label { display: flex; flex-direction: column; gap: var(--space-1); font: 600 14px/20px var(--font-sans); }
  .sa-tools .nl-select { width: 180px; } .sa-tools .nl-input { width: 260px; max-width: 100%; }
  .sa-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius-md); }
  table.sa-table { width: 100%; border-collapse: collapse; font-size: 14px; line-height: 20px; }
  .sa-table th { text-align: left; font-weight: 700; padding: 10px 12px; border-bottom: 2px solid var(--line-strong); white-space: nowrap; background: var(--surface-sunken); }
  .sa-table td { padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .sa-table tr.sa-row { cursor: pointer; }
  .sa-table tr.sa-row:hover td, .sa-table tr.sa-row:focus-within td { background: var(--primary-tint); }
  .sa-table a { color: var(--ink); font-weight: 700; }
  .sa-light { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; font-weight: 700; }
  .sa-light i { width: 12px; height: 12px; border-radius: 50%; flex: none; border: 1px solid rgba(0,0,0,.35); }
  .sa-light--red i { background: #d62839; } .sa-light--yellow i { background: #ffd23f; } .sa-light--green i { background: #1c9a5b; } .sa-light--off i { background: transparent; }
  .sa-err { color: var(--danger); font-weight: 600; margin: var(--space-2) 0; }
  .sa-head { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; }
  .sa-head .sa-light { font-size: 18px; }
  .sa-actions { display: flex; flex-wrap: wrap; gap: var(--space-3); margin: var(--space-4) 0 var(--space-2); }
  .sa-dl { display: grid; grid-template-columns: minmax(160px, max-content) 1fr; gap: var(--space-2) var(--space-5); margin: 0; }
  .sa-dl dt { font-weight: 700; } .sa-dl dd { margin: 0; }
  .sa-ok { color: var(--success); font-weight: 700; } .sa-bad { color: var(--danger); font-weight: 700; }
  .sa-timeline { list-style: none; padding: 0; margin: 0; display: grid; gap: var(--space-2); }
  .sa-timeline li { display: flex; gap: var(--space-3); flex-wrap: wrap; }
  .sa-timeline b { min-width: 230px; }
  .sa-flag { display: block; margin: 0 0 var(--space-1); }
  .sa-date { white-space: nowrap; }
  @media (max-width: 639px) { .sa-dl { grid-template-columns: 1fr; } .sa-timeline b { min-width: 0; } }
</style>`;

function header() {
  return `<header class="nl-header">
  <a class="nl-brand nl-brand--product" href="/super-admin/leagues" style="color:inherit;text-decoration:none"><i></i>Notre Ligue</a>
  <span class="sa-brand-sub" data-i18n="brandSuffix">Super-admin</span>
  <div class="spacer"></div>
  <div class="nl-lang" role="group" aria-label="Langue / Language">
    <button type="button" id="btn-lang-fr" aria-pressed="true" onclick="window.__setLang('fr')">FR</button>
    <button type="button" id="btn-lang-en" aria-pressed="false" onclick="window.__setLang('en')">EN</button>
  </div>
</header>`;
}

function keyGate(isAuthed, T) {
  return `<div class="nl-card" id="gate"${isAuthed ? ' hidden' : ''} style="max-width:420px;margin:var(--space-5) 0">
    <h2 data-i18n="keyTitle" style="margin-top:0">${esc(T.keyTitle)}</h2>
    <input id="key" class="nl-input" type="password" autocomplete="off" data-i18n-ph="keyPh" placeholder="${esc(T.keyPh)}">
    <div style="margin-top:var(--space-3)"><button class="nl-btn nl-btn--primary" type="button" id="go" data-i18n="keyBtn">${esc(T.keyBtn)}</button></div>
    <p class="sa-err" id="err"></p>
  </div>`;
}

// Shared browser helpers: the key (URL, storage, cookie), the dictionary,
// dates, the light.
const COMMON_JS = String.raw`
var K = (function() {
  var p = new URLSearchParams(location.search);
  var v = p.get('key') || p.get('k') || p.get('t') || '';
  if (!v) { try { v = localStorage.getItem('adminkey') || ''; } catch (e) {} }
  if (!v) {
    document.cookie.split(';').forEach(function(c) {
      var i = c.indexOf('=');
      if (i > 0 && c.slice(0, i).trim() === 'admin_key') { try { v = decodeURIComponent(c.slice(i + 1).trim()); } catch (e) {} }
    });
  }
  return v;
})();
function $(id) { return document.getElementById(id); }
function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function T(k) { var d = window.__pageDict(); return d[k] != null ? d[k] : k; }
function fill(s, vars) { return String(s).replace(/[{]([A-Za-z0-9_]+)[}]/g,function(m, k) { return vars[k] != null ? vars[k] : m; }); }
// Montreal time (America/Toronto) for every date and time shown, never UTC.
function mtl(t, opts) {
  try { return new Intl.DateTimeFormat('en-CA', Object.assign({ timeZone: 'America/Toronto' }, opts)).format(new Date(t)); }
  catch (e) { return ''; }
}
function day(isoText) {
  if (!isoText) return '';
  var s = String(isoText);
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return s;
  var t = Date.parse(s);
  return isNaN(t) ? s.slice(0, 10) : (mtl(t, { year: 'numeric', month: '2-digit', day: '2-digit' }) || s.slice(0, 10));
}
// A trial ending at 00:00 on a day: its last day is the day before.
function lastDay(isoText) { var t = Date.parse(String(isoText || '')); return isNaN(t) ? day(isoText) : day(new Date(t - 1).toISOString()); }
function hm(isoText) { var t = Date.parse(String(isoText || '')); return isNaN(t) ? '' : mtl(t, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
// A date or date-time never breaks inside itself (item E): escaped, in a
// nowrap span when it is one; any other text only escaped.
function dateHtml(s) {
  s = String(s == null ? '' : s);
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}( [0-9]{2}:[0-9]{2})?$/.test(s) ? '<span class="sa-date">' + esc(s) + '</span>' : esc(s);
}
function lightHtml(light) {
  if (!light) return '<span class="sa-light sa-light--off"><i></i>' + esc(T('deactivated')) + '</span>';
  return '<span class="sa-light sa-light--' + light + '"><i></i>' + esc(T(light)) + '</span>';
}
function tierText(t) { return t ? T('tier_' + t) : ''; }
function statusText(m) {
  if (!m) return '';
  if (m.billingStatus === 'trial' && m.trialDaysLeft != null) return m.trialDaysLeft === 1 ? T('trialDays1') : fill(T('trialDaysN'), { n: m.trialDaysLeft });
  return m.billingStatus ? T('st_' + m.billingStatus) : '';
}
function shareText(m) {
  if (!m.invitations14) return T('noInvites');
  var pct = Math.round(100 * m.answered14 / m.invitations14);
  return (window.__currentLang === 'en' ? pct + '%' : pct + ' %') + ' (' + m.answered14 + '/' + m.invitations14 + ')';
}
function api(path, opts) {
  opts = opts || {};
  var headers = { 'x-admin': K };
  if (opts.body) headers['content-type'] = 'application/json';
  return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined }).then(function(res) {
    return res.text().then(function(text) {
      var data = null; try { data = JSON.parse(text); } catch (e) {}
      if (!res.ok) { var e2 = new Error((data && data.error) || text || String(res.status)); e2.status = res.status; throw e2; }
      return data;
    });
  });
}
function unlockWith(candidate, load) {
  var prev = K; K = candidate;
  return load().then(function() {
    try { localStorage.setItem('adminkey', K); } catch (e) {}
    try { document.cookie = 'admin_key=' + encodeURIComponent(K) + '; Path=/; Max-Age=2592000; SameSite=Lax; Secure'; } catch (e) {}
    $('gate').hidden = true; $('sa-main').hidden = false; return true;
  }).catch(function() { K = prev; return false; });
}
function wireGate(load) {
  $('go').addEventListener('click', function() {
    var v = $('key').value.trim();
    if (!v) { $('err').textContent = T('keyEmpty'); return; }
    unlockWith(v, load).then(function(ok) { if (!ok) $('err').textContent = T('keyBad'); });
  });
  $('key').addEventListener('keydown', function(e) { if (e.key === 'Enter') $('go').click(); });
}
function afterLang(render) {
  window.addEventListener('nl_lang_changed', function() { render(); });
}
`;

const LIST_JS = String.raw`
var rows = [];
var timer = null;
function rowHtml(m) {
  var href = '/super-admin/league?id=' + encodeURIComponent(m.id);
  var players = m.regularCount == null ? String(m.players) : m.regularCount + (m.countTier ? ' (' + tierText(m.countTier) + ')' : '');
  return '<tr class="sa-row" data-href="' + esc(href) + '">' +
    '<td>' + lightHtml(m.light) + (m.healthLive ? ' <span class="sa-muted" title="' + esc(T('liveMark')) + '">*</span>' : '') + '</td>' +
    '<td><a href="' + esc(href) + '">' + esc(m.name) + '</a></td>' +
    '<td>' + esc(m.ownerMasked || '') + '</td>' +
    '<td>' + dateHtml(day(m.createdAt)) + '</td>' +
    '<td>' + esc(players) + '</td>' +
    '<td>' + esc(statusText(m)) + '</td>' +
    '<td>' + dateHtml(m.lastAdminSignInAt ? day(m.lastAdminSignInAt) : T('never')) + '</td>' +
    '<td>' + esc(shareText(m)) + '</td>' +
    '<td>' + dateHtml(m.nextGame || T('none')) + '</td>' +
    '</tr>';
}
function render() {
  $('sa-tbody').innerHTML = rows.map(rowHtml).join('');
  $('sa-empty').hidden = rows.length > 0;
}
function load() {
  var q = new URLSearchParams({ status: $('sa-status').value, q: $('sa-q').value.trim() });
  return api('/super-admin/leagues/data?' + q.toString()).then(function(data) {
    rows = data.rows || [];
    $('sa-err').textContent = '';
    render();
  });
}
function reload() { load().catch(function(err) { $('sa-err').textContent = T('err') + err.message; }); }
$('sa-status').addEventListener('change', reload);
$('sa-q').addEventListener('input', function() { clearTimeout(timer); timer = setTimeout(reload, 250); });
$('sa-tbody').addEventListener('click', function(e) {
  if (e.target.closest('a')) return;
  var tr = e.target.closest('tr.sa-row');
  if (tr) location.href = tr.getAttribute('data-href');
});
wireGate(load);
afterLang(render);
if (K) { unlockWith(K, load); }
else if (window.__saAuthed) { $('gate').hidden = true; $('sa-main').hidden = false; reload(); }
`;

export function superAdminListPage({ isAuthed = false, lang = 'fr', authScript }) {
  const T = LIST_I18N[lang === 'en' ? 'en' : 'fr'];
  const th = k => `<th scope="col" data-i18n="${k}">${esc(T[k])}</th>`;
  const opt = (v, k) => `<option value="${v}" data-i18n="${k}">${esc(T[k])}</option>`;
  const body = `${STYLE}
${header()}
<main class="sa-page">
  <h1 data-i18n="title">${esc(T.title)}</h1>
  <p class="sa-muted" data-i18n="intro">${esc(T.intro)}</p>
  ${keyGate(isAuthed, T)}
  <div id="sa-main"${isAuthed ? '' : ' hidden'}>
    <div class="sa-tools">
      <label><span data-i18n="filterLabel">${esc(T.filterLabel)}</span>
        <select id="sa-status" class="nl-select">${opt('', 'all')}${opt('red', 'red')}${opt('yellow', 'yellow')}${opt('green', 'green')}${opt('deactivated', 'deactivated')}</select></label>
      <label><span data-i18n="searchLabel">${esc(T.searchLabel)}</span>
        <input id="sa-q" class="nl-input" type="search" autocomplete="off" data-i18n-ph="searchPh" placeholder="${esc(T.searchPh)}"></label>
    </div>
    <p class="sa-err" id="sa-err"></p>
    <div class="sa-scroll"><table class="sa-table" id="sa-table">
      <thead><tr>${['colLight', 'colName', 'colOwner', 'colSignup', 'colPlayers', 'colBilling', 'colSignin', 'colAnswers', 'colNext'].map(th).join('')}</tr></thead>
      <tbody id="sa-tbody"></tbody>
    </table></div>
    <p class="sa-muted" id="sa-empty" hidden data-i18n="empty">${esc(T.empty)}</p>
  </div>
</main>
<script>${authScript(LIST_I18N)}
window.__saAuthed = ${isAuthed ? 'true' : 'false'};
${COMMON_JS}
${LIST_JS}</script>`;
  return nlDocument({ titles: { fr: 'Super-admin | Notre Ligue', en: 'Super-admin | Notre Ligue' }, bodyHtml: body, lang });
}

const LEAGUE_JS = String.raw`
var D = null;
var LEAGUE_ID = new URLSearchParams(location.search).get('id') || '';
function valueFor(key, m) {
  if (key === 'admin_signin_7' || key === 'admin_signin_21') return m.lastAdminSignInAt ? day(m.lastAdminSignInAt) : T('never');
  if (key === 'game_window') return m.nextGame || T('none');
  if (key === 'answers_half') return shareText(m);
  if (key === 'trial_not_ending') return m.trialEndsAt && m.billingStatus === 'trial' ? lastDay(m.trialEndsAt) : T('v_noTrial');
  if (key === 'mail_ok') return fill(T('v_failures'), { n: m.mailFailures7 || 0 });
  if (key === 'setup_done') return fill(T('v_players_games'), { p: m.players || 0, g: m.games || 0 });
  if (key === 'payment_ok') return statusText(m);
  return '';
}
function renderSignals(h) {
  var levels = {};
  D.rules.forEach(function(r) { levels[r.key] = r.level; });
  return (h.signals || []).map(function(s) {
    return '<tr><td>' + esc(T('rule_' + s.key)) + '</td>' +
      '<td class="' + (s.ok ? 'sa-ok' : 'sa-bad') + '">' + esc(s.ok ? T('met') : T('notMet')) + '</td>' +
      '<td>' + lightHtml(levels[s.key] || s.level) + '</td>' +
      '<td>' + dateHtml(valueFor(s.key, h.metrics || {})) + '</td></tr>';
  }).join('');
}
function renderTimeline() {
  return D.timeline.map(function(t) {
    return '<li><b>' + esc(T('tl_' + t.key)) + '</b><span>' + (t.at ? dateHtml(day(t.at)) +(t.observed ? ' <span class="sa-muted">' + esc(T('observed')) + '</span>' : '') : '<span class="sa-muted">' + esc(T('notYet')) + '</span>') + '</span></li>';
  }).join('');
}
function renderLog() {
  if (!D.supportLog.length) return '<p class="sa-muted">' + esc(T('logEmpty')) + '</p>';
  var now = Date.now();
  var rowsHtml = D.supportLog.slice().reverse().map(function(e) {
    var end = e.endedAt ? day(e.endedAt) + ' ' + hm(e.endedAt)
      : (e.expiresAt && Date.parse(e.expiresAt) < now ? T('logExpired') : T('logOpen'));
    return '<tr><td>' + dateHtml(day(e.startedAt) + ' ' + hm(e.startedAt)) + '</td><td>' + dateHtml(end) + '</td>' +
      '<td>' + esc(T('who_' + String(e.who || '').replace('-', '_'))) + '</td><td>' + esc(e.browser || '') + '</td><td><code>' + esc(e.sid) + '</code></td></tr>';
  }).join('');
  return '<div class="sa-scroll"><table class="sa-table"><thead><tr><th>' + esc(T('logStarted')) + '</th><th>' + esc(T('logEnded')) + '</th><th>' + esc(T('logWho')) + '</th><th>' + esc(T('logBrowser')) + '</th><th>' + esc(T('logSession')) + '</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
}
function renderSettings() {
  var s = D.settings;
  var tiers = D.planTiers.map(function(t) { return '<option value="' + esc(t.key) + '"' + (t.key === s.planTier ? ' selected' : '') + '>' + esc(t.label) + '</option>'; }).join('');
  var flags = D.flagKeys.map(function(k) {
    return '<label class="sa-flag"><input type="checkbox" class="sa-flagbox" data-flag="' + esc(k) + '"' + (s.flags[k] ? ' checked' : '') + '> ' + esc(T('flag_' + k)) + '</label>';
  }).join('');
  return '<dl class="sa-dl">' +
    '<dt>' + esc(T('sSlug')) + '</dt><dd>' + esc(s.slug || '') + '</dd>' +
    '<dt>' + esc(T('sAdmins')) + '</dt><dd>' + esc(s.adminCount) + '</dd>' +
    '<dt>' + esc(T('sPublic')) + '</dt><dd>' + esc(s.publicPageEnabled ? T('yes') : T('no')) + '</dd>' +
    '<dt><label for="sa-plan">' + esc(T('sPlan')) + '</label></dt><dd><select id="sa-plan" class="nl-select" style="max-width:220px">' + tiers + '</select></dd>' +
    '<dt>' + esc(T('sFlags')) + '</dt><dd>' + flags + '</dd>' +
    '</dl><div class="sa-actions"><button type="button" class="nl-btn nl-btn--secondary" id="sa-delete" style="color:var(--danger)">' + esc(T('sDelete')) + '</button></div>';
}
function render() {
  if (!D) return;
  var m = D.league;
  var h = D.health;
  $('sa-name').textContent = m.name;
  document.title = m.name + ' | Notre Ligue';
  $('sa-light').innerHTML = lightHtml(h.light);
  $('sa-computed').innerHTML = h.live ? esc(T('computedLive')) : fill(esc(T('computedAt')), { d: dateHtml(day(h.computedAt)) });
  $('sa-signals').innerHTML = renderSignals(h);
  $('sa-timeline').innerHTML = renderTimeline();
  $('sa-billing').innerHTML = '<dl class="sa-dl">' +
    '<dt>' + esc(T('bCount')) + '</dt><dd>' + esc(m.regularCount == null ? '' : m.regularCount) + '</dd>' +
    '<dt>' + esc(T('bCountTier')) + '</dt><dd>' + esc(tierText(m.countTier)) + '</dd>' +
    '<dt>' + esc(T('bStatus')) + '</dt><dd>' + esc(statusText(m)) + '</dd>' +
    '<dt>' + esc(T('bTier')) + '</dt><dd>' + esc(tierText(m.billedTier)) + '</dd>' +
    '<dt>' + esc(T('bTrialEnd')) + '</dt><dd>' + dateHtml(lastDay(m.trialEndsAt)) + '</dd>' +
    '<dt><label for="sa-free">' + esc(T('bFree')) + '</label></dt><dd><input type="checkbox" id="sa-free"' + (m.freeException ? ' checked' : '') + '> <span class="sa-muted">' + esc(T('bFreeHelp')) + '</span></dd>' +
    '</dl>';
  $('sa-settings').innerHTML = renderSettings();
  $('sa-log').innerHTML = renderLog();
}
function load() {
  return api('/super-admin/league/data?id=' + encodeURIComponent(LEAGUE_ID)).then(function(data) {
    D = data; $('sa-err').textContent = ''; render();
  }).catch(function(err) {
    if (err.status === 404) { $('sa-err').textContent = T('notFound'); return; }
    throw err;
  });
}
function update(body) {
  body.leagueId = LEAGUE_ID;
  return api('/super-admin/leagues/update', { method: 'POST', body: body }).then(function() { $('sa-err').textContent = ''; return load(); })
    .catch(function(err) { $('sa-err').textContent = T('err') + err.message; return load(); });
}
document.addEventListener('change', function(e) {
  if (!D) return;
  if (e.target.id === 'sa-free') update({ freeException: e.target.checked });
  else if (e.target.id === 'sa-plan') update({ planTier: e.target.value });
  else if (e.target.classList.contains('sa-flagbox')) { var f = {}; f[e.target.getAttribute('data-flag')] = e.target.checked; update({ flags: f }); }
});
document.addEventListener('click', function(e) {
  if (!D) return;
  if (e.target.id === 'sa-view-as') {
    api('/super-admin/support/start', { method: 'POST', body: { leagueId: LEAGUE_ID } })
      .then(function(r) { location.href = r.redirect || '/dashboard'; })
      .catch(function(err) { $('sa-err').textContent = T('err') + err.message; });
  } else if (e.target.id === 'sa-delete') {
    api('/super-admin/leagues/hard-delete/status?leagueId=' + encodeURIComponent(LEAGUE_ID)).then(function(st) {
      if (st.status === 'protected') { alert(T('deleteProtected')); return; }
      var phrase = prompt(fill(T('deletePrompt'), { name: D.league.name }));
      if (!phrase) return;
      return api('/super-admin/leagues/hard-delete', { method: 'POST', body: { leagueId: LEAGUE_ID, confirmPhrase: phrase } })
        .then(function() { location.href = '/super-admin/leagues'; });
    }).catch(function(err) { $('sa-err').textContent = T('err') + err.message; });
  }
});
wireGate(load);
afterLang(render);
if (K) { unlockWith(K, load); }
else if (window.__saAuthed) { $('gate').hidden = true; $('sa-main').hidden = false; load().catch(function(err) { $('sa-err').textContent = T('err') + err.message; }); }
`;

export function superAdminLeaguePage({ isAuthed = false, lang = 'fr', authScript, leagueName = '' }) {
  const T = LEAGUE_I18N[lang === 'en' ? 'en' : 'fr'];
  const th = k => `<th scope="col" data-i18n="${k}">${esc(T[k])}</th>`;
  const body = `${STYLE}
${header()}
<main class="sa-page">
  <p><a href="/super-admin/leagues" data-i18n="back">${esc(T.back)}</a></p>
  ${keyGate(isAuthed, T)}
  <div id="sa-main"${isAuthed ? '' : ' hidden'}>
    <div class="sa-head"><h1 id="sa-name">${esc(leagueName)}</h1><span id="sa-light"></span></div>
    <p class="sa-muted" id="sa-computed"></p>
    <p class="sa-err" id="sa-err"></p>
    <div class="sa-actions">
      <button type="button" class="nl-btn nl-btn--primary" id="sa-view-as" data-i18n="viewAs">${esc(T.viewAs)}</button>
    </div>
    <p class="sa-muted" data-i18n="viewAsHelp">${esc(T.viewAsHelp)}</p>
    <h2 data-i18n="hSignals">${esc(T.hSignals)}</h2>
    <div class="sa-scroll"><table class="sa-table"><thead><tr>${['colRule', 'colResult', 'colLevel', 'colValue'].map(th).join('')}</tr></thead><tbody id="sa-signals"></tbody></table></div>
    <h2 data-i18n="hTimeline">${esc(T.hTimeline)}</h2>
    <ul class="sa-timeline" id="sa-timeline"></ul>
    <h2 data-i18n="hBilling">${esc(T.hBilling)}</h2>
    <div id="sa-billing"></div>
    <h2 data-i18n="hLog">${esc(T.hLog)}</h2>
    <div id="sa-log"></div>
    <h2 data-i18n="hSettings">${esc(T.hSettings)}</h2>
    <div id="sa-settings"></div>
  </div>
</main>
<script>${authScript(LEAGUE_I18N)}
window.__saAuthed = ${isAuthed ? 'true' : 'false'};
${COMMON_JS}
${LEAGUE_JS}</script>`;
  const name = leagueName || 'Super-admin';
  return nlDocument({ titles: { fr: `${name} | Notre Ligue`, en: `${name} | Notre Ligue` }, bodyHtml: body, lang });
}

// The extra data the league page shows besides the health (settings and
// the plan-tier labels, flags as the old list had them).
export const LEAGUE_PAGE_CONSTANTS = {
  planTiers: PLAN_TIERS,
  flagKeys: CAPABILITY_FLAGS.map(f => f.key)
};

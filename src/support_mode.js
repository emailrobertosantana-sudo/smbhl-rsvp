// Support mode (stage 2): the super-admin views one league's admin pages,
// read-only, as its admin would see them. Notre Ligue only.
//
// ENTERED from the super-admin's league page ("Voir comme l'admin" / "View
// as admin"): POST /super-admin/support/start, with the admin key, sets the
// nl_support cookie: a support session id, the league, an expiry (2 hours),
// signed with AUTH_SECRET. Nothing else changes: the browser's own
// user_session and csrf_token cookies (a real admin session, if the
// super-admin has one) are never written or cleared.
//
// WHILE IT LASTS, on every request but the super-admin's own routes:
//   - checkUserSession (src/auth.js) answers for the league's owner (or
//     its first admin), marked support; checkLeagueAccess refuses any other
//     league and resolveSessionLeagueId always gives this one;
//   - every write is refused before routing (src/write_guard.js, mode
//     'support'), server-side;
//   - the request runs on supportEnv(): its database and KV refuse writes
//     (a GET that would write writes nothing), and no email can leave
//     (sendMail refuses on env.SUPPORT_MODE, the send bindings are gone);
//   - responses lose any Set-Cookie (nothing a page sets reaches the
//     super-admin's browser), and HTML pages get the fixed banner.
// The cookie is ignored entirely on SMBHL (LEAGUE_PRODUCT unset): support
// mode cannot be entered or used there.
//
// LEFT with the banner's button: POST /super-admin/support/exit clears the
// cookie, closes the log entry and returns to the league's super-admin page.
//
// LOGGED: every visit, in the settings table (no migration), key
// support_log:<league id> (league_id set): who (the super-admin, the
// support session id, the browser), when it started, ended or expired.
// The admin key itself is never stored. Shown on the league's super-admin
// page.
import { hmac, same } from './crypto_utils.js';

export const SUPPORT_COOKIE = 'nl_support';
export const SUPPORT_TTL_MS = 2 * 3600 * 1000;
export const SUPPORT_LOG_MAX = 200;
export const supportLogKey = leagueId => `support_log:${leagueId}`;
const SMBHL = 'smbhl';

export function supportAvailable(env) {
  return !!(env && env.LEAGUE_PRODUCT === 'true' && env.AUTH_SECRET);
}

const supportMsg = (sid, leagueId, exp) => `support:${sid}:${leagueId}:${exp}`;

function randomSid() {
  return [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
}

function readCookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (_) { return null; }
}

export async function supportCookieHeader(env, { sid, leagueId, exp }) {
  const sig = await hmac(env.AUTH_SECRET, supportMsg(sid, leagueId, exp));
  const value = encodeURIComponent([sid, leagueId, exp, sig].join('|'));
  return `${SUPPORT_COOKIE}=${value}; Path=/; Max-Age=${Math.floor(SUPPORT_TTL_MS / 1000)}; HttpOnly; SameSite=Lax; Secure`;
}
export function clearSupportCookieHeader() {
  return `${SUPPORT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`;
}

// The request's support session ({ sid, leagueId, exp }), or null: no
// cookie, a bad signature, expired, SMBHL, or not the Notre Ligue product.
export async function readSupportSession(req, env, now = Date.now()) {
  if (!supportAvailable(env)) return null;
  const raw = readCookie(req, SUPPORT_COOKIE);
  if (!raw) return null;
  const parts = raw.split('|');
  if (parts.length !== 4) return null;
  const [sid, leagueId, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!sid || !leagueId || leagueId === SMBHL || !Number.isFinite(exp) || now > exp) return null;
  try {
    const want = await hmac(env.AUTH_SECRET, supportMsg(sid, leagueId, exp));
    if (!same(want, sig)) return null;
  } catch (_) { return null; }
  return { sid, leagueId, exp };
}

// Whose pages support mode shows: the league's owner while still one of its
// admins, else its first admin. null when the league has no admin.
export async function supportViewer(db, leagueId) {
  const league = await db.prepare('SELECT id, created_by FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!league) return null;
  let row = league.created_by
    ? await db.prepare('SELECT user_id FROM league_admins WHERE league_id = ? AND user_id = ?').bind(leagueId, league.created_by).first()
    : null;
  if (!row) row = await db.prepare('SELECT user_id FROM league_admins WHERE league_id = ? ORDER BY created_at, user_id LIMIT 1').bind(leagueId).first();
  return row ? row.user_id : null;
}

// The session checkUserSession answers with in support mode.
export async function supportUserSession(env, sup) {
  const userId = await supportViewer(env.DB, sup.leagueId);
  if (!userId) return null;
  const u = await env.DB.prepare('SELECT session_epoch FROM users WHERE id = ?').bind(userId).first();
  if (!u) return null;
  return { userId, epoch: Number(u.session_epoch) || 0, support: { sid: sup.sid, leagueId: sup.leagueId } };
}

/* ---------- the access log ---------- */

export async function readSupportLog(db, leagueId) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(supportLogKey(leagueId)).first();
  if (!row) return [];
  try { const v = JSON.parse(row.value); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}
async function writeSupportLog(db, leagueId, entries) {
  await db.prepare('INSERT INTO settings (key, value, league_id) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(supportLogKey(leagueId), JSON.stringify(entries.slice(-SUPPORT_LOG_MAX)), leagueId).run();
}

// The browser, briefly, for "who": never an address, never the key.
export function browserLabel(ua) {
  const s = String(ua || '');
  const b = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'autre / other';
  const os = /Windows/.test(s) ? 'Windows' : /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  return os ? `${b}, ${os}` : b;
}

// POST /super-admin/support/start (the caller checked the admin key):
// { ok, cookie, redirect } or { ok: false, status, errorKey }.
export async function startSupport(env, req, leagueId, now = new Date()) {
  if (!supportAvailable(env)) return { ok: false, status: 404, error: 'Not found.', errorKey: 'NOT_FOUND' };
  if (!leagueId || leagueId === SMBHL) return { ok: false, status: 400, error: 'Not a Notre Ligue league.', errorKey: 'SUPPORT_LEAGUE_INVALID' };
  const league = await env.DB.prepare('SELECT id FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!league) return { ok: false, status: 404, error: 'League not found.', errorKey: 'LEAGUE_NOT_FOUND' };
  if (!(await supportViewer(env.DB, leagueId))) return { ok: false, status: 409, error: 'This league has no admin to view as.', errorKey: 'SUPPORT_NO_ADMIN' };
  // A support session already open in this browser ends here.
  const previous = await readSupportSession(req, env, now.getTime());
  if (previous) await endSupport(env, previous, now);
  const sid = randomSid();
  const exp = now.getTime() + SUPPORT_TTL_MS;
  const log = await readSupportLog(env.DB, leagueId);
  log.push({ sid, who: 'super-admin', browser: browserLabel(req.headers.get('user-agent')), startedAt: now.toISOString(), expiresAt: new Date(exp).toISOString(), endedAt: null });
  await writeSupportLog(env.DB, leagueId, log);
  return { ok: true, cookie: await supportCookieHeader(env, { sid, leagueId, exp }), redirect: '/dashboard', sid };
}

// Closes the session's log entry (left with the button, or replaced).
export async function endSupport(env, sup, now = new Date()) {
  const log = await readSupportLog(env.DB, sup.leagueId);
  const entry = log.find(e => e.sid === sup.sid);
  if (!entry || entry.endedAt) return;
  entry.endedAt = now.toISOString();
  await writeSupportLog(env.DB, sup.leagueId, log);
}

/* ---------- the read-only request ---------- */

// Statements that change data. Everything else (SELECT, a WITH that only
// reads, PRAGMA reads) runs.
export function isWriteSql(sql) {
  const s = String(sql || '').replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '').toUpperCase();
  if (/^(INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|VACUUM|REINDEX|ATTACH|DETACH)\b/.test(s)) return true;
  if (/^WITH\b/.test(s) && /\b(INSERT|UPDATE|DELETE|REPLACE)\b/.test(s)) return true;
  if (/^PRAGMA\b/.test(s) && /=/.test(s)) return true;
  return false;
}

// A D1 database whose writes do nothing (and report no change). blocked()
// is told each time, for the tests.
export function readOnlyDb(db, blocked = () => {}) {
  const none = { success: true, results: [], meta: { changes: 0, last_row_id: 0, rows_written: 0 } };
  const wrap = (stmt, write, sql) => ({
    __readOnlyInner: stmt,
    __readOnlyWrite: write,
    bind: (...args) => wrap(stmt.bind(...args), write, sql),
    first: (...args) => (write ? (blocked(sql), Promise.resolve(null)) : stmt.first(...args)),
    all: () => (write ? (blocked(sql), Promise.resolve({ ...none })) : stmt.all()),
    run: () => (write ? (blocked(sql), Promise.resolve({ ...none })) : stmt.run()),
    raw: (...args) => (write ? (blocked(sql), Promise.resolve([])) : stmt.raw(...args))
  });
  return {
    prepare: sql => wrap(db.prepare(sql), isWriteSql(sql), sql),
    batch: async stmts => {
      const out = [];
      for (const s of stmts || []) out.push(s && s.__readOnlyWrite ? (blocked('batch'), { ...none }) : await (s.__readOnlyInner || s).all());
      return out;
    },
    exec: async sql => { if (isWriteSql(sql)) { blocked(sql); return { count: 0, duration: 0 }; } return db.exec(sql); },
    dump: () => db.dump()
  };
}

// A KV namespace whose writes do nothing.
export function readOnlyKv(kv, blocked = () => {}) {
  if (!kv) return kv;
  return {
    get: (...a) => kv.get(...a),
    getWithMetadata: (...a) => kv.getWithMetadata(...a),
    list: (...a) => kv.list(...a),
    put: async key => { blocked(`kv put ${key}`); },
    delete: async key => { blocked(`kv delete ${key}`); }
  };
}

// The env a support-mode request runs on. Defined on a per-request copy,
// never on env itself (shared by every request of the isolate; a Proxy in
// the tests, where an assignment would land on it).
export function supportEnv(env, sup, blocked = () => {}) {
  const e = Object.create(env);
  const def = (k, v) => Object.defineProperty(e, k, { value: v, enumerable: true });
  def('SUPPORT_MODE', { sid: sup.sid, leagueId: sup.leagueId });
  def('DB', readOnlyDb(env.DB, blocked));
  def('SHEETS_KV', readOnlyKv(env.SHEETS_KV, blocked));
  def('SEND_EMAIL', undefined);
  def('RESEND_API_KEY', undefined);
  return e;
}

/* ---------- the banner ---------- */

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const SUPPORT_TEXT = {
  fr: { banner: 'Mode soutien, lecture seule', leave: 'Quitter le mode soutien' },
  en: { banner: 'Support mode, read-only', leave: 'Leave support mode' }
};

export function supportBannerHtml(leagueName) {
  const T = SUPPORT_TEXT;
  return `<div id="nl-support-banner" role="status" style="position:fixed;top:0;left:0;right:0;z-index:2147483000;background:#16181d;color:#ffffff;border-bottom:4px solid #ffd23f;font:600 14px/20px Archivo,Arial,Helvetica,sans-serif;padding:8px 16px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px">`
    + `<span><span lang="fr-CA">${esc(T.fr.banner)}</span> / <span lang="en-CA">${esc(T.en.banner)}</span>${leagueName ? ` · ${esc(leagueName)}` : ''}</span>`
    + `<form method="post" action="/super-admin/support/exit" style="margin:0 0 0 auto"><button type="submit" style="font:inherit;background:#ffd23f;color:#16181d;border:0;border-radius:4px;padding:6px 12px;min-height:32px;cursor:pointer">${esc(T.fr.leave)} / ${esc(T.en.leave)}</button></form>`
    + `</div><div aria-hidden="true" style="height:64px"></div>`;
}

// The response a support-mode request gets: no Set-Cookie, and on an HTML
// page the banner first in the body.
export function supportResponse(resp, leagueName) {
  const headers = new Headers(resp.headers);
  headers.delete('set-cookie');
  headers.set('cache-control', 'no-store');
  const out = new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
  if (!(headers.get('content-type') || '').includes('text/html')) return out;
  const banner = supportBannerHtml(leagueName);
  return new HTMLRewriter().on('body', { element(el) { el.prepend(banner, { html: true }); } }).transform(out);
}

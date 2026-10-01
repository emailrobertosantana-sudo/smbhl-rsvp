// src/health.js -- failure alerting for every league (and the cron itself).
//
// WHY: failures were found by looking -- mail abandoned and marked sent,
// quiet hours pushing sends into the night, an admin page's script dead for
// days, a schema drift. The dead-man check (index.js deadMan) covers SMBHL's
// own steps and outbox only. This covers every league, the silent case
// (a scheduled send that never went out) and the cron dying.
//
// WHAT IT DETECTS (collectProblems), each pass of the cron:
//   per league (league product; SMBHL's own steps stay with deadMan):
//     reminder_missed   a 72 h / 24 h / 12 h step that was due at least
//                       MISSED_GRACE_MINUTES ago, is on, and has no
//                       league_reminder_log row (sent, or skipped on
//                       purpose). The cron is self-healing -- a due step
//                       with no row is sent on the next pass -- so a row
//                       still missing after the grace means the pass is
//                       failing for that league, or not running.
//     outbox_failed     mail that failed permanently in the last 24 h
//     outbox_stuck      mail due for over an hour and still not sent
//     outbox_after_start  pre-game mail scheduled to leave after the game
//                       starts (the quiet-hours incident's shape)
//     cron_error        the pass threw for that league
//   system-wide (the operator only):
//     cron_error        the whole pass threw
//     mail_cap          today's email cap is reached (sends wait)
//     client_error      a page's JavaScript threw (reported by the page)
//   on request, not by the cron (it cannot report its own death):
//     cron_stale        no finished pass for CRON_STALE_MINUTES
//
// WHO IS TOLD: a league's problems go to that league's admins (email, in
// the league's language, and a banner on their dashboard while open); every
// problem goes to the operator (one email per pass AND the ALERT_WEBHOOK_URL
// channel, which does not use Resend -- so a mail outage or an exhausted
// cap still reaches the operator). A problem is told once when it appears,
// and again only if it clears and comes back.
//
// STATE: settings rows, 'health:alert:<scope>:<key>' (no migration needed;
// production's schema guard is unaffected).
import { eventStart, localParts, SMBHL_LEAGUE_ID } from './league_ids.js';
import { dailyCapFromEnv, readDailyCount, OUTBOX_DUE_WHERE } from './mail_queue.js';
import { REMINDER_WINDOW_THRESHOLD_HOURS, advancedStepHours, advancedStepHourOfDay, cadenceStepDue, usesAdvancedReminders, getEmailSettings } from './reminders.js';

// The cron runs every 5 min (SMBHL) / 15 min (league product): stale after
// about three missed passes.
export const CRON_STALE_MINUTES = { smbhl: 20, leagues: 50 };
export const MISSED_GRACE_MINUTES = 45;
export const STUCK_MINUTES = 60;
const ALERT_PREFIX = 'health:alert:';
const CLIENT_ERR_PREFIX = 'health:clienterr:';
const MAX_CLIENT_ERR_KEYS_PER_DAY = 50;
const MAX_ADMIN_EMAILS_PER_PASS = 2;

const KIND_LABEL = {
  reminder_72h: { fr: 'rappel 72 h', en: '72h reminder' },
  reminder_24h: { fr: 'rappel 24 h', en: '24h reminder' },
  logistics_12h: { fr: 'courriel de détails 12 h', en: '12h game-details email' }
};
const ENABLED_COLUMN = { reminder_72h: 'reminder_72h_enabled', reminder_24h: 'reminder_24h_enabled', logistics_12h: 'reminder_12h_enabled' };

export function productOf(env) { return env.LEAGUE_PRODUCT === 'true' ? 'leagues' : 'smbhl'; }
// The operator alerts name the environment that raised them.
export function productName(env) { return productOf(env) === 'leagues' ? 'Notre Ligue' : 'SMBHL'; }
const gameLabel = ev => `${ev.date || ''}${ev.start_time ? ' ' + ev.start_time : ''}`.trim();
const nowIso = now => now.toISOString();

// Every settings row under a key prefix. A range, not LIKE: D1 refuses a
// LIKE pattern over 50 bytes, and a league id alone is 36.
export async function settingsWithPrefix(db, prefix, cols = 'key, value') {
  return (await db.prepare(`SELECT ${cols} FROM settings WHERE key >= ? AND key < ?`).bind(prefix, prefix + '￿').all()).results || [];
}

async function getJson(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  if (!row || !row.value) return null;
  try { return JSON.parse(row.value); } catch (_) { return null; }
}
async function putJson(db, key, value) {
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, JSON.stringify(value)).run();
}

/* ---------- 1c: the cron's own heartbeat ---------- */

// Written at the start and the end of every pass. A pass that starts and
// never finishes (a crash, a timeout) leaves finished_at behind started_at.
// schemaBehind: the pass was skipped because the database is missing
// something this deployment expects (schema_guard.js checkSchemaForPass)
// -- a short list of what; since: when that was first seen (kept while
// it stays behind). Cleared by the next pass that runs.
export async function recordHeartbeat(env, phase, { ok = true, error = null, schemaBehind = null } = {}, now = new Date()) {
  const key = `health:cron:${productOf(env)}`;
  const hb = (await getJson(env.DB, key)) || {};
  if (phase === 'start') hb.started_at = nowIso(now);
  else {
    hb.finished_at = nowIso(now); hb.ok = ok; hb.error = error ? String(error).slice(0, 300) : null;
    if (ok) hb.last_ok_at = nowIso(now);
    hb.schema_behind = schemaBehind ? { missing: String(schemaBehind).slice(0, 300), since: (hb.schema_behind && hb.schema_behind.since) || nowIso(now) } : null;
  }
  await putJson(env.DB, key, hb);
  return hb;
}

// Checked on request (the /health endpoint, a league admin's dashboard):
// the cron cannot report that it has stopped, so whoever looks next does.
export async function cronStatus(env, now = new Date()) {
  const product = productOf(env);
  const hb = (await getJson(env.DB, `health:cron:${product}`)) || {};
  const last = hb.last_ok_at ? Date.parse(hb.last_ok_at) : null;
  const ageMin = last == null ? null : Math.round((now.getTime() - last) / 60000);
  return {
    product,
    started_at: hb.started_at || null,
    finished_at: hb.finished_at || null,
    last_ok_at: hb.last_ok_at || null,
    age_minutes: ageMin,
    // Never run at all is not "stale" (a fresh deployment); a run that
    // stopped is.
    stale: ageMin != null && ageMin > CRON_STALE_MINUTES[product],
    last_error: hb.ok === false ? hb.error : null,
    schema_behind: hb.schema_behind || null
  };
}

// An outbound ping per pass for an external dead-man service (a
// healthchecks.io-style URL): if the pings stop, THAT service alerts --
// it does not depend on this Worker running at all.
export async function pingHeartbeatUrl(env, ok) {
  if (!env.HEARTBEAT_URL) return false;
  try {
    await fetch(ok ? env.HEARTBEAT_URL : env.HEARTBEAT_URL.replace(/\/$/, '') + '/fail', { method: 'POST' });
    return true;
  } catch (e) { console.error(`[health] heartbeat ping failed: ${e.message}`); return false; }
}

/* ---------- 1d: the channel that is not email ---------- */

// ALERT_WEBHOOK_URL: ntfy.sh (a push to a phone, no account), Discord, or
// a Slack-style incoming webhook. Plain HTTPS from the Worker to that
// service -- works when Resend is down or the day's cap is spent.
export async function postWebhook(env, title, text) {
  const url = env.ALERT_WEBHOOK_URL;
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    let res;
    if (/ntfy/.test(host)) {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8', Title: encodeURIComponent(title).slice(0, 200), Tags: 'warning' }, body: text.slice(0, 3900) });
    } else if (/discord/.test(host)) {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `**${title}**\n${text}`.slice(0, 1900) }) });
    } else {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `${title}\n${text}`.slice(0, 3900) }) });
    }
    if (!res.ok) throw new Error(`webhook ${res.status}`);
    return true;
  } catch (e) { console.error(`[health] webhook failed: ${e.message}`); return false; }
}

/* ---------- client-side script errors ---------- */

// POST /health/client-error, sent by every page's first script when a
// later one throws (a syntax error kills a whole admin page silently).
export async function recordClientError(env, body, now = new Date()) {
  const path = String(body && body.path || '').slice(0, 120);
  const msg = String(body && body.msg || '').slice(0, 300);
  if (!path.startsWith('/') || !msg) return false;
  const day = now.toISOString().slice(0, 10);
  let h = 0; for (const ch of path + '|' + msg) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const key = `${CLIENT_ERR_PREFIX}${day}:${h.toString(36)}`;
  const existing = await getJson(env.DB, key);
  if (!existing) {
    const n = (await settingsWithPrefix(env.DB, `${CLIENT_ERR_PREFIX}${day}:`, 'key')).length;
    if (n >= MAX_CLIENT_ERR_KEYS_PER_DAY) return false;
  }
  await putJson(env.DB, key, {
    path, msg, src: String(body.src || '').slice(0, 200), line: Number(body.line) || 0,
    count: (existing ? existing.count : 0) + 1, first: existing ? existing.first : nowIso(now), last: nowIso(now)
  });
  return true;
}

// The reporter itself is CLIENT_ERROR_REPORTER (design_system.js), first
// in every page's <head>.

/* ---------- collecting the problems ---------- */

// CPU: this pass runs inside the cron's Workers Free budget (10 ms), so
// it reads in bulk -- a handful of queries for ALL leagues, not several
// per league plus one per game per reminder kind -- and only the games
// whose date can matter (upcoming inside the reminder horizon, or started
// less than a day ago). What it detects is unchanged.
const localDate = ms => localParts(new Date(ms)).date;
async function inChunks(env, sqlFor, ids, size = 90) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) {
    const part = ids.slice(i, i + size);
    out.push(...((await env.DB.prepare(sqlFor(part.map(() => '?').join(','))).bind(...part).all()).results || []));
  }
  return out;
}

// 1b: steps that should have gone out and did not. Evaluated at t0 = the
// grace period ago (or just before the game, if it has started since):
// was the step due then?
async function missedReminders(env, leagues, now) {
  const out = [];
  if (!leagues.length) return out;
  const byId = new Map(leagues.map(l => [l.id, l]));
  // Which leagues are on the advanced model (hasCapability: no row = off).
  const advancedIds = new Set(((await env.DB.prepare(
    "SELECT league_id FROM league_capability_flags WHERE flag_key = 'advanced_reminders' AND enabled = 1"
  ).all()).results || []).map(r => r.league_id).filter(id => byId.has(id)));
  const advancedById = new Map();
  for (const id of advancedIds) {
    if (await usesAdvancedReminders(env, id)) advancedById.set(id, await getEmailSettings(env.DB, id));
  }
  let horizon = Math.max(...Object.values(REMINDER_WINDOW_THRESHOLD_HOURS));
  for (const st of advancedById.values()) for (const kind of Object.keys(REMINDER_WINDOW_THRESHOLD_HOURS)) horizon = Math.max(horizon, advancedStepHours(st, kind));
  const events = ((await env.DB.prepare(
    `SELECT * FROM events WHERE league_id != ? AND state = 'open' AND start_time IS NOT NULL AND auto_reminders_enabled = 1
       AND date >= ? AND date <= ?`
  ).bind(SMBHL_LEAGUE_ID, localDate(now.getTime() - 2 * 86400000), localDate(now.getTime() + (horizon + 24) * 3600000)).all()).results || [])
    .filter(ev => byId.has(ev.league_id));
  const logged = new Set((await inChunks(env, q => `SELECT event_id, kind FROM league_reminder_log WHERE event_id IN (${q})`, events.map(ev => ev.id)))
    .map(r => `${r.event_id}\u0000${r.kind}`));
  for (const ev of events) {
    const leagueRow = byId.get(ev.league_id);
    const advanced = advancedById.get(ev.league_id) || null;
    const start = eventStart(ev);
    if (!start) continue;
    // A day after the game, a missed step is history, not an alert.
    if (now.getTime() - start.getTime() > 24 * 3600000) continue;
    const t0 = new Date(Math.min(now.getTime() - MISSED_GRACE_MINUTES * 60000, start.getTime() - 60000));
    const hoursThen = (start.getTime() - t0.getTime()) / 3600000;
    const partsThen = localParts(t0);
    for (const kind of Object.keys(REMINDER_WINDOW_THRESHOLD_HOURS)) {
      if (!leagueRow[ENABLED_COLUMN[kind]]) continue;
      const hours = advanced ? advancedStepHours(advanced, kind) : REMINDER_WINDOW_THRESHOLD_HOURS[kind];
      const hod = advanced ? advancedStepHourOfDay(advanced, kind) : null;
      if (!cadenceStepDue(hoursThen, hours, hod, partsThen)) continue;
      if (logged.has(`${ev.id}\u0000${kind}`)) continue;
      const k = KIND_LABEL[kind];
      out.push({
        scope: ev.league_id,
        key: `reminder_missed:${ev.id}:${kind}`,
        fr: `Le ${k.fr} du match du ${gameLabel(ev)} aurait dû partir et n'est pas parti.`,
        en: `The ${k.en} for the ${gameLabel(ev)} game should have gone out and has not.`
      });
    }
  }
  return out;
}

// leagueIds: the leagues to report for (a Set). afterStartOnly: SMBHL,
// whose failed and stuck mail deadMan already covers.
async function outboxProblems(env, leagueIds, now, { afterStartOnly = false } = {}) {
  const out = [];
  if (!afterStartOnly) {
    const dayAgo = new Date(now.getTime() - 24 * 3600000).toISOString();
    const hourAgo = new Date(now.getTime() - STUCK_MINUTES * 60000).toISOString();
    const rows = (await env.DB.prepare(
      `SELECT league_id,
              SUM(CASE WHEN failed_at IS NOT NULL AND failed_at >= ? THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN ${OUTBOX_DUE_WHERE} THEN 1 ELSE 0 END) AS stuck
         FROM outbox WHERE failed_at >= ? OR sent_at IS NULL GROUP BY league_id`
    ).bind(dayAgo, hourAgo, hourAgo, dayAgo).all()).results || [];
    for (const r of rows) {
      if (!leagueIds.has(r.league_id)) continue;
      if (r.failed > 0) out.push({
        scope: r.league_id, key: 'outbox_failed',
        fr: `${r.failed > 1 ? `${r.failed} courriels n'ont pas pu être envoyés` : `${r.failed} courriel n'a pas pu être envoyé`} dans les dernières 24 h (adresse refusée ou essais épuisés).`,
        en: `${r.failed} ${r.failed === 1 ? 'email' : 'emails'} could not be sent in the last 24 hours (address rejected or retries used up).`
      });
      if (r.stuck > 0) out.push({
        scope: r.league_id, key: 'outbox_stuck',
        fr: `${r.stuck > 1 ? `${r.stuck} courriels attendent` : `${r.stuck} courriel attend`} depuis plus d'une heure sans partir.`,
        en: `${r.stuck === 1 ? '1 email has' : `${r.stuck} emails have`} been waiting more than an hour without going out.`
      });
    }
  }
  // Pre-game mail scheduled past the game's start: queued before the game,
  // not sent, and not due until after it begins.
  const rows = (await env.DB.prepare(
    `SELECT o.league_id, o.event_id, o.send_after, o.next_attempt_at, o.created_at, e.id AS eid, e.date, e.start_time
       FROM outbox o JOIN events e ON e.id = o.event_id
      WHERE o.sent_at IS NULL AND o.cancelled = 0 AND o.failed_at IS NULL AND e.start_time IS NOT NULL`
  ).all()).results || [];
  const late = new Map();
  for (const r of rows) {
    if (!leagueIds.has(r.league_id)) continue;
    const start = eventStart({ id: r.eid, start_time: r.start_time });
    if (!start || now.getTime() - start.getTime() > 24 * 3600000) continue;
    const sendAt = Math.max(Date.parse(r.send_after) || 0, Date.parse(r.next_attempt_at || '') || 0);
    if (Date.parse(r.created_at) < start.getTime() && sendAt > start.getTime()) {
      const v = late.get(r.eid) || { league: r.league_id, ev: { date: r.date, start_time: r.start_time }, n: 0 };
      v.n++; late.set(r.eid, v);
    }
  }
  for (const [eid, v] of late) out.push({
    scope: v.league,
    key: `outbox_after_start:${eid}`,
    fr: `${v.n > 1 ? `${v.n} courriels pour le match du ${gameLabel(v.ev)} sont prévus` : `${v.n} courriel pour le match du ${gameLabel(v.ev)} est prévu`} après le début du match.`,
    en: `${v.n === 1 ? '1 email' : `${v.n} emails`} for the ${gameLabel(v.ev)} game ${v.n === 1 ? 'is' : 'are'} scheduled to go out after it starts.`
  });
  return out;
}

// failures: [{ leagueId|null, message }] from this pass (the pass records
// what threw instead of letting one league stop the rest).
export async function collectProblems(env, { failures = [] } = {}, now = new Date()) {
  const problems = [];
  const add = (scope, list) => { for (const p of list) problems.push({ scope, ...p }); };
  const addScoped = list => { for (const p of list) problems.push(p); };
  if (productOf(env) === 'leagues') {
    const leagues = (await env.DB.prepare('SELECT * FROM leagues WHERE id != ? AND deactivated_at IS NULL').bind(SMBHL_LEAGUE_ID).all()).results || [];
    try {
      addScoped(await missedReminders(env, leagues, now));
      addScoped(await outboxProblems(env, new Set(leagues.map(l => l.id)), now));
    } catch (e) {
      add('system', [{ key: 'check_failed', fr: `La vérification des ligues a échoué : ${e.message}`, en: `Checking the leagues failed: ${e.message}` }]);
    }
  } else {
    // SMBHL: deadMan already covers its steps, stuck and failed mail.
    addScoped(await outboxProblems(env, new Set([SMBHL_LEAGUE_ID]), now, { afterStartOnly: true }));
  }
  for (const f of failures) {
    const scope = f.leagueId || 'system';
    add(scope, [f.leagueId
      ? { key: 'cron_error', fr: `Le traitement automatique de la ligue a échoué : ${f.message}`, en: `Automatic processing for the league failed: ${f.message}` }
      : { key: 'cron_error', fr: `Le passage du cron a échoué : ${f.message}`, en: `The cron pass failed: ${f.message}` }]);
  }
  const cap = dailyCapFromEnv(env);
  if (cap) {
    const { sent } = await readDailyCount(env.DB, now);
    if (sent >= cap) add('system', [{
      key: `mail_cap:${now.toISOString().slice(0, 10)}`,
      fr: `Limite quotidienne de courriels atteinte (${sent}/${cap}) : les envois attendent minuit UTC.`,
      en: `Daily email cap reached (${sent}/${cap}): sends are waiting for midnight UTC.`
    }]);
  }
  const day = now.toISOString().slice(0, 10);
  const errs = await settingsWithPrefix(env.DB, `${CLIENT_ERR_PREFIX}${day}:`);
  for (const r of errs) {
    let v; try { v = JSON.parse(r.value); } catch (_) { continue; }
    add('system', [{
      key: `client_error:${r.key.slice(CLIENT_ERR_PREFIX.length + 11)}`,
      fr: `Erreur JavaScript sur ${v.path} : ${v.msg} (${v.count} fois aujourd'hui)`,
      en: `JavaScript error on ${v.path}: ${v.msg} (${v.count} times today)`
    }]);
  }
  return problems;
}

/* ---------- alert state ---------- */

const alertKey = (scope, key) => `${ALERT_PREFIX}${scope}:${key}`;

// Opens new problems, reopens ones that came back, closes ones that are
// gone. Returns the problems nobody has been told about yet.
export async function reconcileAlerts(env, problems, now = new Date()) {
  const current = new Set(problems.map(p => alertKey(p.scope, p.key)));
  const stored = await settingsWithPrefix(env.DB, ALERT_PREFIX);
  const byKey = new Map();
  for (const r of stored) { try { byKey.set(r.key, JSON.parse(r.value)); } catch (_) {} }
  for (const p of problems) {
    const k = alertKey(p.scope, p.key);
    const prev = byKey.get(k);
    if (!prev || prev.resolved_at) {
      byKey.set(k, { scope: p.scope, key: p.key, fr: p.fr, en: p.en, first_seen: nowIso(now), last_seen: nowIso(now), resolved_at: null, ops_notified_at: null, admin_notified_at: null });
    } else {
      Object.assign(prev, { fr: p.fr, en: p.en, last_seen: nowIso(now) });
    }
    await putJson(env.DB, k, byKey.get(k));
  }
  for (const [k, v] of byKey) {
    if (current.has(k)) continue;
    if (!v.resolved_at) { v.resolved_at = nowIso(now); await putJson(env.DB, k, v); }
    else if (now.getTime() - Date.parse(v.resolved_at) > 7 * 24 * 3600000) {
      await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(k).run();
    }
  }
  return [...byKey.entries()].filter(([k, v]) => current.has(k)).map(([k, v]) => ({ storeKey: k, ...v }));
}

// A league's open alerts (its dashboard banner).
export async function openAlertsForLeague(env, leagueId) {
  const rows = await settingsWithPrefix(env.DB, `${ALERT_PREFIX}${leagueId}:`);
  return rows.map(r => { try { return JSON.parse(r.value); } catch (_) { return null; } }).filter(a => a && !a.resolved_at);
}

/* ---------- telling people ---------- */

// Alert emails come out of the same daily cap as players' mail, so they
// get a small share of it: never more than a third, at most 8.
export function healthEmailAllowance(env) {
  const cap = dailyCapFromEnv(env);
  return cap ? Math.max(1, Math.min(8, Math.floor(cap / 3))) : 8;
}
async function takeEmailAllowance(env, now) {
  const key = `health:emails:${now.toISOString().slice(0, 10)}`;
  const used = Number((await getJson(env.DB, key)) || 0);
  if (used >= healthEmailAllowance(env)) return false;
  await putJson(env.DB, key, used + 1);
  return true;
}

const leagueName = (names, scope) => scope === 'system' ? 'Système / System' : (names.get(scope) || scope);

// host: { sendMail, leagueAdminEmails, opsEmail, publicUrl, renderAdminAlert }
export async function notifyAlerts(env, host, alerts, now = new Date()) {
  const log = [];
  const pendingOps = alerts.filter(a => !a.ops_notified_at);
  const pendingAdmin = alerts.filter(a => !a.admin_notified_at && a.scope !== 'system' && a.scope !== SMBHL_LEAGUE_ID);
  const names = new Map();
  for (const id of new Set(alerts.map(a => a.scope))) {
    if (id === 'system') continue;
    const row = await env.DB.prepare('SELECT name FROM leagues WHERE id = ?').bind(id).first();
    if (row) names.set(id, row.name);
  }
  const markAll = async (list, field) => {
    for (const a of list) { a[field] = nowIso(now); await putJson(env.DB, a.storeKey, (({ storeKey, ...rest }) => rest)(a)); }
  };

  if (pendingOps.length) {
    const lines = pendingOps.map(a => `- [${leagueName(names, a.scope)}] ${a.fr}`).join('\n');
    const linesEn = pendingOps.map(a => `- [${leagueName(names, a.scope)}] ${a.en}`).join('\n');
    const title = `${productName(env)} : ${pendingOps.length} ${pendingOps.length > 1 ? 'alertes' : 'alerte'} / ${pendingOps.length === 1 ? 'alert' : 'alerts'}`;
    const body = `${lines}\n\n---\n\n${linesEn}\n\n${host.publicUrl || ''}/health/status`;
    // The channel that does not go through Resend first.
    const hooked = await postWebhook(env, title, body);
    let mailed = false;
    if (await takeEmailAllowance(env, now)) {
      try { await host.sendMail(env, host.opsEmail, title, body); mailed = true; }
      catch (e) { mailed = !!(e && e.deferred); if (!mailed) console.error(`[health] ops email failed: ${e.message}`); }
    }
    if (hooked || mailed) { await markAll(pendingOps, 'ops_notified_at'); log.push(`ops told: ${pendingOps.length} (${[hooked && 'webhook', mailed && 'email'].filter(Boolean).join('+')})`); }
    else log.push(`ops NOT told yet: ${pendingOps.length} (will retry)`);
  }

  // Each league's admins, about their own league only.
  const byLeague = new Map();
  for (const a of pendingAdmin) { if (!byLeague.has(a.scope)) byLeague.set(a.scope, []); byLeague.get(a.scope).push(a); }
  let sentThisPass = 0;
  for (const [leagueId, list] of byLeague) {
    if (sentThisPass >= MAX_ADMIN_EMAILS_PER_PASS) break;
    const admins = await host.leagueAdminEmails(env, leagueId);
    if (!admins.length) { await markAll(list, 'admin_notified_at'); continue; } // the banner still shows it
    const leagueRow = await env.DB.prepare('SELECT name, color, language_mode FROM leagues WHERE id = ?').bind(leagueId).first();
    const mail = host.renderAdminAlert(leagueRow || { name: leagueId }, list);
    let told = false;
    for (const admin of admins) {
      if (sentThisPass >= MAX_ADMIN_EMAILS_PER_PASS || !(await takeEmailAllowance(env, now))) break;
      try { await host.sendMail(env, admin.email, mail.subject, mail.text, mail.html); told = true; }
      catch (e) { if (e && e.deferred) told = true; else console.error(`[health] admin alert to ${admin.email} failed: ${e.message}`); }
      sentThisPass++;
    }
    if (told) { await markAll(list, 'admin_notified_at'); log.push(`${leagueId} admins told: ${list.length}`); }
  }
  return log;
}

// The whole pass: collect, reconcile, tell. The first pass ever (nothing
// recorded yet) takes what is already wrong as the baseline -- one summary
// to the operator, no email to every league's admins about old problems.
export async function runHealthPass(env, host, { failures = [] } = {}, now = new Date()) {
  const problems = await collectProblems(env, { failures }, now);
  const baselined = await getJson(env.DB, 'health:baseline');
  const alerts = await reconcileAlerts(env, problems, now);
  if (!baselined) {
    await putJson(env.DB, 'health:baseline', nowIso(now));
    for (const a of alerts) { a.admin_notified_at = nowIso(now); await putJson(env.DB, a.storeKey, (({ storeKey, ...rest }) => rest)(a)); }
  }
  const log = await notifyAlerts(env, host, alerts, now);
  return { problems, log };
}

// On request: if the cron has gone quiet, tell the operator (at most once
// an hour) -- by webhook, and by email if email still works. Returns the
// status for the caller's banner or response.
export async function checkCronOnRequest(env, host, now = new Date()) {
  const status = await cronStatus(env, now);
  if (!status.stale) return status;
  const key = `health:stale_alerted:${status.product}`;
  const last = await getJson(env.DB, key);
  if (last && now.getTime() - Date.parse(last) < 3600000) return status;
  await putJson(env.DB, key, nowIso(now));
  const title = `${productName(env)} : cron ${status.product} arrêté / stopped`;
  const text = `Le cron ne roule plus : dernier passage réussi il y a ${status.age_minutes} min.\n\nThe cron has stopped: last successful pass ${status.age_minutes} min ago.`;
  await postWebhook(env, title, text);
  try { await host.sendMail(env, host.opsEmail, title, text); } catch (e) { console.error(`[health] stale-cron email failed: ${e.message}`); }
  return status;
}

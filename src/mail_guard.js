// Notre Ligue's sending guard (caps batch, items 1 and 2): the daily limit
// of free leagues, and five rules that catch a mistake before it floods
// anyone. Notre Ligue only (LEAGUE_PRODUCT): SMBHL never reaches any of it.
//
// Item 1b, free leagues (billing state free or grace): at most
// FREE_DAILY_CAP emails a Montreal day to players and subs. The rest wait
// for the next day (defer_reason 'free_cap'), and the ones that would be
// pointless by then are cancelled (index.js drain: a reminder or sub call
// for a game that has started, a sub call past its cutoff).
//
// Item 2, the rules. When one trips, the sending it concerns is paused,
// Roberto gets an alert at once through the existing webhook (league,
// rule, numbers, never an address), and the super-admin list shows the
// pause with Release and Cancel. Held emails stay queued (defer_reason
// 'held:<scope>') until one of the two.
//   2a  the same email (kind, game or event, person, content) already sent
//       in the last 24 hours: blocked, never sent or queued. More than
//       LOOP_BLOCKS_PER_HOUR blocks in an hour for one league is a loop:
//       that league is paused.
//   2b  more than ADDRESS_MAX_PER_HOUR emails to one player or sub in an
//       hour: the rest for that address are held.
//   2c  a league far above its normal: a Montreal day over LEAGUE_DAY_MIN
//       emails and over LEAGUE_DAY_FACTOR times its 14-day daily average,
//       also over LEAGUE_PEAK_FACTOR times its busiest day of the last 35
//       days, with LEAGUE_MIN_HISTORY_DAYS of sending behind it (decision:
//       the plain rule paused SMBHL-sized leagues every week; see the
//       report). That league is paused.
//   2d  everything at once: more than GLOBAL_HOUR_MAX emails in an hour or
//       GLOBAL_DAY_MAX in a day across all leagues: player and sub mail is
//       paused everywhere.
//   2e  bounces: more than BOUNCE_SHARE of a day's emails bounced, with at
//       least BOUNCE_MIN_SENT sent. Alert only.
// Never capped, held or paused (item 1e): billing notices, the operator's
// digest and alerts, and every direct send made without a league (sign-up,
// password reset, invitations): index.js sendMail guards a direct send only
// when its caller names the league.
//
// State lives in `settings` (no migration): counters per league and day,
// per 10 minutes, per address; the pauses; the trips, for the digest.
import { montrealDate, addDays } from './montreal_time.js';
import { loadLeagueState } from './billing.js';
import { postWebhook } from './health.js';
import { maskEmail } from './contact_name.js';
import { SMBHL_LEAGUE_ID } from './league_ids.js';
import { pluralText } from './plural.js';
import { isBounceError } from './bounces.js';

export const FREE_DAILY_CAP = 25;
export const ADDRESS_MAX_PER_HOUR = 5;
export const LEAGUE_DAY_MIN = 50;
export const LEAGUE_DAY_FACTOR = 3;
export const LEAGUE_PEAK_FACTOR = 2;
export const LEAGUE_PEAK_DAYS = 35;
export const LEAGUE_MIN_HISTORY_DAYS = 7;
export const GLOBAL_HOUR_MAX = 300;
export const GLOBAL_DAY_MAX = 2000;
export const BOUNCE_SHARE = 0.10;
export const BOUNCE_MIN_SENT = 20;
export const LOOP_BLOCKS_PER_HOUR = 5;
export const DUPLICATE_WINDOW_HOURS = 24;
export const MONTHLY_INCLUDED = 3000;
// A released scope is not re-tripped by the same rule for this long, so the
// emails just released can go out.
export const RELEASE_GRACE_MINUTES = 120;
export const HELD_UNTIL = '9999-12-31T00:00:00.000Z';
export const FREE_CAP_REASON = 'free_cap';
export const ESSENTIAL_KINDS = new Set(['billing_notice', 'ops_digest']);
const HOUR = 3600000;

export const guardOn = env => !!(env && env.LEAGUE_PRODUCT === 'true' && env.DB);
const isLeague = id => !!id && id !== 'system' && id !== SMBHL_LEAGUE_ID;

// ---------------------------------------------------------------- settings
async function getVal(db, key) {
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return r ? r.value : null;
}
// league_id: the league's own keys carry it (a league's deletion removes
// them); the others take the column's default, as putSetting does.
async function putVal(db, key, value, leagueId = null) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  if (leagueId) await db.prepare('INSERT INTO settings (key, value, league_id) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, v, leagueId).run();
  else await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, v).run();
}
async function incr(db, key, leagueId = null) {
  const bump = 'ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)';
  if (leagueId) await db.prepare(`INSERT INTO settings (key, value, league_id) VALUES (?, '1', ?) ${bump}`).bind(key, leagueId).run();
  else await db.prepare(`INSERT INTO settings (key, value) VALUES (?, '1') ${bump}`).bind(key).run();
}
const num = v => Number(v) || 0;
const json = v => { try { return JSON.parse(v); } catch (_) { return null; } };

async function sha(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}
export const addressKey = address => sha(String(address || '').trim().toLowerCase());

// ---------------------------------------------------------------- keys
const k = {
  vol: (league, day) => `mail:vol:${league}:${day}`,
  volp: (league, day) => `mail:volp:${league}:${day}`,
  gday: day => `mail:gday:${day}`,
  g10: ms => `mail:g10:${new Date(Math.floor(ms / 600000) * 600000).toISOString().slice(0, 15)}`,
  addr: h => `mail:addr:${h}`,
  dup: h => `mail:dup:${h}`,
  blocks: (league, ms) => `mail:blocks:${league}:${new Date(ms).toISOString().slice(0, 13)}`,
  pause: scope => `mail:pause:${scope}`,
  release: scope => `mail:release:${scope}`,
  trips: 'mail:trips',
  bounceAlert: day => `mail:bounce-alert:${day}`,
  crossed: month => `mail:usage-crossed:${month}`
};
export const heldReason = scope => `held:${scope}`;

// ---------------------------------------------------------------- the rules' words
export const RULES = {
  '2a': { fr: 'Même courriel en boucle', en: 'Same email in a loop' },
  '2b': { fr: 'Une personne inondée', en: 'One person flooded' },
  '2c': { fr: 'Ligue bien au-dessus de sa normale', en: 'League far above its normal' },
  '2d': { fr: 'Trop de courriels d\'un coup', en: 'Everything at once' },
  '2e': { fr: 'Rebonds en hausse', en: 'Bounces spiking' }
};
// The numbers of a trip, in words. Pure.
export function tripNumbers(rule, n, lang) {
  const fr = lang !== 'en';
  const p = (t, vars) => pluralText(t, vars, fr ? 'fr' : 'en');
  if (rule === '2a') return p(fr ? '{n|# courriel en double bloqué|# courriels en double bloqués} en une heure' : '{n|# duplicate email blocked|# duplicate emails blocked} in an hour', { n: n.blocks });
  if (rule === '2b') return p(fr ? '{n|# courriel|# courriels} à la même personne en une heure' : '{n|# email|# emails} to one person in an hour', { n: n.count });
  if (rule === '2c') return p(fr ? '{n|# courriel|# courriels} aujourd\'hui, moyenne de {avg} par jour sur 14 jours' : '{n|# email|# emails} today, average of {avg} a day over 14 days', { n: n.today, avg: fr ? String(n.avg).replace('.', ',') : String(n.avg) });
  if (rule === '2d') return n.hour != null
    ? p(fr ? '{n|# courriel|# courriels} dans la dernière heure' : '{n|# email|# emails} in the last hour', { n: n.hour })
    : p(fr ? '{n|# courriel|# courriels} aujourd\'hui' : '{n|# email|# emails} today', { n: n.day });
  if (rule === '2e') {
    const pct = Math.round(100 * n.bounced / Math.max(1, n.sent));
    return p(fr ? '{b|# rebond|# rebonds} sur {n|# courriel|# courriels} aujourd\'hui ({pct} %)' : '{b|# bounce|# bounces} out of {n|# email|# emails} today ({pct}%)', { b: n.bounced, n: n.sent, pct });
  }
  return '';
}

// ---------------------------------------------------------------- pauses
export async function getPause(db, scope) { return json(await getVal(db, k.pause(scope))); }
async function inGrace(db, scope, now) {
  const v = await getVal(db, k.release(scope));
  return !!(v && Date.parse(v) > now.getTime());
}
async function leagueName(db, leagueId) {
  if (!leagueId) return '';
  const r = await db.prepare('SELECT name FROM leagues WHERE id = ?').bind(leagueId).first();
  return r ? r.name : leagueId;
}
async function logTrip(db, trip) {
  const list = json(await getVal(db, k.trips)) || [];
  list.push(trip);
  await putVal(db, k.trips, list.slice(-200));
}
async function alert(env, trip, paused) {
  const scopeFr = trip.scope === 'global' ? 'toutes les ligues' : trip.leagueName;
  const scopeEn = trip.scope === 'global' ? 'all leagues' : trip.leagueName;
  const base = env.PUBLIC_URL || '';
  const title = paused
    ? `Notre Ligue : envois en pause / sending paused (${RULES[trip.rule].en})`
    : `Notre Ligue : ${RULES[trip.rule].fr.toLowerCase()} / ${RULES[trip.rule].en.toLowerCase()}`;
  const fr = `[${scopeFr}] ${RULES[trip.rule].fr} : ${tripNumbers(trip.rule, trip.numbers, 'fr')}.${paused ? ' Les courriels concernés sont retenus.' : ''}`;
  const en = `[${scopeEn}] ${RULES[trip.rule].en}: ${tripNumbers(trip.rule, trip.numbers, 'en')}.${paused ? ' The emails concerned are held.' : ''}`;
  const more = paused ? `\n\n${base}/super-admin/leagues` : '';
  await postWebhook(env, title, `${fr}\n\n---\n\n${en}${more}`);
}

// Pauses a scope (once) and tells Roberto. scope: 'global', 'league:<id>',
// 'addr:<hash>'.
export async function trip(env, { scope, rule, leagueId = null, address = null, numbers = {} }, now = new Date()) {
  const db = env.DB;
  if (await getPause(db, scope)) return false;
  const t = { scope, rule, leagueId, leagueName: await leagueName(db, leagueId), masked: address ? maskEmail(address) : null, numbers, since: now.toISOString() };
  await putVal(db, k.pause(scope), t, isLeague(leagueId) ? leagueId : null);
  await logTrip(db, t);
  await alert(env, t, true);
  return true;
}

// Release: the pause goes, the held emails are due again, and the same
// rule leaves this scope alone for RELEASE_GRACE_MINUTES.
export async function releaseScope(env, scope, now = new Date()) {
  const db = env.DB;
  const p = await getPause(db, scope);
  await db.prepare('DELETE FROM settings WHERE key = ?').bind(k.pause(scope)).run();
  await putVal(db, k.release(scope), new Date(now.getTime() + RELEASE_GRACE_MINUTES * 60000).toISOString(), p && isLeague(p.leagueId) ? p.leagueId : null);
  const r = await db.prepare(
    `UPDATE outbox SET next_attempt_at = NULL, defer_reason = NULL WHERE defer_reason = ? AND sent_at IS NULL AND cancelled = 0`
  ).bind(heldReason(scope)).run();
  return (r && r.meta && r.meta.changes) || 0;
}
// Cancel the held emails; the pause stays until released.
export async function cancelScope(env, scope) {
  const r = await env.DB.prepare(
    `UPDATE outbox SET cancelled = 1, error = 'cancelled by the operator while held', next_attempt_at = NULL WHERE defer_reason = ? AND sent_at IS NULL AND cancelled = 0`
  ).bind(heldReason(scope)).run();
  return (r && r.meta && r.meta.changes) || 0;
}
export async function listPauses(env) {
  const rows = (await env.DB.prepare("SELECT key, value FROM settings WHERE substr(key, 1, 11) = 'mail:pause:' ORDER BY key").all()).results || [];
  const out = [];
  for (const r of rows) {
    const p = json(r.value);
    if (!p) continue;
    const held = await env.DB.prepare('SELECT COUNT(*) n FROM outbox WHERE defer_reason = ? AND sent_at IS NULL AND cancelled = 0').bind(heldReason(p.scope)).first();
    out.push({ scope: p.scope, rule: p.rule, leagueId: p.leagueId, leagueName: p.leagueName, masked: p.masked, numbers: p.numbers, since: p.since, held: held ? held.n : 0 });
  }
  return out;
}

// ---------------------------------------------------------------- counting
// After every email accepted for sending (index.js sendMail).
export async function recordSend(env, { leagueId = null, toPlayer = false, address = null, dupKey = null }, now = new Date()) {
  if (!guardOn(env)) return;
  const db = env.DB;
  const day = montrealDate(now);
  const lid = isLeague(leagueId) ? leagueId : null;
  await incr(db, k.gday(day));
  await incr(db, k.g10(now.getTime()));
  if (lid) {
    await incr(db, k.vol(lid, day), lid);
    if (toPlayer) await incr(db, k.volp(lid, day), lid);
  }
  if (toPlayer && address) {
    const h = await addressKey(address);
    const list = (json(await getVal(db, k.addr(h))) || []).filter(t => t > now.getTime() - HOUR);
    list.push(now.getTime());
    await putVal(db, k.addr(h), list, lid);
  }
  if (dupKey) await putVal(db, k.dup(dupKey), now.toISOString(), lid);
}

// The key of "the same email" (rule 2a).
export async function duplicateKey({ kind, eventId, address, subject, text }) {
  return sha([kind || '', eventId || '', String(address || '').toLowerCase(), subject || '', text || ''].join('\u0000'));
}

async function leagueHistory(db, leagueId, today) {
  const from = addDays(today, -LEAGUE_PEAK_DAYS);
  const rows = (await db.prepare('SELECT key, value FROM settings WHERE key >= ? AND key < ?')
    .bind(k.vol(leagueId, from), k.vol(leagueId, today)).all()).results || [];
  const byDay = new Map(rows.map(r => [r.key.slice(r.key.lastIndexOf(':') + 1), num(r.value)]));
  let sum14 = 0, peak = 0, days = 0;
  for (const [d, n] of byDay) {
    if (d >= addDays(today, -14)) sum14 += n;
    peak = Math.max(peak, n);
    if (n > 0) days++;
  }
  return { avg14: Math.round(sum14 / 14 * 10) / 10, peak, days };
}

// ---------------------------------------------------------------- the check
// Before one email goes out. ctx: { leagueId, kind, eventId, address,
// toPlayer, subject, text, essential, cache (a Map, per drain) }.
// Returns { action: 'send', dupKey } | { action: 'block', reason } |
// { action: 'hold', scope, reason } | { action: 'defer', reason: 'free_cap' }.
export async function checkSend(env, ctx, now = new Date()) {
  if (!guardOn(env) || ctx.essential || ESSENTIAL_KINDS.has(ctx.kind)) return { action: 'send', dupKey: null };
  const db = env.DB;
  const lid = isLeague(ctx.leagueId) ? ctx.leagueId : null;
  const day = montrealDate(now);

  // 2a: the same email again.
  const dupKey = await duplicateKey(ctx);
  const seen = await getVal(db, k.dup(dupKey));
  if (seen && Date.parse(seen) > now.getTime() - DUPLICATE_WINDOW_HOURS * HOUR) {
    if (lid) {
      const bk = k.blocks(lid, now.getTime());
      await incr(db, bk, lid);
      const blocks = num(await getVal(db, bk));
      if (blocks > LOOP_BLOCKS_PER_HOUR && !(await inGrace(db, `league:${lid}`, now))) await trip(env, { scope: `league:${lid}`, rule: '2a', leagueId: lid, numbers: { blocks } }, now);
    }
    return { action: 'block', reason: 'the same email was already sent (rule 2a)' };
  }

  // Standing pauses.
  if (ctx.toPlayer && await getPause(db, 'global')) return { action: 'hold', scope: 'global' };
  if (lid && await getPause(db, `league:${lid}`)) return { action: 'hold', scope: `league:${lid}` };
  const h = ctx.toPlayer && ctx.address ? await addressKey(ctx.address) : null;
  if (h && await getPause(db, `addr:${h}`)) return { action: 'hold', scope: `addr:${h}` };

  // 2d: everything at once (player and sub mail).
  if (ctx.toPlayer && !(await inGrace(db, 'global', now))) {
    let hour = 0;
    for (let i = 0; i < 6; i++) hour += num(await getVal(db, k.g10(now.getTime() - i * 600000)));
    const dayCount = num(await getVal(db, k.gday(day)));
    if (hour + 1 > GLOBAL_HOUR_MAX || dayCount + 1 > GLOBAL_DAY_MAX) {
      await trip(env, { scope: 'global', rule: '2d', numbers: hour + 1 > GLOBAL_HOUR_MAX ? { hour: hour + 1 } : { day: dayCount + 1 } }, now);
      return { action: 'hold', scope: 'global' };
    }
  }

  // 2c: a league far above its normal.
  if (lid) {
    const today = num(await getVal(db, k.vol(lid, day)));
    if (today + 1 > LEAGUE_DAY_MIN && !(await inGrace(db, `league:${lid}`, now))) {
      const hist = await leagueHistory(db, lid, day);
      if (hist.days >= LEAGUE_MIN_HISTORY_DAYS && today + 1 > LEAGUE_DAY_FACTOR * hist.avg14 && today + 1 > LEAGUE_PEAK_FACTOR * hist.peak) {
        await trip(env, { scope: `league:${lid}`, rule: '2c', leagueId: lid, numbers: { today: today + 1, avg: hist.avg14, peak: hist.peak } }, now);
        return { action: 'hold', scope: `league:${lid}` };
      }
    }
  }

  // 2b: one person flooded.
  if (h && !(await inGrace(db, `addr:${h}`, now))) {
    const recent = (json(await getVal(db, k.addr(h))) || []).filter(t => t > now.getTime() - HOUR);
    if (recent.length + 1 > ADDRESS_MAX_PER_HOUR) {
      await trip(env, { scope: `addr:${h}`, rule: '2b', leagueId: lid, address: ctx.address, numbers: { count: recent.length + 1 } }, now);
      return { action: 'hold', scope: `addr:${h}` };
    }
  }

  // 1b: a free league's daily limit (players and subs).
  if (lid && ctx.toPlayer && await isFreeLeague(env, lid, ctx.cache, now)) {
    const sentToPlayers = num(await getVal(db, k.volp(lid, day)));
    if (sentToPlayers >= FREE_DAILY_CAP) return { action: 'defer', reason: FREE_CAP_REASON };
  }
  return { action: 'send', dupKey };
}

// Free (the free slot, or under 15 and free-eligible) or in its grace.
export async function isFreeLeague(env, leagueId, cache = null, now = new Date()) {
  if (cache && cache.has(`free:${leagueId}`)) return cache.get(`free:${leagueId}`);
  let free = false;
  try {
    const st = await loadLeagueState(env, leagueId, now);
    free = !!(st && (st.status === 'free' || st.status === 'grace'));
  } catch (e) { console.error(`[mail-guard] billing state for ${leagueId}: ${e.message}`); }
  if (cache) cache.set(`free:${leagueId}`, free);
  return free;
}

// ---------------------------------------------------------------- 1c
export async function freeCapHeldCount(env, leagueId) {
  const r = await env.DB.prepare('SELECT COUNT(*) n FROM outbox WHERE league_id = ? AND defer_reason = ? AND sent_at IS NULL AND cancelled = 0')
    .bind(leagueId, FREE_CAP_REASON).first();
  return r ? r.n : 0;
}
export async function cancelFreeCapHeld(env, leagueId) {
  const r = await env.DB.prepare(
    `UPDATE outbox SET cancelled = 1, error = 'not sent: the admin chose not to send it after the daily limit', next_attempt_at = NULL
      WHERE league_id = ? AND defer_reason = ? AND sent_at IS NULL AND cancelled = 0`
  ).bind(leagueId, FREE_CAP_REASON).run();
  return (r && r.meta && r.meta.changes) || 0;
}

// ---------------------------------------------------------------- 2e
// Once per Montreal day at most, from the cron: permanent failures that are
// bounces (an address refused) against the day's sends.
export async function checkBounces(env, now = new Date(), dayStartIso = null) {
  if (!guardOn(env)) return null;
  const db = env.DB;
  const day = montrealDate(now);
  if (await getVal(db, k.bounceAlert(day))) return null;
  const sent = num(await getVal(db, k.gday(day)));
  if (sent < BOUNCE_MIN_SENT) return null;
  const from = dayStartIso || new Date(now.getTime() - 24 * HOUR).toISOString();
  const rows = (await db.prepare('SELECT error FROM outbox WHERE failed_at IS NOT NULL AND failed_at >= ?').bind(from).all()).results || [];
  const bounced = rows.filter(r => isBounceError(r.error)).length;
  if (bounced <= BOUNCE_SHARE * (sent + bounced)) return null;
  const t = { scope: 'global', rule: '2e', leagueId: null, leagueName: '', numbers: { bounced, sent: sent + bounced }, since: now.toISOString() };
  await putVal(db, k.bounceAlert(day), now.toISOString());
  await logTrip(db, t);
  await alert(env, t, false);
  return t;
}

// ---------------------------------------------------------------- item 3
// The month's emails across Notre Ligue (Montreal days), the three busiest
// leagues, and whether the month just crossed MONTHLY_INCLUDED (once).
export async function monthUsage(env, now = new Date()) {
  const db = env.DB;
  const month = montrealDate(now).slice(0, 7);
  const g = (await db.prepare('SELECT value FROM settings WHERE key >= ? AND key < ?').bind(`mail:gday:${month}-`, `mail:gday:${month}-~`).all()).results || [];
  const sent = g.reduce((a, r) => a + num(r.value), 0);
  const v = (await db.prepare("SELECT key, value FROM settings WHERE substr(key, 1, 9) = 'mail:vol:' AND substr(key, -10, 7) = ?").bind(month).all()).results || [];
  const per = new Map();
  for (const r of v) { const id = r.key.slice(9, r.key.lastIndexOf(':')); per.set(id, (per.get(id) || 0) + num(r.value)); }
  const top = [];
  for (const [id, n] of [...per].sort((a, b) => b[1] - a[1]).slice(0, 3)) top.push({ id, name: await leagueName(db, id), n });
  const over = sent > MONTHLY_INCLUDED;
  let crossedNow = false;
  if (over && !(await getVal(db, k.crossed(month)))) { crossedNow = true; }
  return { month, sent, top, over, crossedNow };
}
export async function markCrossed(env, month, now = new Date()) { await putVal(env.DB, k.crossed(month), now.toISOString()); }
export async function tripsSince(env, sinceIso) {
  const list = json(await getVal(env.DB, k.trips)) || [];
  return list.filter(t => !sinceIso || t.since > sinceIso);
}

// ---------------------------------------------------------------- upkeep
// Counters older than LEAGUE_PEAK_DAYS + 10 days, address lists and
// duplicate keys older than two days. From the daily health run.
export async function pruneGuardState(env, now = new Date()) {
  if (!guardOn(env)) return;
  const db = env.DB;
  const oldDay = addDays(montrealDate(now), -(LEAGUE_PEAK_DAYS + 10));
  const rows = (await db.prepare("SELECT key, value FROM settings WHERE substr(key, 1, 5) = 'mail:'").all()).results || [];
  const cutoffIso = new Date(now.getTime() - 48 * HOUR).toISOString();
  for (const r of rows) {
    let drop = false;
    const m = r.key.match(/^mail:(vol|volp|gday):(?:.*:)?(\d{4}-\d{2}-\d{2})$/);
    if (m) drop = m[2] < oldDay;
    else if (/^mail:g10:/.test(r.key)) drop = r.key.slice(9) < cutoffIso.slice(0, 15);
    else if (/^mail:blocks:/.test(r.key)) drop = r.key.slice(-13) < cutoffIso.slice(0, 13);
    else if (/^mail:dup:/.test(r.key)) drop = String(r.value) < cutoffIso;
    else if (/^mail:addr:/.test(r.key)) drop = !(json(r.value) || []).some(t => t > now.getTime() - HOUR);
    else if (/^mail:release:/.test(r.key)) drop = Date.parse(r.value) < now.getTime();
    else if (/^mail:bounce-alert:/.test(r.key)) drop = r.key.slice(-10) < oldDay;
    if (drop) await db.prepare('DELETE FROM settings WHERE key = ?').bind(r.key).run();
  }
}

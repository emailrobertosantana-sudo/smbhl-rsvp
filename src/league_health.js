// Notre Ligue: each league's health, for the super-admin (stage 2).
//
// A traffic light per league, from rules kept as data (HEALTH_RULES):
//   green   active: an admin signed in within 7 days, a game in the last 7
//           or the next 14 days, at least half of the invitations of the
//           last 14 days answered;
//   yellow  at risk: one of those slipping, or the trial ending within 7
//           days without a subscription, or failed or bounced emails in
//           the last 7 days;
//   red     stalled: setup not finished 7 days after sign-up (no players or
//           no games), no admin sign-in for 21 days, or a failed payment.
//
// Computed once a day by the Notre Ligue cron (runDailyLeagueHealth) and
// stored in the settings table, no migration:
//   league_health:<league id>      the light, each rule's result, the
//                                  numbers behind them (league_id set, so a
//                                  hard delete removes it)
//   league_milestones:<league id>  the trial timeline's dates the database
//                                  does not keep (first player, first game,
//                                  subscribed): the day the check first saw them
//   admin_seen:<league id>         the last day an admin used the league's
//                                  pages while signed in (recordAdminSeen):
//                                  a session lasts 30 days, so the sign-in
//                                  date alone (users.last_login_at) would
//                                  make an active league look abandoned
//   league_health:day              the day (league time) of the last run
//
// Nothing here sends mail or writes a log line. SMBHL is never included.
import { SMBHL_LEAGUE_ID, localParts } from './league_ids.js';
import { billingSummaries } from './billing.js';
import { dayDiff, lastDayBefore } from './montreal_time.js';
import { maskEmail } from './contact_name.js';

const DAY_MS = 86400000;
export const HEALTH_PREFIX = 'league_health:';
export const healthKey = id => `${HEALTH_PREFIX}${id}`;
export const HEALTH_DAY_KEY = 'league_health:day';
export const milestonesKey = id => `league_milestones:${id}`;
export const adminSeenKey = id => `admin_seen:${id}`;
// The daily run waits for this hour, league time (America/Toronto), so the
// day's numbers and the digest come in the morning.
export const DAILY_HOUR = 7;
// What counts as an invitation: the asks that a player answers.
export const ASK_KINDS = ['reminder_72h', 'reminder_24h', 'sub_call'];
export const LIGHTS = ['red', 'yellow', 'green'];

// The rules, in the order the league page lists them. level: the light a
// broken rule gives. ok(m): the rule holds for the league's numbers m.
// Stage 3 and later can add rules here without touching the computation.
export const HEALTH_RULES = [
  { key: 'admin_signin_7', level: 'yellow',
    fr: "Un admin s'est connecté dans les 7 derniers jours.",
    en: 'An admin signed in within the last 7 days.',
    ok: m => m.signInDays <= 7 },
  { key: 'game_window', level: 'yellow',
    fr: 'Un match dans les 7 derniers jours ou les 14 prochains.',
    en: 'A game in the last 7 days or the next 14 days.',
    ok: m => m.gameInWindow },
  { key: 'answers_half', level: 'yellow',
    fr: 'Au moins la moitié des invitations des 14 derniers jours ont une réponse.',
    en: 'At least half of the invitations of the last 14 days were answered.',
    ok: m => m.invitations14 === 0 || m.answered14 * 2 >= m.invitations14 },
  { key: 'trial_not_ending', level: 'yellow',
    fr: "L'essai ne finit pas dans les 7 prochains jours sans abonnement.",
    en: 'The trial does not end within the next 7 days without a subscription.',
    ok: m => !m.trialEndingNoSub },
  { key: 'mail_ok', level: 'yellow',
    fr: 'Aucun courriel en échec ou refusé dans les 7 derniers jours.',
    en: 'No failed or bounced email in the last 7 days.',
    ok: m => m.mailFailures7 === 0 },
  { key: 'setup_done', level: 'red',
    fr: "Configuration terminée 7 jours après l'inscription : des joueurs et des matchs.",
    en: 'Setup finished 7 days after sign-up: players and games.',
    ok: m => m.ageDays < 7 || (m.players > 0 && m.games > 0) },
  { key: 'admin_signin_21', level: 'red',
    fr: "Un admin s'est connecté dans les 21 derniers jours.",
    en: 'An admin signed in within the last 21 days.',
    ok: m => m.signInDays <= 21 },
  { key: 'payment_ok', level: 'red',
    fr: 'Aucun paiement en échec.',
    en: 'No failed payment.',
    ok: m => !m.paymentFailed }
];

// The light and each rule's result, for one league's numbers. Pure.
export function evaluateHealth(m) {
  const signals = HEALTH_RULES.map(r => ({ key: r.key, level: r.level, ok: !!r.ok(m) }));
  const light = signals.some(s => !s.ok && s.level === 'red') ? 'red'
    : signals.some(s => !s.ok && s.level === 'yellow') ? 'yellow' : 'green';
  return { light, signals };
}

const iso = d => d.toISOString();
const daysBetween = (a, b) => (b - a) / DAY_MS;
const parse = s => { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : null; };
const later = (a, b) => (!a ? b || null : !b ? a : (a > b ? a : b));

async function all(db, sql, ...binds) {
  return (await db.prepare(sql).bind(...binds).all()).results || [];
}

async function settingsWithPrefix(db, prefix) {
  return all(db, 'SELECT key, value FROM settings WHERE key >= ? AND key < ?', prefix, prefix + '￿');
}
function parseJson(v) { try { return JSON.parse(v); } catch (_) { return null; } }

export async function putSetting(db, key, value, leagueId = null) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  if (leagueId) {
    await db.prepare('INSERT INTO settings (key, value, league_id) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(key, v, leagueId).run();
  } else {
    await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(key, v).run();
  }
}
export async function getSetting(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

// An admin used the league's pages while signed in: the day is kept (once a
// day per league per isolate; a failure is ignored). Notre Ligue only.
const seenThisIsolate = new Map();
export async function recordAdminSeen(env, leagueId, now = new Date()) {
  if (!env || env.LEAGUE_PRODUCT !== 'true' || !env.DB || !leagueId || leagueId === SMBHL_LEAGUE_ID) return;
  const day = iso(now).slice(0, 10);
  if (seenThisIsolate.get(leagueId) === day) return;
  try {
    await env.DB.prepare(
      `INSERT INTO settings (key, value, league_id) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE substr(settings.value, 1, 10) < substr(excluded.value, 1, 10)`
    ).bind(adminSeenKey(leagueId), iso(now), leagueId).run();
    seenThisIsolate.set(leagueId, day);
  } catch (_) {}
}

// Every Notre Ligue league's numbers, in a few queries for all of them.
// Deactivated leagues are listed with deactivated: true and no light.
export async function collectLeagueMetrics(env, now = new Date()) {
  const db = env.DB;
  const nowMs = now.getTime();
  const today = localParts(now).date;
  const localDay = offset => localParts(new Date(nowMs + offset * DAY_MS)).date;
  const leagues = await all(db, 'SELECT id, name, slug, created_at, created_by, deactivated_at, plan_tier, angle, utm_source, utm_campaign, utm_content FROM leagues WHERE id != ? ORDER BY created_at DESC', SMBHL_LEAGUE_ID);
  if (!leagues.length) return [];
  const owners = new Map((await all(db,
    `SELECT u.id, u.email FROM users u WHERE u.id IN (SELECT created_by FROM leagues WHERE id != ?)`, SMBHL_LEAGUE_ID)).map(r => [r.id, r.email]));
  const signIn = new Map((await all(db,
    `SELECT la.league_id, MAX(u.last_login_at) AS at FROM league_admins la JOIN users u ON u.id = la.user_id GROUP BY la.league_id`)).map(r => [r.league_id, r.at]));
  const seen = new Map((await settingsWithPrefix(db, 'admin_seen:')).map(r => [r.key.slice('admin_seen:'.length), r.value]));
  const players = new Map((await all(db,
    `SELECT league_id, COUNT(*) AS n FROM contacts WHERE league_id != ? AND COALESCE(is_active, 1) = 1 GROUP BY league_id`, SMBHL_LEAGUE_ID)).map(r => [r.league_id, Number(r.n) || 0]));
  const games = new Map((await all(db,
    `SELECT league_id, COUNT(*) AS n,
            SUM(CASE WHEN date >= ? AND date <= ? THEN 1 ELSE 0 END) AS in_window,
            MIN(CASE WHEN date >= ? AND state = 'open' THEN date || ' ' || COALESCE(start_time, '') END) AS next_game
       FROM events WHERE league_id != ? AND state != 'cancelled' GROUP BY league_id`,
    localDay(-7), localDay(14), today, SMBHL_LEAGUE_ID)).map(r => [r.league_id, r]));
  const kinds = ASK_KINDS.map(() => '?').join(',');
  const asks = new Map((await all(db,
    `SELECT o.league_id, COUNT(DISTINCT o.event_id || '|' || o.player_id) AS inv,
            COUNT(DISTINCT CASE WHEN r.status IN ('in', 'out') THEN o.event_id || '|' || o.player_id END) AS ans
       FROM outbox o LEFT JOIN rsvp r ON r.event_id = o.event_id AND r.player_id = o.player_id
      WHERE o.kind IN (${kinds}) AND o.sent_at >= ? AND o.player_id IS NOT NULL AND o.league_id != ?
      GROUP BY o.league_id`,
    ...ASK_KINDS, iso(new Date(nowMs - 14 * DAY_MS)), SMBHL_LEAGUE_ID)).map(r => [r.league_id, r]));
  const weekAgo = iso(new Date(nowMs - 7 * DAY_MS));
  const failures = new Map();
  for (const r of await all(db, 'SELECT league_id, COUNT(*) AS n FROM outbox WHERE failed_at >= ? GROUP BY league_id', weekAgo)) failures.set(r.league_id, (failures.get(r.league_id) || 0) + Number(r.n));
  for (const r of await all(db, 'SELECT league_id, COUNT(*) AS n FROM league_mail_failure_log WHERE failed_at >= ? GROUP BY league_id', weekAgo)) failures.set(r.league_id, (failures.get(r.league_id) || 0) + Number(r.n));
  // A failed payment: the subscription is past due, or the league's last
  // invoice event of the last 7 days is a failure.
  const lastInvoice = new Map();
  try {
    for (const r of await all(db,
      `SELECT league_id, type, created FROM stripe_events
        WHERE type IN ('invoice.payment_failed', 'invoice.paid') AND league_id IS NOT NULL AND processed_at >= ?
        ORDER BY created`, weekAgo)) lastInvoice.set(r.league_id, r.type);
  } catch (_) {}
  const firstAsk = new Map((await all(db,
    `SELECT league_id, MIN(sent_at) AS at FROM outbox WHERE kind IN (${kinds}) AND sent_at IS NOT NULL AND league_id != ? GROUP BY league_id`,
    ...ASK_KINDS, SMBHL_LEAGUE_ID)).map(r => [r.league_id, r.at]));
  const firstAnswer = new Map((await all(db,
    `SELECT league_id, MIN(updated_at) AS at FROM rsvp WHERE status IN ('in', 'out') AND league_id != ? GROUP BY league_id`,
    SMBHL_LEAGUE_ID)).map(r => [r.league_id, r.at]));
  const billing = await billingSummaries(env, leagues, now);

  return leagues.map(l => {
    const created = parse(l.created_at) ?? nowMs;
    const lastSignIn = later(signIn.get(l.id) || null, seen.get(l.id) || null);
    const g = games.get(l.id) || {};
    const a = asks.get(l.id) || {};
    const b = billing.get(l.id) || null;
    const trialEnd = b && b.trialEndsAt ? parse(b.trialEndsAt) : null;
    // Montreal days, today included (1 on the trial's last day), as the
    // billing page counts them.
    const trialDaysLeft = b && b.status === 'trial' && trialEnd != null ? Math.max(0, dayDiff(today, lastDayBefore(b.trialEndsAt)) + 1) : null;
    const inv = Number(a.inv) || 0;
    const ans = Number(a.ans) || 0;
    return {
      id: l.id,
      name: l.name,
      slug: l.slug || null,
      createdAt: l.created_at,
      deactivated: !!l.deactivated_at,
      ownerMasked: maskEmail(owners.get(l.created_by) || ''),
      players: players.get(l.id) || 0,
      regularCount: b ? b.count : null,
      countTier: b ? b.countTier : null,
      billingStatus: b ? b.status : null,
      billedTier: b ? b.tier : null,
      trialEndsAt: b ? b.trialEndsAt : null,
      trialDaysLeft,
      freeException: b ? b.freeException : false,
      lastAdminSignInAt: lastSignIn,
      // No sign-in on record: the sign-up counts as one.
      signInDays: daysBetween(parse(lastSignIn) ?? created, nowMs),
      ageDays: daysBetween(created, nowMs),
      games: Number(g.n) || 0,
      gameInWindow: (Number(g.in_window) || 0) > 0,
      nextGame: g.next_game ? String(g.next_game).trim() : null,
      invitations14: inv,
      answered14: ans,
      answeredShare: inv ? ans / inv : null,
      mailFailures7: failures.get(l.id) || 0,
      paymentFailed: !!(b && b.status === 'past_due') || lastInvoice.get(l.id) === 'invoice.payment_failed',
      trialEndingNoSub: trialDaysLeft != null && trialDaysLeft <= 7,
      firstInvitationAt: firstAsk.get(l.id) || null,
      firstAnswerAt: firstAnswer.get(l.id) || null,
      subscribed: !!(b && ['active', 'past_due', 'paused'].includes(b.status)),
      // Ad test item 3: where the league came from (migrate-057.sql).
      angle: l.angle || null,
      utmSource: l.utm_source || null,
      utmCampaign: l.utm_campaign || null,
      utmContent: l.utm_content || null
    };
  });
}

// Ad test item 3: per utm_content value, the leagues created in a period
// (their Montreal creation day, from and to included) and how many of them
// have sent a first game invitation (firstInvitationAt: the first sent row
// of an invitation kind, the same as the trial timeline's). Leagues with no
// utm_content are one row of their own (utmContent null). Pure.
export function attributionSummary(rows, { from = '', to = '' } = {}) {
  const by = new Map();
  for (const r of rows || []) {
    const t = Date.parse(r.createdAt || '');
    if (!Number.isFinite(t)) continue;
    const d = localParts(new Date(t)).date;
    if ((from && d < from) || (to && d > to)) continue;
    const k = r.utmContent || null;
    const e = by.get(k) || { utmContent: k, leagues: 0, firstInvites: 0 };
    e.leagues += 1;
    if (r.firstInvitationAt) e.firstInvites += 1;
    by.set(k, e);
  }
  return [...by.values()].sort((a, b) => b.leagues - a.leagues || (a.utmContent === null) - (b.utmContent === null) || String(a.utmContent || '').localeCompare(String(b.utmContent || '')));
}
// The default period: the last 30 Montreal days, today included.
export function defaultAttributionPeriod(now = new Date()) {
  return { from: localParts(new Date(now.getTime() - 29 * DAY_MS)).date, to: localParts(now).date };
}

// Numbers plus the light, for every league (live, nothing stored).
export async function computeLeagueHealth(env, now = new Date()) {
  const metrics = await collectLeagueMetrics(env, now);
  return metrics.map(m => (m.deactivated ? { ...m, light: null, signals: [] } : { ...m, ...evaluateHealth(m) }));
}

// The stored snapshots, by league id.
export async function storedHealth(db) {
  const out = new Map();
  for (const r of await settingsWithPrefix(db, HEALTH_PREFIX)) {
    if (r.key === HEALTH_DAY_KEY) continue;
    const v = parseJson(r.value);
    if (v) out.set(r.key.slice(HEALTH_PREFIX.length), v);
  }
  return out;
}

// The trial timeline's dates the database does not keep, first seen by the
// daily check. Returns the merged record.
async function updateMilestones(db, m, now) {
  const key = milestonesKey(m.id);
  const prev = parseJson(await getSetting(db, key)) || {};
  const next = { ...prev };
  const day = iso(now);
  if (m.players > 0 && !next.firstPlayerAt) next.firstPlayerAt = day;
  if (m.games > 0 && !next.firstGameAt) next.firstGameAt = day;
  if (m.subscribed && !next.subscribedAt) next.subscribedAt = day;
  if (JSON.stringify(next) !== JSON.stringify(prev)) await putSetting(db, key, next, m.id);
  return next;
}

// The daily run: once per league-time day, from DAILY_HOUR. Stores each
// league's snapshot and returns what changed since the last one:
// { ran, day, leagues, worsened: [{ id, name, from, to }], trialsEntering: [...] }.
// force: run now whatever the day and hour (the super-admin's recompute).
export async function runDailyLeagueHealth(env, now = new Date(), { force = false } = {}) {
  if (!env || env.LEAGUE_PRODUCT !== 'true' || !env.DB) return { ran: false };
  const parts = localParts(now);
  if (!force) {
    if (parts.hour < DAILY_HOUR) return { ran: false };
    if ((await getSetting(env.DB, HEALTH_DAY_KEY)) === parts.date) return { ran: false };
  }
  const prev = await storedHealth(env.DB);
  const rows = await computeLeagueHealth(env, now);
  const rank = { green: 0, yellow: 1, red: 2 };
  const worsened = [];
  const trialsEntering = [];
  for (const r of rows) {
    if (r.deactivated) continue;
    const before = prev.get(r.id) || null;
    const milestones = await updateMilestones(env.DB, r, now);
    const changed = !before || before.light !== r.light;
    const snapshot = {
      day: parts.date,
      computedAt: iso(now),
      light: r.light,
      previousLight: before ? before.light : null,
      lightSince: changed ? iso(now) : (before.lightSince || before.computedAt || iso(now)),
      signals: r.signals,
      metrics: pickMetrics(r),
      milestones
    };
    await putSetting(env.DB, healthKey(r.id), snapshot, r.id);
    if (before && before.light && rank[r.light] > rank[before.light] && r.light !== 'green') worsened.push({ id: r.id, name: r.name, from: before.light, to: r.light, signals: r.signals });
    const wasEnding = !!(before && before.metrics && before.metrics.trialEndingNoSub);
    if (r.trialEndingNoSub && !wasEnding) trialsEntering.push({ id: r.id, name: r.name, trialEndsAt: r.trialEndsAt });
  }
  await putSetting(env.DB, HEALTH_DAY_KEY, parts.date);
  return { ran: true, day: parts.date, leagues: rows, worsened, trialsEntering };
}

// What a snapshot keeps of the numbers (the list page shows them).
export function pickMetrics(r) {
  const keys = ['ownerMasked', 'players', 'regularCount', 'countTier', 'billingStatus', 'trialEndsAt', 'trialDaysLeft',
    'lastAdminSignInAt', 'games', 'gameInWindow', 'nextGame', 'invitations14', 'answered14', 'answeredShare',
    'mailFailures7', 'paymentFailed', 'trialEndingNoSub', 'firstInvitationAt', 'firstAnswerAt', 'subscribed'];
  return Object.fromEntries(keys.map(k => [k, r[k] === undefined ? null : r[k]]));
}

// The list's rows: live numbers, the stored light when there is one (else
// the live one, marked). Red, then yellow, then green, then deactivated;
// within a light, the oldest light first, then by name.
export async function leagueListRows(env, now = new Date()) {
  const live = await computeLeagueHealth(env, now);
  const stored = await storedHealth(env.DB);
  const order = { red: 0, yellow: 1, green: 2 };
  const rows = live.map(r => {
    const s = stored.get(r.id);
    const useStored = !r.deactivated && s && s.light;
    return {
      ...r,
      light: r.deactivated ? null : useStored ? s.light : r.light,
      signals: useStored ? s.signals : r.signals,
      healthAt: useStored ? s.computedAt : null,
      healthLive: !useStored && !r.deactivated
    };
  });
  rows.sort((a, b) => {
    const oa = a.light ? order[a.light] : 3, ob = b.light ? order[b.light] : 3;
    if (oa !== ob) return oa - ob;
    return String(a.name || '').localeCompare(String(b.name || ''), 'fr');
  });
  return rows;
}

// Filter by light ('red' | 'yellow' | 'green' | 'deactivated', anything
// else = all) and search by name (case and accents ignored). Pure.
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
export function filterLeagueRows(rows, { status = '', q = '' } = {}) {
  const needle = fold(q);
  return rows.filter(r => {
    if (status === 'deactivated' && !r.deactivated) return false;
    if (LIGHTS.includes(status) && r.light !== status) return false;
    if (needle && !fold(r.name).includes(needle)) return false;
    return true;
  });
}

// One league, for its page: the live numbers and light, the stored
// snapshot, the timeline. null when it is not a Notre Ligue league.
export async function leagueDetail(env, leagueId, now = new Date()) {
  if (!leagueId || leagueId === SMBHL_LEAGUE_ID) return null;
  const rows = await computeLeagueHealth(env, now);
  const r = rows.find(x => x.id === leagueId);
  if (!r) return null;
  const snapshot = parseJson(await getSetting(env.DB, healthKey(leagueId)));
  const milestones = parseJson(await getSetting(env.DB, milestonesKey(leagueId))) || {};
  const timeline = [
    { key: 'signed_up', at: r.createdAt, observed: false },
    { key: 'first_player', at: milestones.firstPlayerAt || null, observed: true },
    { key: 'first_game', at: milestones.firstGameAt || null, observed: true },
    { key: 'first_invitation', at: r.firstInvitationAt, observed: false },
    { key: 'first_answers', at: r.firstAnswerAt, observed: false },
    { key: 'subscribed', at: milestones.subscribedAt || null, observed: true }
  ];
  return { league: r, snapshot, timeline, rules: HEALTH_RULES.map(({ key, level, fr, en }) => ({ key, level, fr, en })) };
}

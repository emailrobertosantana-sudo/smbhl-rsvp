// src/reminders.js -- the ONE reminder module, for SMBHL and the league
// product alike (ending the reminder fork: SMBHL's runSchedule() and the
// league product's runLeagueReminders() used to be two separate
// implementations living in src/index.js).
//
// WHAT LIVES HERE
//   - Quiet hours (afterQuiet, getEmailSettings, DEFAULT_EMAIL_SETTINGS).
//   - The job ledger for the advanced cadence (jobDone / markJob).
//   - The ADVANCED cadence: granular hours-before / hour-of-day steps, held
//     for quiet hours (runSchedule -- SMBHL's steps, moved here verbatim).
//   - The SIMPLE cadence: 72 h / 24 h / 12 h on/off waves
//     (runLeagueReminders / sendLeagueReminderWave, moved here verbatim).
//   - The window-skip rule (applyReminderWindowSkipRule, 6ed0ee8, moved
//     here verbatim from reminder_scheduling.js, which now re-exports it).
//
// Moved VERBATIM from index.js (same precedent as generateRoundRobinRounds,
// f52ca55): every function body is byte-for-byte what it was, except one
// added first line in the three cron functions that takes the helpers they
// still share with the rest of index.js (enqueue, drain, callSubs, ...) from
// the host index.js installs at load time (installReminderHost below) -- a
// plain object, not a circular import. index.js re-exports every moved name,
// so every existing caller and test sees the same function.
//
// Wave-staggered sub calls, the responsiveness order and dormancy were
// already ONE implementation shared by both products before this move
// (callSubs / drain in index.js), and stay there.
import { byStart } from './league_nights.js';
import { eventStart, localParts, SMBHL_LEAGUE_ID } from './league_ids.js';
import { getSeasonConfigForEvent, getTeamNames } from './season_config.js';
import { MAIL_SENDS_PER_INVOCATION, createSendBudget, sendsPerInvocation } from './mail_queue.js';
import { hasCapability } from './super_admin.js';

// ---------------------------------------------------------------------
// Host: the helpers index.js owns and these functions call.
let host = null;
export function installReminderHost(h) { host = h; }
function reminderHost() {
  if (!host) throw new Error('reminders.js: installReminderHost() has not run (index.js installs it at load)');
  return host;
}

// ---------------------------------------------------------------------
// The admin's weekly summary (24 h before the game): each team's count and
// the sub waitlist. Its own function so the Comms preview shows exactly it.
export async function buildSummaryText(env, ev) {
  const { teamState, dateFR } = reminderHost();
  const cfg = await getSeasonConfigForEvent(env, ev.id, ev.season);
  const cfgTeams = getTeamNames(cfg);
  const lines = [];
  for (const team of cfgTeams) {
    const st = await teamState(env.DB, ev.id, team, cfg);
    lines.push(`${team}: ${st.skaters} joueurs, ${st.goalies} gardien(s)` +
      (st.short ? '   <-- SHORT' : ''));
  }
  const wait = (await env.DB.prepare(
    `SELECT c.name, a.need FROM availability a JOIN contacts c ON c.player_id=a.player_id
      WHERE a.event_id=? AND a.status='yes'
        AND a.player_id NOT IN (SELECT player_id FROM rsvp WHERE event_id=? AND player_id IS NOT NULL)
      ORDER BY a.answered_at`).bind(ev.id, ev.id).all()).results || [];
  return `Semaine ${ev.week} — ${dateFR(ev.date)}\n\n` + lines.join('\n') +
    (wait.length ? `\n\nListe d'attente: ` +
      wait.map(w => `${w.name} (${w.need === 'goalie' ? 'G' : 'J'})`).join(', ') : '');
}

// ---------------------------------------------------------------------
// Time helper (moved from index.js, which imports it back).
export const reached = (p, h, m = 0) => p.hour > h || (p.hour === h && p.minute >= m);

// ---------------------------------------------------------------------
// THE TWO CADENCE MODELS, ONE ENGINE
//
// Simple (every league by default): three steps -- 72 h and 24 h reminders
// to players who haven't answered, 12 h details to confirmed players --
// each an on/off toggle, fired once the game is within its fixed window,
// sent straight away.
//
// Advanced (the 'advanced_reminders' capability flag; SMBHL always): each
// step has its own hours-before AND an optional hour of the day it waits
// for (league time), and what it sends is held for quiet hours. SMBHL's
// own steps (invite, r72, r49, short48, pool36, friday_board, r24,
// gameday, summary, lock) are runSchedule below; a flagged league keeps
// its three steps and toggles, timed and held the advanced way.
//
// Both models decide "is this step due" with cadenceStepDue(), and both
// queue through the same outbox (cap, retries, deferral) and call subs
// through the same callSubs() (waves, responsiveness order, dormancy).
export const ADVANCED_REMINDERS_FLAG = 'advanced_reminders';
export async function usesAdvancedReminders(env, leagueId) {
  if (!leagueId || leagueId === SMBHL_LEAGUE_ID) return true; // SMBHL's reminders are built on it
  return hasCapability(env, leagueId, ADVANCED_REMINDERS_FLAG);
}

// Due when the game is within `hours` (and not started) and, if the step
// has an hour of the day, that hour has been reached today (league time).
export function cadenceStepDue(hoursUntil, hours, hourOfDay, parts) {
  return hoursUntil <= hours && hoursUntil > 0 && (hourOfDay == null || reached(parts, hourOfDay));
}

// A flagged league's three steps under the advanced model: which of its
// cadence settings time each one. (SMBHL's settings have no logistics step.)
const ADVANCED_LEAGUE_STEPS = {
  reminder_72h: { hours: 'r72_hours', hourOfDay: 'r72_hour_of_day' },
  reminder_24h: { hours: 'r24_hours', hourOfDay: 'r24_hour_of_day' },
  logistics_12h: { hours: 'logistics_hours', hourOfDay: null }
};
export function advancedStepHours(settings, kind) {
  const h = Number(settings[ADVANCED_LEAGUE_STEPS[kind].hours]);
  return Number.isFinite(h) && h > 0 ? h : REMINDER_WINDOW_THRESHOLD_HOURS[kind];
}
export function advancedStepHourOfDay(settings, kind) {
  const key = ADVANCED_LEAGUE_STEPS[kind].hourOfDay;
  if (!key) return null;
  const v = settings[key];
  return v === null || v === undefined || v === '' ? null : Number(v);
}

/* ---------- quiet hours ---------- */

const QUIET_FROM = 23, QUIET_TO = 7;
// Live-testing task (batch 4), Part 2: SMBHL bug -- the Comms
// quiet-hours card read and wrote quiet_hours_enabled/_start/_end
// (email_cadence_settings, via getEmailSettings below), but this
// function used to unconditionally apply the hardcoded QUIET_FROM/
// QUIET_TO constants and never looked at those settings at all.
// Toggling the card in the UI changed nothing about real send timing.
//
// QUIET_FROM/QUIET_TO remain as the FALLBACK when a stored setting is
// missing or malformed (never NaN/undefined -- Number.isFinite guards
// below), and DEFAULT_EMAIL_SETTINGS.quiet_hours_enabled was changed
// from false to true alongside this fix (see that object's own
// comment) so that an account with no saved settings row at all --
// every league today, and SMBHL unless an operator already saved this
// card at some point -- resolves to the exact same enabled/23/7
// behavior this function already had unconditionally. Byte-identical
// today; only changes for an operator who deliberately sets it.
// settingsLeagueId: a league on the advanced model holds its mail for ITS
// OWN quiet hours. Every other caller passes nothing and reads SMBHL's
// settings, exactly as before.
//
// Quiet hours are LOCAL time (America/Toronto, localParts), from
// quiet_hours_start up to quiet_hours_end. A window may wrap midnight
// (23 -> 7, the default) or not (0 -> 6); start == end means none.
// Until the week-4 investigation this only understood a wrapping window:
// for 0 -> 6 its "allowed" test (hour >= 6 && hour < 0) could never be
// true, so after 24 half-hour steps it returned the time 12 hours later,
// wherever that fell -- production's week-4 sub calls were all pushed
// exactly 12 h, several of them to 01:30-05:30 Montreal.
export function inQuietHours(hour, from, to) {
  if (from === to) return false;
  return from < to ? (hour >= from && hour < to) : (hour >= from || hour < to);
}
export async function afterQuiet(env, d, settingsLeagueId = null) {
  const settings = await getEmailSettings(env.DB, settingsLeagueId);
  if (!settings.quiet_hours_enabled) return new Date(d);
  const from = Number.isFinite(settings.quiet_hours_start) ? settings.quiet_hours_start : QUIET_FROM;
  const to = Number.isFinite(settings.quiet_hours_end) ? settings.quiet_hours_end : QUIET_TO;
  let t = new Date(d);
  // At most 24 h of quiet: step in half hours until outside the window.
  for (let i = 0; i < 49; i++) {
    if (!inQuietHours(localParts(t).hour, from, to)) return t;
    t = new Date(t.getTime() + 30 * 60000);
  }
  return t;
}

/* ---------- scheduled jobs ---------- */

export async function jobDone(db, eventId, job) {
  return !!(await db.prepare('SELECT 1 FROM jobs WHERE event_id=? AND job=?')
    .bind(eventId, job).first());
}
export async function markJob(db, eventId, job) {
  await db.prepare('INSERT OR IGNORE INTO jobs (event_id,job,ran_at) VALUES (?,?,?)')
    .bind(eventId, job, new Date().toISOString()).run();
}

export const DEFAULT_EMAIL_SETTINGS = {
  invite_hours: 120,
  invite_hour_of_day: 18,
  r72_hours: 72,
  r72_hour_of_day: 15,
  r49_hours: 49,
  short48_hours: 48,
  pool_hours: 36,
  r24_hours: 24,
  r24_hour_of_day: 18,
  gameday_morning_hours: 2,
  // Live-testing task (batch 4), Part 2: was `false`, but nothing ever
  // read this field, so the REAL behavior (afterQuiet's own hardcoded
  // QUIET_FROM/QUIET_TO, unconditionally applied) was always "enabled,
  // 23, 7" regardless of what this said. Now that afterQuiet() actually
  // reads it, the default has to match the behavior it's replacing --
  // `true` here is what makes every account with no saved settings row
  // (every league today, and SMBHL unless an operator already saved
  // this card) see byte-identical send timing to before this fix.
  quiet_hours_enabled: true,
  quiet_hours_start: 23,
  quiet_hours_end: 7
};

// leagueId: SMBHL's settings live under 'email_cadence_settings' (nothing
// passed, or SMBHL); a league on the advanced model has its own row,
// 'email_cadence_settings:<leagueId>', defaulting to the same values plus
// its 12 h details step.
export const LEAGUE_ADVANCED_DEFAULTS = { logistics_hours: 12 };
export function emailSettingsKey(leagueId) {
  return leagueId && leagueId !== SMBHL_LEAGUE_ID ? `email_cadence_settings:${leagueId}` : 'email_cadence_settings';
}
export async function getEmailSettings(db, leagueId = null) {
  const league = leagueId && leagueId !== SMBHL_LEAGUE_ID;
  const base = league ? Object.assign({}, DEFAULT_EMAIL_SETTINGS, LEAGUE_ADVANCED_DEFAULTS) : DEFAULT_EMAIL_SETTINGS;
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(emailSettingsKey(leagueId)).first();
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      return Object.assign({}, base, parsed);
    }
  } catch (_) {}
  return Object.assign({}, base);
}

export async function runSchedule(env) {
  const { enqueue, teamState, remindSubs, callSubs, getTeamMessages, callSubsForShortfall, ensureNextEvent, getEvent, drain, deadMan, ADMIN_EMAIL } = reminderHost();
  const log = [];
  const now = new Date();
  const emailSettings = await getEmailSettings(env.DB);
  const evs = (await env.DB.prepare(
    `SELECT * FROM events WHERE state = 'open' ORDER BY week`).all()).results || [];

  for (const ev of evs) {
    const start = eventStart(ev);
    if (!start) continue;
    const hrs = (start - now) / 3600000;
    const p = localParts();

    const fire = async (job, when, who) => {
      if (!when) return;
      if (await jobDone(env.DB, ev.id, job)) return;
      await who();
      await markJob(env.DB, ev.id, job);
      log.push(`${job} ${ev.id}`);
    };

    const roster = async where => (await env.DB.prepare(
      `SELECT player_id FROM rsvp WHERE event_id=? AND role='roster' ${where}`
    ).bind(ev.id).all()).results || [];

    const mailEach = async (rows, kind, extra = {}) => {
      for (const r of rows)
        await enqueue(env, { kind, event_id: ev.id, player_id: r.player_id,
          dedup_key: `${kind}:${ev.id}:${r.player_id}`, ...extra });
    };

    const inviteHours = emailSettings.invite_hours ?? 120;
    const inviteHourOfDay = emailSettings.invite_hour_of_day ?? 18;
    const r72Hours = emailSettings.r72_hours ?? 72;
    const r72HourOfDay = emailSettings.r72_hour_of_day ?? 15;
    const r49Hours = emailSettings.r49_hours ?? 49;
    const short48Hours = emailSettings.short48_hours ?? 48;
    const poolHours = emailSettings.pool_hours ?? 36;
    const r24Hours = emailSettings.r24_hours ?? 24;
    const r24HourOfDay = emailSettings.r24_hour_of_day;
    const gamedayMorningHours = emailSettings.gameday_morning_hours ?? 2;

    await fire('invite', cadenceStepDue(hrs, inviteHours, inviteHourOfDay, p), async () => {
      // 1. All regular roster players
      await mailEach(await roster(''), 'invite');

      // 2. Anyone who played in the previous week (substitutes)
      const prevEv = await env.DB.prepare(
        `SELECT id FROM events WHERE season = ? AND week < ? ORDER BY week DESC LIMIT 1`
      ).bind(ev.season, ev.week).first();

      if (prevEv) {
        const prevSubs = (await env.DB.prepare(
          `SELECT DISTINCT r.player_id FROM rsvp r
            JOIN contacts c ON c.player_id = r.player_id
           WHERE r.event_id = ? AND r.status = 'in' AND r.player_id IS NOT NULL
             AND c.opted_out = 0
             AND r.player_id NOT IN (SELECT player_id FROM rsvp WHERE event_id = ? AND role = 'roster')`
        ).bind(prevEv.id, ev.id).all()).results || [];

        for (const s of prevSubs) {
          await enqueue(env, {
            kind: 'invite',
            event_id: ev.id,
            player_id: s.player_id,
            dedup_key: `invite:${ev.id}:${s.player_id}`,
            payload: { is_sub: true }
          });
        }
      }
    });

    await fire('r72', cadenceStepDue(hrs, r72Hours, r72HourOfDay, p),
      async () => mailEach(await roster("AND status='pending'"), 'chase',
        { payload: { stage: '72' } }));

    await fire('r49', cadenceStepDue(hrs, r49Hours, null, p),
      async () => mailEach(await roster("AND status='pending'"), 'chase',
        { payload: { stage: '49' } }));

    await fire('short48', cadenceStepDue(hrs, short48Hours, null, p), async () => {
      const cfg = await getSeasonConfigForEvent(env, ev.id, ev.season);
      const cfgTeams = getTeamNames(cfg);
      for (const team of cfgTeams) {
        const st = await teamState(env.DB, ev.id, team, cfg);
        if (!st.short) continue;
        const confirmed = st.rows.filter(r => r.status === 'in' && r.player_id);
        for (const r of confirmed)
          await enqueue(env, { kind: 'team_short', event_id: ev.id,
            player_id: r.player_id, team,
            dedup_key: `team_short:${ev.id}:${r.player_id}`,
            payload: { skaters: st.skaters, goalies: st.goalies,
                       needGoalie: st.shortGoalie, needSkaters: st.shortSkaters } });
      }
    });

    await fire('pool36', cadenceStepDue(hrs, poolHours, null, p), async () => {
      await remindSubs(env, ev);
      const cfg = await getSeasonConfigForEvent(env, ev.id, ev.season);
      const cfgTeams = getTeamNames(cfg);
      for (const team of cfgTeams) {
        const st = await teamState(env.DB, ev.id, team, cfg);
        if (st.shortGoalie) await callSubs(env, ev, team, 'goalie');
        if (st.shortSkaters) await callSubs(env, ev, team, 'skater');
      }
    });

    await fire('friday_board', p.weekday === 'Fri' && reached(p, 14) && hrs > 24, async () => {
      const cfg = await getSeasonConfigForEvent(env, ev.id, ev.season);
      const cfgTeams = getTeamNames(cfg);
      for (const team of cfgTeams) {
        const msgs = await getTeamMessages(env.DB, ev.id, team, 5);
        if (!msgs || !msgs.length) continue;
        const recipients = (await env.DB.prepare(
          `SELECT player_id FROM rsvp 
           WHERE event_id=? AND team=? AND player_id IS NOT NULL 
             AND (status='in' OR (role='roster' AND status='pending'))`
        ).bind(ev.id, team).all()).results || [];
        for (const r of recipients) {
          await enqueue(env, {
            kind: 'friday_board',
            event_id: ev.id,
            player_id: r.player_id,
            team,
            dedup_key: `friday_board:${ev.id}:${r.player_id}`
          });
        }
      }
    });

    await fire('r24', cadenceStepDue(hrs, r24Hours, r24HourOfDay, p),
      async () => mailEach(await roster("AND status='pending'"), 'chase',
        { payload: { stage: '24' } }));

    await fire('gameday24', cadenceStepDue(hrs, r24Hours, r24HourOfDay, p), async () => {
      const recipients = (await env.DB.prepare(
        `SELECT player_id, team FROM rsvp 
         WHERE event_id=? AND player_id IS NOT NULL 
           AND (status='in' OR (role='roster' AND status='pending'))`
      ).bind(ev.id).all()).results || [];
      for (const r of recipients) {
        await enqueue(env, {
          kind: 'gameday',
          event_id: ev.id,
          player_id: r.player_id,
          team: r.team,
          dedup_key: `gameday24:${ev.id}:${r.player_id}`,
        });
      }
      await markJob(env.DB, ev.id, 'r24');
    });

    await fire('gameday_morning', cadenceStepDue(hrs, gamedayMorningHours, null, p), async () => {
      const start = eventStart(ev);
      const cutoff24 = start ? new Date(start.getTime() - 24 * 3600000).toISOString() : new Date(Date.now() - 24 * 3600000).toISOString();
      const cfg = await getSeasonConfigForEvent(env, ev.id, ev.season);
      const cfgTeams = getTeamNames(cfg);
      for (const team of cfgTeams) {
        const newMsgs = await getTeamMessages(env.DB, ev.id, team, 10, cutoff24);
        if (!newMsgs || !newMsgs.length) continue;
        const recipients = (await env.DB.prepare(
          `SELECT player_id FROM rsvp 
           WHERE event_id=? AND team=? AND player_id IS NOT NULL 
             AND (status='in' OR (role='roster' AND status='pending'))`
        ).bind(ev.id, team).all()).results || [];
        for (const r of recipients) {
          await enqueue(env, {
            kind: 'gameday_morning',
            event_id: ev.id,
            player_id: r.player_id,
            team,
            dedup_key: `gameday_morning:${ev.id}:${r.player_id}`
          });
        }
      }
    });

    await fire('summary', cadenceStepDue(hrs, 24, 20, p), async () => {
      await enqueue(env, { kind: 'summary', event_id: ev.id,
        dedup_key: `summary:${ev.id}`,
        payload: { text: await buildSummaryText(env, ev) } });
    });

    await fire('lock', hrs <= 0 && reached(p, 13), async () => {
      await env.DB.prepare("UPDATE events SET state='locked' WHERE id=?").bind(ev.id).run();
    });

    // No season-recap step here: it fired at 13:30 on any day for any open
    // game and marked the job done on non-final weeks. Publishing the final
    // week queues the admin's recap prompt once a champion is crowned.

    // Sub-call rework, Part 3: every pass, a team that can no longer
    // reach its minimum from who is still available calls subs -- not
    // only when someone cancels. Idempotent: callSubs skips subs already
    // invited for this game, so repeated passes add only new eligible
    // subs (e.g. one added since the last pass).
    try {
      const n = await callSubsForShortfall(env, ev);
      if (n) log.push(`shortfall ${ev.id}: ${n} sub call(s) queued`);
    } catch (e) { log.push(`shortfall check failed for ${ev.id}: ${e.message}`); }
  }

  try {
    const made = await ensureNextEvent(env);
    if (made) {
      log.push(`created ${made.id} week ${made.week} (${made.players} players)`);
      // A team already below its minimum is short from the moment the
      // game exists: call subs now, in this same pass (drained below).
      const madeEv = await getEvent(env.DB, made.id);
      const n = await callSubsForShortfall(env, madeEv);
      if (n) log.push(`shortfall at creation ${made.id}: ${n} sub call(s) queued`);
    }
  } catch (e) { log.push('ensureNextEvent failed: ' + e.message); }

  const d = await drain(env);
  log.push(`outbox due=${d.due} sent=${d.sent} failed=${d.failed}`);

  try {
    const probs = await deadMan(env);
    if (probs.length) log.push('ALERT: ' + probs.join('; '));
  } catch (e) { log.push('deadMan failed: ' + e.message); }

  return log;
}

/* ---------- the window-skip rule (moved from reminder_scheduling.js) ---------- */

// Reminder-window-skip-on-create/reschedule bug fix.
//
// CONFIRMED BUG (live on demo, real emails sent): creating an event
// whose game is only a few days out fired every reminder wave whose
// hours-before threshold had already elapsed, all in one burst, on
// the very next cron tick. Root cause: runLeagueReminders'/
// sendLeagueReminderWave's own check (src/index.js) only ever asks
// "is hoursUntil under this step's threshold right now" -- with no
// memory of whether that window had ever been legitimately open
// BEFORE the event (or its current date) existed. That check is
// deliberately "self-healing" (a missed cron tick still fires late
// instead of skipping forever, see that code's own comment) -- which
// is exactly right for a window that opened while the event already
// existed and a tick was simply missed, and exactly wrong for a
// window whose nominal fire time is already in the past the moment
// the event is created (there is no earlier tick to have "missed" --
// the reminder was never real, the window opened before the event did).
//
// FIX (this file): whenever an event is created, or its date changes,
// mark any cadence step whose window has ALREADY elapsed AT THAT
// MOMENT as "skipped" in league_reminder_log -- the SAME table and
// PRIMARY KEY (event_id, kind) runLeagueReminders' own dedup check
// already uses ("does a row exist for this event+kind"). This means
// the cron itself needs ZERO changes: it already never re-sends
// anything with an existing row, whether that row represents a
// genuine send or a deliberate skip. Only steps whose window is
// STILL in the future are left with no row at all, to fire normally,
// on schedule, exactly as before this fix for every event created
// with plenty of lead time (the overwhelmingly common case, and the
// one this bug never affected).
//
// SCOPE: applies to both the granular per-step hours-before thresholds
// (reminder_72h/reminder_24h/logistics_12h, each its own fixed
// window) and the simple per-league on/off toggles that gate each of
// them (reminder_72h_enabled/24h/12h) -- a disabled step is simply
// skipped over entirely (nothing to mark either way, since it was
// never going to fire regardless of this fix).
//
// SELF-CONTAINED ON PURPOSE: the advanced reminder module (this whole
// cadence system) is scheduled for extraction into a shared module in
// a later task. This file does not import anything from index.js (the
// cron's own current home) -- only eventStart from league_ids.js,
// itself already a shared, dependency-free module -- and everything
// index.js/leagues.js need from this system (the threshold hours, the
// skip-marking function) is exported from here, not duplicated. When
// that extraction happens, this file should need nothing more than a
// straight move and an import-path update -- see the fix's own commit/
// report for confirmation this was verified, not just hoped for.
// Single source of truth for both this file and index.js's own
// runLeagueReminders/sendLeagueReminderWave (which imports this
// instead of keeping its own separate copy of the same 3 numbers).
export const REMINDER_WINDOW_THRESHOLD_HOURS = { reminder_72h: 72, reminder_24h: 24, logistics_12h: 12 };
const REMINDER_WINDOW_ENABLED_COLUMN = { reminder_72h: 'reminder_72h_enabled', reminder_24h: 'reminder_24h_enabled', logistics_12h: 'reminder_12h_enabled' };

// Call after creating a league event, or after changing an existing
// one's date -- `ev` only needs `id` and `start_time` (the same shape
// eventStart already expects; `ev.id`'s own trailing date suffix is
// what eventStart actually parses, via eventDateFromId, so this
// naturally picks up a NEW date on a reschedule as long as the caller
// passes the event's current row). No-ops harmlessly if the event has
// no start_time yet (nothing to schedule against -- matches
// runLeagueReminders' own guard) or the league can't be found.
//
// "Treating a date change as if the event were freshly created":
// every step is re-evaluated from scratch against the CURRENT
// hoursUntil, not just newly-passed ones marked forward-only --
// a step already marked skipped whose window is legitimately back in
// the future (the event was rescheduled FURTHER out) has its skip
// mark cleared here, so it can fire normally later, exactly as a
// freshly-created event at that same date would. A step that
// genuinely SENT already (skipped=0, a real row) is checked first and
// never touched, unconditionally -- "already sent stays sent."
export async function applyReminderWindowSkipRule(env, leagueId, ev) {
  if (!ev || !ev.start_time) return;
  const start = eventStart(ev);
  if (!start) return;
  const hoursUntil = (start.getTime() - Date.now()) / 3600000;

  const leagueRow = await env.DB.prepare(
    'SELECT reminder_72h_enabled, reminder_24h_enabled, reminder_12h_enabled FROM leagues WHERE id = ?'
  ).bind(leagueId).first();
  if (!leagueRow) return;

  // A league on the advanced model skips against its own hours-before.
  const advancedSettings = (await usesAdvancedReminders(env, leagueId)) ? await getEmailSettings(env.DB, leagueId) : null;
  for (const kind of Object.keys(REMINDER_WINDOW_THRESHOLD_HOURS)) {
    if (!leagueRow[REMINDER_WINDOW_ENABLED_COLUMN[kind]]) continue;

    const existing = await env.DB.prepare(
      'SELECT skipped FROM league_reminder_log WHERE event_id = ? AND kind = ?'
    ).bind(ev.id, kind).first();

    if (existing && !existing.skipped) continue; // a real send already happened -- never touch

    const windowAlreadyPassed = hoursUntil <= (advancedSettings ? advancedStepHours(advancedSettings, kind) : REMINDER_WINDOW_THRESHOLD_HOURS[kind]);

    if (windowAlreadyPassed) {
      if (!existing) {
        await env.DB.prepare(
          `INSERT INTO league_reminder_log (event_id, kind, league_id, sent_at, recipient_count, skipped)
           VALUES (?, ?, ?, ?, 0, 1)
           ON CONFLICT(event_id, kind) DO NOTHING`
        ).bind(ev.id, kind, leagueId, new Date().toISOString()).run();
      }
      // else: already marked skipped -- idempotent, nothing to do.
    } else if (existing && existing.skipped) {
      // Rescheduled further out -- this step's window is legitimately
      // in the future again; clear the stale skip so the cron can
      // send it normally when its real time comes.
      await env.DB.prepare('DELETE FROM league_reminder_log WHERE event_id = ? AND kind = ?').bind(ev.id, kind).run();
    }
  }
}

/* ---------- the simple cadence: 72 h / 24 h / 12 h waves ---------- */

// Sends one reminder wave for one event: real recipients (never a
// static count), real per-league branding and color, real dedup via
// league_reminder_log (never re-sent automatically for the same
// event+kind once logged). kind: 'reminder_72h' | 'reminder_24h' |
// 'logistics_12h'. Each kind has its OWN hours-until-start threshold
// -- a 70h-out event only qualifies for reminder_72h, never also
// reminder_24h/logistics_12h just because it's already <= 72h out.
// Returns the number of emails actually sent, per kind.
// Threshold hours now live in reminder_scheduling.js (reminder-window-
// skip-on-create/reschedule bug fix task) -- that file's own
// applyReminderWindowSkipRule needs the identical 3 numbers to decide
// whether a step's window has already elapsed at event-creation time,
// and a single source of truth means the two can never drift apart.
// advancedSettings: the league's cadence settings when it is on the
// advanced model (its hours-before and hour of day decide when each step is
// due, and its mail is held for its quiet hours); null for the simple model.
// night: the night's games (D1) when there is more than one -- ev is the
// first. One wave for the night: already sent if any of its games has it,
// and logged for each of them (sendLeagueReminderKind).
export async function sendLeagueReminderWave(env, leagueRow, cfg, ev, hoursUntil, advancedSettings = null, night = null) {
  const games = night && night.length > 1 ? night : [ev];
  const { sendLeagueReminderKind } = reminderHost();
  const kindToColumn = { reminder_72h: 'reminder_72h_enabled', reminder_24h: 'reminder_24h_enabled', logistics_12h: 'reminder_12h_enabled' };
  const results = {};
  const parts = localParts();
  for (const kind of ['reminder_72h', 'reminder_24h', 'logistics_12h']) {
    const due = advancedSettings
      ? cadenceStepDue(hoursUntil, advancedStepHours(advancedSettings, kind), advancedStepHourOfDay(advancedSettings, kind), parts)
      : !(hoursUntil > REMINDER_WINDOW_THRESHOLD_HOURS[kind]);
    if (!due) { results[kind] = 0; continue; }
    if (!leagueRow[kindToColumn[kind]]) { results[kind] = 0; continue; }
    const already = games.length === 1
      ? await env.DB.prepare('SELECT 1 FROM league_reminder_log WHERE event_id = ? AND kind = ?').bind(ev.id, kind).first()
      : await env.DB.prepare(`SELECT 1 FROM league_reminder_log WHERE kind = ? AND event_id IN (${games.map(() => '?').join(',')})`).bind(kind, ...games.map(g => g.id)).first();
    if (already) { results[kind] = 0; continue; }
    // The automated cron wave only ever logs a summary count -- no
    // admin is watching a live message for it, so only .sent (not the
    // eligible/failed breakdown Bug 2 added for the manual trigger) is
    // needed here; this keeps runLeagueReminders' own summing logic
    // unchanged.
    results[kind] = (await sendLeagueReminderKind(env, leagueRow, cfg, ev, kind, { writeLog: true, quietHours: !!advancedSettings, night: games.length > 1 ? games : null })).queued;
  }
  return results;
}

// The cron entry point (scheduled(), below the export default). Scans
// every non-SMBHL, non-deactivated league's own OPEN events with a
// real start_time (no start_time = no countdown to measure against --
// the manual "send now" trigger still works for those, since it
// targets non-responders directly, not a time window) and sends
// whichever of the 3 waves have crossed their own threshold and
// haven't been sent yet for that event. Self-healing by construction:
// if a tick is ever missed, the NEXT tick still finds hoursUntil under
// the threshold and sends it late, rather than silently skipping it
// forever -- league_reminder_log is what prevents a duplicate send,
// not a narrow time window.
// failures: filled with { leagueId, message } for a league whose pass threw
// -- that league is skipped for this pass and the others still run (one
// bad league used to stop every league after it). src/health.js alerts on
// them.
export async function runLeagueReminders(env, budget = createSendBudget(sendsPerInvocation(env)), failures = []) {
  const log = [];
  const leagues = (await env.DB.prepare(
    `SELECT * FROM leagues WHERE id != ? AND deactivated_at IS NULL`
  ).bind(SMBHL_LEAGUE_ID).all()).results || [];

  // CPU (Workers Free plan, 10 ms a pass): a league with nothing that can
  // happen this pass is skipped outright -- no timed open game inside the
  // longest window any step looks at (the shortfall check's, 8 days), no
  // mail waiting to go out, and not on the advanced model (whose own
  // hours-before could reach further). For it, runOneLeague would read
  // its rows and do nothing, a few queries each, for every idle league.
  const { SHORTFALL_HORIZON_HOURS } = reminderHost();
  const busy = new Set(((await env.DB.prepare(
    `SELECT DISTINCT league_id FROM events
      WHERE state = 'open' AND start_time IS NOT NULL AND date >= ? AND date <= ?
     UNION SELECT DISTINCT league_id FROM outbox WHERE sent_at IS NULL AND cancelled = 0 AND failed_at IS NULL
     UNION SELECT league_id FROM league_capability_flags WHERE flag_key = 'advanced_reminders' AND enabled = 1`
  ).bind(localDateInDays(-1), localDateInDays(Math.ceil(SHORTFALL_HORIZON_HOURS / 24) + 1)).all()).results || []).map(r => r.league_id));

  for (const leagueRow of leagues) {
    if (!busy.has(leagueRow.id)) continue;
    try {
      await runOneLeague(env, leagueRow, budget, log);
    } catch (e) {
      failures.push({ leagueId: leagueRow.id, message: String(e && e.message || e).slice(0, 300) });
      log.push(`${leagueRow.id} FAILED: ${e && e.message}`);
    }
  }
  // Mail that belongs to no league (sign-up and password emails, deferred
  // when Resend's daily quota ran out) -- the per-league drains above never
  // pick it up. SMBHL's own cron drains everything, so it's covered there.
  const { drain } = reminderHost();
  const systemDrain = await drain(env, MAIL_SENDS_PER_INVOCATION, null, 'system', budget);
  if (systemDrain.sent > 0 || systemDrain.failed > 0) log.push(`system drain sent=${systemDrain.sent} failed=${systemDrain.failed}`);
  return log;
}

// The league-local date `days` from now (YYYY-MM-DD), for date windows.
export function localDateInDays(days, now = Date.now()) {
  return localParts(new Date(now + days * 86400000)).date;
}

// One league's pass (the body of runLeagueReminders' loop).
async function runOneLeague(env, leagueRow, budget, log) {
  const { getLeagueSeasonConfig, randomAssignEventTeams, callSubsForShortfall, drain } = reminderHost();
  {
    // Which cadence model this league is on (the advanced_reminders flag).
    const advancedSettings = (await usesAdvancedReminders(env, leagueRow.id)) ? await getEmailSettings(env.DB, leagueRow.id) : null;
    const horizon = advancedSettings
      ? Math.max(72, ...Object.keys(ADVANCED_LEAGUE_STEPS).map(k => advancedStepHours(advancedSettings, k)))
      : 72;
    // Live-testing task (batch 6), Part 10: an event created (or later
    // toggled) with auto_reminders_enabled = 0 is skipped entirely here
    // -- the per-event opt-out this part adds. Every pre-existing event
    // defaults to 1 (migrate-042.sql), so this filter changes nothing
    // for an event nobody has ever opted out.
    // CPU (Workers Free plan, 10 ms a pass): only the games whose date can
    // fall inside the horizon are read at all -- the loop below skipped
    // every other one anyway (hoursUntil <= 0 or > horizon), after
    // computing its start time. A day of margin on each side (dates are
    // league-local).
    const events = (await env.DB.prepare(
      `SELECT * FROM events WHERE league_id = ? AND state = 'open' AND start_time IS NOT NULL AND auto_reminders_enabled = 1
         AND date >= ? AND date <= ?`
    ).bind(leagueRow.id, localDateInDays(-1), localDateInDays(Math.ceil(horizon / 24) + 1)).all()).results || [];

    // Nights (D1): a league's games on the same day are one night -- one
    // set of emails, timed from its first game. Two seasons on one day are
    // two nights.
    const nights = new Map();
    for (const ev of events) {
      const key = `${ev.date}|${ev.season || ''}`;
      if (!nights.has(key)) nights.set(key, []);
      nights.get(key).push(ev);
    }
    for (const nightGames of nights.values()) {
    nightGames.sort(byStart);
    for (const ev of nightGames) {
      const start = eventStart(ev);
      if (!start) continue;
      const hoursUntil = (start.getTime() - Date.now()) / 3600000;
      if (hoursUntil <= 0 || hoursUntil > horizon) continue;

      // Season-level team-structure override task: resolved PER EVENT
      // (this event's own ev.season), not once per league -- a league
      // can have open events spanning more than one published season
      // (an older season's event left open while a new season is
      // already current), and each must use its OWN season's config,
      // not whichever season happens to be current right now.
      const cfg = await getLeagueSeasonConfig(env, leagueRow.id, ev.season);
      if (ev === nightGames[0]) {
        const results = await sendLeagueReminderWave(env, leagueRow, cfg, ev, hoursUntil, advancedSettings, nightGames);
        const total = results.reminder_72h + results.reminder_24h + results.logistics_12h;
        if (total > 0) log.push(`${leagueRow.id}:${ev.id} 72h=${results.reminder_72h} 24h=${results.reminder_24h} logistics=${results.logistics_12h}`);
      }

      // Live-testing task, Part 9: scheduled auto-draw, extending this
      // SAME cron rather than building a second trigger -- per the
      // standing principle (do not touch SMBHL's own cron, do not build
      // a second parallel scheduler when one already exists for this
      // exact "N hours before an event" purpose). Off by default
      // (auto_draw_enabled); only meaningful for weekly_draw. Runs the
      // EXACT same draw randomAssignEventTeams uses for the admin's own
      // manual button -- never a second copy of the shuffle logic.
      // league_auto_draw_log is the same self-healing idempotency
      // pattern as league_reminder_log: a missed tick still draws late
      // on the next one instead of skipping forever, and a re-run never
      // re-shuffles an event already drawn once.
      if (leagueRow.auto_draw_enabled && cfg.teamStructure === 'weekly_draw' && hoursUntil <= leagueRow.auto_draw_hours_before) {
        const alreadyDrawn = await env.DB.prepare('SELECT 1 FROM league_auto_draw_log WHERE event_id = ?').bind(ev.id).first();
        if (!alreadyDrawn) {
          const drawResult = await randomAssignEventTeams(env, leagueRow, ev, cfg);
          if (drawResult.ok) {
            await env.DB.prepare(
              `INSERT INTO league_auto_draw_log (event_id, league_id, drawn_at, assigned_count) VALUES (?, ?, ?, ?)
               ON CONFLICT(event_id) DO NOTHING`
            ).bind(ev.id, leagueRow.id, new Date().toISOString(), drawResult.assigned).run();
            log.push(`${leagueRow.id}:${ev.id} auto-draw assigned=${drawResult.assigned}`);
          }
        }
      }
    }
    }

    // Sub-call rework, Part 3: every pass, a team that can no longer
    // reach its minimum calls subs (queued here, delivered just below).
    try {
      // Only games callSubsForShortfall would look at: it returns at once
      // for one with no start time or more than SHORTFALL_HORIZON_HOURS out.
      const { SHORTFALL_HORIZON_HOURS } = reminderHost();
      const openEvents = (await env.DB.prepare(
        `SELECT * FROM events WHERE league_id = ? AND state = 'open' AND start_time IS NOT NULL AND date >= ? AND date <= ?`
      ).bind(leagueRow.id, localDateInDays(-1), localDateInDays(Math.ceil(SHORTFALL_HORIZON_HOURS / 24) + 1)).all()).results || [];
      for (const ev of openEvents) {
        const n = await callSubsForShortfall(env, ev);
        if (n) log.push(`${leagueRow.id}:${ev.id} shortfall: ${n} sub call(s) queued`);
      }
    } catch (e) { log.push(`${leagueRow.id} shortfall check failed: ${e.message}`); }

    // Delivers this league's outbox: the reminder waves and team-
    // assigned follow-ups queued above (outbox QA batch), plus sub-call
    // invites and retries. Every league shares ONE budget for the whole
    // invocation (src/mail_queue.js, sendsPerInvocation): once it is spent, the remaining
    // leagues' mail simply waits for the next pass (every 15 minutes on
    // demo) -- queued, never dropped.
    const leagueDrain = await drain(env, MAIL_SENDS_PER_INVOCATION, null, leagueRow.id, budget);
    if (leagueDrain.sent > 0 || leagueDrain.failed > 0) {
      log.push(`${leagueRow.id} drain sent=${leagueDrain.sent} failed=${leagueDrain.failed} retrying=${leagueDrain.retrying}`);
    }
  }
}

/* ---------- the cron's one entry point ---------- */

// Every reminder pass, for either product, starts here (index.js's
// scheduled()). A deployment serves one product: SMBHL's own (production)
// or the league product (LEAGUE_PRODUCT=true, demo). SMBHL is always on the
// advanced model (usesAdvancedReminders), and its advanced steps are
// runSchedule. On the league product, runLeagueReminders picks each
// league's model from its advanced_reminders flag.
export async function runReminderPass(env) {
  if (env.LEAGUE_PRODUCT === 'true') {
    const failures = [];
    return { product: 'leagues', log: await runLeagueReminders(env, createSendBudget(sendsPerInvocation(env)), failures), failures };
  }
  return { product: 'smbhl', log: await runSchedule(env), failures: [] };
}

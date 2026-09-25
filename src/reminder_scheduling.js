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
import { eventStart } from './league_ids.js';

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

  for (const kind of Object.keys(REMINDER_WINDOW_THRESHOLD_HOURS)) {
    if (!leagueRow[REMINDER_WINDOW_ENABLED_COLUMN[kind]]) continue;

    const existing = await env.DB.prepare(
      'SELECT skipped FROM league_reminder_log WHERE event_id = ? AND kind = ?'
    ).bind(ev.id, kind).first();

    if (existing && !existing.skipped) continue; // a real send already happened -- never touch

    const windowAlreadyPassed = hoursUntil <= REMINDER_WINDOW_THRESHOLD_HOURS[kind];

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

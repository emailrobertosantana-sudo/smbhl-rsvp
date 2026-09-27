// Outbox delivery policy: how many sends one Worker invocation may make,
// what counts as a transient vs permanent failure, how a row moves
// between states, and how retries are spaced. Deliberately free of any
// SMBHL- or league-specific logic and of index.js imports, so the
// planned shared reminder module can import it unchanged: callers pass
// in the D1 handle and do the actual rendering/sending themselves.
//
// ---------------------------------------------------------------------
// WHY 45 SENDS PER INVOCATION
// ---------------------------------------------------------------------
// Cloudflare Workers limits (developers.cloudflare.com/workers/platform/
// limits, checked 2026-09-26), per invocation -- a cron tick and an HTTP
// request are each one invocation:
//   Free plan:  50 subrequests (fetch) + 1,000 to internal services
//               (D1, KV, R2)
//   Paid plan:  10,000 by default (configurable up to 10M)
// Production failed on bursts of 15-30 sends, which only the Free
// plan's 50 can explain, so the cap is sized for Free (and is therefore
// safe on any plan).
//
// Measured cost, per send (test/part103, instrumented D1/KV/fetch on a
// realistic 60-player SMBHL week):
//   - before this change: 2 external fetches for every invite/chase/
//     gameday/friday_board/gameday_morning to a player with a team --
//     Resend, plus getTeamFixtures() re-fetching smbhl.com/data.json
//     for EVERY recipient. 50 / 2 = 25 sends, which is exactly why a
//     40-row pass failed its last 15 (the Sept 21 cluster: 15 invites).
//   - after: 1 (Resend). data.json is fetched once per drain and shared.
//   - ~8 D1 calls per send (worst kind: invite).
// Other external fetches the same cron invocation can make, worst case:
//   ensureNextEvent's data.json (1), deadMan's single combined alert
//   (1), drain's shared data.json (1), weekly-highlights' KV-miss
//   fallback fetch (1 per distinct week in the batch, 2 at most)
//   = 5 reserved.
// 50 - 5 = 45 sends. Internal calls at 45 sends: ~365 for the sends,
// up to ~360 for queueing a large invite wave in the same pass, ~20 for
// deadMan -- about 750 of 1,000, so the external limit is the binding
// one. At one pass every 5 minutes (production) that is 540 sends an
// hour; every 15 minutes (demo), 180 -- a backlog clears in a few
// passes and nothing is dropped, because anything over the cap simply
// stays queued.
export const EXTERNAL_SUBREQUEST_LIMIT = 50;
export const RESERVED_NON_SEND_SUBREQUESTS = 5;
export const MAIL_SENDS_PER_INVOCATION = EXTERNAL_SUBREQUEST_LIMIT - RESERVED_NON_SEND_SUBREQUESTS;

// One budget per invocation, shared by every drain() in it (the league
// cron drains once per league; a request may drain after enqueueing).
export function createSendBudget(max = MAIL_SENDS_PER_INVOCATION) {
  let used = 0;
  let halted = false;
  return {
    get remaining() { return halted ? 0 : Math.max(0, max - used); },
    take() { if (halted || used >= max) return false; used++; return true; },
    // After the platform itself refuses a subrequest, every further one
    // in this invocation will fail too -- stop instead of burning
    // attempts on rows that would each record a spurious failure.
    halt() { halted = true; },
    get used() { return used; }
  };
}

// ---------------------------------------------------------------------
// RETRY POLICY
// ---------------------------------------------------------------------
// 5 attempts in total. Retries wait 5, 15, 60, then 180 minutes, so the
// last attempt happens ~4h20 after the first. A transient failure that
// is still failing then becomes a permanent failure -- visible, and
// never retried forever.
export const MAX_SEND_ATTEMPTS = 5;
export const RETRY_BACKOFF_MINUTES = [5, 15, 60, 180];

export function isSubrequestLimitError(err) {
  return /too many subrequests/i.test(String(err && err.message || err));
}

// 'transient' = worth retrying; 'permanent' = retrying cannot help.
//
// Permanent means wrong for THIS message: a rejected or malformed
// recipient/content (Resend 400/404/409/422), an invalid address, or a
// row whose event/contact no longer exists.
//
// Configuration faults -- a missing RESEND_API_KEY, Resend 401 (bad
// key) or 403 (sender domain not verified) -- hit EVERY message until
// someone fixes them, so they are retried (bounded, ~4h20) instead:
// marking them permanent would lose every email sent during the
// outage. They surface anyway: Comms shows them retrying, deadMan
// alerts on anything still failing after an hour, and after the last
// attempt they become permanent failures.
export function classifySendError(err) {
  const msg = String(err && err.message || err || '');
  if (isSubrequestLimitError(msg)) return 'transient';
  const resend = msg.match(/^resend (\d{3})/);
  if (resend) {
    const status = Number(resend[1]);
    if ([400, 404, 409, 422].includes(status)) return 'permanent';
    return 'transient'; // 401/403 configuration, 429 rate limit, 5xx
  }
  if (/invalid email format|no email on file|event gone|contact gone|unknown kind/i.test(msg)) return 'permanent';
  return 'transient'; // network errors, timeouts, missing API key, anything unexpected -- bounded by MAX_SEND_ATTEMPTS
}

// ---------------------------------------------------------------------
// STATES (one outbox row)
// ---------------------------------------------------------------------
//   queued    sent_at NULL, cancelled 0, error NULL
//   retrying  sent_at NULL, cancelled 0, error set, next_attempt_at set
//   sent      sent_at set, error NULL            (never both -- see below)
//   failed    failed_at set, cancelled 1, error set (permanent; also
//             cancelled so every existing "pending = sent_at IS NULL AND
//             cancelled = 0" query already excludes it)
//   deferred  sent_at NULL, cancelled 0, defer_reason set (daily cap:
//             waits for the next UTC day's budget; see DAILY SEND CAP)
//   skipped   cancelled 1, failed_at NULL (deliberate: opted out, no
//             longer confirmed, superseded by a newer message, ...)
// last_error keeps the most recent failure text even after a later
// success, so history survives without breaking "sent means sent".
export const OUTBOX_DUE_WHERE =
  'sent_at IS NULL AND cancelled = 0 AND failed_at IS NULL AND send_after <= ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)';

export function outboxRowStatus(row) {
  if (row.sent_at) return 'sent';
  if (row.failed_at) return 'failed';
  if (row.cancelled) return 'skipped';
  if (row.error) return 'retrying';
  if (row.defer_reason) return 'deferred'; // waiting for tomorrow's send budget (daily cap)
  return 'pending';
}

export async function recordSendSuccess(db, id, now = new Date()) {
  await db.prepare(
    `UPDATE outbox SET sent_at = ?, error = NULL, next_attempt_at = NULL, defer_reason = NULL, attempts = attempts + 1 WHERE id = ?`
  ).bind(now.toISOString(), id).run();
}

// Returns 'retrying' or 'failed'.
export async function recordSendFailure(db, row, err, now = new Date()) {
  const message = String(err && err.message || err || 'unknown error').slice(0, 300);
  const attempts = Number(row.attempts || 0) + 1;
  const permanent = classifySendError(err) === 'permanent' || attempts >= MAX_SEND_ATTEMPTS;
  if (permanent) {
    const reason = classifySendError(err) === 'permanent' ? message : `gave up after ${attempts} attempts: ${message}`;
    await db.prepare(
      `UPDATE outbox SET error = ?, last_error = ?, attempts = ?, failed_at = ?, cancelled = 1, next_attempt_at = NULL WHERE id = ?`
    ).bind(reason.slice(0, 300), message, attempts, now.toISOString(), row.id).run();
    return 'failed';
  }
  const waitMin = RETRY_BACKOFF_MINUTES[Math.min(attempts - 1, RETRY_BACKOFF_MINUTES.length - 1)];
  await db.prepare(
    `UPDATE outbox SET error = ?, last_error = ?, attempts = ?, next_attempt_at = ? WHERE id = ?`
  ).bind(message, message, attempts, new Date(now.getTime() + waitMin * 60000).toISOString(), row.id).run();
  return 'retrying';
}

// ---------------------------------------------------------------------
// DAILY SEND CAP (sub-call rework, Part 1)
// ---------------------------------------------------------------------
// The Resend plan allows a fixed number of emails per calendar day
// (UTC). The number is configuration -- MAIL_DAILY_CAP in wrangler.jsonc
// vars -- never a constant here, so a plan upgrade is a config change.
// Not set / not a positive number: no cap is enforced (and every drain
// logs a warning).
//
// Who gets the budget:
//   - everything that is NOT a sub call (gameday mail, reminders,
//     logistics, team assignments, admin alerts, the dead-man check)
//     always sends, and is processed before sub calls in every pass;
//   - sub calls get only what is left after reserving room for the
//     roster mail still to come today (rosterReserve, computed by the
//     caller), and are DEFERRED to the next UTC day -- queued, never
//     dropped -- once it is gone.
//
// Counting: sendMail() adds one to mail_daily_count(day) after every
// send Resend accepts, whatever the path (outbox, alerts, broadcasts,
// sign-up mail). It is stored in D1, so a Worker restart loses nothing.
// If Resend itself refuses for quota (it counts every sender on the
// account), recordResendQuotaExhausted() marks the day full so nothing
// else is attempted until the next UTC day.
export const ADMIN_ALERT_RESERVE = 3;

export function dailyCapFromEnv(env) {
  const n = Number(env && env.MAIL_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function nextUtcMidnight(now = new Date()) {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

export function isResendQuotaError(err) {
  const msg = String(err && err.message || err || '');
  return /^resend 429/.test(msg) && /quota/i.test(msg);
}

export async function countSentMail(db, { subCall = false } = {}, now = new Date()) {
  await db.prepare(
    `INSERT INTO mail_daily_count (day, sent, sub_calls) VALUES (?, 1, ?)
     ON CONFLICT(day) DO UPDATE SET sent = sent + 1, sub_calls = sub_calls + excluded.sub_calls`
  ).bind(utcDay(now), subCall ? 1 : 0).run();
}

export async function recordResendQuotaExhausted(db, cap, now = new Date()) {
  if (!cap) return;
  await db.prepare(
    `INSERT INTO mail_daily_count (day, sent, sub_calls) VALUES (?, ?, 0)
     ON CONFLICT(day) DO UPDATE SET sent = MAX(sent, excluded.sent)`
  ).bind(utcDay(now), cap).run();
}

export async function readDailyCount(db, now = new Date()) {
  const row = await db.prepare('SELECT sent, sub_calls FROM mail_daily_count WHERE day = ?').bind(utcDay(now)).first();
  return { sent: row ? row.sent : 0, subCalls: row ? row.sub_calls : 0 };
}

// How many sub calls may still go out today.
//   allowance = cap - sentToday - max(0, reserve - rosterSentToday)
// where rosterSentToday = everything sent today that was not a sub call.
//
// The reserve is an estimate (one email per rostered player on every
// open game in the next 6 days), and it can reach the whole cap -- demo:
// 14 against a cap of 10 -- which would defer sub calls to "tomorrow"
// every day, forever. So it never holds back more than
// ROSTER_RESERVE_MAX_SHARE of the cap: sub calls always get at least the
// rest. Roster mail is unaffected (it is never held back by the cap).
export const ROSTER_RESERVE_MAX_SHARE = 0.8;
export function subCallAllowance({ cap, sentToday, subCallsToday, reserve }) {
  if (!cap) return Infinity;
  const rosterSentToday = Math.max(0, sentToday - subCallsToday);
  const reserveLeft = Math.max(0, Math.min(reserve, Math.floor(cap * ROSTER_RESERVE_MAX_SHARE)) - rosterSentToday);
  return Math.max(0, cap - sentToday - reserveLeft);
}

// until: when the budget is back -- the caller passes the next UTC
// midnight moved past quiet hours (index.js deferralTarget), so a backlog
// never goes out at 3am just because that is when the budget freed up.
export async function deferToNextDay(db, id, reason, now = new Date(), until = null) {
  await db.prepare(
    `UPDATE outbox SET next_attempt_at = ?, defer_reason = ? WHERE id = ?`
  ).bind((until || nextUtcMidnight(now)).toISOString(), reason, id).run();
}

// Thrown by sendMail() when Resend refused for quota and the email was
// queued for later instead (deferred, not lost). A caller that reports
// to a person must say "deferred", never "sent"; a caller that doesn't
// catch it reports an error -- never a false success.
export class MailDeferredError extends Error {
  constructor(until, reason = 'resend_quota') {
    super(`email deferred until ${until} (${reason})`);
    this.name = 'MailDeferredError';
    this.deferred = true;
    this.until = until;
    this.reason = reason;
  }
}
export function isMailDeferred(err) {
  return !!(err && err.deferred === true);
}

// A queued copy lives in one outbox row (D1 rows max out at 2 MB); an
// email too big to store -- large attachments -- is not queued, and its
// send fails visibly instead.
export const MAX_QUEUED_MAIL_BYTES = 1500000;

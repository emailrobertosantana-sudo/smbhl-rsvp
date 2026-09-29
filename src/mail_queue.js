// Outbox delivery policy: how many sends one Worker invocation may make,
// what counts as a transient vs permanent failure, how a row moves
// between states, and how retries are spaced. Deliberately free of any
// SMBHL- or league-specific logic and of index.js imports, so the
// planned shared reminder module can import it unchanged: callers pass
// in the D1 handle and do the actual rendering/sending themselves.
//
// ---------------------------------------------------------------------
// HOW MANY SENDS PER INVOCATION
// ---------------------------------------------------------------------
// History: until 2026-09-29 the account was on the Workers Free plan, 50
// external subrequests per invocation, and this was 45 (50 minus 5
// reserved for the pass's other fetches). Production failed on bursts of
// 15-30 sends before that (test/part103). The account is now on Workers
// Paid: 10,000 subrequests per invocation (D1 and KV included), 30 s of
// CPU. A send costs 1 external fetch (Resend) and ~8 D1 calls, so the
// subrequest limit no longer binds anything this app can queue.
//
// What binds now, and sets the number:
//   1. Resend's day (MAIL_DAILY_CAP; 90 on production, shared with
//      demo). One pass never sends more than DAY_SHARE_PER_PASS of it,
//      so a single pass cannot spend the day: at 90 that is 60 -- a
//      whole SMBHL invite wave (42-44 in September, 60 at most) in one
//      pass instead of two, with a third of the day left for the chase,
//      sub calls and alerts. It does not replace the daily-cap deferral
//      below; it only bounds one pass.
//   2. Time. Sends are sequential; production's slowest measured burst
//      ran 2.3 s a send (42 sends, 96 s, Sept 28). MAIL_SENDS_CEILING
//      keeps a pass at ~4 minutes worst case, inside production's
//      5-minute cron interval. (A pass that did overrun cannot double-
//      send: drain() claims each row before sending it -- claimOutboxRow.)
// With no MAIL_DAILY_CAP configured, the ceiling alone applies.
export const MAIL_SENDS_CEILING = 100;
export const DAY_SHARE_PER_PASS = 2 / 3;
// The per-call `limit` default drain() callers pass; the invocation's
// budget (sendsPerInvocation) is what actually bounds a pass.
export const MAIL_SENDS_PER_INVOCATION = MAIL_SENDS_CEILING;
// MAIL_SENDS_PER_PASS overrides it only for the recorded-behaviour
// (golden) tests, whose passes are hours apart -- never set on a deployment.
export function sendsPerInvocation(env) {
  const pinned = Number(env && env.MAIL_SENDS_PER_PASS);
  if (Number.isFinite(pinned) && pinned > 0) return Math.floor(pinned);
  const cap = dailyCapFromEnv(env);
  if (!cap) return MAIL_SENDS_CEILING;
  return Math.max(1, Math.min(MAIL_SENDS_CEILING, Math.floor(cap * DAY_SHARE_PER_PASS)));
}

// One budget per invocation, shared by every drain() in it (the league
// cron drains once per league; a request may drain after enqueueing).
export function createSendBudget(max = MAIL_SENDS_CEILING) {
  let used = 0;
  let halted = false;
  return {
    get remaining() { return halted ? 0 : Math.max(0, max - used); },
    take() { if (halted || used >= max) return false; used++; return true; },
    // A taken send that did not happen (another drain had claimed the row).
    refund() { if (used > 0) used--; },
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

// Claim: drain() takes a row for itself before sending it, so two drains
// running at once -- a cron pass that overran, or a manual "send now"
// during a pass -- never send the same row twice. The claim is the row's
// next_attempt_at pushed CLAIM_MINUTES ahead, written only if the row is
// still due and unsent; whichever drain's write lands owns the row. The
// send then settles it (recordSendSuccess clears next_attempt_at,
// recordSendFailure/deferToNextDay set their own). A Worker that dies
// mid-send leaves the row due again after CLAIM_MINUTES. No new column.
export const CLAIM_MINUTES = 15;
export async function claimOutboxRow(db, id, now = new Date()) {
  const iso = now.toISOString();
  const r = await db.prepare(
    `UPDATE outbox SET next_attempt_at = ? WHERE id = ? AND ${OUTBOX_DUE_WHERE}`
  ).bind(new Date(now.getTime() + CLAIM_MINUTES * 60000).toISOString(), id, iso, iso).run();
  return !!(r && r.meta && r.meta.changes === 1);
}

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

// HARD daily cap (MAIL_HARD_DAILY_CAP): every kind of email counts, and once
// the day's count reaches it nothing more is sent that UTC day -- mail waits
// for the next one, exactly as when Resend refuses for its own quota. For a
// deployment that shares a Resend account it must not spend: demo shares
// production's 90 a day, and MAIL_DAILY_CAP only holds back sub calls (demo
// sent 11 and 13 on Sept 27-28 against its 10). Not set on production.
export function hardDailyCapFromEnv(env) {
  const n = Number(env && env.MAIL_HARD_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
export function hardCapError(cap) {
  // Worded so isResendQuotaError() treats it as Resend's own quota refusal.
  return new Error(`resend 429: daily quota reached -- this deployment's hard daily cap (${cap}, MAIL_HARD_DAILY_CAP)`);
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

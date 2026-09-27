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
  return 'pending';
}

export async function recordSendSuccess(db, id, now = new Date()) {
  await db.prepare(
    `UPDATE outbox SET sent_at = ?, error = NULL, next_attempt_at = NULL, attempts = attempts + 1 WHERE id = ?`
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

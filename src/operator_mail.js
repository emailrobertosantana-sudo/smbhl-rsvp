// Operator alerts by email (email alerts batch, item 1). ntfy.sh refuses
// publishes from Cloudflare's shared addresses (a 429 in 162 ms, access
// token or not), so every operator alert (new league, new subscription,
// stuck mail, the five sending rules, the dead-man alert, the health
// alerts, the super-admin test) is also sent by email to
// OPERATOR_ALERT_EMAIL, when that variable is set. Without it nothing here
// runs and every alert behaves as before (SMBHL production today).
//
// The email is sent straight to the provider: never through sendMail, the
// outbox, the daily caps, the free-league cap or the five sending rules
// (src/mail_guard.js), so an alert is never held, counted or queued, and
// an alert about mail that does not go out can still go out. Cloudflare
// Email Sending when the environment uses it for Notre Ligue's domain
// (src/mail_provider.js), Resend otherwise.
//
// Flooding: at most OPERATOR_MAIL_PER_HOUR emails an hour. Past that, an
// alert is grouped, and one summary email lists the hour's grouped alerts
// once the hour is over (the next alert or the next cron pass sends it).
// State: settings rows 'ops_mail:count:<hour>' and 'ops_mail:grouped:<hour>'
// (an hour is 'YYYY-MM-DDTHH', UTC). No migration.
//
// Privacy: the address is never shown, logged or returned; errors are
// scrubbed of addresses before they are logged or shown.
import { chooseMailProvider, parseAddress } from './mail_provider.js';

export const OPERATOR_MAIL_PER_HOUR = 10;
const COUNT_PREFIX = 'ops_mail:count:';
const GROUPED_PREFIX = 'ops_mail:grouped:';
const SEND_TIMEOUT_MS = 10000;

const isSmbhl = env => {
  let host = '';
  try { host = new URL(env.PUBLIC_URL || 'https://rsvp.smbhl.com').hostname; } catch (_) {}
  return host.includes('smbhl.com');
};

// « [Notre Ligue] » on Notre Ligue, « [SMBHL] » on SMBHL: what Roberto
// filters on.
export function operatorSubjectPrefix(env) {
  return env && env.LEAGUE_PRODUCT === 'true' ? '[Notre Ligue]' : (isSmbhl(env) ? '[SMBHL]' : '[Notre Ligue]');
}

// The From of an alert: Notre Ligue's alerts address on mail.notreligue.ca
// (the domain Cloudflare Email Sending is set up for), SMBHL's own sender
// on SMBHL.
export function operatorFrom(env) {
  return isSmbhl(env) && env.LEAGUE_PRODUCT !== 'true'
    ? 'SMBHL alertes <joueur@smbhl.com>'
    : 'Notre Ligue alertes <alertes@mail.notreligue.ca>';
}

export function operatorEmailConfigured(env) {
  return !!(env && String(env.OPERATOR_ALERT_EMAIL || '').trim());
}

const scrub = s => String(s == null ? '' : s)
  .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[courriel/email]');
const hourKey = now => now.toISOString().slice(0, 13);

async function getJson(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  if (!row || !row.value) return null;
  try { return JSON.parse(row.value); } catch (_) { return null; }
}
async function putJson(db, key, value) {
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, JSON.stringify(value)).run();
}
async function rowsWithPrefix(db, prefix) {
  return (await db.prepare('SELECT key, value FROM settings WHERE key >= ? AND key < ?').bind(prefix, prefix + '￿').all()).results || [];
}

// One email to the operator, straight to the provider. Returns
// { sent, provider, status, ms, error }: status is Resend's HTTP status, or
// 'accepted' for Cloudflare Email Sending (a binding, no HTTP status).
export async function deliverOperatorEmail(env, subject, text) {
  const to = String(env.OPERATOR_ALERT_EMAIL || '').trim();
  const from = operatorFrom(env);
  const started = Date.now();
  const provider = chooseMailProvider(env, from) === 'cloudflare' && env.SEND_EMAIL && typeof env.SEND_EMAIL.send === 'function' ? 'cloudflare' : 'resend';
  try {
    if (provider === 'cloudflare') {
      const f = parseAddress(from);
      await env.SEND_EMAIL.send({ from: { email: f.email, name: f.name }, to, subject, text });
      return { sent: true, provider, status: 'accepted', ms: Date.now() - started, error: '' };
    }
    if (!env.RESEND_API_KEY) return { sent: false, provider, status: 0, ms: 0, error: 'no_resend_key' };
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
    if (!res.ok) return { sent: false, provider, status: res.status, ms: Date.now() - started, error: `resend ${res.status}` };
    return { sent: true, provider, status: res.status, ms: Date.now() - started, error: '' };
  } catch (e) {
    const msg = e && e.name === 'TimeoutError' ? 'timeout' : scrub((e && e.message) || 'error').slice(0, 160);
    console.error(`[ops-mail] alert email failed (${provider}): ${msg}`);
    return { sent: false, provider, status: 0, ms: Date.now() - started, error: msg };
  }
}

// The summary of each finished hour that had grouped alerts: one email per
// hour, then that hour's rows go. Also clears finished hours' counters.
export async function flushOperatorSummaries(env, now = new Date()) {
  if (!operatorEmailConfigured(env) || !env.DB) return 0;
  const current = hourKey(now);
  let sent = 0;
  for (const row of await rowsWithPrefix(env.DB, GROUPED_PREFIX)) {
    const hour = row.key.slice(GROUPED_PREFIX.length);
    if (hour >= current) continue;
    let list = [];
    try { list = JSON.parse(row.value) || []; } catch (_) {}
    if (list.length) {
      const when = `${hour.slice(0, 10)} ${hour.slice(11, 13)}:00 UTC`;
      const subject = `${operatorSubjectPrefix(env)} ${list.length} ${list.length > 1 ? 'alertes regroupées' : 'alerte regroupée'} / ${list.length > 1 ? 'grouped alerts' : 'grouped alert'}`;
      const lines = list.map(a => `- ${a.at ? a.at.slice(11, 16) + ' UTC ' : ''}${a.title}`).join('\n');
      const text = `Plus de ${OPERATOR_MAIL_PER_HOUR} alertes dans l'heure de ${when} : celles-ci ont été regroupées.\n\n`
        + `More than ${OPERATOR_MAIL_PER_HOUR} alerts in the hour of ${when}: these were grouped.\n\n${scrub(lines)}`;
      const r = await deliverOperatorEmail(env, subject, text);
      if (!r.sent) continue; // kept: the next pass tries again
      sent++;
    }
    await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(row.key).run();
  }
  for (const row of await rowsWithPrefix(env.DB, COUNT_PREFIX)) {
    if (row.key.slice(COUNT_PREFIX.length) < current) await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(row.key).run();
  }
  return sent;
}

// An operator alert by email: the prefix, then the title; the body as the
// webhook has it. opts.bypassLimit: the super-admin's test (a manual check,
// neither counted nor grouped). Returns { sent, grouped, provider, status,
// ms, error } (sent false and error 'not_configured' without the variable).
export async function sendOperatorEmail(env, title, text, { bypassLimit = false } = {}, now = new Date()) {
  if (!operatorEmailConfigured(env)) return { sent: false, grouped: false, provider: '', status: 0, ms: 0, error: 'not_configured' };
  const subject = `${operatorSubjectPrefix(env)} ${scrub(title)}`.slice(0, 250);
  const body = scrub(text);
  if (env.DB && !bypassLimit) {
    try { await flushOperatorSummaries(env, now); } catch (e) { console.error(`[ops-mail] summary: ${scrub(e && e.message)}`); }
    const hour = hourKey(now);
    const countKey = COUNT_PREFIX + hour;
    const count = Number((await getJson(env.DB, countKey)) || 0);
    if (count >= OPERATOR_MAIL_PER_HOUR) {
      const groupKey = GROUPED_PREFIX + hour;
      const list = (await getJson(env.DB, groupKey)) || [];
      list.push({ at: now.toISOString(), title: scrub(title).slice(0, 200) });
      await putJson(env.DB, groupKey, list.slice(-200));
      return { sent: false, grouped: true, provider: '', status: 0, ms: 0, error: '' };
    }
    await putJson(env.DB, countKey, count + 1);
  }
  return { grouped: false, ...(await deliverOperatorEmail(env, subject, body)) };
}

// Operator alerts by email (email alerts batch, item 1): with
// OPERATOR_ALERT_EMAIL set, every operator alert is an email with the
// « [Notre Ligue] » prefix, sent straight to the provider (never the
// outbox, the caps or the sending rules), at most 10 an hour then one
// summary; the webhook is still tried when set and never holds the email
// up; the super-admin test reports both channels; the address and the
// token are never shown.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must } from './support/league_season.js';
import { alertSubscriptionActive } from '../src/operator_alerts.js';
import { notifyAlerts, checkCronOnRequest, postWebhook } from '../src/health.js';
import { trip } from '../src/mail_guard.js';
import { deadMan } from '../src/index.js';
import { sendOperatorEmail, flushOperatorSummaries, deliverOperatorEmail, OPERATOR_MAIL_PER_HOUR } from '../src/operator_mail.js';

const NOW = Date.UTC(2026, 9, 14, 16, 0); // Wednesday 2026-10-14, 12:00 Montreal
const OPS = 'ops.p240@example.com';
const HOOK = 'https://ntfy.sh/p240-secret-topic';
const TOKEN = 'tk_p240_secret';
const KEY = 'p240-admin-key';
const BASE = 'https://rsvp.p240.example';
const cf = [];      // Cloudflare Email Sending
const resend = [];  // Resend (everything else, players' mail included)
const hooks = [];
let hookMode = 200;
let cfMode = 'ok';
let originalFetch;

const opsMails = () => cf.filter(m => m.to === OPS);

beforeAll(async () => {
  Object.assign(env, { LEAGUE_PRODUCT: 'true', RESEND_API_KEY: 'x', RSVP_SECRET: 'p240', AUTH_SECRET: 'p240-auth', ADMIN_KEY: KEY,
    ALERT_WEBHOOK_URL: HOOK, OPERATOR_ALERT_EMAIL: OPS, PUBLIC_URL: BASE, MAIL_PROVIDER: 'cloudflare', ADMIN_EMAIL: 'admin.p240@example.com' });
  delete env.ALERT_WEBHOOK_TOKEN;
  Object.defineProperty(env, 'SEND_EMAIL', { configurable: true, writable: true, value: { send: async m => {
    if (cfMode === 'throw') throw new Error(`destination ${m.to} refused`);
    cf.push(m); return { messageId: '<x@mail.notreligue.ca>' };
  } } });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  await applyRealSchema(env);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url && url.url ? url.url : url);
    if (u.includes('api.resend.com')) { resend.push(JSON.parse(opts.body)); return new Response('{"id":"x"}', { status: 200 }); }
    if (u === HOOK) {
      hooks.push({ title: decodeURIComponent((opts.headers && opts.headers.Title) || ''), auth: opts.headers && opts.headers.Authorization });
      if (hookMode === 'hang') return new Promise((_, reject) => { if (opts.signal) opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))); });
      return new Response('{}', { status: hookMode });
    }
    return new Response('{}', { status: 404 });
  };
});
afterAll(() => { globalThis.fetch = originalFetch; vi.useRealTimers(); delete env.OPERATOR_ALERT_EMAIL; delete env.SEND_EMAIL; delete env.MAIL_PROVIDER; });
beforeEach(async () => {
  vi.setSystemTime(new Date(NOW));
  cf.length = 0; resend.length = 0; hooks.length = 0; hookMode = 200; cfMode = 'ok';
  await env.DB.prepare("DELETE FROM settings WHERE key >= 'ops_mail:' AND key < 'ops_mail;'").run();
});

const one = (list) => { expect(list).toHaveLength(1); return list[0]; };
const outboxAlerts = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE payload LIKE ?").bind(`%${OPS}%`).first()).n;

describe('each alert kind: one email with the prefix', () => {
  it('a new league: the title, the body and the super-admin link; from « Notre Ligue alertes »', async () => {
    const a = await admin('p240one');
    const created = await must(a.post('/leagues/create', { name: 'Les Castors', teamNames: ['A', 'B'], languageMode: 'fr' }), 'create');
    const m = one(opsMails());
    expect(m.subject).toBe('[Notre Ligue] Notre Ligue : nouvelle ligue / new league');
    expect(m.from).toEqual({ email: 'alertes@mail.notreligue.ca', name: 'Notre Ligue alertes' });
    expect(m.text).toContain('Les Castors : Équipes fixes');
    expect(m.text).toContain(`${BASE}/super-admin/league?id=${created.league.id}`);
    expect(m.text).not.toContain('admin.p240one@example.com');
    expect(m.html).toBeUndefined();
    // The webhook too, as before.
    expect(hooks.map(h => h.title)).toEqual(['Notre Ligue : nouvelle ligue / new league']);
    expect(await outboxAlerts()).toBe(0);
  });

  it('a new subscription', async () => {
    const a = await admin('p240sub');
    const created = await must(a.post('/leagues/create', { name: 'Ligue Abonnée', teamNames: ['A', 'B'] }), 'create');
    cf.length = 0;
    await alertSubscriptionActive(env, { leagueId: created.league.id, sub: { id: 'sub_p240' }, status: 'active', tier: 'standard', interval: 'month' });
    const m = one(opsMails());
    expect(m.subject).toBe('[Notre Ligue] Notre Ligue : nouvel abonnement / new subscription');
    expect(m.text).toContain('Ligue Abonnée : forfait Standard, mensuel');
  });

  it('a sending rule: paused, with the super-admin link', async () => {
    await trip(env, { scope: 'global', rule: '2d', numbers: { hour: 120 } });
    const m = one(opsMails());
    expect(m.subject).toBe('[Notre Ligue] Notre Ligue : envois en pause / sending paused (Everything at once)');
    expect(m.text).toContain(`${BASE}/super-admin/leagues`);
    await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'mailguard:%'").run();
  });

  it('a health alert (stuck mail): by alert email only, the capped ops email is not sent too', async () => {
    const host = { sendMail: vi.fn(), leagueAdminEmails: async () => [], renderAdminAlert: () => ({}), opsEmail: 'admin.p240@example.com', publicUrl: BASE };
    const alerts = [{ storeKey: 'health:alert:system:p240', scope: 'system', key: 'outbox_stuck', fr: '2 messages bloqués', en: '2 messages stuck', ops_notified_at: null, admin_notified_at: 'x' }];
    const log = await notifyAlerts(env, host, alerts);
    const m = one(opsMails());
    expect(m.subject).toBe('[Notre Ligue] Notre Ligue : 1 alerte / alert');
    expect(m.text).toContain('2 messages bloqués');
    expect(m.text).toContain(`${BASE}/health/status`);
    expect(host.sendMail).not.toHaveBeenCalled();
    expect(log.join(' ')).toMatch(/ops told: 1/);
    expect(alerts[0].ops_notified_at).toBeTruthy();
  });

  it('the dead-man alert: one email, and marked as raised', async () => {
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, dedup_key, payload, send_after, created_at, error, league_id) VALUES ('gameday', 'smbhl:2026-10-18', 'P1', 'p240:1', '{}', '2026-10-14T10:00:00Z', '2026-10-14T10:00:00Z', 'upstream', 'smbhl')`).run();
    await deadMan(env);
    const m = one(opsMails());
    expect(m.subject).toBe('[Notre Ligue] SMBHL : le système a manqué quelque chose / something did not run');
    expect(m.text).toContain("1 message bloqué dans la file d'envoi");
    expect(m.text).toContain('1 message stuck in the email queue');
    // Not also through sendMail to the admin address (Resend).
    expect(resend.filter(r => String(r.subject).includes('something did not run'))).toHaveLength(0);
    cf.length = 0;
    await deadMan(env);
    expect(opsMails()).toHaveLength(0);
  });

  it('a stopped cron: one email, not the capped ops email', async () => {
    await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind('health:cron:leagues', JSON.stringify({ last_ok_at: new Date(NOW - 3 * 3600000).toISOString() })).run();
    const host = { sendMail: vi.fn(), opsEmail: 'admin.p240@example.com' };
    await checkCronOnRequest(env, host);
    const m = one(opsMails());
    expect(m.subject).toBe('[Notre Ligue] Notre Ligue : cron leagues arrêté / stopped');
    expect(host.sendMail).not.toHaveBeenCalled();
  });
});

describe('flooding: at most 10 an hour, then one summary', () => {
  it('the 11th and 12th are grouped; the next hour sends one summary listing them', async () => {
    for (let i = 1; i <= 12; i++) await sendOperatorEmail(env, `Alerte ${i}`, 'texte');
    expect(opsMails()).toHaveLength(OPERATOR_MAIL_PER_HOUR);
    expect(OPERATOR_MAIL_PER_HOUR).toBe(10);
    cf.length = 0;
    // Still the same hour: nothing more.
    vi.setSystemTime(new Date(NOW + 50 * 60000));
    expect(await flushOperatorSummaries(env)).toBe(0);
    expect(opsMails()).toHaveLength(0);
    // The hour is over (the cron's pass, or the next alert, sends it).
    vi.setSystemTime(new Date(NOW + 65 * 60000));
    expect(await flushOperatorSummaries(env)).toBe(1);
    const m = one(opsMails());
    expect(m.subject).toBe('[Notre Ligue] 2 alertes regroupées / grouped alerts');
    expect(m.text).toContain('- 16:00 UTC Alerte 11');
    expect(m.text).toContain('- 16:00 UTC Alerte 12');
    expect(m.text).not.toContain('Alerte 10');
    // Sent once; the new hour starts from zero.
    cf.length = 0;
    expect(await flushOperatorSummaries(env)).toBe(0);
    await sendOperatorEmail(env, 'Alerte 13', 'texte');
    expect(opsMails().map(x => x.subject)).toEqual(['[Notre Ligue] Alerte 13']);
  });
});

describe('the webhook never blocks the email', () => {
  it('ntfy refusing (429): the email goes, and the alert counts as told', async () => {
    hookMode = 429;
    expect(await postWebhook(env, 'Titre', 'Texte')).toBe(true);
    expect(one(opsMails()).subject).toBe('[Notre Ligue] Titre');
  });

  it('ntfy hanging: the email is already sent; the webhook gives up after 4 s', async () => {
    hookMode = 'hang';
    const t = performance.now();
    expect(await postWebhook(env, 'Titre lent', 'Texte')).toBe(true);
    expect(performance.now() - t).toBeLessThan(9000);
    expect(one(opsMails()).subject).toBe('[Notre Ligue] Titre lent');
  }, 20000);

  it('the email failing: the webhook still counts; the address never in the error or the log', async () => {
    cfMode = 'throw';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await deliverOperatorEmail(env, 'x', 'y');
      expect(r).toMatchObject({ sent: false, provider: 'cloudflare', status: 0 });
      expect(r.error).not.toContain(OPS);
      expect(r.error).toContain('[courriel/email]');
      expect(errors.mock.calls.flat().join(' ')).not.toContain(OPS);
      expect(await postWebhook(env, 'Titre', 'Texte')).toBe(true);
    } finally { errors.mockRestore(); }
  });

  it('without OPERATOR_ALERT_EMAIL: no alert email, the webhook as before', async () => {
    delete env.OPERATOR_ALERT_EMAIL;
    try {
      expect(await postWebhook(env, 'Titre', 'Texte')).toBe(true);
      expect(cf).toHaveLength(0);
      expect(hooks).toHaveLength(1);
    } finally { env.OPERATOR_ALERT_EMAIL = OPS; }
  });
});

describe('the super-admin test: both channels', () => {
  const press = () => SELF.fetch('http://example.com/super-admin/alert/test', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin': KEY }, body: '{}' });

  it('email and webhook each say sent or not, the status and the time; no address, no token', async () => {
    env.ALERT_WEBHOOK_TOKEN = TOKEN;
    hookMode = 429;
    try {
      const res = await press();
      const raw = await res.text();
      const r = JSON.parse(raw);
      expect(r.email).toMatchObject({ configured: true, sent: true, provider: 'cloudflare', status: 'accepted' });
      expect(r.webhook).toMatchObject({ configured: true, sent: false, status: 429, token: true });
      expect(typeof r.email.ms).toBe('number');
      expect(typeof r.webhook.ms).toBe('number');
      expect(one(opsMails()).subject).toBe("[Notre Ligue] Notre Ligue : test d'alerte / alert test");
      for (const secret of [OPS, TOKEN, 'p240-secret-topic']) expect(raw).not.toContain(secret);
    } finally { delete env.ALERT_WEBHOOK_TOKEN; }
  });

  it('the test is not counted nor grouped by the hourly limit', async () => {
    for (let i = 0; i < OPERATOR_MAIL_PER_HOUR; i++) await sendOperatorEmail(env, `A${i}`, 't');
    cf.length = 0;
    const r = await (await press()).json();
    expect(r.email.sent).toBe(true);
    expect(opsMails()).toHaveLength(1);
  });

  it('the super-admin page never shows the address', async () => {
    const html = await (await SELF.fetch('http://example.com/super-admin/leagues', { headers: { 'x-admin': KEY } })).text();
    expect(html).toContain('id="sa-test-alert"');
    expect(html).not.toContain(OPS);
  });
});

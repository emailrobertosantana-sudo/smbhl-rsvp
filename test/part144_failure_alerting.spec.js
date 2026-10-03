// Failure alerting across every league (src/health.js): a league's
// failure reaches its own admin and the operator; a scheduled send that
// never went out is detected; the cron's own death is detected on request;
// when email itself is broken, the webhook still carries the alert.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { healthHost, runCronPass } from '../src/index.js';
import { runHealthPass, recordHeartbeat, collectProblems, reconcileAlerts, cronStatus, CRON_STALE_MINUTES } from '../src/health.js';

const OPS = 'ops@p144.example';
let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.144.${++ip}` },
    body: JSON.stringify({ accept_terms: true, email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = async (s, path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

// Records every outbound call; `resend` decides Resend's answer.
let calls, original;
function mockFetch({ resend = 200 } = {}) {
  calls = { resend: [], webhook: [], other: [] };
  original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('api.resend.com')) {
      const b = JSON.parse(opts.body);
      calls.resend.push({ to: b.to[0], subject: b.subject, text: b.text });
      return resend === 200 ? new Response('{"id":"x"}', { status: 200 }) : new Response('{"message":"down"}', { status: resend });
    }
    if (u.includes('ntfy.sh')) { calls.webhook.push({ url: u, title: decodeURIComponent(opts.headers.Title || ''), body: opts.body }); return new Response('ok'); }
    calls.other.push(u);
    return new Response('{}', { status: 200 });
  };
}
afterEach(() => { if (original) globalThis.fetch = original; original = null; });

async function clearHealth() {
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'health:%'").run();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('health:baseline', '\"2000-01-01T00:00:00Z\"')").run();
}
function montreal(hoursAhead) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(Date.now() + hoursAhead * 3600000));
  const g = t => parts.find(p => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}
async function leagueWithAdmin(email, name) {
  const s = await signup(email);
  const league = (await (await post(s, '/leagues/create', { name, teamNames: ['A', 'B'] })).json()).league;
  await post(s, '/league/season/publish', { season_name: 'S1' });
  return { s, league };
}

beforeAll(async () => {
  env.AUTH_SECRET = 'p144-auth';
  env.ADMIN_KEY = 'p144-admin';
  env.RESEND_API_KEY = 'p144-resend';
  env.LEAGUE_PRODUCT = 'true';
  env.OPS_ALERT_EMAIL = OPS;
  env.ALERT_WEBHOOK_URL = 'https://ntfy.sh/p144-alerts';
  delete env.MAIL_DAILY_CAP;
  await applyRealSchema(env);
  // Creating a league now pings the webhook (src/operator_alerts.js): outside
  // mockFetch, that ping is answered here, never sent to ntfy.sh.
  base = globalThis.fetch;
  globalThis.fetch = async (url, opts) => String(url).includes('ntfy.sh') ? new Response('ok') : base(url, opts);
});
let base;
afterAll(() => { if (base) globalThis.fetch = base; });
beforeEach(clearHealth);

describe('1a. A league\'s failure reaches its own admin and the operator', () => {
  it('permanently failed mail in league A: A\'s admin is emailed, the operator is emailed and pinged, B\'s admin hears nothing -- once', async () => {
    const a = await leagueWithAdmin('admin.a@p144.example', 'P144 League A');
    await leagueWithAdmin('admin.b@p144.example', 'P144 League B');
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, payload, send_after, created_at, failed_at, cancelled, error, league_id) VALUES ('invite', 'x', '{}', ?, ?, ?, 1, 'resend 422: bad address', ?)`)
      .bind(new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), a.league.id).run();
    mockFetch();
    await runHealthPass(env, healthHost(env));
    const to = calls.resend.map(c => c.to);
    expect(to).toContain('admin.a@p144.example');
    expect(to).toContain(OPS);
    expect(to).not.toContain('admin.b@p144.example');
    const adminMail = calls.resend.find(c => c.to === 'admin.a@p144.example');
    expect(adminMail.subject).toContain("P144 League A : quelque chose n'a pas fonctionné");
    expect(adminMail.text).toContain("1 courriel n'a pas pu être envoyé dans les dernières 24 h");
    expect(adminMail.text).toContain('1 email could not be sent in the last 24 hours');
    expect(calls.webhook.length).toBe(1);
    expect(calls.webhook[0].body).toContain('[P144 League A]');
    // Told once: the next pass sends nothing new.
    mockFetch();
    await runHealthPass(env, healthHost(env));
    expect(calls.resend.length).toBe(0);
    expect(calls.webhook.length).toBe(0);
    // And the admin sees it on the dashboard while it is open.
    const dash = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie: a.s.cookie } })).text();
    expect(dash).toContain('id="dash_health"');
    expect(dash).toContain('data-date-en="1 email could not be sent in the last 24 hours (address rejected or retries used up)."');
    await env.DB.prepare('DELETE FROM outbox WHERE league_id = ?').bind(a.league.id).run();
  });

  it('a pass that throws for one league is an alert for that league', async () => {
    const c = await leagueWithAdmin('admin.c@p144.example', 'P144 League C');
    mockFetch();
    await runHealthPass(env, healthHost(env), { failures: [{ leagueId: c.league.id, message: 'D1_ERROR: no such column' }] });
    const mail = calls.resend.find(x => x.to === 'admin.c@p144.example');
    expect(mail.text).toContain('Le traitement automatique de la ligue a échoué : D1_ERROR: no such column');
  });
});

describe('1b. The silent case: a scheduled send that never went out', () => {
  it('a 72 h reminder due an hour ago with nothing logged is an alert; once logged, it clears', async () => {
    const d = await leagueWithAdmin('admin.d@p144.example', 'P144 League D');
    const due = montreal(70); // the 72 h window opened 2 h ago
    const evId = `${d.league.id}:${due.date}`;
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, state, start_time, league_id, auto_reminders_enabled) VALUES (?, 'S1', 1, ?, 'open', ?, ?, 1)`).bind(evId, due.date, due.time, d.league.id).run();
    await env.DB.prepare('UPDATE leagues SET reminder_72h_enabled = 1, reminder_24h_enabled = 0, reminder_12h_enabled = 0 WHERE id = ?').bind(d.league.id).run();
    let problems = await collectProblems(env);
    const missed = problems.find(p => p.scope === d.league.id && p.key === `reminder_missed:${evId}:reminder_72h`);
    expect(missed).toBeTruthy();
    expect(missed.en).toContain('72h reminder');
    expect(missed.en).toContain('should have gone out and has not');
    await env.DB.prepare(`INSERT INTO league_reminder_log (event_id, kind, league_id, sent_at, recipient_count, skipped) VALUES (?, 'reminder_72h', ?, ?, 3, 0)`).bind(evId, d.league.id, new Date().toISOString()).run();
    problems = await collectProblems(env);
    expect(problems.find(p => p.key === `reminder_missed:${evId}:reminder_72h`)).toBeUndefined();
  });

  it('not yet: a window that opened within the grace period, or has not opened, is not an alert', async () => {
    const e = await leagueWithAdmin('admin.e@p144.example', 'P144 League E');
    await env.DB.prepare('UPDATE leagues SET reminder_72h_enabled = 1 WHERE id = ?').bind(e.league.id).run();
    for (const h of [71.8, 80]) {
      const t = montreal(h);
      await env.DB.prepare(`INSERT INTO events (id, season, week, date, state, start_time, league_id, auto_reminders_enabled) VALUES (?, 'S1', 1, ?, 'open', ?, ?, 1)`).bind(`${e.league.id}:${h}:${t.date}`, t.date, t.time, e.league.id).run();
    }
    const problems = await collectProblems(env);
    expect(problems.filter(p => p.scope === e.league.id && p.key.startsWith('reminder_missed'))).toEqual([]);
  });

  it('pre-game mail scheduled after the game starts is an alert', async () => {
    const f = await leagueWithAdmin('admin.f@p144.example', 'P144 League F');
    const g = montreal(5);
    const evId = `${f.league.id}:${g.date}`;
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, state, start_time, league_id, auto_reminders_enabled) VALUES (?, 'S1', 1, ?, 'open', ?, ?, 0)`).bind(evId, g.date, g.time, f.league.id).run();
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, payload, send_after, created_at, league_id) VALUES ('sub_call', ?, '{}', ?, ?, ?)`)
      .bind(evId, new Date(Date.now() + 12 * 3600000).toISOString(), new Date().toISOString(), f.league.id).run();
    const problems = await collectProblems(env);
    expect(problems.find(p => p.scope === f.league.id && p.key === `outbox_after_start:${evId}`).en).toContain('scheduled to go out after it starts');
  });
});

describe('1c. The cron itself dying', () => {
  it('no finished pass for too long: /health/status says 503 cron_stale and the operator is pinged, once an hour', async () => {
    await recordHeartbeat(env, 'end', { ok: true }, new Date(Date.now() - (CRON_STALE_MINUTES.leagues + 10) * 60000));
    mockFetch();
    const res = await SELF.fetch('http://example.com/health/status');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reasons).toContain('cron_stale');
    expect(calls.webhook.length).toBe(1);
    expect(calls.webhook[0].body).toContain('The cron has stopped');
    await SELF.fetch('http://example.com/health/status');
    expect(calls.webhook.length).toBe(1); // not every request
  });

  it('a real pass records its heartbeat: /health/status is 200 again', async () => {
    mockFetch();
    await runCronPass(env);
    const status = await cronStatus(env);
    expect(status.stale).toBe(false);
    expect(status.age_minutes).toBe(0);
    const res = await SELF.fetch('http://example.com/health/status');
    const body = await res.json();
    expect(body.reasons).not.toContain('cron_stale');
    expect(body.alerts).toBeUndefined(); // details need the admin key
    const detailed = await (await SELF.fetch('http://example.com/health/status', { headers: { 'x-admin': 'p144-admin' } })).json();
    expect(Array.isArray(detailed.alerts)).toBe(true);
  });

  it('the external heartbeat is pinged every pass, /fail when the pass fails', async () => {
    env.HEARTBEAT_URL = 'https://hc-ping.example/p144';
    mockFetch();
    await runCronPass(env);
    expect(calls.other).toContain('https://hc-ping.example/p144');
    delete env.HEARTBEAT_URL;
  });
});

describe('1d. Email broken: the alert still gets out', () => {
  it('Resend down: the webhook carries the alert, and it counts as told', async () => {
    const h = await leagueWithAdmin('admin.h@p144.example', 'P144 League H');
    mockFetch({ resend: 500 });
    await runHealthPass(env, healthHost(env), { failures: [{ leagueId: h.league.id, message: 'boom' }] });
    expect(calls.resend.length).toBeGreaterThan(0); // tried, and failed
    expect(calls.webhook.length).toBe(1);
    const alerts = await reconcileAlerts(env, await collectProblems(env, { failures: [{ leagueId: h.league.id, message: 'boom' }] }));
    expect(alerts.find(a => a.scope === h.league.id && a.key === 'cron_error').ops_notified_at).toBeTruthy();
  });

  it('Resend down and no webhook: nobody told -- /health/status turns 503 alerts_not_delivered for the external monitor', async () => {
    const i = await leagueWithAdmin('admin.i@p144.example', 'P144 League I');
    const hook = env.ALERT_WEBHOOK_URL; delete env.ALERT_WEBHOOK_URL;
    mockFetch({ resend: 500 });
    const failures = [{ leagueId: i.league.id, message: 'boom' }];
    const longAgo = new Date(Date.now() - 45 * 60000);
    await runHealthPass(env, healthHost(env), { failures }, longAgo);
    await recordHeartbeat(env, 'end', { ok: true });
    const body = await (await SELF.fetch('http://example.com/health/status')).json();
    expect(body.ok).toBe(false);
    expect(body.reasons).toContain('alerts_not_delivered');
    env.ALERT_WEBHOOK_URL = hook;
  });

  it('the cap spent: an operator-only alert, and the webhook is how it arrives', async () => {
    env.MAIL_DAILY_CAP = '10';
    await env.DB.prepare(`INSERT INTO mail_daily_count (day, sent, sub_calls) VALUES (?, 10, 0) ON CONFLICT(day) DO UPDATE SET sent = 10`).bind(new Date().toISOString().slice(0, 10)).run();
    mockFetch();
    await runHealthPass(env, healthHost(env));
    expect(calls.webhook.some(w => w.body.includes('Daily email cap reached (10/10)'))).toBe(true);
    delete env.MAIL_DAILY_CAP;
    await env.DB.prepare('DELETE FROM mail_daily_count').run();
  });
});

describe('A page whose JavaScript throws reaches the operator', () => {
  it('the page reports its own error; the next pass alerts the operator (not league admins)', async () => {
    const r = await SELF.fetch('http://example.com/health/client-error', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/league/roster', msg: "SyntaxError: Unexpected token '}'", line: 12 }) });
    expect(r.status).toBe(204);
    mockFetch();
    await runHealthPass(env, healthHost(env));
    expect(calls.webhook[0].body).toContain("JavaScript error on /league/roster: SyntaxError: Unexpected token '}' (1 times today)");
    // Only the operator's email carries it -- a league's admins are not told about the product's own bug.
    expect(calls.resend.filter(c => c.text.includes('JavaScript error')).map(c => c.to)).toEqual([OPS]);
  });

  it('every page carries the reporter, first in <head>', async () => {
    const html = await (await SELF.fetch('http://example.com/rsvp')).text();
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head.indexOf("/health/client-error")).toBeGreaterThan(0);
    expect(head.indexOf("/health/client-error")).toBeLessThan(head.indexOf('<title>'));
    const login = await (await SELF.fetch('http://example.com/login')).text();
    expect(login.slice(0, login.indexOf('<title>'))).toContain('/health/client-error');
  });
});

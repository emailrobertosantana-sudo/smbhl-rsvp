// Drives a league through a season the way it really runs: an admin sets
// it up through the product's own routes, the cron pass runs on a clock,
// and players act on the emails they receive (the links in them), so what
// a fixture exercises is what a real league would. Used by the
// league-shape fixtures (part152_*), which look for what assumes SMBHL's
// shape: fixed teams, two games a night, a big sub pool, a roster in
// data.json.
//
// Needs the file's env: LEAGUE_PRODUCT 'true' (the league cron),
// RESEND_API_KEY / RSVP_SECRET / AUTH_SECRET set, and fake Date timers
// (vi.useFakeTimers({ toFake: ['Date'] })) -- the helpers set the time.
import { env, SELF } from 'cloudflare:test';
import { vi } from 'vitest';
import { runCronPass } from '../../src/index.js';
import { answerViaEmailLink } from './email_link.js';

export const H = 3600000;
export const DAY = 24 * H;

// League-local (America/Toronto) date and HH:MM for a UTC instant.
export function local(ms) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}

// ---- mail -----------------------------------------------------------------
// Every Resend call, with the time it was made; the Worker's other
// fetches (data.json for SMBHL) get a 404.
export const mail = { sent: [] };
let originalFetch = null;
export function installMailCapture() {
  originalFetch = originalFetch || globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      const b = JSON.parse(opts.body);
      mail.sent.push({ to: Array.isArray(b.to) ? b.to[0] : b.to, subject: b.subject, text: b.text || '', html: b.html || '', at: Date.now() });
      return new Response('{"id":"x"}', { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
}
export function removeMailCapture() { if (originalFetch) globalThis.fetch = originalFetch; }

// Links in an email to a path ('/league/rsvp', '/avail', ...), &amp; undone.
export function linksIn(m, path) {
  const out = new Set();
  for (const src of [m.html, m.text]) {
    for (const x of String(src).matchAll(/https?:\/\/[^\s"'<>]+/g)) {
      const u = x[0].replace(/&amp;/g, '&').replace(/[).,]+$/, '');
      try { if (new URL(u).pathname === path) out.add(u); } catch (_) {}
    }
  }
  return [...out];
}

// ---- admin ----------------------------------------------------------------
let ip = 0;
export async function admin(tag) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${(++ip % 250) + 1}` },
    body: JSON.stringify({ email: `admin.${tag}@example.com`, password: 'a-strong-password-1' })
  });
  const s = {};
  const take = r => { const cookies = r.headers.getSetCookie(); s.cookie = cookies.map(c => c.split(';')[0]).join('; '); s.csrf = (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1]; };
  take(res);
  // Sessions last 30 days; a season can run longer: log in again, as an admin would.
  const login = async () => take(await SELF.fetch('http://example.com/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${(++ip % 250) + 1}` },
    body: JSON.stringify({ email: `admin.${tag}@example.com`, password: 'a-strong-password-1' })
  }));
  const post = async (path, body, retried = false) => {
    const r = await SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (r.status === 401 && !retried) { await login(); return post(path, body, true); }
    let json = null; try { json = await r.clone().json(); } catch (_) {}
    return { status: r.status, json, text: json ? null : await r.text() };
  };
  const get = async path => {
    const r = await SELF.fetch('http://example.com' + path, { headers: { cookie: s.cookie } });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { status: r.status, json, text };
  };
  return { s, post, get };
}

// POSTs that must succeed while setting a fixture up.
export async function must(p, what) {
  const r = await p;
  if (r.status !== 200 || (r.json && r.json.ok === false)) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json || r.text).slice(0, 400)}`);
  return r.json;
}

// ---- the cron -------------------------------------------------------------
// One pass at `ms`. Returns its log lines and any error the pass or the
// Worker wrote (console.error), so a fixture can require none.
export async function pass(ms) {
  vi.setSystemTime(new Date(ms));
  const logs = [], errors = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.map(String).join(' ')); });
  const err = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.map(x => (x && x.stack) || String(x)).join(' ')); });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try { await runCronPass(env); }
  finally { log.mockRestore(); err.mockRestore(); warn.mockRestore(); }
  const failed = logs.filter(l => /FAILED|failed:|pass failed/i.test(l));
  return { at: ms, logs, errors, failed };
}

// A player acting on an email link (GET, then the confirmation's button).
export async function answer(url) {
  return answerViaEmailLink((u, i) => SELF.fetch(u, i), url);
}

// ---- reading the league back ---------------------------------------------
export const rows = async (sql, ...binds) => (await env.DB.prepare(sql).bind(...binds).all()).results;
export const one = async (sql, ...binds) => env.DB.prepare(sql).bind(...binds).first();

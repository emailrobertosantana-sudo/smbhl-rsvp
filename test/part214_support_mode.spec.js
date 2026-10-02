// Stage 2 item 2e: support mode (src/support_mode.js, src/write_guard.js).
//   - entered only with the admin key, only on Notre Ligue, only for a
//     Notre Ligue league; each visit logged (who, which league, when), never
//     the key itself; the log is on the league's super-admin page;
//   - the league's admin pages render, read-only, with the fixed banner;
//   - every write route refuses, server-side, and no email can be sent or
//     queued; a GET's writes do nothing;
//   - the real admin session in the same browser is never altered, and the
//     support session cannot reach another league;
//   - leaving returns to the super-admin; SMBHL ignores it all.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import INDEX_SRC from '../src/index.js?raw';
import { applyRealSchema } from './support/real_schema.js';
import { supportEnv, readOnlyDb, isWriteSql, supportCookieHeader, SUPPORT_TEXT } from '../src/support_mode.js';
import { WRITE_MODES } from '../src/write_guard.js';
import { sendMail, drain } from '../src/index.js';

const ADMIN_KEY = 'test-p214-admin';
const BASE = 'http://example.com';
let resendCalls = 0;
const originalFetch = globalThis.fetch;

function cookiesOf(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.get('set-cookie') || '').split(', ');
  return list.filter(Boolean);
}
const pair = c => c.split(';')[0];
async function signup(email, ip) {
  const res = await SELF.fetch(`${BASE}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ accept_terms: true, email, password: 'a-strong-password-1' })
  });
  const cookies = cookiesOf(res);
  const session = pair(cookies.find(c => c.startsWith('user_session=')));
  const csrf = pair(cookies.find(c => c.startsWith('csrf_token='))).split('=')[1];
  return { session, csrf, cookie: `${session}; csrf_token=${csrf}` };
}
async function createLeague(s, name) {
  const res = await SELF.fetch(`${BASE}/leagues/create`, {
    method: 'POST', headers: { cookie: s.cookie, 'content-type': 'application/json', 'x-csrf-token': s.csrf },
    body: JSON.stringify({ name, teamNames: ['A', 'B'], tracksStats: true })
  });
  return (await res.json()).league;
}
const start = (leagueId, headers = { 'x-admin': ADMIN_KEY }) => SELF.fetch(`${BASE}/super-admin/support/start`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36', ...headers },
  body: JSON.stringify({ leagueId })
});
const count = async (table, where = '1=1', ...b) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...b).first()).n;

// Every literal write route of the router (src/index.js): POST, PUT, PATCH, DELETE.
function writeRoutes() {
  const src = INDEX_SRC;
  const out = new Set();
  const re = /url\.pathname === '([^']+)'(?:\s*\|\|\s*url\.pathname === '[^']+')*\)?\s*&&\s*req\.method === '(POST|PUT|PATCH|DELETE)'/g;
  let m;
  while ((m = re.exec(src))) out.add(`${m[2]} ${m[1]}`);
  return [...out];
}

let owner, other, leagueA, leagueB, supportCookie;

beforeAll(async () => {
  env.AUTH_SECRET = 'test-p214-auth';
  env.ADMIN_KEY = ADMIN_KEY;
  env.RSVP_SECRET = 'test-p214-rsvp';
  env.RESEND_API_KEY = 'mock-key';
  env.LEAGUE_PRODUCT = 'true';
  await applyRealSchema(env);
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) { resendCalls++; return new Response('{"id":"x"}', { status: 200 }); }
    return originalFetch(url, opts);
  };
  owner = await signup('owner.p214@example.com', '203.0.214.1');
  leagueA = await createLeague(owner, 'Ligue Soutien A');
  other = await signup('other.p214@example.com', '203.0.214.2');
  leagueB = await createLeague(other, 'Ligue Autre B');
  for (const [lg, name] of [[leagueA.id, 'Alice Alpha'], [leagueB.id, 'Bruno Beta']]) {
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, token_salt, league_id) VALUES (?, ?, ?, 'roster', 0, 's', ?)`)
      .bind(`${lg}-p1`, name, `${name.split(' ')[0].toLowerCase()}@example.com`, lg).run();
  }
  resendCalls = 0;
});
afterAll(() => { globalThis.fetch = originalFetch; delete env.LEAGUE_PRODUCT; });

describe('entering support mode', () => {
  it('needs the admin key, a Notre Ligue league, and a league that exists', async () => {
    expect((await start(leagueA.id, {})).status).toBe(403);
    expect((await start(leagueA.id, { cookie: owner.cookie })).status).toBe(403);
    expect((await start('smbhl')).status).toBe(400);
    expect((await start('nope')).status).toBe(404);
  });

  it('sets only the support cookie and logs who, which league and when, never the key', async () => {
    const res = await start(leagueA.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, redirect: '/dashboard' });
    const cookies = cookiesOf(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^nl_support=[^;]+; Path=\/; Max-Age=7200; HttpOnly; SameSite=Lax; Secure$/);
    supportCookie = pair(cookies[0]);
    const row = await env.DB.prepare('SELECT value, league_id FROM settings WHERE key = ?').bind(`support_log:${leagueA.id}`).first();
    expect(row.league_id).toBe(leagueA.id);
    expect(row.value).not.toContain(ADMIN_KEY);
    const log = JSON.parse(row.value);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ who: 'super-admin', browser: 'Chrome, Windows', endedAt: null });
    expect(log[0].sid).toMatch(/^[0-9a-f]{12}$/);
    expect(Math.abs(Date.parse(log[0].startedAt) - Date.now())).toBeLessThan(60000);
  });
});

describe('in support mode', () => {
  it("the league's admin pages render read-only, with the banner, and set no cookie", async () => {
    for (const path of ['/dashboard', '/league/roster', '/league/schedule', '/league/settings', '/league/comms', '/league/finances']) {
      const res = await SELF.fetch(`${BASE}${path}`, { headers: { cookie: supportCookie }, redirect: 'manual' });
      expect(res.status, path).toBe(200);
      expect(cookiesOf(res), path).toEqual([]);
      const html = await res.text();
      expect(html, path).toContain('id="nl-support-banner"');
      expect(html).toContain(SUPPORT_TEXT.fr.banner);
      expect(html).toContain(SUPPORT_TEXT.en.banner);
      expect(html).toContain('action="/super-admin/support/exit"');
      expect(html).toContain('Ligue Soutien A');
    }
    const players = await (await SELF.fetch(`${BASE}/league/contacts`, { headers: { cookie: supportCookie } })).json();
    expect(JSON.stringify(players)).toContain('Alice Alpha');
  });

  it('every write route refuses, server-side, before it runs', async () => {
    const routes = writeRoutes();
    expect(routes.length).toBeGreaterThan(80);
    const before = { contacts: await count('contacts'), events: await count('events'), outbox: await count('outbox'), settings: await count('settings') };
    const allowed = WRITE_MODES.support.allow;
    const refused = [];
    for (const r of routes) {
      const [method, path] = r.split(' ');
      if (allowed.some(p => path === p || path.startsWith(p))) continue;
      const res = await SELF.fetch(`${BASE}${path}`, {
        method, headers: { cookie: `${supportCookie}; ${owner.cookie}`, 'content-type': 'application/json', 'x-csrf-token': owner.csrf },
        body: JSON.stringify({ name: 'X', email: 'x@example.com', confirm: 'Ligue Soutien A' })
      });
      const body = await res.json().catch(() => null);
      if (res.status === 403 && body && body.errorKey === 'SUPPORT_READ_ONLY') refused.push(r);
      else throw new Error(`${r} answered ${res.status}`);
    }
    expect(refused.length).toBeGreaterThan(80);
    // A route the router does not even know is refused the same way.
    expect((await SELF.fetch(`${BASE}/league/anything-new`, { method: 'POST', headers: { cookie: supportCookie } })).status).toBe(403);
    expect({ contacts: await count('contacts'), events: await count('events'), outbox: await count('outbox'), settings: await count('settings') }).toEqual(before);
    expect(resendCalls).toBe(0);
  });

  it('no email can be sent or queued, and a drain sends nothing', async () => {
    const senv = supportEnv(env, { sid: 'test', leagueId: leagueA.id });
    await expect(sendMail(senv, 'alice@example.com', 'S', 'T')).rejects.toThrow(/support mode/);
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, payload, send_after, created_at, league_id) VALUES ('direct_mail', 'system', ?, ?, ?, ?)`)
      .bind(JSON.stringify({ prerendered: { to: 'alice@example.com', subject: 'S', text: 'T', html: null, identity: null } }), new Date(Date.now() - 60000).toISOString(), new Date().toISOString(), leagueA.id).run();
    const id = (await env.DB.prepare('SELECT MAX(id) AS id FROM outbox').first()).id;
    const r = await drain(senv, 10, null, leagueA.id);
    expect(r.sent).toBe(0);
    expect(resendCalls).toBe(0);
    const row = await env.DB.prepare('SELECT sent_at, attempts, error FROM outbox WHERE id = ?').bind(id).first();
    expect(row).toEqual({ sent_at: null, attempts: 0, error: null });
    await env.DB.prepare('DELETE FROM outbox WHERE id = ?').bind(id).run();
  });

  it("a GET's writes do nothing: the database and KV are read-only", async () => {
    const db = readOnlyDb(env.DB);
    const res = await db.prepare(`INSERT INTO settings (key, value) VALUES ('p214-probe', 'x')`).run();
    expect(res.meta.changes).toBe(0);
    expect(await count('settings', "key = 'p214-probe'")).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM leagues').first()).n).toBeGreaterThan(1);
    for (const sql of ['INSERT INTO x VALUES (1)', '  update x set a=1', 'DELETE FROM x', 'REPLACE INTO x VALUES (1)', 'WITH a AS (SELECT 1) DELETE FROM x', 'PRAGMA foreign_keys = off']) expect(isWriteSql(sql), sql).toBe(true);
    for (const sql of ['SELECT 1', 'WITH a AS (SELECT 1) SELECT * FROM a', 'PRAGMA table_info(x)']) expect(isWriteSql(sql), sql).toBe(false);
    const senv = supportEnv(env, { sid: 'test', leagueId: leagueA.id });
    await senv.SHEETS_KV.put('p214-probe', 'x');
    expect(await env.SHEETS_KV.get('p214-probe')).toBeNull();
  });

  it('cannot reach another league, whatever the URL asks', async () => {
    const res = await SELF.fetch(`${BASE}/league/contacts?league_id=${encodeURIComponent(leagueB.id)}`, { headers: { cookie: supportCookie } });
    const text = await res.text();
    expect(text).not.toContain('Bruno Beta');
  });

  it("the real admin session in the same browser is never altered", async () => {
    const both = `${supportCookie}; ${owner.cookie}`;
    const res = await SELF.fetch(`${BASE}/dashboard`, { headers: { cookie: both } });
    expect(cookiesOf(res)).toEqual([]);
    // Logging out is a write: refused, so the session's epoch is unchanged.
    const epoch = async () => (await env.DB.prepare('SELECT session_epoch FROM users WHERE email = ?').bind('owner.p214@example.com').first()).session_epoch;
    const e0 = await epoch();
    expect((await SELF.fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { cookie: both, 'x-csrf-token': owner.csrf } })).status).toBe(403);
    expect(await epoch()).toBe(e0);
  });
});

describe('leaving support mode', () => {
  it('returns to the super-admin, clears only the support cookie, closes the log entry', async () => {
    const res = await SELF.fetch(`${BASE}/super-admin/support/exit`, { method: 'POST', headers: { cookie: supportCookie }, redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/super-admin/league?id=${encodeURIComponent(leagueA.id)}`);
    const cookies = cookiesOf(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^nl_support=; Path=\/; Max-Age=0/);
    const data = await (await SELF.fetch(`${BASE}/super-admin/league/data?id=${encodeURIComponent(leagueA.id)}`, { headers: { 'x-admin': ADMIN_KEY } })).json();
    expect(data.supportLog).toHaveLength(1);
    expect(data.supportLog[0].endedAt).toBeTruthy();
    // The owner's own session still works, on the owner's own league.
    const own = await SELF.fetch(`${BASE}/league/contacts`, { headers: { cookie: owner.cookie } });
    expect(JSON.stringify(await own.json())).toContain('Alice Alpha');
  });

  it('a second visit is logged as its own entry', async () => {
    const res = await start(leagueA.id);
    const c = pair(cookiesOf(res)[0]);
    await SELF.fetch(`${BASE}/super-admin/support/exit`, { method: 'POST', headers: { cookie: c }, redirect: 'manual' });
    const data = await (await SELF.fetch(`${BASE}/super-admin/league/data?id=${encodeURIComponent(leagueA.id)}`, { headers: { 'x-admin': ADMIN_KEY } })).json();
    expect(data.supportLog).toHaveLength(2);
    expect(new Set(data.supportLog.map(e => e.sid)).size).toBe(2);
  });
});

describe('SMBHL', () => {
  it('cannot enter support mode, and ignores a support cookie', async () => {
    delete env.LEAGUE_PRODUCT;
    try {
      expect((await start(leagueA.id)).status).toBe(404);
      const forged = pair(await supportCookieHeader(env, { sid: 'aaaaaaaaaaaa', leagueId: leagueA.id, exp: Date.now() + 60000 }));
      const res = await SELF.fetch(`${BASE}/league/contacts`, { headers: { cookie: forged } });
      expect(res.status).toBe(401);
      const page = await SELF.fetch(`${BASE}/admin/board`, { headers: { cookie: forged, 'x-admin': ADMIN_KEY } });
      expect(await page.text()).not.toContain('nl-support-banner');
      expect((await SELF.fetch(`${BASE}/super-admin/league?id=${encodeURIComponent(leagueA.id)}`, { headers: { 'x-admin': ADMIN_KEY } })).status).toBe(404);
    } finally { env.LEAGUE_PRODUCT = 'true'; }
  });
});

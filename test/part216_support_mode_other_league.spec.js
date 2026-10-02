// Stage 2 fix item 3: support mode never shows or acts on the owner's OTHER
// league. Every page that picks "this admin's league" goes through the
// shared access check (checkLeagueAccess / resolveSessionLeagueId /
// newestSessionLeagueId in src/leagues.js), which in support mode answers
// only for the league being supported. The pages that used to look up the
// owner's leagues in league_admins directly: the dashboard, signup's last
// step (and steps 2 and 3), the onboarding season page, the dashboard's
// ?league_id= link, and hard delete (status and action).
//
// The owner runs two leagues; the newer one is NOT the one supported, so a
// "most recent league of this user" lookup would land on it.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { checkLeagueAccess, resolveSessionLeagueId, newestSessionLeagueId } from '../src/leagues.js';

const ADMIN_KEY = 'test-p216-admin';
const BASE = 'http://example.com';
const MAIN = 'Ligue Soutenue P216';
const OTHER = 'Ligue Seconde P216';
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
async function createLeague(s, name, teamNames) {
  const res = await SELF.fetch(`${BASE}/leagues/create`, {
    method: 'POST', headers: { cookie: s.cookie, 'content-type': 'application/json', 'x-csrf-token': s.csrf },
    body: JSON.stringify({ name, teamNames, tracksStats: true })
  });
  const body = await res.json();
  expect(body.ok, JSON.stringify(body)).toBe(true);
  return body.league;
}
const count = async (table, where = '1=1', ...b) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...b).first()).n;

let owner, main, other, supportCookie;

beforeAll(async () => {
  env.AUTH_SECRET = 'test-p216-auth';
  env.ADMIN_KEY = ADMIN_KEY;
  env.RSVP_SECRET = 'test-p216-rsvp';
  env.RESEND_API_KEY = 'mock-key';
  env.LEAGUE_PRODUCT = 'true';
  await applyRealSchema(env);
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) { resendCalls++; return new Response('{"id":"x"}', { status: 200 }); }
    return originalFetch(url, opts);
  };
  owner = await signup('owner.p216@example.com', '203.0.216.1');
  main = await createLeague(owner, MAIN, ['Huards', 'Castors']);
  other = await createLeague(owner, OTHER, ['Renards', 'Carcajous']);
  // The other league is the newer one.
  await env.DB.prepare('UPDATE leagues SET created_at = ? WHERE id = ?').bind('2026-01-01T00:00:00.000Z', main.id).run();
  await env.DB.prepare('UPDATE leagues SET created_at = ? WHERE id = ?').bind('2026-06-01T00:00:00.000Z', other.id).run();
  // Each league has a season (the onboarding page needs one) and a player.
  for (const lg of [main, other]) {
    await env.SHEETS_KV.put(`data_json:${lg.id}`, JSON.stringify({ current_season: 'S1', seasons: [{ name: 'S1', games: 0, standings: [], fixtures: [] }], players: [] }));
  }
  for (const [lg, name] of [[main.id, 'Alice Soutenue'], [other.id, 'Bruno Ailleurs']]) {
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, token_salt, league_id) VALUES (?, ?, ?, 'roster', 0, 's', ?)`)
      .bind(`${lg}-p1`, name, `${name.split(' ')[0].toLowerCase()}.p216@example.com`, lg).run();
  }
  const res = await SELF.fetch(`${BASE}/super-admin/support/start`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin': ADMIN_KEY },
    body: JSON.stringify({ leagueId: main.id })
  });
  expect(res.status).toBe(200);
  supportCookie = pair(cookiesOf(res)[0]);
  resendCalls = 0;
});
afterAll(() => { globalThis.fetch = originalFetch; delete env.LEAGUE_PRODUCT; });

// The support cookie alone, and with the owner's own session in the same
// browser (the super-admin may also be the owner).
const browsers = () => [['support only', supportCookie], ['support and the owner session', `${supportCookie}; ${owner.cookie}`]];

describe("support mode cannot open the owner's other league", () => {
  it('outside support mode, the owner\'s newest league is the other one (the case this guards)', async () => {
    const req = new Request(`${BASE}/dashboard`, { headers: { cookie: owner.cookie } });
    expect(await newestSessionLeagueId(req, env)).toBe(other.id);
    expect(await checkLeagueAccess(req, env, other.id)).toBe('ok');
  });

  it('the shared access check refuses the other league and resolves only the supported one', async () => {
    for (const [label, cookie] of browsers()) {
      const req = new Request(`${BASE}/dashboard?league_id=${encodeURIComponent(other.id)}`, { headers: { cookie } });
      expect(await checkLeagueAccess(req, env, other.id), label).toBe('forbidden');
      expect(await checkLeagueAccess(req, env, main.id), label).toBe('ok');
      expect(await resolveSessionLeagueId(req, env, new URL(req.url)), label).toBe(main.id);
      expect(await newestSessionLeagueId(req, env), label).toBe(main.id);
    }
  });

  for (const path of ['/dashboard', '/signup?step=done', '/onboarding/season', '/league/roster', '/league/schedule', '/league/settings']) {
    it(`${path} shows the supported league, never the other one, whatever the URL asks`, async () => {
      for (const [label, cookie] of browsers()) {
        for (const q of ['', `${path.includes('?') ? '&' : '?'}league_id=${encodeURIComponent(other.id)}`]) {
          const res = await SELF.fetch(`${BASE}${path}${q}`, { headers: { cookie }, redirect: 'manual' });
          const where = `${label}: ${path}${q}`;
          expect(res.status, where).toBe(200);
          const html = await res.text();
          expect(html, where).toContain(MAIN);
          expect(html, where).not.toContain(OTHER);
          expect(html, where).not.toMatch(/Renards|Carcajous|Bruno Ailleurs/);
          expect(cookiesOf(res), where).toEqual([]);
        }
      }
    });
  }

  it('signup steps 2 and 3 send support mode to the supported league\'s onboarding', async () => {
    for (const step of ['2', '3']) {
      const res = await SELF.fetch(`${BASE}/signup?step=${step}`, { headers: { cookie: supportCookie }, redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${BASE}/onboarding/season`);
    }
  });

  it("hard delete's status answers for the supported league only", async () => {
    const res = await SELF.fetch(`${BASE}/league/hard-delete/status?league_id=${encodeURIComponent(other.id)}`, { headers: { cookie: supportCookie } });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('not_deactivated');
  });
});

describe("support mode cannot act as a writer on the owner's other league", () => {
  it('every write aimed at the other league is refused and changes nothing', async () => {
    const before = {
      contacts: await count('contacts', 'league_id = ?', other.id),
      events: await count('events', 'league_id = ?', other.id),
      leagues: await env.DB.prepare('SELECT name, deactivated_at FROM leagues WHERE id = ?').bind(other.id).first(),
      outbox: await count('outbox')
    };
    const q = `?league_id=${encodeURIComponent(other.id)}`;
    const writes = [
      ['POST', '/league/contacts', { name: 'Intrus', email: 'intrus.p216@example.com' }],
      ['POST', '/league/events', { date: '2026-12-01', start_time: '20:00', home_team: 'Renards', away_team: 'Carcajous' }],
      ['POST', '/league/identity', { name: 'Renamed' }],
      ['POST', '/league/deactivate', { confirm: OTHER }],
      ['POST', '/league/hard-delete', { confirmPhrase: OTHER }],
      ['POST', '/league/admins/invite', { email: 'intrus.p216@example.com' }],
      ['POST', '/league/billing/pause', {}]
    ];
    for (const [label, cookie] of browsers()) {
      for (const [method, path, body] of writes) {
        const res = await SELF.fetch(`${BASE}${path}${q}`, {
          method, headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': owner.csrf }, body: JSON.stringify(body)
        });
        expect(res.status, `${label}: ${path}`).toBe(403);
        expect((await res.json()).errorKey, `${label}: ${path}`).toBe('SUPPORT_READ_ONLY');
      }
    }
    expect({
      contacts: await count('contacts', 'league_id = ?', other.id),
      events: await count('events', 'league_id = ?', other.id),
      leagues: await env.DB.prepare('SELECT name, deactivated_at FROM leagues WHERE id = ?').bind(other.id).first(),
      outbox: await count('outbox')
    }).toEqual(before);
    expect(before.leagues).toEqual({ name: OTHER, deactivated_at: null });
    expect(resendCalls).toBe(0);
  });

  it('even past the write guard, the access check a write route runs refuses the other league', async () => {
    // What every league write handler asks before acting (checkLeagueAccess),
    // with a support session: never 'ok' for the other league.
    for (const [label, cookie] of browsers()) {
      const req = new Request(`${BASE}/league/contacts?league_id=${encodeURIComponent(other.id)}`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': owner.csrf }, body: '{}'
      });
      expect(await checkLeagueAccess(req, env, other.id), label).toBe('forbidden');
    }
  });
});

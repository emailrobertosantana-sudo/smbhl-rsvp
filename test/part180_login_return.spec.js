// An email's link to a league page gets the admin to that page, signed in
// or not (src/next_path.js).
//
// Before this, a league page opened without a session answered with a bare
// redirect to /login, and signing in went to the dashboard: an admin who
// tapped "View the game" in the short-of-players email from a phone's mail
// app (no session there) never reached the game.
//
// Now the page asked for rides along as /login?next=..., through every way
// of signing in this product has:
//   - the password form (the only login method);
//   - "forgot password": the emailed reset link carries it, so it survives
//     being opened in another browser or app than the one that asked.
// An admin already signed in skips the login page. The value is never
// trusted: only a league page of this site is accepted, so it cannot be
// used to send someone to another site.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must, mail, installMailCapture, removeMailCapture, linksIn } from './support/league_season.js';
import { safeNextPath, loginUrlFor, nextQuery, nextForScript } from '../src/next_path.js';

const BASE = 'http://example.com';
let a, league, ev, gamePath;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-03-01T15:00:00Z'));
  env.AUTH_SECRET = 'p180-auth'; env.RSVP_SECRET = 'p180-rsvp'; env.RESEND_API_KEY = 'p180'; env.LEAGUE_PRODUCT = 'true'; env.PUBLIC_URL = BASE;
  await applyRealSchema(env);
  installMailCapture();
  a = await admin('p180');
  league = (await must(a.post('/leagues/create', { name: 'P180 League', teamNames: ['Bulls', 'Parade'] }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'season');
  ev = (await must(a.post('/league/events', { date: '2027-03-10', start_time: '19:00', end_time: '20:00', venue: 'Gym', home_team: 'Bulls', away_team: 'Parade' }), 'ev')).event;
  gamePath = `/league/events/detail?e=${encodeURIComponent(ev.id)}`;
});
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

const get = (path, cookie) => SELF.fetch(BASE + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const cookieOf = res => res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
let ip = 0;
const login = (email, password = 'a-strong-password-1') => SELF.fetch(BASE + '/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${(++ip % 200) + 1}` }, body: JSON.stringify({ email, password })
});
// Where the login (or reset) page's own script goes once signed in.
const landing = html => { const m = html.match(/window\.location\.href = ("[^"]*") \|\| '\/dashboard';/); return m ? (JSON.parse(m[1]) || '/dashboard') : null; };

describe('safeNextPath: only a league page of this site', () => {
  it('accepts league pages and the dashboard, and gives back the parsed path', () => {
    expect(safeNextPath(gamePath)).toBe(gamePath);
    expect(safeNextPath('/dashboard')).toBe('/dashboard');
    expect(safeNextPath('/league/schedule')).toBe('/league/schedule');
    expect(safeNextPath('/league/roster?x=1&y=2')).toBe('/league/roster?x=1&y=2');
    expect(safeNextPath('/league/a/../settings')).toBe('/league/settings');
  });

  it('refuses another site in every spelling, and anything that is not a league page', () => {
    const attempts = [
      'https://evil.example/league/x', 'http://evil.example', '//evil.example/league/x', '///evil.example', '/\\evil.example', '\\\\evil.example',
      '/\t/evil.example', '/\n/evil.example', '/league/\\..\\..\\evil', 'javascript:alert(1)', 'data:text/html,x', ' /league/x', 'league/x',
      '/%2F%2Fevil.example', '/%2f%2fevil.example/league/', '/%5Cevil.example', '/league/..//evil.example', '/league/%2e%2e/%2e%2e//evil.example', '/league/../../login',
      '/league//evil.example', '/login', '/login?next=/dashboard', '/auth/logout', '/admin/board', '/rsvp', '/', '', null, undefined, 42, '/league/' + 'x'.repeat(700),
      '/league/x\u0000', '/dashboard/../admin/board', '/@evil.example', '/league/../%2F%2Fevil.example'
    ];
    for (const raw of attempts) expect(safeNextPath(raw), JSON.stringify(raw)).toBe(null);
    // What is refused never reaches a link or a script.
    expect(nextQuery('//evil.example')).toBe('');
    expect(nextForScript('https://evil.example')).toBe('""');
    expect(loginUrlFor(new URL('http://example.com/rsvp?e=1'))).toBe('http://example.com/login');
  });

  it('what it writes into a script cannot close the script', () => {
    const v = nextForScript('/league/x?a=</script><script>alert(1)</script>');
    expect(v).not.toContain('<');
    expect(JSON.parse(v)).toBe('/league/x?a=%3C/script%3E%3Cscript%3Ealert(1)%3C/script%3E');
  });
});

describe('The game link from an email', () => {
  it('signed in: the game page, directly', async () => {
    const res = await get(gamePath, a.s.cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(ev.id);
    expect(html).not.toContain('id="ev_not_found"');
  });

  it('signed out: the login page, with the game as its destination; signing in with the password lands on the exact game page', async () => {
    const res = await get(gamePath);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/login?next=${encodeURIComponent(gamePath)}`);
    const loginRes = await get(`/login?next=${encodeURIComponent(gamePath)}`);
    expect(loginRes.status).toBe(200);
    const html = await loginRes.text();
    expect(landing(html)).toBe(gamePath);
    // "Forgot password" carries it too.
    expect(html).toContain(`href="/forgot-password?next=${encodeURIComponent(gamePath)}"`);
    const signed = await login('admin.p180@example.com');
    expect(signed.status).toBe(200);
    const page = await get(landing(html), cookieOf(signed));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(ev.id);
  });

  it('already signed in and sent to the login page anyway: straight on to the game', async () => {
    const res = await get(`/login?next=${encodeURIComponent(gamePath)}`, a.s.cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(BASE + gamePath);
  });

  it('an expired session is a signed-out click: login, then the game', async () => {
    const b = await admin('p180.expired');
    await must(b.post('/leagues/create', { name: 'P180 Expired', teamNames: ['A', 'B'] }), 'create');
    await must(b.post('/league/season/publish', { season_name: 'S1' }), 'season');
    const game = (await must(b.post('/league/events', { date: '2027-03-11', start_time: '19:00', end_time: '20:00', venue: 'Gym' }), 'ev')).event;
    const path = `/league/events/detail?e=${encodeURIComponent(game.id)}`;
    const old = b.s.cookie;
    expect((await get(path, old)).status).toBe(200);
    // Signing out everywhere ends every session issued so far.
    await b.post('/auth/logout', {});
    const res = await get(path, old);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${BASE}/login?next=${encodeURIComponent(path)}`);
    const signed = await login('admin.p180.expired@example.com');
    const page = await get(path, cookieOf(signed));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(game.id);
  });

  it('another browser: the reset link in the email carries the game, and the new password lands on it', async () => {
    const forgot = await get(`/forgot-password?next=${encodeURIComponent(gamePath)}`);
    const forgotHtml = await forgot.text();
    expect(forgotHtml).toContain(`next: ${JSON.stringify(gamePath)}`);
    expect(forgotHtml).toContain(`href="/login?next=${encodeURIComponent(gamePath)}"`);
    mail.sent.length = 0;
    const asked = await SELF.fetch(BASE + '/auth/request-password-reset', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.240' }, body: JSON.stringify({ email: 'admin.p180@example.com', next: gamePath })
    });
    expect((await asked.json()).ok).toBe(true);
    expect(mail.sent).toHaveLength(1);
    const [link] = linksIn(mail.sent[0], '/reset-password');
    const u = new URL(link);
    expect(u.searchParams.get('next')).toBe(gamePath);
    // Opened with no cookie at all: a browser that never saw the login page.
    const resetPage = await get(u.pathname + u.search);
    expect(resetPage.status).toBe(200);
    const resetHtml = await resetPage.text();
    expect(landing(resetHtml)).toBe(gamePath);
    const done = await SELF.fetch(BASE + '/auth/reset-password', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: u.searchParams.get('token'), password: 'a-strong-password-1' })
    });
    expect(done.status).toBe(200);
    const page = await get(landing(resetHtml), cookieOf(done));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(ev.id);
    a.s.cookie = cookieOf(done); // the reset ended the earlier sessions
    a.s.csrf = (done.headers.getSetCookie().find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1];
  });

  it('a game that no longer exists: a clear page in French and in English, with the way to the league home', async () => {
    const res = await get('/league/events/detail?e=' + encodeURIComponent(league.id + ':2026-01-01'), a.s.cookie);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<h1 data-i18n="notFound">Match introuvable</h1>');
    expect(html).toContain(`id="ev_not_found" data-i18n="notFoundBody">Ce match n'existe plus, ou le lien n'est pas valide.</p>`);
    expect(html).toContain('href="/dashboard" data-i18n="notFoundHome">Aller à l\'accueil de la ligue</a>');
    expect(html).toContain('href="/league/schedule" data-i18n="notFoundSchedule">');
    const dict = JSON.parse(html.match(/var __I18N = (\{[\s\S]*?\});\n/)[1]);
    expect(dict.en).toMatchObject({ notFound: 'Game not found', notFoundBody: 'This game no longer exists, or the link is not valid.', notFoundHome: 'Go to the league home', notFoundSchedule: 'See the schedule' });
    // Signed out, the same link still comes back to this page after login.
    const out = await get('/league/events/detail?e=gone');
    expect(out.headers.get('location')).toBe(`${BASE}/login?next=${encodeURIComponent('/league/events/detail?e=gone')}`);
  });
});

describe('The destination cannot send anyone to another site', () => {
  const evil = ['https://evil.example/', '//evil.example/league/x', '/\\evil.example', '/%2F%2Fevil.example', '/league/%2e%2e/%2e%2e//evil.example', 'javascript:alert(1)', '/league//evil.example', '/admin/board'];

  it('the login page drops it: signing in goes to the dashboard, and nothing of it is on the page', async () => {
    for (const next of evil) {
      const res = await get('/login?next=' + encodeURIComponent(next));
      expect(res.status, next).toBe(200);
      const html = await res.text();
      expect(landing(html), next).toBe('/dashboard');
      expect(html, next).not.toContain('evil.example');
      expect(html, next).toContain('href="/forgot-password"');
    }
  });

  it('signed in: no redirect to it, the login page answers as it always has', async () => {
    for (const next of evil) {
      const res = await get('/login?next=' + encodeURIComponent(next), a.s.cookie);
      expect(res.status, next).toBe(200);
      expect(res.headers.get('location'), next).toBe(null);
    }
  });

  it('the reset email and the reset page drop it too', async () => {
    for (const next of evil.slice(0, 4)) {
      mail.sent.length = 0;
      const asked = await SELF.fetch(BASE + '/auth/request-password-reset', {
        method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${241 + evil.indexOf(next)}` }, body: JSON.stringify({ email: 'admin.p180@example.com', next })
      });
      expect((await asked.json()).ok).toBe(true);
      const [link] = linksIn(mail.sent[0], '/reset-password');
      expect(new URL(link).searchParams.get('next'), next).toBe(null);
      const page = await (await get('/reset-password?token=x.y.z&next=' + encodeURIComponent(next))).text();
      expect(landing(page), next).toBe('/dashboard');
      expect(page, next).not.toContain('evil.example');
    }
  });

  it('with no destination, /login is exactly what it was', async () => {
    const html = await (await get('/login')).text();
    expect(landing(html)).toBe('/dashboard');
    expect(html).toContain('href="/forgot-password"');
    // Even signed in: the page, no redirect.
    expect((await get('/login', a.s.cookie)).status).toBe(200);
  });
});

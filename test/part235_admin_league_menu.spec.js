// Stage 2, item 2a: the league menu in the admin header. An admin of several
// leagues sees, on every admin page, which league they are in and can switch
// to another from the header (/dashboard?league_id=, which makes it the
// current league through the nl_league cookie). An admin of one league sees
// just the name, as before. Notre Ligue only.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { withGameTimes } from './support/game_times.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.235.${++ip}` },
    body: JSON.stringify({ accept_terms: true, email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = (s, path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const get = (s, path) => SELF.fetch('http://example.com' + path, { headers: s ? { cookie: s.cookie } : {}, redirect: 'manual' });
const html = async (s, path) => (await get(s, path)).text();
const withCookie = (s, res) => {
  const jar = new Map(s.cookie.split('; ').map(c => [c.slice(0, c.indexOf('=')), c]));
  for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; jar.set(kv.slice(0, kv.indexOf('=')), kv); }
  return { ...s, cookie: [...jar.values()].join('; ') };
};

const PAGES = ['/dashboard', '/league/roster', '/league/schedule', '/league/settings', '/league/comms', '/league/finances', '/league/billing'];

beforeAll(async () => {
  env.AUTH_SECRET = 'p235-auth'; env.LEAGUE_PRODUCT = 'true'; env.BILLING_LAUNCH_AT = '2026-10-02';
  await applyRealSchema(env);
});
afterAll(() => { delete env.LEAGUE_PRODUCT; delete env.BILLING_LAUNCH_AT; });

describe('the league menu in the admin header', () => {
  let s, first, second, eventId;

  it('one league: just the name, no menu, on every admin page', async () => {
    s = await signup('p235.owner@example.com');
    const res = await post(s, '/leagues/create', { name: 'Ligue Alpha', teamNames: ['A', 'B'] });
    s = withCookie(s, res);
    first = (await res.json()).league.id;
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const ev = await post(s, '/league/events', withGameTimes({ date: '2099-06-07', season: 'S1', venue: 'Parc', start_time: '19:00' }));
    eventId = (await ev.json()).event.id;
    for (const p of PAGES) {
      const page = await html(s, p);
      expect(page, p).toContain('<span class="nl-brand" style="max-width:280px" title="Ligue Alpha">Ligue Alpha</span>');
      expect(page, p).not.toContain('id="nl_league_menu"');
    }
  });

  it('two leagues: the menu on every admin page, the current league marked', async () => {
    const res = await post(s, '/leagues/create', { name: 'Ligue Beta', teamStructure: 'headcount' });
    s = withCookie(s, res);
    second = (await res.json()).league.id;
    for (const p of [...PAGES, `/league/events/detail?e=${eventId}`]) {
      const page = await html(s, p);
      expect(page, p).toContain('id="nl_league_menu"');
      expect(page, p).toContain('data-date-fr="Changer de ligue" data-date-en="Switch league"');
      expect(page, p).toContain(`href="/dashboard?league_id=${encodeURIComponent(first)}"`);
      expect(page, p).toContain(`href="/dashboard?league_id=${encodeURIComponent(second)}"`);
      expect(page, p).not.toContain('<span class="nl-brand" style="max-width:280px"');
    }
    // The game page made Alpha (the game's league) the current one.
  });

  it('switching from the menu: the chosen league is current on every page after', async () => {
    let res = await get(s, `/dashboard?league_id=${encodeURIComponent(second)}`);
    expect(res.status).toBe(200);
    s = withCookie(s, res);
    let roster = await html(s, '/league/roster');
    expect(roster).toContain('<span class="nl-lm-name">Ligue Beta</span>');
    expect(roster).toContain(`href="/dashboard?league_id=${encodeURIComponent(second)}" aria-current="true"`);
    expect(roster).not.toContain(`href="/dashboard?league_id=${encodeURIComponent(first)}" aria-current`);
    res = await get(s, `/dashboard?league_id=${encodeURIComponent(first)}`);
    s = withCookie(s, res);
    const schedule = await html(s, '/league/schedule');
    expect(schedule).toContain('<span class="nl-lm-name">Ligue Alpha</span>');
    expect(schedule).toContain(`href="/dashboard?league_id=${encodeURIComponent(first)}" aria-current="true"`);
  });

  it('a deactivated league leaves the menu', async () => {
    await env.DB.prepare('UPDATE leagues SET deactivated_at = ? WHERE id = ?').bind(new Date().toISOString(), second).run();
    const page = await html(s, '/league/roster');
    expect(page).not.toContain('id="nl_league_menu"');
    expect(page).toContain('title="Ligue Alpha">Ligue Alpha</span>');
    await env.DB.prepare('UPDATE leagues SET deactivated_at = NULL WHERE id = ?').bind(second).run();
  });

  it('a league the user does not run is never listed', async () => {
    let other = await signup('p235.other@example.com');
    const res = await post(other, '/leagues/create', { name: 'Ligue Gamma', teamNames: ['C', 'D'] });
    other = withCookie(other, res);
    const page = await html(s, '/dashboard');
    expect(page).not.toContain('Ligue Gamma');
    expect(await html(other, '/dashboard')).not.toContain('id="nl_league_menu"');
  });
});

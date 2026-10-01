// The dashboard, for an admin of several leagues: it shows the current
// league (the nl_league cookie a game link sets), and a league's alert
// email links to that league's dashboard (?league_id=), which then becomes
// the current league. A league the admin does not run is ignored.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { admin, must } from './support/league_season.js';
import { healthHost } from '../src/index.js';

const BASE = 'http://example.com';
let a, b, older, newer, other;

beforeAll(async () => {
  env.AUTH_SECRET = 'p199-auth'; env.RSVP_SECRET = 'p199-rsvp'; env.LEAGUE_PRODUCT = 'true';
  await applyRealSchema(env);
  a = await admin('p199.two');
  older = (await must(a.post('/leagues/create', { name: 'Older Dash League', teamNames: ['A', 'B'] }), 'older')).league;
  await new Promise(r => setTimeout(r, 1100));
  newer = (await must(a.post('/leagues/create', { name: 'Newer Dash League', teamNames: ['C', 'D'] }), 'newer')).league;
  b = await admin('p199.other');
  other = (await must(b.post('/leagues/create', { name: 'Someone Else Dash', teamNames: ['E', 'F'] }), 'other')).league;
});

const get = (path, cookie) => SELF.fetch(BASE + path, { redirect: 'manual', headers: { cookie } });
const leagueOn = html => (html.includes('Older Dash League') ? 'older' : '') + (html.includes('Newer Dash League') ? 'newer' : '') + (html.includes('Someone Else Dash') ? 'other' : '');

describe('the dashboard, for an admin of two leagues', () => {
  it('no choice yet: the most recent league, as before', async () => {
    expect(leagueOn(await (await get('/dashboard', a.s.cookie)).text())).toBe('newer');
  });

  it('the current league chosen by a game link (the nl_league cookie) is the one shown', async () => {
    const cookie = `${a.s.cookie}; nl_league=${encodeURIComponent(older.id)}`;
    expect(leagueOn(await (await get('/dashboard', cookie)).text())).toBe('older');
  });

  it("an alert's link to the older league: that league, and it becomes the current one", async () => {
    const res = await get(`/dashboard?league_id=${encodeURIComponent(older.id)}`, a.s.cookie);
    expect(res.status).toBe(200);
    expect(leagueOn(await res.text())).toBe('older');
    const set = res.headers.getSetCookie().find(c => c.startsWith('nl_league='));
    expect(set).toContain(`nl_league=${encodeURIComponent(older.id)}`);
    expect(set).toContain('HttpOnly');
    expect(await (await get('/league/schedule', `${a.s.cookie}; ${set.split(';')[0]}`)).text()).toContain('Older Dash League');
  });

  it('a league they do not run: ignored, no cookie, their own league shown', async () => {
    const res = await get(`/dashboard?league_id=${encodeURIComponent(other.id)}`, a.s.cookie);
    expect(res.status).toBe(200);
    expect(leagueOn(await res.text())).toBe('newer');
    expect(res.headers.getSetCookie().some(c => c.startsWith('nl_league='))).toBe(false);
  });

  it("the league admin's alert email links to that league's dashboard", () => {
    const mail = healthHost(env).renderAdminAlert({ id: older.id, name: 'Older Dash League' }, [{ fr: 'Un problème', en: 'A problem' }]);
    expect(mail.text).toContain(`/dashboard?league_id=${encodeURIComponent(older.id)}`);
  });
});

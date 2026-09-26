// Live-testing task (batch 2), Part 4: the public page showed a
// standings table for weekly_draw and headcount leagues, where it's
// meaningless. For weekly_draw, teams are redrawn every event -- a
// cumulative win/loss table for a name that gets reassigned weekly
// doesn't track anything real (tonight's "Rouge" is a different group
// of people than next week's). For headcount there are no teams at
// all (and showing standings there would leak the internal
// HEADCOUNT_TEAM_NAME sentinel as if it were a real team).
//
// Fix: standings only ever render for teamStructure === 'fixed'.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part4-batch2-standings-fixed-only-secret';

function extractCookie(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(', ');
  const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
  return csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
}
async function signup(email, ip) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  return { cookie: extractCookie(res), csrfToken: extractCsrfToken(res) };
}
async function createLeague(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).league;
}
async function createEvent(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).event;
}
async function submitScore(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events/score', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return res.json();
}

describe('Part 4 (live-testing task, batch 2): public-page standings only render for fixed', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('fixed: standings DO render (real per-team win/loss tracking)', async () => {
    const { cookie, csrfToken } = await signup('standings.fixed@example.com', '203.0.164.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Standings Fixed League', teamNames: ['Falcons', 'Otters'], tracksStats: true });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Standings Season' })
    });
    // Stats tracking task (Part 4): standings are now computed fresh
    // from real game results (computeStandings), replacing the old
    // permanently-0-0-0 season.standings array that used to populate
    // this table from team names alone -- a real result has to exist
    // for a real row to appear.
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'Standings Season' });
    await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: 3, away_score: 1 });
    const html = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
    expect(html).toContain('data-i18n="standings"');
    expect(html).toContain('Falcons');
  });

  it('weekly_draw: standings do NOT render (teams are redrawn every event)', async () => {
    const { cookie, csrfToken } = await signup('standings.weekly@example.com', '203.0.164.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Standings Weekly League', teamStructure: 'weekly_draw', teamNames: ['Rouge', 'Bleu'], tracksStats: true });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Standings Season' })
    });
    const html = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
    expect(html).not.toContain('data-i18n="standings"');
  });

  it('headcount: standings do NOT render (no teams at all)', async () => {
    const { cookie, csrfToken } = await signup('standings.headcount@example.com', '203.0.164.003');
    const league = await createLeague(cookie, csrfToken, { name: 'Standings Headcount League', teamStructure: 'headcount', minPlayers: 6, maxPlayers: 12, tracksStats: true });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Standings Season' })
    });
    const html = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
    expect(html).not.toContain('data-i18n="standings"');
    // The internal sentinel team name must never leak either.
    expect(html).not.toContain('Tous');
  });

  it('a fixed league with tracksStats OFF still shows no standings (unaffected, pre-existing behavior)', async () => {
    const { cookie, csrfToken } = await signup('standings.notracking@example.com', '203.0.164.004');
    const league = await createLeague(cookie, csrfToken, { name: 'Standings No Tracking League', teamNames: ['A', 'B'], tracksStats: false });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Standings Season' })
    });
    const html = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
    expect(html).not.toContain('data-i18n="standings"');
  });
});

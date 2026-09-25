// Fixed-teams investigation follow-up batch (Parts 1-3): fixed teams
// had barely been exercised end to end. This file locks Part 1's fix
// first -- src/index.js's handleLeagueEventDetailPage used to loop
// over EVERY team in a 'fixed' league for every event, as if all of
// them played that one game. Correct by coincidence for a 2-team
// league (both genuinely do play); wrong for any larger one (a
// 4-team league showed all 4 team cards -- rosters, shortage badges,
// invite buttons -- for a game only 2 of them are actually in).
// weekly_draw and headcount are unaffected: each of their own team
// cards already means something different (weekly_draw's is this
// week's real draw result; headcount's is the league's one implicit
// pool).
//
// There's no stored matchup yet at this point in the batch (Part 2
// adds ev.home_team/ev.away_team) -- until then, a >2-team fixed
// event's real matchup is unknown, so the page renders an explicit
// "no matchup set" state instead of guessing. Parts 2/3's own tests
// are appended to this same file as they land.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part92-fixed-teams-scheduling-secret';

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
async function publishSeason(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return res.json();
}
async function createEvent(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).event;
}
async function eventDetailHtml(cookie, eventId) {
  return (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } })).text();
}

describe('Part 1 (fixed-teams investigation follow-up): the event page shows only the teams actually playing', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a 4-team fixed league: no team cards render for an event with no known matchup -- a "no matchup set" state instead, in both languages', async () => {
    const { cookie, csrfToken } = await signup('p1.fourteam@example.com', '203.0.197.001');
    await createLeague(cookie, csrfToken, { name: 'Four Team League', teamNames: ['Rouge', 'Bleu', 'Vert', 'Jaune'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-03-01', season: 'S1' });

    const html = await eventDetailHtml(cookie, ev.id);
    // None of the 4 team names render as a team-card heading.
    for (const team of ['Rouge', 'Bleu', 'Vert', 'Jaune']) {
      expect(html).not.toContain(`>${team}</h2>`);
    }
    expect(html).not.toContain('class="nl-badge nl-badge--short"');
    expect(html).not.toContain('class="nl-badge nl-badge--in">');
    expect((html.match(/class="ev-team"/g) || []).length).toBe(0);
    expect(html).toContain('data-i18n="noMatchupSetTitle">Aucun match déterminé<');
    expect(html).toContain('data-i18n="noMatchupSetDesc"');

    // Confirm the EN string exists in the page's own i18n dict (client
    // FR/EN toggle), not only the French server-rendered fallback.
    const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/);
    expect(m).toBeTruthy();
    const dict = JSON.parse(m[1]);
    expect(dict.en.noMatchupSetTitle).toBe('No matchup set');
    expect(dict.en.noMatchupSetDesc).toBe("This league has more than two teams -- who's playing needs to be known before rosters can be shown.");
  });

  it('a 2-team fixed league: both teams still render, completely unchanged -- no matchup data is needed when both teams always play', async () => {
    const { cookie, csrfToken } = await signup('p1.twoteam@example.com', '203.0.197.002');
    await createLeague(cookie, csrfToken, { name: 'Two Team League', teamNames: ['Rouge', 'Bleu'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-03-01', season: 'S1' });

    const html = await eventDetailHtml(cookie, ev.id);
    expect(html).toContain('>Rouge</h2>');
    expect(html).toContain('>Bleu</h2>');
    expect((html.match(/class="[^"]*\bev-team\b[^"]*"/g) || []).length).toBe(2);
    expect(html).not.toContain('data-i18n="noMatchupSetTitle"');
  });

  it('a 3-team fixed league also gets the "no matchup set" state (not just 4+)', async () => {
    const { cookie, csrfToken } = await signup('p1.threeteam@example.com', '203.0.197.003');
    await createLeague(cookie, csrfToken, { name: 'Three Team League', teamNames: ['A', 'B', 'C'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-03-01', season: 'S1' });

    const html = await eventDetailHtml(cookie, ev.id);
    expect((html.match(/class="[^"]*\bev-team\b[^"]*"/g) || []).length).toBe(0);
    expect(html).toContain('data-i18n="noMatchupSetTitle"');
  });

  it('a weekly_draw league with 4 teams is completely unaffected -- its own pool/draw cards render exactly as before', async () => {
    const { cookie, csrfToken } = await signup('p1.weeklydraw@example.com', '203.0.197.004');
    await createLeague(cookie, csrfToken, { name: 'Weekly Draw Four League', teamStructure: 'weekly_draw', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-03-01', season: 'S1' });

    const html = await eventDetailHtml(cookie, ev.id);
    expect(html).not.toContain('data-i18n="noMatchupSetTitle"');
    // Pre-draw pool card (Group A fix, this same page) still renders.
    expect(html).toContain('data-i18n="poolTitle"');
  });

  it('a headcount league is completely unaffected -- its own single pool card renders exactly as before', async () => {
    const { cookie, csrfToken } = await signup('p1.headcount@example.com', '203.0.197.005');
    await createLeague(cookie, csrfToken, { name: 'Headcount League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12, tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1', min_players: 8, max_players: 12 });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-03-01', season: 'S1' });

    const html = await eventDetailHtml(cookie, ev.id);
    expect(html).not.toContain('data-i18n="noMatchupSetTitle"');
    expect(html).toContain('data-i18n="poolTitle">Joueurs<');
  });
});

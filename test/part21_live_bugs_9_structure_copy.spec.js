// Part 3 of a live-testing task: the team-structure signup copy was
// too terse/unclear for a non-technical league organizer. Rewrote the
// three descriptions to be clearer, friendlier, and (for weekly_draw)
// to mention the app's own automatic team-building capability, which
// wasn't communicated anywhere during signup before this.
//
// B2 (stale-copy polish task) deliberately superseded this generation
// of copy with a new final wording, applied everywhere: "Teams
// shuffle" was jargon and "No teams" (as a title) undersold that those
// leagues do form teams, just at the venue -- descriptions were
// rewritten again to be clearer about that. Titles/descriptions below
// updated to match; this is not a reversion of Part 3's own fix, which
// remains true in spirit (clearer, friendlier copy, automatic
// team-building mentioned for weekly_draw).
import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { env } from 'cloudflare:test';

const AUTH_SECRET = 'test-part21-live-bugs-9-secret';

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

describe('Live-testing Part 3: team-structure copy is clearer and friendlier', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('signup step 2 renders the updated FR copy for all three structure options', async () => {
    const { cookie } = await signup('bugs9.copy.step2.fr@example.com', '203.0.124.001');
    const html = await (await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie } })).text();
    expect(html).toContain('La même équipe toute la saison, comme une ligue régulière.');
    expect(html).toContain('Juste la liste des présents. Vous formez les équipes sur place.');
    expect(html).toContain('Les équipes sont refaites à chaque match — tirage automatique ou choisies par toi.');
    // The earlier, now-superseded copy generations are gone.
    expect(html).not.toContain('Les mêmes équipes toute la saison.');
    expect(html).not.toContain("Juste une liste de joueurs, pas d'équipes.");
    expect(html).not.toContain('Les équipes changent à chaque match.');
    expect(html).not.toContain('comme une ligue classique');
    expect(html).not.toContain('parfait pour une partie improvisée');
  });

  it('signup step 2 embeds the updated EN copy in its own i18n dict, including a mention of automatic team-building for weekly_draw', async () => {
    const { cookie } = await signup('bugs9.copy.step2.en@example.com', '203.0.124.002');
    const html = await (await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie } })).text();
    expect(html).toContain('The same team all season, like a regular league.');
    expect(html).toContain("Just a list of who's in. You sort out sides at the venue.");
    // The weekly_draw copy still communicates the app can build teams
    // automatically -- previously not communicated at all at signup.
    expect(html).toContain('drawn automatically or set by you');
    expect(html).not.toContain('The same teams all season.');
    expect(html).not.toContain('Just a list of players, no teams.');
    expect(html).not.toContain('Teams are different every game.');
    expect(html).not.toContain('we can even build them for you, automatically');
  });

  it('Settings\' own season-structure-override picker uses the SAME updated copy, kept consistent with signup', async () => {
    // Live-testing task (batch 6), Part 7: this section moved from the
    // dashboard home to Settings -- see handleDashboardPage/
    // handleLeagueSettingsPage's own comments. Was /dashboard before.
    const { cookie, csrfToken } = await signup('bugs9.copy.dashboard@example.com', '203.0.124.003');
    await createLeague(cookie, csrfToken, { name: 'Copy Dashboard League', teamNames: ['A', 'B'], tracksStats: true });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Copy Dashboard Season' })
    });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toContain('La même équipe toute la saison, comme une ligue régulière.');
    expect(html).toContain('Juste la liste des présents. Vous formez les équipes sur place.');
    expect(html).toContain('tirage automatique ou choisies par toi.');
  });
});

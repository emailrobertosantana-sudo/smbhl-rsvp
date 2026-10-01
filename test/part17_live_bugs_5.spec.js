// Bug 4 found via a real end-to-end live verification against
// notreligue.ca: the dashboard's onboarding checklist always showed
// "Nommer les équipes" ("Name the teams") as done, even for a
// headcount league that never named any teams at all -- a false
// "done" for a step that genuinely never happened.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part17-live-bugs-5-secret';

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
    body: JSON.stringify({ accept_terms: true, email, password: 'a-strong-password-1' })
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

describe('Live-testing Bug 4: onboarding checklist accuracy per team-structure mode', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  // Onboarding items 4/5 (replacing Bug 4 / B3's pre-season row): team
  // names and the player count are set during onboarding, AFTER the season
  // exists, so the pre-season checklist has no row for them (it could never
  // be ticked). With a season, a FIXED league still on its generated names
  // gets "Nommer tes équipes" among the next steps; a pickup league never
  // (teams drawn fresh each game -- default names are fine); a no-teams
  // league has no names at all.
  const dash = async cookie => (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
  const publish = (cookie, csrfToken) => SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ season_name: 'S1' })
  });

  it('before a season: no team-names or player-count row, for every structure', async () => {
    for (const [i, body] of [
      { teamNames: ['A', 'B'] },
      { teamNames: ['Team 1', 'Team 2'], teamStructure: 'weekly_draw' },
      { teamStructure: 'headcount' }
    ].entries()) {
      const { cookie, csrfToken } = await signup(`bugs5.noseason.${i}@example.com`, `203.0.120.0${10 + i}`);
      await createLeague(cookie, csrfToken, { name: `No Season League ${i}`, tracksStats: true, ...body });
      const html = await dash(cookie);
      expect(html).toContain('data-i18n="checklistTitle"');
      expect(html).not.toContain('<span data-i18n="ckTeams">');
      expect(html).not.toContain('<span data-i18n="ckPlayerCount">');
    }
  });

  for (const [label, names, expected] of [
    ['generated English defaults', ['Team 1', 'Team 2'], true],
    ['generated French defaults', ['Équipe 1', 'Équipe 2'], true],
    ['one of two renamed', ['Team 1', 'Dynamos'], false],
    ['a real name that happens to be "Team 1"', ['Team 1', 'Real Team Name'], false]
  ]) {
    it(`with a season, a FIXED league with ${label}: "Nommer tes équipes" ${expected ? 'is' : 'is not'} a next step`, async () => {
      const { cookie, csrfToken } = await signup(`bugs5.fixednames.${label.replace(/[^a-z]/gi, '')}@example.com`, `203.0.120.${30 + label.length}`);
      await createLeague(cookie, csrfToken, { name: `Names ${label}`, teamNames: names, tracksStats: true });
      await publish(cookie, csrfToken);
      const html = await dash(cookie);
      if (expected) expect(html).toContain('data-i18n="nsNameTeams"'); else expect(html).not.toContain('data-i18n="nsNameTeams"');
    });
  }

  it('with a season, a PICKUP league keeping "Équipe 1/2" is never asked to name teams', async () => {
    const { cookie, csrfToken } = await signup('bugs5.pickupnames@example.com', '203.0.120.060');
    await createLeague(cookie, csrfToken, { name: 'Pickup Names', teamNames: ['Équipe 1', 'Équipe 2'], tracksStats: true, teamStructure: 'weekly_draw' });
    await publish(cookie, csrfToken);
    expect(await dash(cookie)).not.toContain('data-i18n="nsNameTeams"');
  });

  it('the checklist section only ever renders before the first season is published, for every mode', async () => {
    const { cookie, csrfToken } = await signup('bugs5.checklist.gone@example.com', '203.0.120.004');
    await createLeague(cookie, csrfToken, { name: 'Checklist Gone League', tracksStats: true, teamStructure: 'headcount', minPlayers: 4, maxPlayers: 8 });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Checklist Gone Season' })
    });
    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const html = await res.text();
    expect(html).not.toContain('data-i18n="checklistTitle"');
    expect(html).not.toContain('data-i18n="ckPlayerCount">');
  });
});

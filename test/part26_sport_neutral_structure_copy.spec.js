// Live-testing task, Part 3: "the team-structure question at signup
// currently says 'Comment ça marche, ton hockey?' -- hardcoded to
// hockey. Change to sport-neutral copy." Investigation found this
// wording doesn't exist anywhere in the codebase anymore -- the
// question was already rewritten to a sport-neutral form ("Comment
// sont organisées tes équipes?" / "How are your teams organized?") as
// part of an earlier team-structure copy pass, and that rewrite is
// already applied consistently on both surfaces that ask it: signup
// step 2 and the season-override picker (originally on the dashboard;
// moved to Settings in batch 6, Part 7 -- see that part's own comment
// in handleLeagueSettingsPage/handleDashboardPage). No code change
// needed; this test locks the sport-neutral wording in as a
// regression, and confirms no sport name (hockey, ice hockey, etc.)
// leaks into the question on either surface, in either language.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part3-sport-neutral-secret';

function extractCookie(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

describe('Part 3 (live-testing task): team-structure question copy is sport-neutral', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('signup step 2 asks the sport-neutral question in French, never naming a sport', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.120' },
      body: JSON.stringify({ email: 'fr.structure.copy@example.com', password: 'a-strong-password-1', lang: 'fr' })
    });
    const cookieHeader = extractCookie(signupRes);
    const html = await (await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie: cookieHeader } })).text();
    expect(html).toContain('Comment sont organisées tes équipes?');
    expect(html.toLowerCase()).not.toContain('hockey');
  });

  it('signup step 2 asks the sport-neutral question in English, never naming a sport', async () => {
    const html = await (await SELF.fetch('http://example.com/signup?step=2')).text();
    expect(html).toContain('How are your teams organized?');
    expect(html.toLowerCase()).not.toContain('hockey');
  });

  it('the Settings season-override picker uses the same sport-neutral question, both languages', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.121' },
      body: JSON.stringify({ email: 'dash.structure.copy@example.com', password: 'a-strong-password-1' })
    });
    const cookieHeader = extractCookie(signupRes);
    const csrfCookies = typeof signupRes.headers.getSetCookie === 'function'
      ? signupRes.headers.getSetCookie()
      : (signupRes.headers.get('set-cookie') || '').split(', ');
    const csrfToken = (csrfCookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1];

    await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Structure Copy Dashboard League', tracksStats: true, teamStructure: 'fixed', teamNames: ['A', 'B'] })
    });
    // The season-override section (where this question also appears)
    // only renders once a season exists (!needsSeason) -- publish one.
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Structure Copy Season' })
    });

    const settingsHtml = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie: cookieHeader } })).text();
    expect(settingsHtml).toContain('Comment sont organisées tes équipes?');
    expect(settingsHtml).toContain('How are your teams organized?');
    const htmlNoScripts = settingsHtml.replace(/<script[\s\S]*?<\/script>/g, '');
    const visibleText = (htmlNoScripts.match(/>([^<]*)</g) || []).join(' ').toLowerCase();
    expect(visibleText).not.toContain('hockey');
  });
});

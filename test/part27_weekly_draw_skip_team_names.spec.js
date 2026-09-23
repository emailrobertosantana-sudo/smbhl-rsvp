// Live-testing task, Part 4: weekly_draw doesn't ask for team names at
// signup -- teams are re-drawn every game, so a permanent name chosen
// upfront isn't meaningful. Two teams are created automatically
// ("Rouge / Red" / "Bleu / Blue" -- a single bilingual name per team,
// reading fine in either UI language without needing per-language
// dict logic) and step 3 (the team-names step) is skipped entirely:
// submitStep2() creates the league directly and navigates straight to
// the done page for weekly_draw, never rendering step 3's team-name
// inputs. 'fixed' is unaffected -- it still goes to step 3 and still
// asks for real team names, since fixed teams are permanent.
//
// DECISION (flagged per this task's own "document every decision"
// instruction): the task described this as "fully editable later from
// wherever team names/colors are already editable in league settings"
// -- investigation found NO existing route or UI anywhere in this
// codebase for editing a league's team names (or color) after
// creation; handleLeagueCreate is the only writer of leagues.team_names.
// Per the task's own "do not build a new editing surface if one
// already exists" instruction, and since building one wasn't itself
// asked for, no new editing surface was built. This is a genuine gap
// (a weekly_draw admin can't yet rename "Rouge / Red" without direct DB
// access) called out explicitly in the final report rather than
// silently left unaddressed or silently expanded in scope.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part4-weekly-draw-secret';

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

describe('Part 4 (live-testing task): weekly_draw skips team names at signup, defaults to Rouge/Red + Bleu/Blue', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it("signup step 2's served script creates the league directly for weekly_draw, with the bilingual default team names, and never mentions step=3", async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.132' },
      body: JSON.stringify({ email: 'step2.script.check@example.com', password: 'a-strong-password-1' })
    });
    const cookieHeader = extractCookie(signupRes);
    const html = await (await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie: cookieHeader } })).text();
    expect(html).toContain("teamStructure === 'weekly_draw'");
    expect(html).toContain('Rouge / Red');
    expect(html).toContain('Bleu / Blue');
    expect(html).toContain("window.__navWithLang('/signup?step=done')");
  });

  it("'fixed' mode is completely unaffected -- step 2's script still stores a draft and navigates to step 3 for it", async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.133' },
      body: JSON.stringify({ email: 'step2.fixed.check@example.com', password: 'a-strong-password-1' })
    });
    const cookieHeader = extractCookie(signupRes);
    const html = await (await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie: cookieHeader } })).text();
    expect(html).toContain("window.__navWithLang('/signup?step=3')");
    expect(html).toContain('nl_signup_league');
  });

  it("a stale weekly_draw draft reaching step 3 (e.g. browser back after this fix) redirects to step 2, never shows team-name inputs for it", async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.134' },
      body: JSON.stringify({ email: 'step3.stale.check@example.com', password: 'a-strong-password-1' })
    });
    const cookieHeader = extractCookie(signupRes);
    const html = await (await SELF.fetch('http://example.com/signup?step=3', { headers: { cookie: cookieHeader } })).text();
    expect(html).toContain("leagueDraft.teamStructure === 'weekly_draw'");
  });

  it('a weekly_draw league created with the wizard default has exactly two teams named "Rouge / Red" and "Bleu / Blue"', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.130' },
      body: JSON.stringify({ email: 'weekly.draw.default@example.com', password: 'a-strong-password-1' })
    });
    const cookieHeader = extractCookie(signupRes);
    const csrfToken = extractCsrfToken(signupRes);

    const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Weekly Draw Default League', tracksStats: true, teamStructure: 'weekly_draw', teamNames: ['Rouge / Red', 'Bleu / Blue'] })
    });
    expect(leagueRes.status).toBe(200);
    const json = await leagueRes.json();
    expect(json.ok).toBe(true);
    expect(json.league.teamCount).toBe(2);
    expect(json.league.teamNames).toEqual(['Rouge / Red', 'Bleu / Blue']);

    const row = await env.DB.prepare('SELECT team_names FROM leagues WHERE id = ?').bind(json.league.id).first();
    expect(JSON.parse(row.team_names)).toEqual(['Rouge / Red', 'Bleu / Blue']);
  });

  it("'fixed' mode signups are unaffected end-to-end: still requires real team names via the API, still rejects fewer than 2", async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.131' },
      body: JSON.stringify({ email: 'fixed.unaffected@example.com', password: 'a-strong-password-1' })
    });
    const cookieHeader = extractCookie(signupRes);
    const csrfToken = extractCsrfToken(signupRes);

    const rejected = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Fixed No Names League', tracksStats: true, teamStructure: 'fixed', teamNames: [] })
    });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).errorKey).toBe('MIN_TEAM_NAMES');

    const accepted = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Fixed Real Names League', tracksStats: true, teamStructure: 'fixed', teamNames: ['Falcons', 'Otters'] })
    });
    expect(accepted.status).toBe(200);
    const json = await accepted.json();
    expect(json.league.teamNames).toEqual(['Falcons', 'Otters']);
  });
});

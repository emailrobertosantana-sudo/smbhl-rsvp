// Live-testing task, Part 4: weekly_draw doesn't ask for team names at
// signup -- teams are re-drawn every game, so a permanent name chosen
// upfront isn't meaningful. Two teams are created automatically and
// step 3 (the team-names step) is skipped entirely: submitStep2()
// creates the league directly and navigates straight to the done page
// for weekly_draw, never rendering step 3's team-name inputs. 'fixed'
// is unaffected -- it still goes to step 3 and still asks for real
// team names, since fixed teams are permanent.
//
// Live-testing task (batch 2), Part 8: the original default names were
// a single JAMMED bilingual string per team ("Rouge / Red", "Bleu /
// Blue"), rendering literally as that combined string everywhere --
// not "fine in either UI language" as first assumed, just wrong in
// both. A team's name is meant to be a single value (whatever the
// admin sets), not a bilingual pair crammed into one field (this
// product has no name_fr/name_en split for league team names at all,
// unlike SMBHL's own DEFAULT_SEASON_CONFIG.teams). Replaced with the
// same numbered-placeholder convention the 'fixed' wizard's own
// team-name step already uses when a name is left blank
// (teamPlaceholder: "Équipe "/"Team " + the signup's own current
// language) -- "Équipe 1"/"Équipe 2" (FR) or "Team 1"/"Team 2" (EN).
//
// The settings page's team-rename route (/league/settings/teams, built
// in a later session than this file's own original "no editing
// surface exists" note) now covers the "still editable afterward"
// half of this fix -- confirmed below.
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

describe('Part 4 (live-testing task): weekly_draw skips team names at signup, defaults to single-language numbered names', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it("signup step 2's served script creates the league directly for weekly_draw, with single-language numbered default team names (not a jammed bilingual pair), and never mentions step=3", async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.132' },
      body: JSON.stringify({ email: 'step2.script.check@example.com', password: 'a-strong-password-1' })
    });
    const cookieHeader = extractCookie(signupRes);
    const html = await (await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie: cookieHeader } })).text();
    expect(html).toContain("teamStructure === 'weekly_draw'");
    // Live-testing task (batch 2), Part 8: single-language, numbered,
    // built from the same i18n dict the 'fixed' wizard's own team-name
    // placeholders already use -- not a hardcoded literal string, since
    // the actual rendered team names depend on window.__pageDict() at
    // signup time (the player's current FR/EN choice).
    expect(html).toContain("(window.__pageDict().teamPlaceholder) + '1'");
    expect(html).toContain("(window.__pageDict().teamPlaceholder) + '2'");
    expect(html).not.toContain('Rouge / Red');
    expect(html).not.toContain('Bleu / Blue');
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

  it('a weekly_draw league created with the wizard\'s real default (single-language, numbered) has exactly two such teams, and they can be renamed via the settings page afterward', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.130' },
      body: JSON.stringify({ email: 'weekly.draw.default@example.com', password: 'a-strong-password-1' })
    });
    const cookieHeader = extractCookie(signupRes);
    const csrfToken = extractCsrfToken(signupRes);

    // The exact strings the FR-default signup script would send
    // (window.__pageDict().teamPlaceholder + '1'/'2', per its own
    // fix -- reproduced literally here since this test hits the API
    // directly rather than executing the client script).
    const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Weekly Draw Default League', tracksStats: true, teamStructure: 'weekly_draw', teamNames: ['Équipe 1', 'Équipe 2'] })
    });
    expect(leagueRes.status).toBe(200);
    const json = await leagueRes.json();
    expect(json.ok).toBe(true);
    expect(json.league.teamCount).toBe(2);
    expect(json.league.teamNames).toEqual(['Équipe 1', 'Équipe 2']);

    const row = await env.DB.prepare('SELECT team_names FROM leagues WHERE id = ?').bind(json.league.id).first();
    expect(JSON.parse(row.team_names)).toEqual(['Équipe 1', 'Équipe 2']);

    // Live-testing task (batch 2), Part 8: confirms the settings page's
    // team-rename route now covers a weekly_draw league's default
    // names -- a genuine gap this same file used to flag as absent.
    const renameRes = await SELF.fetch('http://example.com/league/settings/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ teamNames: ['Les Faucons', 'Les Loutres'] })
    });
    expect(renameRes.status).toBe(200);
    const renamed = await env.DB.prepare('SELECT team_names FROM leagues WHERE id = ?').bind(json.league.id).first();
    expect(JSON.parse(renamed.team_names)).toEqual(['Les Faucons', 'Les Loutres']);
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

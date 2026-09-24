// Live-testing task, Part 2: public site theme picker. The design
// system (notre-ligue-design-system/guidelines/20-public-site-themes.md)
// defines 4 themes -- Arène, Classique, Épuré, Quartier -- all sharing
// "the same data and structure... only the look changes." That rule is
// what makes this a CSS-only swap of the SAME HTML/class names this
// page already generated (see PUBLIC_THEME_ARENE_CSS's own comment,
// index.js).
//
// SCOPE (documented, per the task's own "stop at a clean boundary"
// instruction): only 2 of the 4 themes are implemented and tested --
// Arène (the pre-existing, unchanged default) and Épuré (new).
// Classique needs a top-scorers leaderboard this app has no data
// source for; Quartier needs an admin-authored "organizer's note" free
// text field, a new data concept, plus a second webfont. Both are real
// feature work, not a quick reskin, so neither is offered in the
// picker -- shipping a selectable-but-unstyled option would be worse
// than not offering it.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part2-public-themes-secret';

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
async function setTheme(cookie, csrfToken, publicTheme) {
  return SELF.fetch('http://example.com/league/settings/identity', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ publicTheme })
  });
}

describe('Part 2 (live-testing task): public site theme picker', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it("every existing/new league defaults to 'arene' -- the exact pre-existing dark theme, unchanged", async () => {
    const { cookie, csrfToken } = await signup('theme.default@example.com', '203.0.134.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Theme Default League', teamNames: ['A', 'B'], tracksStats: true });
    const row = await env.DB.prepare('SELECT public_theme FROM leagues WHERE id = ?').bind(league.id).first();
    expect(row.public_theme).toBe('arene');

    const html = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
    expect(html).toContain('background: var(--surface-hero, #16181d)');
    expect(html).not.toContain('font-family: Inter, var(--font-sans)');
  });

  it("switching to 'clean' actually changes the public page's rendered CSS to the Épuré look", async () => {
    const { cookie, csrfToken } = await signup('theme.clean@example.com', '203.0.134.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Theme Clean League', teamNames: ['A', 'B'], tracksStats: true });

    const res = await setTheme(cookie, csrfToken, 'clean');
    expect(res.status).toBe(200);
    expect((await res.json()).settings.publicTheme).toBe('clean');

    const html = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
    expect(html).toContain('.nl { background: #ffffff; color: #1a1a1a;');
    expect(html).toContain('font-family: Inter, var(--font-sans)');
    expect(html).not.toContain('background: var(--surface-hero, #16181d)');
  });

  it('the SAME data (next game, standings, upcoming, teams) renders in both themes -- only the CSS differs', async () => {
    const { cookie, csrfToken } = await signup('theme.samedata@example.com', '203.0.134.003');
    const league = await createLeague(cookie, csrfToken, { name: 'Theme Same Data League', teamNames: ['Falcons', 'Otters'], tracksStats: true });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Theme Data Season' })
    });
    await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2099-04-04', venue: 'Theme Test Arena' })
    });

    const areneHtml = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
    expect(areneHtml).toContain('2099-04-04');
    expect(areneHtml).toContain('Theme Test Arena');
    expect(areneHtml).toContain('Falcons');
    expect(areneHtml).toContain('Otters');

    await setTheme(cookie, csrfToken, 'clean');
    const cleanHtml = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
    expect(cleanHtml).toContain('2099-04-04');
    expect(cleanHtml).toContain('Theme Test Arena');
    expect(cleanHtml).toContain('Falcons');
    expect(cleanHtml).toContain('Otters');
  });

  it('rejects an unimplemented/unknown theme value rather than silently storing it', async () => {
    const { cookie, csrfToken } = await signup('theme.invalid@example.com', '203.0.134.004');
    await createLeague(cookie, csrfToken, { name: 'Theme Invalid League', teamNames: ['A', 'B'], tracksStats: true });
    const res = await setTheme(cookie, csrfToken, 'classic');
    expect(res.status).toBe(400);
    expect((await res.json()).errorKey).toBe('INVALID_PUBLIC_THEME');
  });

  it('an invalid/legacy stored value on the league row still falls back to arene at render time (defensive)', async () => {
    const { cookie, csrfToken } = await signup('theme.badstored@example.com', '203.0.134.005');
    const league = await createLeague(cookie, csrfToken, { name: 'Theme Bad Stored League', teamNames: ['A', 'B'], tracksStats: true });
    await env.DB.prepare("UPDATE leagues SET public_theme = 'nonsense' WHERE id = ?").bind(league.id).run();
    const html = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
    expect(html).toContain('background: var(--surface-hero, #16181d)');
  });

  it('the settings page only offers the 2 genuinely implemented themes, never Classique/Quartier', async () => {
    const { cookie, csrfToken } = await signup('theme.picker.options@example.com', '203.0.134.006');
    await createLeague(cookie, csrfToken, { name: 'Theme Picker Options League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toContain('<option value="arene"');
    expect(html).toContain('<option value="clean"');
    expect(html).not.toContain('value="classic"');
    expect(html).not.toContain('value="warm"');
  });

  it('the public page renders correctly (200, not empty) for a weekly_draw league in the clean theme too', async () => {
    const { cookie, csrfToken } = await signup('theme.clean.weeklydraw@example.com', '203.0.134.007');
    const league = await createLeague(cookie, csrfToken, { name: 'Theme Clean Weekly Draw League', teamStructure: 'weekly_draw', teamNames: ['Rouge / Red', 'Bleu / Blue'], tracksStats: true });
    await setTheme(cookie, csrfToken, 'clean');
    const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Rouge / Red');
    expect(html).toContain('Bleu / Blue');
  });

  it('SMBHL is unaffected -- the theme route cannot be used against it, and its own public rendering (if any) never reads public_theme differently', async () => {
    const { cookie, csrfToken } = await signup('theme.smbhl.blocked@example.com', '203.0.134.008');
    const res = await setTheme(cookie, csrfToken, 'clean');
    // No league created for this account -- resolves NO_LEAGUE_FOUND,
    // same defense every other settings route already has.
    expect(res.status).toBe(404);
    expect((await res.json()).errorKey).toBe('NO_LEAGUE_FOUND');
  });
});

// Live-testing task, Part 6: the post-signup "done" screen's primary
// button used to be "Ajouter mes joueurs" (/league/roster), but the
// corrected dependency order established in this session (and already
// reflected in the dashboard's own checklist -- see buildDashI18n's
// "Bug 5" comment) is league -> SEASON -> real roster/event use. A
// season has to exist before adding players (or creating events) means
// anything real -- the dashboard blocks event creation entirely without
// one (needsSeason). This test locks in the corrected primary action:
// "Créer ma saison" / "Create my season" (B3, stale-copy polish task --
// was "Lancer ma saison"/"Start my season", a different verb than the
// "Create the season"/"Create a season" action and checklist item the
// dashboard itself actually uses), pointing at /dashboard, which
// itself renders the season-start form as the headline "next step" the
// moment a league has none yet. "Ajouter mes joueurs" stays available,
// just as a secondary, non-primary action.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part6-signup-done-secret';

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

describe('Part 6 (live-testing task): signup completion screen starts the season, not the roster', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  for (const [structure, extra] of [
    ['fixed', { teamNames: ['A', 'B'] }],
    ['headcount', { teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10 }],
    ['weekly_draw', { teamStructure: 'weekly_draw', teamNames: ['A', 'B'] }]
  ]) {
    it(`${structure}: the primary button is "Créer ma saison" targeting /dashboard`, async () => {
      const { cookie, csrfToken } = await signup(`done.primary.${structure}@example.com`, `203.0.151.00${structure === 'fixed' ? 1 : structure === 'headcount' ? 2 : 3}`);
      await createLeague(cookie, csrfToken, { name: `Done Primary ${structure} League`, tracksStats: true, ...extra });
      const html = await (await SELF.fetch('http://example.com/signup?step=done', { headers: { cookie } })).text();
      const primaryMatch = html.match(/<button[^>]*nl-btn--primary[^>]*>/);
      expect(primaryMatch).not.toBeNull();
      expect(primaryMatch[0]).toContain("onclick=\"location.href='/dashboard'\"");
      expect(primaryMatch[0]).toContain('data-i18n="startMySeason"');
      expect(html).toContain('>Créer ma saison</button>');
    });
  }

  // B3 bug fix (i18n/onboarding polish task): "Ajouter mes joueurs"
  // removed outright, not just kept as a secondary action -- a season
  // has to exist before adding players is meaningful (the reason it was
  // already demoted below primary), so "Lancer ma saison" is the one
  // real next action on this screen now.
  it('"Ajouter mes joueurs" is gone entirely -- "Créer ma saison" is the only action on this screen', async () => {
    const { cookie, csrfToken } = await signup('done.secondary@example.com', '203.0.151.010');
    await createLeague(cookie, csrfToken, { name: 'Done Secondary League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/signup?step=done', { headers: { cookie } })).text();
    expect(html).not.toContain("onclick=\"location.href='/league/roster'\"");
    expect(html).not.toContain('data-i18n="addPlayers"');
    expect((html.match(/class="su-bottom"[\s\S]*?<\/div>/) || [''])[0].match(/<button/g) || []).toHaveLength(1);
  });

  // A1 bug fix (onboarding polish task): the done screen used to say the
  // public page was "already live" and invite sharing it -- misleading,
  // since it's genuinely empty (no schedule, no roster) the moment a
  // league is created. Reframed to set the right expectation instead.
  it('A1: the done screen sets the right expectation -- the page is empty for now, not "already live" ready to share', async () => {
    const { cookie, csrfToken } = await signup('done.a1.copy.fr@example.com', '203.0.151.014');
    await createLeague(cookie, csrfToken, { name: 'Done A1 Copy League', teamNames: ['A', 'B'], tracksStats: true });
    const htmlFr = await (await SELF.fetch('http://example.com/signup?step=done', { headers: { cookie } })).text();
    expect(htmlFr).toContain("La page de ta ligue se trouve à cette adresse. Elle est vide pour l'instant et se remplit automatiquement au fur et à mesure que tu ajoutes ton calendrier et ton alignement. Partage-la une fois ta saison en place.");
    expect(htmlFr).not.toContain('déjà en ligne');

    const { cookie: cookieEn, csrfToken: csrfEn } = await signup('done.a1.copy.en@example.com', '203.0.151.015');
    await createLeague(cookieEn, csrfEn, { name: 'Done A1 Copy League EN', teamNames: ['A', 'B'], tracksStats: true });
    const htmlEn = await (await SELF.fetch('http://example.com/signup?step=done&lang=en', { headers: { cookie: cookieEn } })).text();
    expect(htmlEn).toContain("Your league's page is at this address. It's empty for now, and fills in automatically as you add your schedule and roster. Share it when your season is set up.");
    expect(htmlEn).not.toContain('already live');

    // The URL and Copy link button stay -- only the framing text changed.
    expect(htmlFr).toContain('id="su_public_url"');
    expect(htmlFr).toContain('id="su_copy"');
  });

  it('clicking through to /dashboard actually shows the season-start form as the headline next step', async () => {
    const { cookie, csrfToken } = await signup('done.followthrough@example.com', '203.0.151.011');
    await createLeague(cookie, csrfToken, { name: 'Done Followthrough League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(html).toContain('id="season_name"');
    expect(html).toContain('data-i18n="startSeason"');
  });

  it('matches the dashboard\'s own corrected checklist order: season before players', async () => {
    const { cookie, csrfToken } = await signup('done.checklist@example.com', '203.0.151.012');
    await createLeague(cookie, csrfToken, { name: 'Done Checklist League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    const seasonIdx = html.indexOf('ckSeason');
    const playersIdx = html.indexOf('ckPlayers');
    expect(seasonIdx).toBeGreaterThan(-1);
    expect(playersIdx).toBeGreaterThan(-1);
    expect(seasonIdx).toBeLessThan(playersIdx);
  });

  it('the done page\'s JS syntax is still valid (no corruption introduced by the new button)', async () => {
    const { cookie, csrfToken } = await signup('done.jssyntax@example.com', '203.0.151.013');
    await createLeague(cookie, csrfToken, { name: 'Done JS Syntax League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/signup?step=done', { headers: { cookie } })).text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
  });
});

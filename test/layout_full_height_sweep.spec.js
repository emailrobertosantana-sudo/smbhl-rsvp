// A1 (layout/spacing polish task): .su-body used to be a flex:1 child
// stretching to fill .nl's min-height (100vh -- on mobile, the LARGEST
// possible viewport, taller than what's actually visible once browser
// chrome is accounted for), pushing .su-bottom's own primary action
// (Log in, Create my season, etc.) below the fold on mobile and
// leaving a pointless empty gap above a bottom-pinned button on a
// short-content desktop page. Fixed in signupStyles() (src/index.js):
// content now defines the height (no flex-grow on .su-body) and .nl's
// own min-height uses 100dvh, not 100vh.
//
// Every one of the 8 screens sharing signupStyles() is swept here --
// not just the two the task named (mobile login, the league-created
// completion screen) -- since a shared-CSS fix covers all of them at
// once, and the point of a sweep is proving that, not assuming it.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-a1-layout-sweep-secret';

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
async function signupAndCreateLeague(email, ip, name) {
  const signupRes = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookie = extractCookie(signupRes);
  const csrfToken = extractCsrfToken(signupRes);
  const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, teamNames: ['A', 'B'], tracksStats: true })
  });
  return { cookie, csrfToken, league: (await leagueRes.json()).league };
}

// The exact rendered CSS text the fix produces/removes -- checked
// literally, not just "contains dvh somewhere", so a regression that
// re-adds flex:1 elsewhere on the page can't slip past a looser check.
const FIXED_NL_RULE = '.nl { display: flex; flex-direction: column; min-height: 100dvh; }';
const FIXED_SU_BODY_START = '.su-body { max-width: var(--content-narrow)';
const OLD_SU_BODY_FLEX = '.su-body { flex: 1;';

function assertLayoutFixed(html, label) {
  expect(html, `${label}: .nl should use min-height: 100dvh`).toContain(FIXED_NL_RULE);
  expect(html, `${label}: .su-body should no longer stretch (flex: 1)`).not.toContain(OLD_SU_BODY_FLEX);
  expect(html, `${label}: .su-body should still be present, just without the flex-grow`).toContain(FIXED_SU_BODY_START);
  expect(html, `${label}: no page using this layout should still reference 100vh`).not.toContain('100vh');
}

describe('A1: full-height layout sweep -- content defines height, no bottom-pinned-below-the-fold', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the mobile login page: the Log in button is no longer pushed below the fold by a stretched .su-body', async () => {
    const html = await (await SELF.fetch('http://example.com/login')).text();
    expect(html).toContain('id="li_submit"');
    assertLayoutFixed(html, 'login');
  });

  it('signup step 1 (account creation)', async () => {
    const html = await (await SELF.fetch('http://example.com/signup?step=1')).text();
    assertLayoutFixed(html, 'signup step 1');
  });

  it('signup step 2 (league details)', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.201.001' },
      body: JSON.stringify({ email: 'a1.step2@example.com', password: 'a-strong-password-1' })
    });
    const cookie = extractCookie(signupRes);
    const html = await (await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie } })).text();
    assertLayoutFixed(html, 'signup step 2');
  });

  it('signup step 3 (team names)', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.201.002' },
      body: JSON.stringify({ email: 'a1.step3@example.com', password: 'a-strong-password-1' })
    });
    const cookie = extractCookie(signupRes);
    const html = await (await SELF.fetch('http://example.com/signup?step=3', { headers: { cookie } })).text();
    assertLayoutFixed(html, 'signup step 3');
  });

  it('the league-created completion screen ("done") -- the desktop empty-gap case the task names explicitly', async () => {
    const { cookie } = await signupAndCreateLeague('a1.done@example.com', '203.0.201.003', 'A1 Done League');
    const html = await (await SELF.fetch('http://example.com/signup?step=done', { headers: { cookie } })).text();
    expect(html).toContain('id="su_public_url"');
    assertLayoutFixed(html, 'signup done');
  });

  it('forgot-password', async () => {
    const html = await (await SELF.fetch('http://example.com/forgot-password')).text();
    assertLayoutFixed(html, 'forgot-password');
  });

  it('reset-password', async () => {
    const html = await (await SELF.fetch('http://example.com/reset-password?token=whatever')).text();
    assertLayoutFixed(html, 'reset-password');
  });

  it('onboarding season step (reached from the dashboard\'s own "next steps" once a season exists)', async () => {
    const { cookie, csrfToken } = await signupAndCreateLeague('a1.onboarding@example.com', '203.0.201.004', 'A1 Onboarding League');
    // handleOnboardingSeasonPage redirects to /dashboard when no season
    // has been published yet -- this page is reached AFTER that, not
    // as part of the pre-season signup flow.
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'A1 Onboarding Season' })
    });
    const html = await (await SELF.fetch('http://example.com/onboarding/season', { headers: { cookie } })).text();
    assertLayoutFixed(html, 'onboarding season');
  });
});

// A2/A3 (layout/spacing polish task): .nl-card has no gap of its own
// between children -- both pages scope a flex+gap rule to their own
// cards instead of changing the shared .nl-card (which SMBHL's own
// pages also use).
describe('A2/A3: consistent field spacing on the event edit panel and the settings page', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('A2: the event detail page\'s edit panel spaces its fields (the date help text is no longer flush against the next field)', async () => {
    const { cookie, csrfToken } = await signupAndCreateLeague('a2.eventedit@example.com', '203.0.201.010', 'A2 Event Edit League');
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'A2 Season' })
    });
    const evRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2099-10-10' })
    });
    const eventId = (await evRes.json()).event.id;
    const html = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } })).text();
    expect(html).toContain('#ev_edit_panel { display: flex; flex-direction: column; gap: var(--space-3); }');
    expect(html).toContain('data-i18n="editDateNote"');
  });

  it('A3: the settings page spaces every card\'s own fields consistently', async () => {
    const { cookie } = await signupAndCreateLeague('a3.settings@example.com', '203.0.201.011', 'A3 Settings League');
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toContain('.se-main .nl-card { display: flex; flex-direction: column; gap: var(--space-3); }');
  });
});

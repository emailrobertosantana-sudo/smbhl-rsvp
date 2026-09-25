// Design system Part 2: signup rebuilt as a real 3-step wizard
// (notre-ligue-design-system/components/ScreenSignup/preview.html) --
// account, then league, then teams, then a done/confirmation screen.
// This is a genuine end-to-end walk through all three steps and the
// server-side session gating between them (the actual behavior the
// wizard depends on, not just markup snapshots -- those are covered
// separately in part0/part1/part2 language-toggle specs).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part2-signup-wizard-secret';

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}
function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(', ');
  const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
  return csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
}

describe('Part 2: signup wizard, step-by-step', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('step 1 (account) creates a real session; step 2 (league) and step 3 (teams) are reachable only after it', async () => {
    const step1Res = await SELF.fetch('http://example.com/signup?step=1');
    expect(step1Res.status).toBe(200);
    const step1Html = await step1Res.text();
    expect(step1Html).toContain('id="su_email"');
    expect(step1Html).toContain('id="su_password"');
    expect(step1Html).toContain('nl-steps');
    expect(step1Html).toContain('aria-valuenow="1"');

    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.701' },
      body: JSON.stringify({ email: 'wizard.e2e@example.com', password: 'a-strong-password-1' })
    });
    expect(signupRes.status).toBe(200);
    const cookie = extractCookie(signupRes);
    const csrfToken = extractCsrfToken(signupRes);

    const step2Res = await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie } });
    expect(step2Res.status).toBe(200);
    const step2Html = await step2Res.text();
    expect(step2Html).toContain('id="su_league_name"');
    expect(step2Html).toContain('id="su_slug"');
    expect(step2Html).toContain('notreligue.ca/');
    expect(step2Html).toContain('aria-valuenow="2"');

    const step3Res = await SELF.fetch('http://example.com/signup?step=3', { headers: { cookie } });
    expect(step3Res.status).toBe(200);
    const step3Html = await step3Res.text();
    expect(step3Html).toContain('id="su_team_count_out"');
    expect(step3Html).toContain('aria-valuenow="3"');

    // Step 3's own client JS is what actually calls /leagues/create
    // (with the step-2 fields carried forward via sessionStorage) --
    // exercised directly here since this test environment doesn't run
    // client JS. Confirms the real backend league-creation endpoint
    // step 3 depends on still behaves exactly as before.
    const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Wizard E2E League', teamNames: ['Les Castors', 'Les Aurores'], tracksStats: true, slug: 'wizard-e2e-league' })
    });
    expect(leagueRes.status).toBe(200);
    const leagueJson = await leagueRes.json();
    expect(leagueJson.ok).toBe(true);
    expect(leagueJson.league.slug).toBe('wizard-e2e-league');

    const doneRes = await SELF.fetch('http://example.com/signup?step=done', { headers: { cookie } });
    expect(doneRes.status).toBe(200);
    const doneHtml = await doneRes.text();
    expect(doneHtml).toContain('Wizard E2E League'); // league's own name in the header, not "Notre Ligue"
    expect(doneHtml).toContain('wizard-e2e-league'); // the real public URL, not a placeholder
    expect(doneHtml).toContain('Ta ligue est prête');
  });

  it('step 2 without a session redirects to step 1 instead of rendering a broken form', async () => {
    const res = await SELF.fetch('http://example.com/signup?step=2', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location') || '').toContain('/signup?step=1');
  });

  it('step 3 without a session redirects to step 1', async () => {
    const res = await SELF.fetch('http://example.com/signup?step=3', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location') || '').toContain('/signup?step=1');
  });

  it('the done screen without a session, or with a session but no league yet, redirects rather than crashing', async () => {
    const noSessionRes = await SELF.fetch('http://example.com/signup?step=done', { redirect: 'manual' });
    expect(noSessionRes.status).toBe(302);
    expect(noSessionRes.headers.get('location') || '').toContain('/signup?step=1');

    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.702' },
      body: JSON.stringify({ email: 'wizard.nodone@example.com', password: 'a-strong-password-1' })
    });
    const cookie = extractCookie(signupRes);
    const doneNoLeagueRes = await SELF.fetch('http://example.com/signup?step=done', { headers: { cookie }, redirect: 'manual' });
    expect(doneNoLeagueRes.status).toBe(302);
    expect(doneNoLeagueRes.headers.get('location') || '').toContain('/signup?step=2');
  });

  // A2 bug fix (onboarding polish task): the slug becomes the league's
  // permanent public address the moment it's created -- nothing warned
  // the admin at step 2, the one point it's still editable. The live
  // preview (su_slug auto-filling from su_league_name as you type) was
  // already there; this locks the new warning text, in both languages,
  // and confirms the live-preview wiring is still present.
  it('A2: step 2 warns the slug becomes permanent, in both languages, and the live-preview wiring is still there', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.703' },
      body: JSON.stringify({ email: 'wizard.a2.slugwarn@example.com', password: 'a-strong-password-1' })
    });
    const cookie = extractCookie(signupRes);

    const htmlFr = await (await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie } })).text();
    expect(htmlFr).toContain("Devient permanente à la création de ta ligue -- ça garantit que les liens que tu partages continuent toujours de fonctionner.");
    expect(htmlFr).not.toContain('Tu peux la changer');

    const htmlEn = await (await SELF.fetch('http://example.com/signup?step=2&lang=en', { headers: { cookie } })).text();
    expect(htmlEn).toContain("Becomes permanent once your league is created -- that guarantees the links you share always keep working.");
    expect(htmlEn).not.toContain('You can change it');

    // Live preview: su_league_name's own input listener still writes
    // into su_slug via slugify() as the admin types.
    expect(htmlFr).toContain("document.getElementById('su_slug').value = window.NotreLigue.slugify(this.value)");
  });
});

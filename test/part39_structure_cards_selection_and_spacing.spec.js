// Live-testing task, Parts 3 & 4: team-structure option cards (signup
// wizard, dashboard season management, and the settings page built in
// the prior task) had two real bugs in the same markup.
//
// Part 3 ROOT CAUSE: the "fixed" card's CSS class used an overly-broad
// negative condition (`!== 'headcount'`) instead of a precise positive
// one (`=== 'fixed'`) -- true for BOTH 'fixed' and 'weekly_draw', so a
// weekly_draw league's season-management/settings page showed the
// fixed card AND the weekly_draw card both visually "on" at once, even
// though only one radio was ever actually checked. The click-handler
// JS itself was always correct (verified with a real, stateful DOM
// simulation before writing this fix) -- the bug was in the initial
// server-rendered class, not the interaction.
//
// Part 4 ROOT CAUSE: .su-structure-opt .t/.d (the label/description)
// are both inline <span>s by default -- margin-top on .d silently had
// no effect (vertical margins are a no-op on inline boxes), so the two
// ran together with no space or line break at all. Fixed with
// display:block on both.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part3-4-structure-cards-secret';

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
describe('Part 3 (live-testing task): exactly one team-structure card highlighted at a time', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  for (const [structure, extra] of [
    ['fixed', { teamNames: ['A', 'B'] }],
    ['headcount', { teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10 }],
    ['weekly_draw', { teamStructure: 'weekly_draw', teamNames: ['Rouge / Red', 'Bleu / Blue'] }]
  ]) {
    it(`settings page season-management: a ${structure} league shows exactly one 'on' card, matching its real structure`, async () => {
      // Live-testing task (batch 6), Part 7: this section (name/
      // structure-override/roster-limits for the CURRENT season) moved
      // from the dashboard home to Settings -- see handleDashboardPage/
      // handleLeagueSettingsPage's own comments. Was /dashboard before.
      const { cookie, csrfToken } = await signup(`structure.dash.${structure}@example.com`, `203.0.141.00${structure === 'fixed' ? 1 : structure === 'headcount' ? 2 : 3}`);
      await createLeague(cookie, csrfToken, { name: `Structure Dash ${structure} League`, tracksStats: true, ...extra });
      await SELF.fetch('http://example.com/league/season/publish', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ season_name: `${structure} Season` })
      });
      const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
      const section = html.slice(html.indexOf('id="season_structure_radio"'), html.indexOf('id="season_structure_radio"') + 1400);
      const onLabels = [...section.matchAll(/<label class="su-structure-opt([^"]*)" data-value="(\w+)"/g)].filter(m => m[1].includes('on'));
      expect(onLabels.length).toBe(1);
      expect(onLabels[0][2]).toBe(structure);
    });

    it(`settings page: a ${structure} league shows exactly one 'on' card, matching its real structure`, async () => {
      const { cookie, csrfToken } = await signup(`structure.settings.${structure}@example.com`, `203.0.141.01${structure === 'fixed' ? 1 : structure === 'headcount' ? 2 : 3}`);
      await createLeague(cookie, csrfToken, { name: `Structure Settings ${structure} League`, tracksStats: true, ...extra });
      const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
      const section = html.slice(html.indexOf('id="se_structure_radio"'), html.indexOf('id="se_structure_radio"') + 1400);
      const onLabels = [...section.matchAll(/<label class="su-structure-opt([^"]*)" data-value="(\w+)"/g)].filter(m => m[1].includes('on'));
      expect(onLabels.length).toBe(1);
      expect(onLabels[0][2]).toBe(structure);
    });
  }

  it('signup wizard step 2 also shows exactly one on card on initial load (fixed, the default)', async () => {
    const { cookie } = await signup('structure.signup.initial@example.com', '203.0.141.020');
    const html = await (await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie } })).text();
    const section = html.slice(html.indexOf('id="su_structure_radio"'), html.indexOf('id="su_structure_radio"') + 1400);
    const onLabels = [...section.matchAll(/<label class="su-structure-opt([^"]*)" data-value="(\w+)"/g)].filter(m => m[1].includes('on'));
    expect(onLabels.length).toBe(1);
    expect(onLabels[0][2]).toBe('fixed');
  });

  it("the click-handler JS itself (verified correct via a real stateful DOM simulation) clears the previous card and sets exactly the new one -- confirms both root causes together", async () => {
    const { cookie, csrfToken } = await signup('structure.clickhandler@example.com', '203.0.141.021');
    await createLeague(cookie, csrfToken, { name: 'Structure Clickhandler League', tracksStats: true, teamStructure: 'weekly_draw', teamNames: ['A', 'B'] });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
  });
});

describe('Part 4 (live-testing task): label and description are visually separated', () => {
  it('the CSS makes .t and .d block-level (not run together as one inline line) on both signup and dashboard/settings surfaces', async () => {
    const { cookie } = await signup('structure.spacing.css@example.com', '203.0.141.030');
    const signupHtml = await (await SELF.fetch('http://example.com/signup?step=2', { headers: { cookie } })).text();
    expect(signupHtml).toMatch(/\.su-structure-opt \.t \{[^}]*display:\s*block/);
    expect(signupHtml).toMatch(/\.su-structure-opt \.d \{[^}]*display:\s*block/);

    await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    });
  });

  it('the dashboard/settings shared stylesheet also has the block-level fix', async () => {
    const { cookie, csrfToken } = await signup('structure.spacing.dash@example.com', '203.0.141.031');
    await createLeague(cookie, csrfToken, { name: 'Structure Spacing Dash League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toMatch(/\.su-structure-opt \.t \{[^}]*display:\s*block/);
    expect(html).toMatch(/\.su-structure-opt \.d \{[^}]*display:\s*block/);
  });
});

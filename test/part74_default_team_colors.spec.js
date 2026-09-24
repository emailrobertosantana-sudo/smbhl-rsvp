// Live-testing task (batch 6), Part 3: a new league's teams were all
// assigned the SAME colour -- confirmed in Settings, both teams shown
// in the same red -- so the public page rendered them identically and
// neither matched its own name.
//
// ROOT CAUSE: the post-season onboarding page's own "teams" step
// (batch 5, Part 6 -- this session's own earlier work) sent
// teamColors: teamNames.map(() => '#b3122e') to /league/settings/teams
// -- literally the SAME hardcoded red for every team, no matter how
// many. Once that gets WRITTEN to leagues.team_colors, it permanently
// overrides resolveTeamColor()'s own read-time positional fallback
// (which already gives each team a distinct colour from the curated
// ROSTER_TEAM_DOTS palette when team_colors is null) -- so a league
// that completes onboarding (now the standard flow after creating a
// season) ends every team on the exact same red, for good, until an
// admin manually recolours them one at a time.
//
// Settings' own addTeamRow() (the "+" button that adds one more team
// row) had the identical bug: every newly added row's colour input
// also defaulted to the same hardcoded '#b3122e'.
//
// FIX: both now draw from the SAME curated palette
// resolveTeamColor()'s own fallback already uses everywhere a team
// gets a colour (roster page, public page, settings preview) -- one
// source of truth, positional (index i -> palette[i % length]), so a
// league that never touches either of these two paths at all already
// looked exactly like this via the existing read-time fallback.
// Existing leagues/teams that already have a stored team_colors value
// are completely untouched -- this only changes what gets WRITTEN by
// these two specific client-side actions going forward.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { extractInlineScripts, runScript } from './support/inline_scripts.js';

const AUTH_SECRET = 'test-part74-default-team-colors-secret';

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
async function publishSeason(cookie, csrfToken, body) {
  return SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
}

describe('Part 3 (live-testing task, batch 6): new leagues no longer get identical default team colours', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the onboarding teams step: the real embedded OB_TEAM_COLORS constant gives N teams N distinct colours (was: all "#b3122e")', async () => {
    const { cookie, csrfToken } = await signup('teamcolors.onboarding@example.com', '203.0.188.001');
    await createLeague(cookie, csrfToken, { name: 'Team Colors Onboarding League', teamNames: ['Nord', 'Sud', 'Est', 'Ouest'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const html = await (await SELF.fetch('http://example.com/onboarding/season?step=2', { headers: { cookie } })).text();
    const combined = extractInlineScripts(html).join('\n;\n');

    expect(html).not.toContain("return '#b3122e';");

    // Run the REAL computation exactly as obSubmit() does it, against
    // the REAL embedded OB_TEAM_COLORS constant.
    const colors4 = runScript(combined,
      "return ['Nord','Sud','Est','Ouest'].map(function(_, idx) { return OB_TEAM_COLORS[idx % OB_TEAM_COLORS.length]; });");
    expect(new Set(colors4).size).toBe(4);

    const colors2 = runScript(combined,
      "return ['A','B'].map(function(_, idx) { return OB_TEAM_COLORS[idx % OB_TEAM_COLORS.length]; });");
    expect(new Set(colors2).size).toBe(2);
    expect(colors2.every(c => /^#[0-9a-fA-F]{6}$/.test(c))).toBe(true);
  });

  it('Settings\' addTeamRow(), fired for real against a capturing DOM stub, gives each newly-added row a distinct colour (was: every row "#b3122e")', async () => {
    const { cookie, csrfToken } = await signup('teamcolors.settings@example.com', '203.0.188.002');
    await createLeague(cookie, csrfToken, { name: 'Team Colors Settings League', teamNames: ['Nord', 'Sud'] });

    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    const combined = extractInlineScripts(html).join('\n;\n');
    expect(html).not.toContain("colorInput.value = '#b3122e'");

    // A small capturing stub: every created element tracks its own
    // appended children AND its type/class, so after addTeamRow()
    // appends nameInput/colorInput/removeBtn to a row, and the row to
    // se_teams_list, we can walk the real tree it built and read the
    // REAL color input's REAL .value -- not a reimplementation.
    function makeElement() {
      // `children` is the real DOM property name addTeamRow() itself
      // reads (list.children.length, to pick the next palette index) --
      // must be named exactly that, not an internal alias, or the real
      // code under test silently reads undefined.
      const el = {
        children: [], value: '', className: '', type: '', textContent: '',
        setAttribute(k, v) { if (k === 'type') this.type = v; },
        getAttribute() { return null; },
        classList: { add() {}, remove() {} },
        appendChild(child) { this.children.push(child); },
      };
      return el;
    }
    const list = makeElement();
    const doc = {
      getElementById: (id) => (id === 'se_teams_list' ? list : makeElement()),
      createElement: () => makeElement(),
      querySelectorAll: () => [], querySelector: () => null,
      addEventListener: () => {}, documentElement: { lang: '' }, cookie: '',
    };
    const win = { location: { search: '' }, addEventListener: () => {}, dispatchEvent: () => {} };

    const fn = new Function('window', 'document', 'localStorage', 'navigator', 'location',
      combined + '\n;\nwindow.__pageDict = function() { return { removeTeam: "Remove" }; };\naddTeamRow(); addTeamRow(); addTeamRow();');
    fn(win, doc, { getItem: () => null, setItem: () => {} }, { language: 'en-US' }, { search: '' });

    expect(list.children.length).toBe(3);
    const colorValues = list.children.map(row => {
      const colorInput = row.children.find(c => c.className === 'se-color');
      return colorInput && colorInput.value;
    });
    expect(colorValues.every(Boolean)).toBe(true);
    expect(new Set(colorValues).size).toBe(3);
  });
});

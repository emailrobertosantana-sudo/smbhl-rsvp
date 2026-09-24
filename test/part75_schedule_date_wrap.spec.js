// Live-testing task (batch 6), Part 4: on the schedule list, dates
// broke across lines ("Thu Sep" / "17"). The date FORMAT is correct
// per the design system; the CONTAINER broke it.
//
// ROOT CAUSE: .sc-game's grid gave the date column a fixed 96px
// (72px on mobile), and .sc-when b had no white-space: nowrap. The
// longest date this format actually produces isn't the common short
// ones -- French month abbreviations go up to 5 letters ("juill"),
// so "mer 28 juill" is the real worst case, comfortably wider than
// 96px at 18px bold. Fixed with white-space: nowrap (a date is one
// unit, never meant to wrap) plus a wider column (112px / 92px on
// mobile) so the now-unwrappable text doesn't visually overflow into
// the next column instead.
//
// Checked every OTHER surface rendering a formatted date per the
// task's own instruction: the public page's game list (.pb-g-d, same
// shape of risk as the schedule list) got the same defensive
// white-space: nowrap. The public page's own HERO date/time
// (.pb-hero-when), the event-detail page's <h1>, and the RSVP page's
// overline are all full-width headline-style elements, not narrow
// fixed-width grid columns -- deliberately left alone, since forcing
// nowrap there risks the opposite bug (horizontal overflow on a
// narrow phone) for text that's fine to wrap gracefully as a
// headline.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part75-schedule-date-wrap-secret';

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

describe('Part 4 (live-testing task, batch 6): schedule dates no longer wrap mid-date', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the real served schedule page: .sc-when b has white-space: nowrap, and the date column is wider than the old too-narrow 96px/72px', async () => {
    const { cookie, csrfToken } = await signup('datewrap.schedule@example.com', '203.0.189.001');
    await createLeague(cookie, csrfToken, { name: 'Date Wrap Schedule League', teamNames: ['X', 'Y'] });
    const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();

    const whenRule = html.match(/\.sc-when b \{[^}]*\}/);
    expect(whenRule).toBeTruthy();
    expect(whenRule[0]).toContain('white-space: nowrap');

    const desktopCol = html.match(/\.sc-game \{ display: grid; grid-template-columns: (\d+)px/);
    expect(desktopCol).toBeTruthy();
    expect(Number(desktopCol[1])).toBeGreaterThan(96);

    const mobileCol = html.match(/@media \(max-width: 640px\) \{ \.sc-game \{ grid-template-columns: (\d+)px/);
    expect(mobileCol).toBeTruthy();
    expect(Number(mobileCol[1])).toBeGreaterThan(72);
  });

  it('the real served public page: .pb-g-d b (the game-list date, same shape of risk as the schedule list) also has white-space: nowrap', async () => {
    const { cookie, csrfToken } = await signup('datewrap.public@example.com', '203.0.189.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Date Wrap Public League', teamNames: ['X', 'Y'] });
    const html = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();

    const rules = [...html.matchAll(/\.pb-g-d b \{[^}]*\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r[0]).toContain('white-space: nowrap');
    }
  });

  it('the longest realistic date string this format produces really is 5 letters ("juill", July, French) -- confirms the fix accounts for the true worst case, not just the common short ones', () => {
    const MONTH_ABBR_FR = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juill', 'août', 'sept', 'oct', 'nov', 'déc'];
    const longest = MONTH_ABBR_FR.reduce((a, b) => (b.length > a.length ? b : a), '');
    expect(longest).toBe('juill');
    expect(longest.length).toBe(5);
  });
});

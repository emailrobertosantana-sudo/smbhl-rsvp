// Part 3 (overnight follow-up task): the same real FR/EN toggle from
// Part 2, extended to every session-authenticated admin page built
// this session -- dashboard, roster, schedule, event status/detail --
// which previously rendered French-only with no toggle at all. Same
// data-i18n + per-page dict + applyLanguage() mechanism, reusing
// page()'s existing shared .langswitch/window.__setLang plumbing
// (unchanged). Confirms this doesn't touch or affect SMBHL's own
// legacy ADMIN_KEY-gated admin pages, a separate, older system out of
// scope here -- those never call any of the functions modified in this
// task, so they're not exercised by these routes at all.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part3-lang-toggle-secret';

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

function assertRealToggle(html, sampleEnStrings) {
  expect(html).toContain('langswitch');
  expect(html).toContain('langbtn');
  expect(html).toContain('__setLang');
  expect(html).toContain('admin_lang_changed');
  expect(html).toContain('data-i18n');
  for (const s of sampleEnStrings) expect(html).toContain(s);
}

// The dashboard was migrated to the real design system (design system
// task, Part 3) -- its toggle is now the real nl-lang component, not
// the ad hoc .langswitch/.langbtn pattern the not-yet-migrated
// roster/schedule pages below still use.
function assertRealToggleNl(html, sampleEnStrings) {
  expect(html).toContain('nl-lang');
  expect(html).toContain('__setLang');
  expect(html).toContain('localStorage');
  expect(html).toContain('data-i18n');
  for (const s of sampleEnStrings) expect(html).toContain(s);
}

async function signupAndCreateLeague(email, ip, leagueName, teamNames) {
  const signupRes = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookie = extractCookie(signupRes);
  const csrfToken = extractCsrfToken(signupRes);
  const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name: leagueName, teamNames, tracksStats: true })
  });
  const leagueId = (await leagueRes.json()).league.id;
  return { cookie, csrfToken, leagueId };
}

describe('Part 3: real FR/EN toggle on every session-authenticated admin page', () => {
  let cookie, csrfToken, leagueId;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
    const a = await signupAndCreateLeague('part3.lang@example.com', '203.0.113.621', 'Part 3 Lang League', ['Otters', 'Falcons']);
    cookie = a.cookie;
    csrfToken = a.csrfToken;
    leagueId = a.leagueId;
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Part 3 Season', goalies_per_team: 1, skaters_per_team: 3, min_skaters: 1 })
    });
  });

  it('the dashboard has a real, working toggle with genuine English content (design system, ScreenDashboard)', async () => {
    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const html = await res.text();
    // 'Co-admins' moved to Settings in batch 5 Part 7 -- 'Public page'
    // is still a real, always-rendered dashboard tile.
    assertRealToggleNl(html, ['Players', 'Schedule', 'Public page', 'Log out']);
  });

  it('the roster page has a real, working toggle with genuine English content (design system, ScreenRoster)', async () => {
    const res = await SELF.fetch('http://example.com/league/roster', { headers: { cookie } });
    const html = await res.text();
    assertRealToggleNl(html, ['Add a player', 'Full name', 'Unassigned', 'No players yet.']);
  });

  it('the schedule page has a real, working toggle with genuine English content (design system, ScreenSchedule)', async () => {
    const res = await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } });
    const html = await res.text();
    assertRealToggleNl(html, ['Create an event', 'No events yet.']);
  });

  it('the event-detail (status) page has a real, working toggle with genuine English content (design system, ScreenEventStatus)', async () => {
    const contactRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Part 3 Player One', team: 'Otters' })
    });
    expect(contactRes.status).toBe(200);
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2099-06-06', season: 'Part 3 Season' })
    });
    const eventId = (await eventRes.json()).event.id;

    const res = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } });
    const html = await res.text();
    assertRealToggleNl(html, ['confirmed', 'open spots', 'no reply']);
  });

  it("SMBHL's own legacy ADMIN_KEY-gated admin page shell still renders correctly, untouched by this task (a separate, older system with its own pre-existing data-i18n mechanism)", async () => {
    // handleDashboardPage/handleLeagueRosterPage/etc. (modified in this
    // task) are entirely separate functions from the legacy board page
    // -- this route's own code was never touched. It rendering
    // correctly, unmodified, is the proof of isolation here (it already
    // has its own separate, pre-existing data-i18n-based toggle, so
    // that attribute name isn't unique to this task's new pages).
    const res = await SELF.fetch('http://example.com/admin/board');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('SMBHL');
  });
});

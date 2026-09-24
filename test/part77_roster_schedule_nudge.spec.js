// Live-testing task (batch 6), Part 6: the post-season onboarding
// flow improved (batch 5, Part 6), but after adding a player the user
// was left on the roster page with no direction -- submitContact()
// just reloaded the same page. It should prompt the next step
// (creating the schedule), consistent with how the rest of the
// guided flow works.
//
// Fix: the roster page now shows a "next step" nudge card, computed
// from real state (real players exist, no event created yet) rather
// than a one-time flag -- the same approach the dashboard's own
// next-steps card (batch 5, Part 6) already established. It naturally
// disappears once a real schedule exists, and never appears for an
// empty roster (nothing to nudge toward yet).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part77-roster-schedule-nudge-secret';

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
async function addContact(cookie, csrfToken, name) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name })
  });
  return (await res.json()).contact;
}
async function publishSeason(cookie, csrfToken, seasonName) {
  return SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ season_name: seasonName })
  });
}
async function createEvent(cookie, csrfToken, date) {
  return SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ date })
  });
}
async function fetchRoster(cookie) {
  return (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
}

describe('Part 6 (live-testing task, batch 6): the roster page now nudges toward the schedule after adding players', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('an empty roster (no players yet) shows no nudge -- nothing to point toward yet', async () => {
    const { cookie, csrfToken } = await signup('nudge.empty@example.com', '203.0.191.001');
    await createLeague(cookie, csrfToken, { name: 'Nudge Empty League', teamNames: ['X', 'Y'] });
    const html = await fetchRoster(cookie);
    expect(html).not.toContain('data-i18n="rosterNudgeTitle"');
  });

  it('after adding the first player, the roster page shows the schedule nudge -- the exact reported gap', async () => {
    const { cookie, csrfToken } = await signup('nudge.afterplayer@example.com', '203.0.191.002');
    await createLeague(cookie, csrfToken, { name: 'Nudge After Player League', teamNames: ['X', 'Y'] });
    await addContact(cookie, csrfToken, 'First Player');

    const html = await fetchRoster(cookie);
    expect(html).toContain('data-i18n="rosterNudgeTitle"');
    expect(html).toContain('href="/league/schedule"');
    expect(html).toContain('data-i18n="rosterNudgeBtn"');
  });

  it('full flow: create league -> add player -> nudge appears -> create an event -> nudge disappears (the guided flow genuinely continues through to schedule creation)', async () => {
    const { cookie, csrfToken } = await signup('nudge.fullflow@example.com', '203.0.191.003');
    await createLeague(cookie, csrfToken, { name: 'Nudge Full Flow League', teamNames: ['X', 'Y'] });
    await addContact(cookie, csrfToken, 'Flow Player One');

    const beforeEvent = await fetchRoster(cookie);
    expect(beforeEvent).toContain('data-i18n="rosterNudgeTitle"');

    await publishSeason(cookie, csrfToken, 'S1');
    const eventRes = await createEvent(cookie, csrfToken, '2099-06-15');
    expect(eventRes.status).toBe(200);

    const afterEvent = await fetchRoster(cookie);
    expect(afterEvent).not.toContain('data-i18n="rosterNudgeTitle"');
  });

  it('a league with players AND an event never shows the nudge again, even after adding more players', async () => {
    const { cookie, csrfToken } = await signup('nudge.established@example.com', '203.0.191.004');
    await createLeague(cookie, csrfToken, { name: 'Nudge Established League', teamNames: ['X', 'Y'] });
    await addContact(cookie, csrfToken, 'Established Player One');
    await publishSeason(cookie, csrfToken, 'S1');
    await createEvent(cookie, csrfToken, '2099-07-01');
    await addContact(cookie, csrfToken, 'Established Player Two');

    const html = await fetchRoster(cookie);
    expect(html).not.toContain('data-i18n="rosterNudgeTitle"');
  });
});

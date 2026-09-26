// Public-page themes batch: organizer's note (Part 1), the Classique
// and Quartier public themes (Part 2), best-of-N series tracking
// (Part 3), and three small outstanding items (Part 4). League
// product (demo/notreligue) only -- SMBHL is untouched throughout.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part95-public-themes-secret';

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
  const res = await SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return res.json();
}
async function updateIdentity(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/settings/identity', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}
async function publicPageHtml(leagueId) {
  return (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(leagueId)}`)).text();
}
async function settingsHtml(cookie) {
  return (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
}

describe('Public-page themes, Part 1: organizer\'s note', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('absent from the public page when never set -- no empty placeholder box', async () => {
    const { cookie, csrfToken } = await signup('p1.absent@example.com', '203.0.210.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Note Absent League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const html = await publicPageHtml(league.id);
    expect(html).not.toContain('class="pb-note"');
  });

  it('shown on the public page once set in Settings, in both languages\' copy', async () => {
    const { cookie, csrfToken } = await signup('p1.shown@example.com', '203.0.210.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Note Shown League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const note = 'Sunday mornings at Letendre since 2005, new players welcome.';
    const upd = await updateIdentity(cookie, csrfToken, { organizerNote: note });
    expect(upd.status).toBe(200);
    expect(upd.json.settings.organizerNote).toBe(note);

    const html = await publicPageHtml(league.id);
    expect(html).toContain('class="pb-note"');
    expect(html).toContain(note);
    expect(html).toContain("Le mot de l'organisateur");
    expect(html).toContain("Organizer's note");
  });

  it('clearing the note (empty string) removes it from the public page again', async () => {
    const { cookie, csrfToken } = await signup('p1.clear@example.com', '203.0.210.003');
    const league = await createLeague(cookie, csrfToken, { name: 'Note Clear League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await updateIdentity(cookie, csrfToken, { organizerNote: 'Temporary note.' });
    expect(await publicPageHtml(league.id)).toContain('class="pb-note"');
    const cleared = await updateIdentity(cookie, csrfToken, { organizerNote: '' });
    expect(cleared.json.settings.organizerNote).toBeNull();
    expect(await publicPageHtml(league.id)).not.toContain('class="pb-note"');
  });

  it('rejected when over 500 characters', async () => {
    const { cookie, csrfToken } = await signup('p1.toolong@example.com', '203.0.210.004');
    await createLeague(cookie, csrfToken, { name: 'Note Too Long League', teamNames: ['A', 'B'] });
    const res = await updateIdentity(cookie, csrfToken, { organizerNote: 'x'.repeat(501) });
    expect(res.status).toBe(400);
    expect(res.json.errorKey).toBe('ORGANIZER_NOTE_TOO_LONG');
  });

  it('the Settings form field is pre-filled with the saved note and both languages\' labels are present', async () => {
    const { cookie, csrfToken } = await signup('p1.settingsui@example.com', '203.0.210.005');
    await createLeague(cookie, csrfToken, { name: 'Note Settings UI League', teamNames: ['A', 'B'] });
    await updateIdentity(cookie, csrfToken, { organizerNote: 'Prefilled note text.' });
    const html = await settingsHtml(cookie);
    expect(html).toContain('id="se_organizer_note"');
    expect(html).toContain('Prefilled note text.');
    expect(html).toContain("Mot de l'organisateur");
    expect(html).toContain("Organizer's note");
  });
});

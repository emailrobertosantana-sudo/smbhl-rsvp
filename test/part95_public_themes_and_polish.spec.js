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

// Part 2: Classique and Quartier. Both reuse the exact same HTML/data
// logic every other theme does (heroHtml/standingsHtml/topScorersHtml/
// etc, built once) -- only the <style> block differs, so what needs
// testing is theme SELECTION (the right stylesheet renders) and that
// every section still renders correctly with standings/player-stats
// on or off, exactly like the two existing themes already are.
describe('Public-page themes, Part 2: Classique and Quartier', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  async function createEvent(cookie, csrfToken, body) {
    const res = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify(body)
    });
    return (await res.json()).event;
  }
  async function submitScore(cookie, csrfToken, body) {
    const res = await SELF.fetch('http://example.com/league/events/score', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify(body)
    });
    return res.json();
  }
  async function addContact(cookie, csrfToken, body) {
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify(body)
    });
    return (await res.json()).contact;
  }
  async function setRsvp(cookie, csrfToken, eventId, playerId, status) {
    return SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: playerId, status })
    });
  }
  async function postPlayerStats(cookie, csrfToken, body) {
    const res = await SELF.fetch('http://example.com/league/events/player-stats', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify(body)
    });
    return res.json();
  }

  // Each theme's own CSS carries at least one string unique to it,
  // used below to prove the RIGHT stylesheet actually rendered rather
  // than just checking the page returned 200.
  const THEME_FINGERPRINT = {
    classique: '.nl-header { background: var(--pb-accent',
    quartier: '.pb-hero:before { content: ""'
  };

  it.each(['classique', 'quartier'])('%s: selecting the theme in Settings renders that theme\'s own stylesheet on the public page', async (themeName) => {
    const { cookie, csrfToken } = await signup(`p2.${themeName}.select@example.com`, `203.0.211.00${themeName === 'classique' ? 1 : 2}`);
    const league = await createLeague(cookie, csrfToken, { name: `${themeName} Select League`, teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const upd = await updateIdentity(cookie, csrfToken, { publicTheme: themeName });
    expect(upd.status).toBe(200);
    expect(upd.json.settings.publicTheme).toBe(themeName);
    const html = await publicPageHtml(league.id);
    expect(html).toContain(THEME_FINGERPRINT[themeName]);
    expect(html).not.toContain(THEME_FINGERPRINT[themeName === 'classique' ? 'quartier' : 'classique']);
  });

  it('rejects an unknown theme name', async () => {
    const { cookie, csrfToken } = await signup('p2.badtheme@example.com', '203.0.211.003');
    await createLeague(cookie, csrfToken, { name: 'Bad Theme League', teamNames: ['A', 'B'] });
    const res = await updateIdentity(cookie, csrfToken, { publicTheme: 'not-a-real-theme' });
    expect(res.status).toBe(400);
    expect(res.json.errorKey).toBe('INVALID_PUBLIC_THEME');
  });

  for (const themeName of ['classique', 'quartier']) {
    describe(`${themeName} theme: every section renders correctly across the results/player-stats switch combinations`, () => {
      it('results ON, player stats ON: standings, top scorers, organizer\'s note, and teams all render', async () => {
        const { cookie, csrfToken } = await signup(`p2.${themeName}.full@example.com`, `203.0.211.01${themeName === 'classique' ? 1 : 2}`);
        const league = await createLeague(cookie, csrfToken, { name: `${themeName} Full League`, teamNames: ['Rouge', 'Bleu'], tracksStats: false });
        await updateIdentity(cookie, csrfToken, { tracksResults: true, tracksPlayerStats: true, publicTheme: themeName, organizerNote: 'A standing note.' });
        await publishSeason(cookie, csrfToken, { season_name: 'S1' });
        const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
        await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: 4, away_score: 1 });
        const player = await addContact(cookie, csrfToken, { name: 'Full League Player', role: 'roster' });
        await setRsvp(cookie, csrfToken, ev.id, player.player_id, 'in');
        await postPlayerStats(cookie, csrfToken, { event_id: ev.id, entries: [{ player_id: player.player_id, role: 'skater', goals: 2, assists: 1 }] });

        const html = await publicPageHtml(league.id);
        expect(html).toContain(THEME_FINGERPRINT[themeName]);
        expect(html).toContain('data-i18n="standings"');
        expect(html).toContain('data-i18n="topScorers"');
        expect(html).toContain('Full League Player');
        expect(html).toContain('class="pb-note"');
        expect(html).toContain('A standing note.');
        expect(html).toContain('data-i18n="teams"');
      });

      it('results OFF, player stats OFF (minimal league): no standings, no top scorers, no note -- but the page still renders cleanly with upcoming/teams', async () => {
        const { cookie, csrfToken } = await signup(`p2.${themeName}.min@example.com`, `203.0.211.02${themeName === 'classique' ? 1 : 2}`);
        const league = await createLeague(cookie, csrfToken, { name: `${themeName} Minimal League`, teamNames: ['A', 'B'], tracksStats: false });
        await updateIdentity(cookie, csrfToken, { publicTheme: themeName });
        await publishSeason(cookie, csrfToken, { season_name: 'S1' });
        await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });

        const html = await publicPageHtml(league.id);
        expect(html).toContain(THEME_FINGERPRINT[themeName]);
        expect(html).not.toContain('data-i18n="standings"');
        expect(html).not.toContain('data-i18n="topScorers"');
        expect(html).not.toContain('class="pb-note"');
        expect(html).toContain('data-i18n="upcoming"');
        expect(html).toContain('data-i18n="teams"');
      });

      it('results ON, player stats OFF: standings render, top scorers do not', async () => {
        const { cookie, csrfToken } = await signup(`p2.${themeName}.resultsonly@example.com`, `203.0.211.03${themeName === 'classique' ? 1 : 2}`);
        const league = await createLeague(cookie, csrfToken, { name: `${themeName} Results Only League`, teamNames: ['A', 'B'], tracksStats: false });
        await updateIdentity(cookie, csrfToken, { tracksResults: true, publicTheme: themeName });
        await publishSeason(cookie, csrfToken, { season_name: 'S1' });
        const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
        await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: 2, away_score: 0 });

        const html = await publicPageHtml(league.id);
        expect(html).toContain('data-i18n="standings"');
        expect(html).not.toContain('data-i18n="topScorers"');
      });

      it('results OFF, player stats ON: top scorers render, standings do not', async () => {
        const { cookie, csrfToken } = await signup(`p2.${themeName}.statsonly@example.com`, `203.0.211.04${themeName === 'classique' ? 1 : 2}`);
        const league = await createLeague(cookie, csrfToken, { name: `${themeName} Stats Only League`, teamNames: ['A', 'B'], tracksStats: false });
        await updateIdentity(cookie, csrfToken, { tracksPlayerStats: true, publicTheme: themeName });
        await publishSeason(cookie, csrfToken, { season_name: 'S1' });
        const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
        const player = await addContact(cookie, csrfToken, { name: 'Stats Only Player', role: 'roster' });
        await setRsvp(cookie, csrfToken, ev.id, player.player_id, 'in');
        await postPlayerStats(cookie, csrfToken, { event_id: ev.id, entries: [{ player_id: player.player_id, role: 'skater', goals: 1, assists: 0 }] });

        const html = await publicPageHtml(league.id);
        expect(html).not.toContain('data-i18n="standings"');
        expect(html).toContain('data-i18n="topScorers"');
      });
    });
  }

  it('the Settings theme picker lists all 4 themes with both languages\' names', async () => {
    const { cookie, csrfToken } = await signup('p2.settingslist@example.com', '203.0.211.005');
    await createLeague(cookie, csrfToken, { name: 'Theme Picker League', teamNames: ['A', 'B'] });
    const html = await settingsHtml(cookie);
    expect(html).toContain('value="arene"');
    expect(html).toContain('value="clean"');
    expect(html).toContain('value="classique"');
    expect(html).toContain('value="quartier"');
    expect(html).toContain('Classique (couleurs de la ligue, gras)');
    expect(html).toContain('Classique (bold, league colours)');
    expect(html).toContain('Quartier (chaleureux, arrondi)');
    expect(html).toContain('Quartier (warm, rounded)');
  });
});

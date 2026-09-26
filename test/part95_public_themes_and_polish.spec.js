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
async function updatePlayoffs(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/settings/playoffs', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}
async function fixtureApprove(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/season/fixture-approve', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}
async function submitScore(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events/score', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}
async function eventDetailHtml(cookie, eventId) {
  return (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } })).text();
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

// Part 3: best-of-N series tracking. resolvePlayoffSeeding (Part 5,
// stats tracking task) used to advance whoever won the LATEST played
// game of a matchup -- wrong for a real series (a best-of-3 split 1-1
// could be "decided" by whichever team happened to win game 2, even
// though the series isn't over). Fixed: a series is decided by a
// majority of its own games (Math.ceil(seriesLength/2)), never before.
// A series that ends early leaves its remaining game(s) unused --
// marked cancelled, never scorable again, so they don't sit there
// looking like an unplayed game forever.
describe('Best-of-N series tracking, Part 3', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  // A 2-team league's own playoffs are just ONE series -- the final,
  // with no further round to advance into. Minimal setup to isolate
  // series-decision timing itself from round-to-round advancement
  // (covered separately below).
  async function setUpTwoTeamSeries(email, ip, bestOf) {
    const { cookie, csrfToken } = await signup(email, ip);
    const league = await createLeague(cookie, csrfToken, { name: 'Series League', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await updateIdentity(cookie, csrfToken, { tracksResults: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: true, playoff_format: 'best_of_n', playoff_teams: 2, playoff_best_of: bestOf, playoff_third_place: false });
    // 1 regular-season game (2-team round robin) + bestOf playoff games.
    const approve = await fixtureApprove(cookie, csrfToken, { total_slots: 1 + bestOf, start_date: '2099-01-05', interval_days: 7, time: '18:00', venue: 'Series Gym' });
    expect(approve.status).toBe(200);
    const regularEvent = approve.json.created.find(e => !e.is_playoff);
    const seriesGames = approve.json.created.filter(e => e.is_playoff).sort((a, b) => a.date.localeCompare(b.date));
    expect(seriesGames.length).toBe(bestOf);

    // Seed the series from a 1-game "regular season" (Rouge wins ->
    // Rouge is seed 1, Bleu seed 2 -- both real teams, so an unambiguous
    // seeding regardless of this task's own tiebreak rule).
    await submitScore(cookie, csrfToken, { event_id: regularEvent.id, home_score: 3, away_score: 0 });
    const seeded = await env.DB.prepare('SELECT home_team, away_team FROM events WHERE id = ?').bind(seriesGames[0].id).first();
    expect(seeded.home_team).toBe('Rouge');
    expect(seeded.away_team).toBe('Bleu');
    return { cookie, csrfToken, league, seriesGames };
  }

  it('best-of-3: a 1-1 split after two games is NOT decided -- the decider game stays playable, nobody is cancelled', async () => {
    const { cookie, csrfToken, seriesGames } = await setUpTwoTeamSeries('p3.bo3.split@example.com', '203.0.212.001', 3);
    await submitScore(cookie, csrfToken, { event_id: seriesGames[0].id, home_score: 5, away_score: 2 }); // Rouge (home) wins game 1
    await submitScore(cookie, csrfToken, { event_id: seriesGames[1].id, home_score: 1, away_score: 4 }); // Bleu (away) wins game 2 -- 1-1

    const game3Before = await env.DB.prepare('SELECT state, home_team, away_team FROM events WHERE id = ?').bind(seriesGames[2].id).first();
    expect(game3Before.state).not.toBe('cancelled');
    expect(game3Before.home_team).toBe('Rouge'); // still seeded, still playable

    // Game 3 (the decider) still accepts a real score -- proves the
    // route itself doesn't treat the series as already decided either.
    const stillScorable = await submitScore(cookie, csrfToken, { event_id: seriesGames[2].id, home_score: 3, away_score: 1 }); // Rouge wins game 3 -- series 2-1 Rouge
    expect(stillScorable.status).toBe(200);
  });

  it('best-of-3: a 2-0 sweep is decided after game 2 -- game 3 is cancelled, never left looking unplayed, and can no longer be scored', async () => {
    const { cookie, csrfToken, seriesGames } = await setUpTwoTeamSeries('p3.bo3.sweep@example.com', '203.0.212.002', 3);
    await submitScore(cookie, csrfToken, { event_id: seriesGames[0].id, home_score: 4, away_score: 1 }); // Rouge wins game 1
    await submitScore(cookie, csrfToken, { event_id: seriesGames[1].id, home_score: 3, away_score: 0 }); // Rouge wins game 2 -- 2-0, decided

    const game3 = await env.DB.prepare('SELECT state, result_entered_at FROM events WHERE id = ?').bind(seriesGames[2].id).first();
    expect(game3.state).toBe('cancelled');
    expect(game3.result_entered_at).toBeNull(); // cancelled, not silently marked as played

    const rejected = await submitScore(cookie, csrfToken, { event_id: seriesGames[2].id, home_score: 1, away_score: 0 });
    expect(rejected.status).toBe(409);
    expect(rejected.json.errorKey).toBe('EVENT_CANCELLED');

    const html = await eventDetailHtml(cookie, seriesGames[2].id);
    expect(html).toContain('data-i18n="playoffSeriesDecidedTitle"');
    expect(html).not.toContain('id="score_section"'); // no score form for a cancelled game
  });

  it('best-of-5: needs 3 wins, not 2 -- a 2-2 split after four games is still NOT decided', async () => {
    const { cookie, csrfToken, seriesGames } = await setUpTwoTeamSeries('p3.bo5.notyet@example.com', '203.0.212.003', 5);
    await submitScore(cookie, csrfToken, { event_id: seriesGames[0].id, home_score: 3, away_score: 1 }); // Rouge
    await submitScore(cookie, csrfToken, { event_id: seriesGames[1].id, home_score: 1, away_score: 3 }); // Bleu
    await submitScore(cookie, csrfToken, { event_id: seriesGames[2].id, home_score: 4, away_score: 2 }); // Rouge
    await submitScore(cookie, csrfToken, { event_id: seriesGames[3].id, home_score: 0, away_score: 2 }); // Bleu -- 2-2

    const game5 = await env.DB.prepare('SELECT state FROM events WHERE id = ?').bind(seriesGames[4].id).first();
    expect(game5.state).not.toBe('cancelled');

    const decisive = await submitScore(cookie, csrfToken, { event_id: seriesGames[4].id, home_score: 2, away_score: 0 }); // Rouge wins game 5 -- series 3-2 Rouge
    expect(decisive.status).toBe(200);
  });

  it('a 4-team bracket: each semifinal is its own best-of-3 series, and only once BOTH are decided does the final get seeded with the real winners', async () => {
    const { cookie, csrfToken } = await signup('p3.bracket@example.com', '203.0.212.004');
    await createLeague(cookie, csrfToken, { name: 'Bracket Series League', teamNames: ['Rouge', 'Bleu', 'Vert', 'Jaune'], tracksStats: false });
    await updateIdentity(cookie, csrfToken, { tracksResults: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: true, playoff_format: 'best_of_n', playoff_teams: 4, playoff_best_of: 3, playoff_third_place: false });
    // 6 regular-season games (round robin of 4) + 9 playoff slots (2 best-of-3 semifinals + 1 best-of-3 final).
    const approve = await fixtureApprove(cookie, csrfToken, { total_slots: 15, start_date: '2099-02-01', interval_days: 7, time: '18:00', venue: 'Bracket Gym' });
    expect(approve.status).toBe(200);
    const regularEvents = approve.json.created.filter(e => !e.is_playoff);
    const playoffEvents = approve.json.created.filter(e => e.is_playoff);
    expect(regularEvents.length).toBe(6);
    expect(playoffEvents.length).toBe(9);

    // Rouge 1st, Bleu 2nd, Vert 3rd, Jaune 4th -- unambiguous, no tiebreak needed.
    const rankOrder = ['Rouge', 'Bleu', 'Vert', 'Jaune'];
    for (const ev of regularEvents) {
      const homeBetter = rankOrder.indexOf(ev.home_team) < rankOrder.indexOf(ev.away_team);
      await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: homeBetter ? 3 : 1, away_score: homeBetter ? 1 : 3 });
    }

    const rows = (await env.DB.prepare(
      `SELECT id, date, home_team, away_team, playoff_meta FROM events WHERE id IN (${playoffEvents.map(() => '?').join(',')}) ORDER BY date ASC`
    ).bind(...playoffEvents.map(e => e.id)).all()).results;
    const withMeta = rows.map(r => ({ ...r, meta: JSON.parse(r.playoff_meta || 'null') || {} }));
    const sf1Games = withMeta.filter(r => r.meta.role === 'semifinal' && r.meta.matchupIndexInRound === 1).sort((a, b) => a.date.localeCompare(b.date));
    const sf2Games = withMeta.filter(r => r.meta.role === 'semifinal' && r.meta.matchupIndexInRound === 2).sort((a, b) => a.date.localeCompare(b.date));
    const finalGames = withMeta.filter(r => r.meta.role === 'final').sort((a, b) => a.date.localeCompare(b.date));
    expect(sf1Games.length).toBe(3); expect(sf2Games.length).toBe(3); expect(finalGames.length).toBe(3);
    expect(sf1Games[0].home_team).toBe('Rouge'); expect(sf1Games[0].away_team).toBe('Jaune'); // seed 1 v 4
    expect(sf2Games[0].home_team).toBe('Bleu'); expect(sf2Games[0].away_team).toBe('Vert'); // seed 2 v 3

    // SF1: Rouge sweeps 2-0 -- decided early, game 3 cancelled.
    await submitScore(cookie, csrfToken, { event_id: sf1Games[0].id, home_score: 5, away_score: 2 });
    await submitScore(cookie, csrfToken, { event_id: sf1Games[1].id, home_score: 4, away_score: 1 });
    const sf1Game3 = await env.DB.prepare('SELECT state FROM events WHERE id = ?').bind(sf1Games[2].id).first();
    expect(sf1Game3.state).toBe('cancelled');

    // The final's home slot (SF1's own advancesToSide) is already
    // filled with SF1's real winner; the away slot stays unseeded --
    // SF2 hasn't decided yet.
    let finalRow = await env.DB.prepare('SELECT home_team, away_team FROM events WHERE id = ?').bind(finalGames[0].id).first();
    expect(finalRow.home_team).toBe('Rouge');
    expect(finalRow.away_team).toBeNull();

    // SF2: Vert upsets Bleu, but it takes all 3 games (1-1 after two,
    // decided 2-1 on the third) -- proves the "not decided at 1-1"
    // rule applies mid-bracket too, not just in the isolated tests above.
    await submitScore(cookie, csrfToken, { event_id: sf2Games[0].id, home_score: 3, away_score: 1 }); // Bleu (home) wins
    await submitScore(cookie, csrfToken, { event_id: sf2Games[1].id, home_score: 0, away_score: 2 }); // Vert (away) wins -- 1-1, final's away slot still unseeded
    finalRow = await env.DB.prepare('SELECT home_team, away_team FROM events WHERE id = ?').bind(finalGames[0].id).first();
    expect(finalRow.away_team).toBeNull();
    await submitScore(cookie, csrfToken, { event_id: sf2Games[2].id, home_score: 1, away_score: 3 }); // Vert (away) wins game 3 -- series 2-1 Vert

    // Both semifinals decided -- the final's own 3 games all get seeded
    // with the real winners (Rouge from SF1, Vert from SF2).
    for (const ev of finalGames) {
      const row = await env.DB.prepare('SELECT home_team, away_team FROM events WHERE id = ?').bind(ev.id).first();
      expect(row.home_team).toBe('Rouge');
      expect(row.away_team).toBe('Vert');
    }
  });
});

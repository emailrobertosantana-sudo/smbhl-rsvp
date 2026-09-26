// Public site rebuild task (Part 3): the public page was one narrow
// centred column showing only next game/organizer's note/standings/
// upcoming events, with no surface at all for player or goalie stats
// beyond a top-10 teaser, and no way to see a past season or a
// league's own career totals. This batch adds a wider, multi-section
// layout (Home/Standings/Players/Goalies/Leaders/Schedule/History),
// following SMBHL's own hash-routed navigation model as a design
// reference only (not ported -- this page already has its data
// server-side, so every section renders in full up front; the hash
// just controls which one shows). Reuses getLeagueSeasonsList/
// computeStandings/computeTopScorers/computeGoalieStats (season=null
// meaning "every season", added this task) for the History/All-time
// view.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part99-public-site-rebuild-secret';

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
async function updateTracking(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/settings/identity', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}
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
  return { status: res.status, json: await res.json() };
}
async function addContact(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).contact;
}
async function setRsvp(cookie, csrfToken, eventId, playerId, status) {
  const res = await SELF.fetch('http://example.com/league/rsvp/admin', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ event_id: eventId, player_id: playerId, status })
  });
  return res.json();
}
async function postPlayerStats(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events/player-stats', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}
async function publicPageHtml(leagueId, extraParams) {
  return (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(leagueId)}${extraParams || ''}`)).text();
}
async function setPublicTheme(cookie, csrfToken, theme) {
  const res = await SELF.fetch('http://example.com/league/settings/identity', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ public_theme: theme })
  });
  return { status: res.status, json: await res.json() };
}

describe('Public site rebuild, nav and section gating', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a fixed-teams league tracking both results and player stats gets every nav item', async () => {
    const { cookie, csrfToken } = await signup('nav.full@example.com', '203.0.213.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Full Nav League', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true, tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const html = await publicPageHtml(league.id);
    for (const id of ['home', 'standings', 'players', 'goalies', 'leaders', 'schedule', 'history']) {
      expect(html).toContain(`data-section="${id}"`);
      expect(html).toContain(`<section id="${id}" class="pb-view">`);
    }
  });

  it('a league tracking neither switch only gets Home and Schedule -- no Standings/Players/Goalies/Leaders/History', async () => {
    const { cookie, csrfToken } = await signup('nav.none@example.com', '203.0.213.002');
    const league = await createLeague(cookie, csrfToken, { name: 'No Tracking League', teamNames: ['A', 'B'], tracksStats: false });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const html = await publicPageHtml(league.id);
    expect(html).toContain('data-section="home"');
    expect(html).toContain('data-section="schedule"');
    for (const id of ['standings', 'players', 'goalies', 'leaders', 'history']) {
      expect(html).not.toContain(`data-section="${id}"`);
    }
  });

  it('a headcount league never gets Standings (no teams at all), even with results tracked', async () => {
    const { cookie, csrfToken } = await signup('nav.headcount@example.com', '203.0.213.003');
    const league = await createLeague(cookie, csrfToken, { name: 'Headcount Nav League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12, tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1', min_players: 8, max_players: 12 });

    const html = await publicPageHtml(league.id);
    expect(html).not.toContain('data-section="standings"');
  });

  it('Goalies needs BOTH player stats and results tracked -- player stats alone is not enough', async () => {
    const { cookie, csrfToken } = await signup('nav.goalies@example.com', '203.0.213.004');
    const league = await createLeague(cookie, csrfToken, { name: 'Player Stats Only League', teamNames: ['A', 'B'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksPlayerStats: true }); // results left off
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const html = await publicPageHtml(league.id);
    expect(html).toContain('data-section="players"');
    expect(html).not.toContain('data-section="goalies"');
  });
});

describe('Public site rebuild, Goalies section', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('shows GAA/W/L/T once goalie stats are recorded', async () => {
    const { cookie, csrfToken } = await signup('goalies.data@example.com', '203.0.214.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Goalie Data League', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true, tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const goalie = await addContact(cookie, csrfToken, { name: 'Public Goalie Player', role: 'roster', team: 'Rouge' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
    await setRsvp(cookie, csrfToken, ev.id, goalie.player_id, 'in');
    await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: 5, away_score: 2 });
    await postPlayerStats(cookie, csrfToken, { event_id: ev.id, entries: [{ player_id: goalie.player_id, role: 'goalie', goals_against: 0 }] });

    const html = await publicPageHtml(league.id);
    expect(html).toContain('data-i18n="goalieStats"');
    expect(html).toContain('Public Goalie Player');
    expect(html).toMatch(/<td>2<\/td><td>2<\/td>/); // GAA of 2 (Rouge's goalie faced Bleu's 2 goals over 1 game)
  });

  it('shows a deliberate empty state when tracked but nothing recorded yet -- never a blank/missing section', async () => {
    const { cookie, csrfToken } = await signup('goalies.empty@example.com', '203.0.214.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Goalie Empty League', teamNames: ['A', 'B'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true, tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const html = await publicPageHtml(league.id);
    expect(html).toContain('data-section="goalies"');
    expect(html).toContain('data-i18n="noGoaliesYet"');
    expect(html).toContain('class="pb-empty"');
  });
});

describe('Public site rebuild, Leaders section', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('shows the top 3 scorers and top 3 goalies by GAA', async () => {
    const { cookie, csrfToken } = await signup('leaders.data@example.com', '203.0.215.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Leaders League', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true, tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const top = await addContact(cookie, csrfToken, { name: 'Leader Top Player', role: 'roster', team: 'Rouge' });
    const low = await addContact(cookie, csrfToken, { name: 'Leader Low Player', role: 'roster', team: 'Rouge' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
    await setRsvp(cookie, csrfToken, ev.id, top.player_id, 'in');
    await setRsvp(cookie, csrfToken, ev.id, low.player_id, 'in');
    await postPlayerStats(cookie, csrfToken, {
      event_id: ev.id,
      entries: [
        { player_id: top.player_id, role: 'skater', goals: 5, assists: 2 },
        { player_id: low.player_id, role: 'skater', goals: 0, assists: 1 }
      ]
    });

    const html = await publicPageHtml(league.id);
    expect(html).toContain('data-i18n="leadersTitle"');
    expect(html).toContain('class="pb-leaders"');
    const leadersBlockStart = html.indexOf('id="leaders"');
    const leadersBlock = html.slice(leadersBlockStart, leadersBlockStart + 2000);
    expect(leadersBlock).toContain('Leader Top Player');
  });

  it('shows a deliberate empty state when nothing is recorded yet', async () => {
    const { cookie, csrfToken } = await signup('leaders.empty@example.com', '203.0.215.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Leaders Empty League', teamNames: ['A', 'B'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true, tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const html = await publicPageHtml(league.id);
    expect(html).toContain('data-i18n="noLeadersYet"');
  });

  it('is absent entirely for a league tracking neither switch', async () => {
    const { cookie, csrfToken } = await signup('leaders.absent@example.com', '203.0.215.003');
    const league = await createLeague(cookie, csrfToken, { name: 'Leaders Absent League', teamNames: ['A', 'B'], tracksStats: false });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const html = await publicPageHtml(league.id);
    expect(html).not.toContain('data-section="leaders"');
  });
});

describe('Public site rebuild, Players section shows EVERY player, not just a top-10 teaser', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('12 players with recorded stats all appear (the old page capped this list at 10)', async () => {
    const { cookie, csrfToken } = await signup('players.full@example.com', '203.0.216.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Full Players League', teamNames: ['A', 'B'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
    const players = [];
    for (let i = 0; i < 12; i++) {
      const p = await addContact(cookie, csrfToken, { name: `Roster Player Number ${i}`, role: 'roster' });
      await setRsvp(cookie, csrfToken, ev.id, p.player_id, 'in');
      players.push(p);
    }
    await postPlayerStats(cookie, csrfToken, {
      event_id: ev.id,
      entries: players.map((p, i) => ({ player_id: p.player_id, role: 'skater', goals: i + 1, assists: 0 }))
    });

    const html = await publicPageHtml(league.id);
    for (let i = 0; i < 12; i++) expect(html).toContain(`Roster Player Number ${i}`);
  });

  // This is the exact bug reported: top-scorers data existed but
  // didn't render on the Arène theme. Investigated directly -- the
  // OLD code already shared the identical HTML/CSS class (.pb-table)
  // across all 4 themes with no theme-specific gating, so no
  // reproducible cause was found in the old implementation either.
  // Fixed by construction in the rebuild regardless: Players is its
  // own dedicated section, verified rendering on Arène (the default,
  // untouched theme) explicitly here, and on all 4 themes below.
  it('renders on Arène specifically (the theme the bug report named), with no theme switch needed', async () => {
    const { cookie, csrfToken } = await signup('players.arene@example.com', '203.0.216.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Arene Players League', teamNames: ['A', 'B'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
    const scorer = await addContact(cookie, csrfToken, { name: 'Arene Scorer Player', role: 'roster' });
    await setRsvp(cookie, csrfToken, ev.id, scorer.player_id, 'in');
    await postPlayerStats(cookie, csrfToken, { event_id: ev.id, entries: [{ player_id: scorer.player_id, role: 'skater', goals: 4, assists: 1 }] });

    // No setPublicTheme call -- 'arene' is every league's real default.
    const html = await publicPageHtml(league.id);
    expect(html).toContain('Arene Scorer Player');
    expect(html).toContain('data-i18n="topScorers"');
  });
});

describe('Public site rebuild, matchup display (item 7)', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a 2-team fixed league always shows its one unambiguous matchup, even with no explicit home/away stored', async () => {
    const { cookie, csrfToken } = await signup('matchup.twoteam@example.com', '203.0.217.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Matchup Two Team League', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });

    const html = await publicPageHtml(league.id);
    expect(html).toContain('class="pb-hero-matchup">Rouge contre Bleu<');
    expect(html).toContain('class="pb-g-matchup">Rouge contre Bleu<');
  });

  it('a >2-team fixed league only shows the matchup once one is actually resolved', async () => {
    const { cookie, csrfToken } = await signup('matchup.fourteam@example.com', '203.0.217.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Matchup Four Team League', teamNames: ['Rouge', 'Bleu', 'Vert', 'Jaune'], tracksStats: false });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const noMatchup = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
    let html = await publicPageHtml(league.id);
    expect(html).not.toContain('class="pb-hero-matchup"');

    await createEvent(cookie, csrfToken, { date: '2099-01-12', season: 'S1', home_team: 'Vert', away_team: 'Jaune' });
    html = await publicPageHtml(league.id);
    // The hero always shows the NEXT event -- still the no-matchup one
    // (earliest date) -- but the schedule list shows the later,
    // resolved one correctly.
    expect(html).toContain('class="pb-g-matchup">Vert contre Jaune<');
  });

  it('a headcount league never shows a matchup line at all', async () => {
    const { cookie, csrfToken } = await signup('matchup.headcount@example.com', '203.0.217.003');
    const league = await createLeague(cookie, csrfToken, { name: 'Matchup Headcount League', teamStructure: 'headcount', minPlayers: 4, maxPlayers: 10, tracksStats: false });
    await publishSeason(cookie, csrfToken, { season_name: 'S1', min_players: 4, max_players: 10 });
    await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });

    const html = await publicPageHtml(league.id);
    expect(html).not.toContain('class="pb-hero-matchup"');
    expect(html).not.toContain('class="pb-g-matchup"');
  });
});

describe('Public site rebuild, History and All-time (items 5)', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a brand-new league with only its current season shows a deliberate "no past seasons yet" message, not a missing/broken section', async () => {
    const { cookie, csrfToken } = await signup('history.empty@example.com', '203.0.218.001');
    const league = await createLeague(cookie, csrfToken, { name: 'History Empty League', teamNames: ['A', 'B'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const html = await publicPageHtml(league.id);
    expect(html).toContain('data-section="history"');
    expect(html).toContain('data-i18n="noPastSeasonsYet"');
    // All-time is still reachable even with only one season on record.
    expect(html).toContain('?season=all#history');
  });

  it('once a second season exists, the first appears as a real, linked past season, and All-time aggregates across both', async () => {
    const { cookie, csrfToken } = await signup('history.two@example.com', '203.0.218.002');
    const league = await createLeague(cookie, csrfToken, { name: 'History Two Season League', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true, tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'Winter 2026' });
    const scorer = await addContact(cookie, csrfToken, { name: 'Two Season Player', role: 'roster' });
    const ev1 = await createEvent(cookie, csrfToken, { date: '2026-01-05', season: 'Winter 2026' });
    await setRsvp(cookie, csrfToken, ev1.id, scorer.player_id, 'in');
    await postPlayerStats(cookie, csrfToken, { event_id: ev1.id, entries: [{ player_id: scorer.player_id, role: 'skater', goals: 3, assists: 0 }] });

    await publishSeason(cookie, csrfToken, { season_name: 'Fall 2026' });
    const ev2 = await createEvent(cookie, csrfToken, { date: '2026-09-05', season: 'Fall 2026' });
    await setRsvp(cookie, csrfToken, ev2.id, scorer.player_id, 'in');
    await postPlayerStats(cookie, csrfToken, { event_id: ev2.id, entries: [{ player_id: scorer.player_id, role: 'skater', goals: 2, assists: 1 }] });

    // History lists the OTHER (non-current) season as a real link.
    const historyHtml = await publicPageHtml(league.id);
    expect(historyHtml).toContain('Winter 2026');
    expect(historyHtml).toContain('?season=' + encodeURIComponent('Winter 2026') + '#history');
    expect(historyHtml).not.toContain('data-i18n="noPastSeasonsYet"');

    // Viewing the past season directly shows ONLY its own stats.
    const pastSeasonHtml = await publicPageHtml(league.id, '&season=' + encodeURIComponent('Winter 2026'));
    expect(pastSeasonHtml).toContain('class="pb-season-banner"');
    expect(pastSeasonHtml).toContain('Tu consultes : Winter 2026');
    expect(pastSeasonHtml).toMatch(/Two Season Player<\/td><td>3<\/td>/);

    // All-time sums both seasons: 3 + 2 = 5 goals.
    const allTimeHtml = await publicPageHtml(league.id, '&season=all');
    expect(allTimeHtml).toContain('data-i18n="allTime"');
    expect(allTimeHtml).toMatch(/Two Season Player<\/td><td>5<\/td>/);
  });

  it('an unrecognized ?season= value falls back to the current season rather than erroring', async () => {
    const { cookie, csrfToken } = await signup('history.badparam@example.com', '203.0.218.003');
    const league = await createLeague(cookie, csrfToken, { name: 'History Bad Param League', teamNames: ['A', 'B'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const res = await SELF.fetch(`http://example.com/league/public?league=${league.id}&season=NotARealSeason`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('class="pb-season-banner"'); // silently treated as the current season
  });

  it('an empty All-time view (a real league, tracking results, that has simply never had a game played) renders deliberately -- the real Standings empty-state message, never a blank or broken-looking table', async () => {
    const { cookie, csrfToken } = await signup('history.emptyalltime@example.com', '203.0.218.004');
    const league = await createLeague(cookie, csrfToken, { name: 'Empty All Time League', teamNames: ['A', 'B'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true, tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    // No events, no scores, no player stats posted at all.

    const html = await publicPageHtml(league.id, '&season=all');
    expect(html).toContain('Tu consultes : Toutes saisons'); // the banner still confirms which view this is
    expect(html).toContain('data-i18n="noStandingsYet"');
    expect(html).toContain('data-i18n="noPlayersYet"');
    expect(html).toContain('data-i18n="noGoaliesYet"');
    expect(html).not.toContain('<table class="pb-table">'); // no empty <table> shell either
  });
});

describe('Public site rebuild, responsive layout and all 4 themes', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('.pb-main now uses the wide container, not the old narrow single column, in every theme', async () => {
    const { cookie, csrfToken } = await signup('theme.width@example.com', '203.0.219.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Width League', teamNames: ['A', 'B'], tracksStats: false });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    for (const theme of ['arene', 'clean', 'classique', 'quartier']) {
      await setPublicTheme(cookie, csrfToken, theme);
      const html = await publicPageHtml(league.id);
      expect(html).toContain('.pb-main { max-width: var(--content-wide)');
      expect(html).not.toContain('.pb-main { max-width: var(--content-narrow)');
    }
  });

  it('every theme renders the nav bar, leaders grid, and empty-state class with its own real CSS (not falling through to another theme\'s)', async () => {
    const { cookie, csrfToken } = await signup('theme.sections@example.com', '203.0.219.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Theme Sections League', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true, tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    for (const theme of ['arene', 'clean', 'classique', 'quartier']) {
      await setPublicTheme(cookie, csrfToken, theme);
      const html = await publicPageHtml(league.id);
      expect(html).toContain('.pb-nav {');
      expect(html).toContain('.pb-nav-link[aria-current="page"]');
      expect(html).toContain('.pb-leaders {');
      expect(html).toContain('.pb-empty {');
      expect(html).toContain('.pb-season-banner {');
      expect(html).toContain('data-section="players"');
      expect(html).toContain('data-i18n="noPlayersYet"'); // deliberately empty, no data posted in this test
    }
  });

  it('present AND absent: a fully-populated league and a bare-minimum league both render cleanly across all 4 themes', async () => {
    const { cookie: fullCookie, csrfToken: fullCsrf } = await signup('theme.populated@example.com', '203.0.219.003');
    const fullLeague = await createLeague(fullCookie, fullCsrf, { name: 'Populated Theme League', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await updateTracking(fullCookie, fullCsrf, { tracksResults: true, tracksPlayerStats: true });
    await publishSeason(fullCookie, fullCsrf, { season_name: 'S1' });
    const p = await addContact(fullCookie, fullCsrf, { name: 'Populated Player', role: 'roster', team: 'Rouge' });
    const ev = await createEvent(fullCookie, fullCsrf, { date: '2099-01-05', season: 'S1' });
    await setRsvp(fullCookie, fullCsrf, ev.id, p.player_id, 'in');
    await submitScore(fullCookie, fullCsrf, { event_id: ev.id, home_score: 4, away_score: 1 });
    await postPlayerStats(fullCookie, fullCsrf, { event_id: ev.id, entries: [{ player_id: p.player_id, role: 'goalie', goals_against: 0 }] });

    const { cookie: bareCookie, csrfToken: bareCsrf } = await signup('theme.bare@example.com', '203.0.219.004');
    const bareLeague = await createLeague(bareCookie, bareCsrf, { name: 'Bare Theme League', teamNames: ['A', 'B'], tracksStats: false });
    await publishSeason(bareCookie, bareCsrf, { season_name: 'S1' });

    for (const theme of ['arene', 'clean', 'classique', 'quartier']) {
      await setPublicTheme(fullCookie, fullCsrf, theme);
      const fullHtml = await publicPageHtml(fullLeague.id);
      expect(fullHtml).toContain('Populated Player');
      expect(fullHtml).toContain('data-i18n="goalieStats"');

      await setPublicTheme(bareCookie, bareCsrf, theme);
      const bareHtml = await publicPageHtml(bareLeague.id);
      expect(bareHtml).toContain('data-i18n="noEvents"');
      expect(bareHtml).not.toContain('data-section="standings"');
    }
  });
});

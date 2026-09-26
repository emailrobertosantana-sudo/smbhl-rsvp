// Stats tracking task: no score-entry/results feature existed in the
// league product. This blocked public standings (permanently 0-0-0),
// a top-scorers leaderboard, and playoff seeding (commit fa52ad8's
// own placeholders). This batch unblocks all three.
//
// Part 1: the old single "Track stats?" question replaced by two
// independent ones -- GAME RESULTS and PLAYER STATS. Either, both, or
// neither. By structure: FIXED and PICKUP (weekly_draw) offer both
// (pickup's results never produce standings -- see Part 4's own
// tests); NO TEAMS (headcount) never offers game results at all (no
// sides to attach a score to), player stats still offered.
//
// migrate-047.sql migrates any league that already had the old
// tracks_stats on to having BOTH new switches on, so nothing silently
// turns off. leagues.tracks_stats itself and the shared tracksStats()
// helper (season_config.js) are untouched -- SMBHL still reads that
// exact column on its own row for its own (data.json-based) stats
// tracking, deliberately not the model for this.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { deriveGoalieRecord, computeStandings, rankStandings, computeTopScorers, computeGoalieStats, buildBracketAdvancement, buildEliminationBracket } from '../src/leagues.js';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part94-stats-tracking-secret';

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
async function onboardingHtml(cookie, step) {
  return (await SELF.fetch(`http://example.com/onboarding/season?step=${step}`, { headers: { cookie } })).text();
}
async function settingsHtml(cookie) {
  return (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
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
async function eventDetailHtml(cookie, eventId) {
  return (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } })).text();
}
async function setRsvp(cookie, csrfToken, eventId, playerId, status) {
  const res = await SELF.fetch('http://example.com/league/rsvp/admin', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ event_id: eventId, player_id: playerId, status })
  });
  return res.json();
}
async function assignEventTeam(cookie, csrfToken, eventId, playerId, team) {
  const res = await SELF.fetch('http://example.com/league/events/assign-team', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ event_id: eventId, player_id: playerId, team })
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
async function postPlayerStats(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events/player-stats', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}
async function publicPageHtml(leagueId) {
  return (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(leagueId)}`)).text();
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

describe('Stats tracking, Part 1: two independent switches', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a fixed-teams league offers both questions at onboarding, and the switches are independently settable in Settings', async () => {
    const { cookie, csrfToken } = await signup('p1.fixed@example.com', '203.0.202.001');
    await createLeague(cookie, csrfToken, { name: 'Fixed Stats League', teamNames: ['A', 'B'], tracksStats: false });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const step5 = await onboardingHtml(cookie, 5);
    expect(step5).toContain('id="ob_tracks_results"');
    expect(step5).toContain('id="ob_tracks_player_stats"');

    // Independent: results on, player stats off.
    const set1 = await updateTracking(cookie, csrfToken, { tracksResults: true, tracksPlayerStats: false });
    expect(set1.status).toBe(200);
    expect(set1.json.settings.tracksResults).toBe(true);
    expect(set1.json.settings.tracksPlayerStats).toBe(false);

    // Flip independently: results off, player stats on.
    const set2 = await updateTracking(cookie, csrfToken, { tracksResults: false, tracksPlayerStats: true });
    expect(set2.json.settings.tracksResults).toBe(false);
    expect(set2.json.settings.tracksPlayerStats).toBe(true);

    const html = await settingsHtml(cookie);
    expect(html).toContain('id="se_tracks_results"');
    expect(html).toContain('id="se_tracks_player_stats"');
  });

  it('a pickup (weekly_draw) league offers both questions too, with copy that never implies results accumulate toward standings', async () => {
    const { cookie, csrfToken } = await signup('p1.pickup@example.com', '203.0.202.002');
    await createLeague(cookie, csrfToken, { name: 'Pickup Stats League', teamStructure: 'weekly_draw', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const step4 = await onboardingHtml(cookie, 4); // weekly_draw: roster,teams,playoffs-skipped,reminders... step numbering: roster=1,teams=2,reminders=3,stats=4
    expect(step4).toContain('id="ob_tracks_results"');
    expect(step4).toContain('id="ob_tracks_player_stats"');
    expect(step4).toContain('data-i18n="lblTracksResultsDescPickup"');

    const m = step4.match(/var __I18N = (\{[\s\S]*?\});\n/);
    const dict = JSON.parse(m[1]);
    expect(dict.fr.lblTracksResultsDescPickup).toBe("Le score de chaque match, gardé comme historique -- les équipes changent chaque semaine, donc pas de classement.");
    expect(dict.en.lblTracksResultsDescPickup).toBe("Each game's score, kept as history -- teams change every week, so there's no standings table.");
  });

  it('a no-teams (headcount) league never offers game results at all -- onboarding, Settings, and the route itself all reject it', async () => {
    const { cookie, csrfToken } = await signup('p1.headcount@example.com', '203.0.202.003');
    await createLeague(cookie, csrfToken, { name: 'Headcount Stats League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12, tracksStats: false });
    await publishSeason(cookie, csrfToken, { season_name: 'S1', min_players: 8, max_players: 12 });

    const step3 = await onboardingHtml(cookie, 3); // headcount: roster,reminders,stats
    expect(step3).not.toContain('id="ob_tracks_results"');
    expect(step3).toContain('id="ob_tracks_player_stats"');

    const html = await settingsHtml(cookie);
    expect(html).not.toContain('id="se_tracks_results"');
    expect(html).toContain('id="se_tracks_player_stats"');

    const res = await updateTracking(cookie, csrfToken, { tracksResults: true });
    expect(res.status).toBe(409);
    expect(res.json.errorKey).toBe('RESULTS_REQUIRE_TEAMS');

    // Player stats alone is still fine for headcount.
    const okRes = await updateTracking(cookie, csrfToken, { tracksPlayerStats: true });
    expect(okRes.status).toBe(200);
    expect(okRes.json.settings.tracksPlayerStats).toBe(true);
  });

  it('a league that already had the old "track stats" on migrates to having BOTH new switches on, so nothing silently turns off', async () => {
    const { cookie, csrfToken } = await signup('p1.migrate@example.com', '203.0.202.004');
    const league = await createLeague(cookie, csrfToken, { name: 'Migrate League', teamNames: ['A', 'B'], tracksStats: true });
    // handleLeagueCreate's own prospective version of the migration
    // rule (new leagues going forward, not the D1 UPDATE which only
    // ever runs once against already-existing rows) -- both on.
    const row = await env.DB.prepare('SELECT tracks_stats, tracks_results, tracks_player_stats FROM leagues WHERE id = ?').bind(league.id).first();
    expect(row.tracks_stats).toBe(1);
    expect(row.tracks_results).toBe(1);
    expect(row.tracks_player_stats).toBe(1);
  });

  it('a headcount league created with the legacy tracksStats:true never gets tracks_results forced on -- no sides to attach a score to', async () => {
    const { cookie, csrfToken } = await signup('p1.legacyheadcount@example.com', '203.0.202.005');
    const league = await createLeague(cookie, csrfToken, { name: 'Legacy Headcount League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12, tracksStats: true });
    const row = await env.DB.prepare('SELECT tracks_stats, tracks_results, tracks_player_stats FROM leagues WHERE id = ?').bind(league.id).first();
    expect(row.tracks_stats).toBe(1);
    expect(row.tracks_results).toBe(0); // never forced on
    expect(row.tracks_player_stats).toBe(1);
  });

  it('a league that never had tracking on stays off on both new switches (not silently turned on)', async () => {
    const { cookie, csrfToken } = await signup('p1.nevermigrated@example.com', '203.0.202.006');
    const league = await createLeague(cookie, csrfToken, { name: 'Never Tracked League', teamNames: ['A', 'B'], tracksStats: false });
    const row = await env.DB.prepare('SELECT tracks_results, tracks_player_stats FROM leagues WHERE id = ?').bind(league.id).first();
    expect(row.tracks_results).toBe(0);
    expect(row.tracks_player_stats).toBe(0);
  });

  it('both languages\' copy for the two onboarding questions, verbatim', async () => {
    const { cookie, csrfToken } = await signup('p1.copy@example.com', '203.0.202.007');
    await createLeague(cookie, csrfToken, { name: 'Copy League', teamNames: ['A', 'B'], tracksStats: false });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const html = await onboardingHtml(cookie, 5);
    const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/);
    const dict = JSON.parse(m[1]);
    expect(dict.fr.lblTracksResults).toBe('Résultats des matchs');
    expect(dict.fr.lblTracksResultsDesc).toBe('Le score de chaque match, calculé en classement (V-D-N).');
    expect(dict.fr.lblTracksPlayerStats).toBe('Statistiques des joueurs');
    expect(dict.fr.lblTracksPlayerStatsDesc).toBe('Buts et passes par joueur, par match.');
    expect(dict.en.lblTracksResults).toBe('Game results');
    expect(dict.en.lblTracksResultsDesc).toBe("Each game's score, computed into a standings table (W-L-T).");
    expect(dict.en.lblTracksPlayerStats).toBe('Player stats');
    expect(dict.en.lblTracksPlayerStatsDesc).toBe('Goals and assists per player, per game.');
  });
});

// Part 2: score entry. ADMIN ONLY (no player/captain entry route
// exists or is planned -- standings and playoff seeding must be
// authoritative). An event can be marked played with a result, and
// that result is editable afterward.
describe('Stats tracking, Part 2: score entry', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a score can be entered for a 2-team fixed league (matchup implied) and edited afterward', async () => {
    const { cookie, csrfToken } = await signup('p2.fixed2@example.com', '203.0.203.001');
    await createLeague(cookie, csrfToken, { name: 'Fixed 2 Score League', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });

    const entered = await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: 4, away_score: 2 });
    expect(entered.status).toBe(200);
    expect(entered.json.event.home_team).toBe('Rouge');
    expect(entered.json.event.away_team).toBe('Bleu');
    expect(entered.json.event.home_score).toBe(4);

    let row = await env.DB.prepare('SELECT home_score, away_score, result_entered_at FROM events WHERE id = ?').bind(ev.id).first();
    expect(row.home_score).toBe(4); expect(row.away_score).toBe(2);
    expect(row.result_entered_at).toBeTruthy();

    // Editable afterward -- scoresheets get misread.
    const edited = await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: 5, away_score: 2 });
    expect(edited.status).toBe(200);
    row = await env.DB.prepare('SELECT home_score, away_score FROM events WHERE id = ?').bind(ev.id).first();
    expect(row.home_score).toBe(5); expect(row.away_score).toBe(2);
  });

  it('a score for a >2-team fixed league needs a matchup set first -- rejected without one', async () => {
    const { cookie, csrfToken } = await signup('p2.nomatchup@example.com', '203.0.203.002');
    await createLeague(cookie, csrfToken, { name: 'No Matchup Score League', teamNames: ['A', 'B', 'C', 'D'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });

    const res = await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: 1, away_score: 0 });
    expect(res.status).toBe(409);
    expect(res.json.errorKey).toBe('NO_MATCHUP_SET');
  });

  it('a score for a weekly_draw event is recorded as game history, using the two teams actually drawn', async () => {
    const { cookie, csrfToken } = await signup('p2.pickup@example.com', '203.0.203.003');
    await createLeague(cookie, csrfToken, { name: 'Pickup Score League', teamStructure: 'weekly_draw', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
    const p1 = await (await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Player One', role: 'roster' })
    })).json().then(r => r.contact);
    const p2 = await (await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Player Two', role: 'roster' })
    })).json().then(r => r.contact);
    await setRsvp(cookie, csrfToken, ev.id, p1.player_id, 'in');
    await setRsvp(cookie, csrfToken, ev.id, p2.player_id, 'in');
    await assignEventTeam(cookie, csrfToken, ev.id, p1.player_id, 'Rouge');
    await assignEventTeam(cookie, csrfToken, ev.id, p2.player_id, 'Bleu');

    const res = await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: 3, away_score: 3 });
    expect(res.status).toBe(200);
    expect([res.json.event.home_team, res.json.event.away_team].sort()).toEqual(['Bleu', 'Rouge']);
    const row = await env.DB.prepare('SELECT home_team, away_team FROM events WHERE id = ?').bind(ev.id).first();
    expect(row.home_team).toBeTruthy();
    expect(row.away_team).toBeTruthy();
  });

  it('a headcount league is rejected outright -- no sides to attach a score to -- normally via RESULTS_NOT_TRACKED (Part 1 never lets tracks_results turn on for headcount in the first place), and the route\'s own structure guard is genuine defense in depth even if that were somehow bypassed', async () => {
    const { cookie, csrfToken } = await signup('p2.headcount@example.com', '203.0.203.004');
    const league = await createLeague(cookie, csrfToken, { name: 'Headcount Score League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12, tracksStats: false });
    await publishSeason(cookie, csrfToken, { season_name: 'S1', min_players: 8, max_players: 12 });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });

    const normal = await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: 1, away_score: 0 });
    expect(normal.status).toBe(409);
    expect(normal.json.errorKey).toBe('RESULTS_NOT_TRACKED');

    // Force tracks_results on directly (bypassing Part 1's own route
    // guard) to prove the score route's OWN structure check is real,
    // independent defense in depth -- not just relying on Part 1 never
    // having let this state exist.
    await env.DB.prepare('UPDATE leagues SET tracks_results = 1 WHERE id = ?').bind(league.id).run();
    const forced = await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: 1, away_score: 0 });
    expect(forced.status).toBe(409);
    expect(forced.json.errorKey).toBe('RESULTS_REQUIRE_TEAMS');
  });

  it('rejected when the league does not track results at all', async () => {
    const { cookie, csrfToken } = await signup('p2.notracking@example.com', '203.0.203.005');
    await createLeague(cookie, csrfToken, { name: 'No Tracking Score League', teamNames: ['A', 'B'], tracksStats: false });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
    const res = await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: 1, away_score: 0 });
    expect(res.status).toBe(409);
    expect(res.json.errorKey).toBe('RESULTS_NOT_TRACKED');
  });

  it('rejects a non-integer or negative score', async () => {
    const { cookie, csrfToken } = await signup('p2.invalid@example.com', '203.0.203.006');
    await createLeague(cookie, csrfToken, { name: 'Invalid Score League', teamNames: ['A', 'B'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
    const res1 = await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: -1, away_score: 0 });
    expect(res1.status).toBe(400);
    expect(res1.json.errorKey).toBe('INVALID_SCORE');
    const res2 = await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: 1.5, away_score: 0 });
    expect(res2.status).toBe(400);
  });

  it('the event detail page shows the score-entry form for an admin, and the saved score once entered', async () => {
    const { cookie, csrfToken } = await signup('p2.uidetail@example.com', '203.0.203.007');
    await createLeague(cookie, csrfToken, { name: 'UI Score League', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });

    const before = await eventDetailHtml(cookie, ev.id);
    expect(before).toContain('id="score_section"');
    expect(before).toContain('data-i18n="scoreEnterBtn"');

    await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: 2, away_score: 1 });
    const after = await eventDetailHtml(cookie, ev.id);
    expect(after).toContain('Rouge 2 -- 1 Bleu');
    expect(after).toContain('data-i18n="scoreEditBtn"');
  });

  it('the score section is absent when the league does not track results', async () => {
    const { cookie, csrfToken } = await signup('p2.uiabsent@example.com', '203.0.203.008');
    await createLeague(cookie, csrfToken, { name: 'UI Absent League', teamNames: ['A', 'B'], tracksStats: false });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
    const html = await eventDetailHtml(cookie, ev.id);
    expect(html).not.toContain('id="score_section"');
  });
});

// Part 3: player stats entry. Goals/assists per CONFIRMED player --
// never the whole roster. Goalie win/loss/tie is DERIVED from the
// event's own score + which side the goalie was on, never asked for
// twice; goals_against is the one real number asked for. Goalie
// entries need game results enabled (Part 1's own decision).
describe('Stats tracking, Part 3: player stats entry', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('only players CONFIRMED IN for this event can have stats entered -- a non-confirmed player is rejected', async () => {
    const { cookie, csrfToken } = await signup('p3.confirmed@example.com', '203.0.204.001');
    await createLeague(cookie, csrfToken, { name: 'Confirmed League', teamNames: ['A', 'B'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
    const confirmed = await addContact(cookie, csrfToken, { name: 'Confirmed Player', role: 'roster' });
    const notConfirmed = await addContact(cookie, csrfToken, { name: 'Not Confirmed Player', role: 'roster' });
    await setRsvp(cookie, csrfToken, ev.id, confirmed.player_id, 'in');
    await setRsvp(cookie, csrfToken, ev.id, notConfirmed.player_id, 'out');

    const good = await postPlayerStats(cookie, csrfToken, { event_id: ev.id, entries: [{ player_id: confirmed.player_id, role: 'skater', goals: 2, assists: 1 }] });
    expect(good.status).toBe(200);

    const bad = await postPlayerStats(cookie, csrfToken, { event_id: ev.id, entries: [{ player_id: notConfirmed.player_id, role: 'skater', goals: 1, assists: 0 }] });
    expect(bad.status).toBe(409);
    expect(bad.json.errorKey).toBe('PLAYER_NOT_CONFIRMED');

    const row = await env.DB.prepare('SELECT goals, assists FROM player_game_stats WHERE event_id = ? AND player_id = ?').bind(ev.id, confirmed.player_id).first();
    expect(row.goals).toBe(2); expect(row.assists).toBe(1);
  });

  it('the event page only lists CONFIRMED players in the stats form -- not the whole roster', async () => {
    const { cookie, csrfToken } = await signup('p3.uilist@example.com', '203.0.204.002');
    await createLeague(cookie, csrfToken, { name: 'UI List League', teamNames: ['A', 'B'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
    const confirmed = await addContact(cookie, csrfToken, { name: 'Shows Up Player', role: 'roster' });
    const notConfirmed = await addContact(cookie, csrfToken, { name: 'Hidden Player', role: 'roster' });
    await setRsvp(cookie, csrfToken, ev.id, confirmed.player_id, 'in');
    await setRsvp(cookie, csrfToken, ev.id, notConfirmed.player_id, 'pending');

    const html = await eventDetailHtml(cookie, ev.id);
    expect(html).toContain('Shows Up Player');
    expect(html).not.toContain('Hidden Player');
  });

  it('goalie stats are rejected when game results are off for this league, and accepted once turned on', async () => {
    const { cookie, csrfToken } = await signup('p3.goalieoff@example.com', '203.0.204.003');
    await createLeague(cookie, csrfToken, { name: 'Goalie Off League', teamNames: ['A', 'B'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksPlayerStats: true }); // results left off
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
    const goalie = await addContact(cookie, csrfToken, { name: 'Goalie Player', role: 'roster' });
    await setRsvp(cookie, csrfToken, ev.id, goalie.player_id, 'in');

    const rejected = await postPlayerStats(cookie, csrfToken, { event_id: ev.id, entries: [{ player_id: goalie.player_id, role: 'goalie', goals_against: 3 }] });
    expect(rejected.status).toBe(409);
    expect(rejected.json.errorKey).toBe('GOALIE_STATS_REQUIRE_RESULTS');

    await updateTracking(cookie, csrfToken, { tracksResults: true });
    const accepted = await postPlayerStats(cookie, csrfToken, { event_id: ev.id, entries: [{ player_id: goalie.player_id, role: 'goalie', goals_against: 3 }] });
    expect(accepted.status).toBe(200);
    const row = await env.DB.prepare('SELECT role, goals_against FROM player_game_stats WHERE event_id = ? AND player_id = ?').bind(ev.id, goalie.player_id).first();
    expect(row.role).toBe('goalie');
    expect(row.goals_against).toBe(3);
  });

  it('a goalie\'s win/loss/tie is DERIVED from the event\'s own score and which side they were on -- never asked for, never stored', async () => {
    const { cookie, csrfToken } = await signup('p3.derive@example.com', '203.0.204.004');
    await createLeague(cookie, csrfToken, { name: 'Derive League', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true, tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
    await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: 5, away_score: 2 }); // Rouge (home) wins

    // Not stored anywhere as an enum -- deriveGoalieRecord computes it
    // fresh from the event row + team, every time.
    const scoredEv = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(ev.id).first();
    expect(deriveGoalieRecord(scoredEv, 'Rouge')).toBe('win');
    expect(deriveGoalieRecord(scoredEv, 'Bleu')).toBe('loss');

    const tieEv = { ...scoredEv, home_score: 3, away_score: 3 };
    expect(deriveGoalieRecord(tieEv, 'Rouge')).toBe('tie');
    expect(deriveGoalieRecord(tieEv, 'Bleu')).toBe('tie');

    // No result yet -- nothing to derive.
    const noResultEv = { ...scoredEv, result_entered_at: null, home_score: null, away_score: null };
    expect(deriveGoalieRecord(noResultEv, 'Rouge')).toBeNull();
  });

  it('a player can be a skater in one game and a goalie in another, within the same season -- the model never prevents it', async () => {
    const { cookie, csrfToken } = await signup('p3.bothroles@example.com', '203.0.204.005');
    await createLeague(cookie, csrfToken, { name: 'Both Roles League', teamNames: ['A', 'B'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true, tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev1 = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
    const ev2 = await createEvent(cookie, csrfToken, { date: '2099-01-12', season: 'S1' });
    const player = await addContact(cookie, csrfToken, { name: 'Two Way Player', role: 'roster' });
    await setRsvp(cookie, csrfToken, ev1.id, player.player_id, 'in');
    await setRsvp(cookie, csrfToken, ev2.id, player.player_id, 'in');

    const skaterGame = await postPlayerStats(cookie, csrfToken, { event_id: ev1.id, entries: [{ player_id: player.player_id, role: 'skater', goals: 1, assists: 2 }] });
    expect(skaterGame.status).toBe(200);
    const goalieGame = await postPlayerStats(cookie, csrfToken, { event_id: ev2.id, entries: [{ player_id: player.player_id, role: 'goalie', goals_against: 2 }] });
    expect(goalieGame.status).toBe(200);

    const rows = (await env.DB.prepare('SELECT event_id, role FROM player_game_stats WHERE player_id = ? ORDER BY event_id').bind(player.player_id).all()).results;
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.role).sort()).toEqual(['goalie', 'skater']);
  });

  it('rejected when the league does not track player stats at all', async () => {
    const { cookie, csrfToken } = await signup('p3.notracking@example.com', '203.0.204.006');
    await createLeague(cookie, csrfToken, { name: 'No Player Stats League', teamNames: ['A', 'B'], tracksStats: false });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
    const player = await addContact(cookie, csrfToken, { name: 'Test Player', role: 'roster' });
    await setRsvp(cookie, csrfToken, ev.id, player.player_id, 'in');
    const res = await postPlayerStats(cookie, csrfToken, { event_id: ev.id, entries: [{ player_id: player.player_id, role: 'skater', goals: 1, assists: 0 }] });
    expect(res.status).toBe(409);
    expect(res.json.errorKey).toBe('PLAYER_STATS_NOT_TRACKED');
  });

  it('editable afterward -- re-submitting the same player overwrites their stats for that game', async () => {
    const { cookie, csrfToken } = await signup('p3.edit@example.com', '203.0.204.007');
    await createLeague(cookie, csrfToken, { name: 'Edit Stats League', teamNames: ['A', 'B'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' });
    const player = await addContact(cookie, csrfToken, { name: 'Test Player', role: 'roster' });
    await setRsvp(cookie, csrfToken, ev.id, player.player_id, 'in');

    await postPlayerStats(cookie, csrfToken, { event_id: ev.id, entries: [{ player_id: player.player_id, role: 'skater', goals: 1, assists: 0 }] });
    await postPlayerStats(cookie, csrfToken, { event_id: ev.id, entries: [{ player_id: player.player_id, role: 'skater', goals: 3, assists: 2 }] });
    const row = await env.DB.prepare('SELECT goals, assists FROM player_game_stats WHERE event_id = ? AND player_id = ?').bind(ev.id, player.player_id).first();
    expect(row.goals).toBe(3); expect(row.assists).toBe(2);
  });
});

// Part 4: standings (fixed-teams only, computed fresh from game
// results every read -- see computeStandings' own comment for why
// this is deliberately NOT an incrementally-updated cache) and top
// scorers (any structure, any league with player stats enabled). Both
// must respect Part 1's own switches, at READ time -- not just at
// write time (a switch flipped off afterward must hide data that's
// still sitting in the DB, not just block new writes).
describe('Stats tracking, Part 4: standings and leaderboards', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('computeStandings aggregates real, asymmetric per-team totals from game results -- wins, losses, a tie, goals for/against, and points (win=2, tie=1, loss=0)', async () => {
    const { cookie, csrfToken } = await signup('p4.standings@example.com', '203.0.205.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Standings League', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const games = [[5, 2], [4, 1], [1, 4], [2, 2]]; // Rouge: W, W, L, T
    for (let i = 0; i < games.length; i++) {
      const ev = await createEvent(cookie, csrfToken, { date: `2099-02-0${i + 1}`, season: 'S1' });
      await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: games[i][0], away_score: games[i][1] });
    }

    const standings = await computeStandings(env, league.id, 'S1');
    const rouge = standings.find(s => s.team === 'Rouge');
    const bleu = standings.find(s => s.team === 'Bleu');
    expect(rouge).toEqual({ team: 'Rouge', gp: 4, w: 2, l: 1, t: 1, gf: 12, ga: 9, pts: 5 });
    expect(bleu).toEqual({ team: 'Bleu', gp: 4, w: 1, l: 2, t: 1, gf: 9, ga: 12, pts: 3 });

    const ranked = rankStandings(standings);
    expect(ranked.map(s => s.team)).toEqual(['Rouge', 'Bleu']);
  });

  it('rankStandings applies the tiebreak chain in order: points, then wins, then goal differential, then goals for', () => {
    // Level 1: points alone decides.
    expect(rankStandings([
      { team: 'A', pts: 3, w: 1, gf: 5, ga: 5 },
      { team: 'B', pts: 5, w: 1, gf: 1, ga: 1 }
    ]).map(s => s.team)).toEqual(['B', 'A']);

    // Level 2: equal points, wins break the tie.
    expect(rankStandings([
      { team: 'A', pts: 4, w: 1, gf: 5, ga: 5 },
      { team: 'B', pts: 4, w: 2, gf: 1, ga: 1 }
    ]).map(s => s.team)).toEqual(['B', 'A']);

    // Level 3: equal points and wins, goal differential breaks the tie.
    expect(rankStandings([
      { team: 'A', pts: 4, w: 2, gf: 6, ga: 5 },
      { team: 'B', pts: 4, w: 2, gf: 9, ga: 5 }
    ]).map(s => s.team)).toEqual(['B', 'A']);

    // Level 4: equal points, wins, and differential -- goals for breaks it.
    expect(rankStandings([
      { team: 'A', pts: 4, w: 2, gf: 4, ga: 2 },
      { team: 'B', pts: 4, w: 2, gf: 6, ga: 4 }
    ]).map(s => s.team)).toEqual(['B', 'A']);
  });

  it('computeTopScorers sums goals/assists across the season for ANY team structure -- not just fixed -- and sorts by points then goals', async () => {
    const { cookie, csrfToken } = await signup('p4.topscorers@example.com', '203.0.205.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Top Scorers Pickup League', teamStructure: 'weekly_draw', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev1 = await createEvent(cookie, csrfToken, { date: '2099-03-01', season: 'S1' });
    const ev2 = await createEvent(cookie, csrfToken, { date: '2099-03-08', season: 'S1' });
    const top = await addContact(cookie, csrfToken, { name: 'Top Scorer Player', role: 'roster' });
    const low = await addContact(cookie, csrfToken, { name: 'Low Scorer Player', role: 'roster' });
    await setRsvp(cookie, csrfToken, ev1.id, top.player_id, 'in');
    await setRsvp(cookie, csrfToken, ev2.id, top.player_id, 'in');
    await setRsvp(cookie, csrfToken, ev1.id, low.player_id, 'in');

    await postPlayerStats(cookie, csrfToken, { event_id: ev1.id, entries: [{ player_id: top.player_id, role: 'skater', goals: 2, assists: 1 }, { player_id: low.player_id, role: 'skater', goals: 0, assists: 1 }] });
    await postPlayerStats(cookie, csrfToken, { event_id: ev2.id, entries: [{ player_id: top.player_id, role: 'skater', goals: 1, assists: 0 }] });

    const scorers = await computeTopScorers(env, league.id, 'S1');
    expect(scorers[0]).toEqual({ player_id: top.player_id, name: 'Top Scorer Player', goals: 3, assists: 1, points: 4 });
    expect(scorers[1]).toEqual({ player_id: low.player_id, name: 'Low Scorer Player', goals: 0, assists: 1, points: 1 });
  });

  it('computeGoalieStats derives win/loss per game from the event\'s own result (never a stored enum) and computes GAA as goals-against per game played', async () => {
    const { cookie, csrfToken } = await signup('p4.goaliestats@example.com', '203.0.205.003');
    const league = await createLeague(cookie, csrfToken, { name: 'Goalie Stats League', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true, tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const goalie = await addContact(cookie, csrfToken, { name: 'Team Goalie Player', role: 'roster', team: 'Rouge' });
    const ev1 = await createEvent(cookie, csrfToken, { date: '2099-04-01', season: 'S1' });
    const ev2 = await createEvent(cookie, csrfToken, { date: '2099-04-08', season: 'S1' });
    await setRsvp(cookie, csrfToken, ev1.id, goalie.player_id, 'in');
    await setRsvp(cookie, csrfToken, ev2.id, goalie.player_id, 'in');

    await submitScore(cookie, csrfToken, { event_id: ev1.id, home_score: 5, away_score: 2 }); // Rouge win
    await submitScore(cookie, csrfToken, { event_id: ev2.id, home_score: 1, away_score: 4 }); // Rouge loss
    await postPlayerStats(cookie, csrfToken, { event_id: ev1.id, entries: [{ player_id: goalie.player_id, role: 'goalie', goals_against: 2 }] });
    await postPlayerStats(cookie, csrfToken, { event_id: ev2.id, entries: [{ player_id: goalie.player_id, role: 'goalie', goals_against: 4 }] });

    const [stats] = await computeGoalieStats(env, league.id, 'S1');
    expect(stats.games).toBe(2);
    expect(stats.w).toBe(1);
    expect(stats.l).toBe(1);
    expect(stats.t).toBe(0);
    expect(stats.goalsAgainst).toBe(6);
    expect(stats.gaa).toBe(3);
  });

  it('the public page shows a full standings table for a fixed-teams league with results on, and hides it again the moment the switch is turned off -- even though the scores stay in the DB', async () => {
    const { cookie, csrfToken } = await signup('p4.pubstandings@example.com', '203.0.205.004');
    const league = await createLeague(cookie, csrfToken, { name: 'Public Standings League', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2024-01-05', season: 'S1' });
    await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: 5, away_score: 2 });

    const before = await publicPageHtml(league.id);
    expect(before).toContain('data-i18n="standings"');
    expect(before).toContain('>Rouge<');
    expect(before).toContain('>5<');
    expect(before).toContain('Standings'); // both languages' copy embedded for the client toggle
    expect(before).toContain('Classement');

    await updateTracking(cookie, csrfToken, { tracksResults: false });
    const after = await publicPageHtml(league.id);
    expect(after).not.toContain('data-i18n="standings"');
    const row = await env.DB.prepare('SELECT home_score FROM events WHERE id = ?').bind(ev.id).first();
    expect(row.home_score).toBe(5); // the score itself was never deleted, only hidden
  });

  it('a pickup (weekly_draw) league with a result entered shows NO standings table, but the game result is visible in its recent-results history', async () => {
    const { cookie, csrfToken } = await signup('p4.pubpickup@example.com', '203.0.205.005');
    const league = await createLeague(cookie, csrfToken, { name: 'Public Pickup League', teamStructure: 'weekly_draw', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2024-01-05', season: 'S1' });
    const p1 = await addContact(cookie, csrfToken, { name: 'Pickup Player One', role: 'roster' });
    const p2 = await addContact(cookie, csrfToken, { name: 'Pickup Player Two', role: 'roster' });
    await setRsvp(cookie, csrfToken, ev.id, p1.player_id, 'in');
    await setRsvp(cookie, csrfToken, ev.id, p2.player_id, 'in');
    await assignEventTeam(cookie, csrfToken, ev.id, p1.player_id, 'Rouge');
    await assignEventTeam(cookie, csrfToken, ev.id, p2.player_id, 'Bleu');
    const scored = await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: 6, away_score: 3 });

    const html = await publicPageHtml(league.id);
    expect(html).not.toContain('data-i18n="standings"');
    // Home/away for a weekly_draw event is resolved from whichever team
    // was actually drawn into each rsvp.team slot (no fixed home/away
    // convention -- see resolveScoreEventSides' own comment), so assert
    // against the score route's own response rather than assuming which
    // team landed on which side.
    expect(html).toContain(`${scored.json.event.home_team} <b>6</b>`);
    expect(html).toContain(`<b>3</b> ${scored.json.event.away_team}`);
  });

  it('a headcount (no-teams) league never shows a standings table, regardless of player stats tracking', async () => {
    const { cookie, csrfToken } = await signup('p4.pubheadcount@example.com', '203.0.205.006');
    const league = await createLeague(cookie, csrfToken, { name: 'Public Headcount League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12, tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1', min_players: 8, max_players: 12 });
    const html = await publicPageHtml(league.id);
    expect(html).not.toContain('data-i18n="standings"');
  });

  it('the public page top-scorers leaderboard respects tracks_player_stats at READ time (not just at write time), and works for a pickup league, not just fixed', async () => {
    const { cookie, csrfToken } = await signup('p4.pubtopscorers@example.com', '203.0.205.007');
    const league = await createLeague(cookie, csrfToken, { name: 'Public Top Scorers League', teamStructure: 'weekly_draw', teamNames: ['Rouge', 'Bleu'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksPlayerStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2024-01-05', season: 'S1' });
    const player = await addContact(cookie, csrfToken, { name: 'Public Scorer Player', role: 'roster' });
    await setRsvp(cookie, csrfToken, ev.id, player.player_id, 'in');
    await postPlayerStats(cookie, csrfToken, { event_id: ev.id, entries: [{ player_id: player.player_id, role: 'skater', goals: 4, assists: 2 }] });

    const on = await publicPageHtml(league.id);
    expect(on).toContain('data-i18n="topScorers"');
    expect(on).toContain('Public Scorer Player');
    expect(on).toContain('Top scorers'); // both languages' copy embedded for the client toggle
    expect(on).toContain('Meilleurs pointeurs');

    await updateTracking(cookie, csrfToken, { tracksPlayerStats: false });
    const off = await publicPageHtml(league.id);
    expect(off).not.toContain('data-i18n="topScorers"');
    const row = await env.DB.prepare('SELECT goals FROM player_game_stats WHERE event_id = ? AND player_id = ?').bind(ev.id, player.player_id).first();
    expect(row.goals).toBe(4); // the stat itself was never deleted, only hidden
  });
});

// Part 5: playoff seeding resolver. Placeholders from
// buildPlayoffPlaceholders (commit fa52ad8) carry round/matchup-index/
// seed numbers with home_team/away_team left null. resolvePlayoffSeeding
// (called from handleLeagueEventScore after every score write) fills
// round 1 from final standings once the regular season completes, and
// advances a playoff game's winner into the next round the moment
// it's decided. FIXED TEAMS ONLY. A tied playoff game has no
// tiebreak -- left exactly as unresolved as an unplayed one, rather
// than guessed.
describe('Stats tracking, Part 5: playoff seeding resolver', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it("buildBracketAdvancement's own seedA/seedB never disagrees with buildEliminationBracket's, across a range of team counts", () => {
    for (const numTeams of [2, 3, 4, 5, 6, 7, 8, 10, 16]) {
      const expected = buildEliminationBracket(numTeams).map(round => round.map(m => ({ seedA: m.seedA, seedB: m.seedB })));
      const actual = buildBracketAdvancement(numTeams).rounds.map(round => round.map(m => ({ seedA: m.seedA, seedB: m.seedB })));
      expect(actual).toEqual(expected);
    }
  });

  // Shared setup for the three end-to-end tests below: a 4-team fixed
  // league, single-elimination (semifinal -> final, no third place, no
  // bye -- numTeams is even), regular season + playoff placeholders
  // generated together by the real fixture-generator routes (the same
  // path an admin uses). Every regular-season game is then scored so
  // Rouge finishes 1st, Bleu 2nd, Vert 3rd, Jaune 4th -- an
  // unambiguous ranking, no tiebreak needed for THIS part.
  async function setUpFourTeamBracket(email, ip) {
    const { cookie, csrfToken } = await signup(email, ip);
    const league = await createLeague(cookie, csrfToken, { name: 'Playoff Seeding League', teamNames: ['Rouge', 'Bleu', 'Vert', 'Jaune'], tracksStats: false });
    await updateTracking(cookie, csrfToken, { tracksResults: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: true, playoff_format: 'single_elimination', playoff_teams: 4, playoff_third_place: false });
    // 6 regular-season games (round robin of 4) + 3 playoff slots (2 semifinals + 1 final).
    const approve = await fixtureApprove(cookie, csrfToken, { total_slots: 9, start_date: '2099-01-05', interval_days: 7, time: '18:00', venue: 'Main Gym' });
    expect(approve.status).toBe(200);
    const regularEvents = approve.json.created.filter(e => !e.is_playoff);
    const playoffEvents = approve.json.created.filter(e => e.is_playoff);
    expect(regularEvents.length).toBe(6);
    expect(playoffEvents.length).toBe(3);

    const rankOrder = ['Rouge', 'Bleu', 'Vert', 'Jaune']; // best to worst
    for (const ev of regularEvents) {
      const homeBetter = rankOrder.indexOf(ev.home_team) < rankOrder.indexOf(ev.away_team);
      await submitScore(cookie, csrfToken, { event_id: ev.id, home_score: homeBetter ? 3 : 1, away_score: homeBetter ? 1 : 3 });
    }

    const rows = (await env.DB.prepare(
      `SELECT id, home_team, away_team, playoff_meta FROM events WHERE id IN (${playoffEvents.map(() => '?').join(',')})`
    ).bind(...playoffEvents.map(e => e.id)).all()).results;
    const withMeta = rows.map(r => ({ ...r, meta: JSON.parse(r.playoff_meta || 'null') || {} }));
    const semifinal1 = withMeta.find(r => r.meta.role === 'semifinal' && r.meta.matchupIndexInRound === 1);
    const semifinal2 = withMeta.find(r => r.meta.role === 'semifinal' && r.meta.matchupIndexInRound === 2);
    const final = withMeta.find(r => r.meta.role === 'final');
    return { cookie, csrfToken, league, semifinal1, semifinal2, final };
  }

  it('the first playoff round is seeded from final standings the moment the regular season completes (seed 1 vs seed 4, seed 2 vs seed 3)', async () => {
    const { semifinal1, semifinal2 } = await setUpFourTeamBracket('p5.seed1@example.com', '203.0.206.001');
    const sf1 = await env.DB.prepare('SELECT home_team, away_team FROM events WHERE id = ?').bind(semifinal1.id).first();
    const sf2 = await env.DB.prepare('SELECT home_team, away_team FROM events WHERE id = ?').bind(semifinal2.id).first();
    expect(sf1).toEqual({ home_team: 'Rouge', away_team: 'Jaune' }); // seed 1 vs seed 4
    expect(sf2).toEqual({ home_team: 'Bleu', away_team: 'Vert' }); // seed 2 vs seed 3
  });

  it("a decisive playoff result advances its winner into the next round's slot -- by the actual score, not seed ranking", async () => {
    const { cookie, csrfToken, semifinal1, semifinal2, final } = await setUpFourTeamBracket('p5.advance@example.com', '203.0.206.002');
    // Semifinal 1: the higher seed (Rouge) wins as expected.
    await submitScore(cookie, csrfToken, { event_id: semifinal1.id, home_score: 5, away_score: 2 });
    // Semifinal 2: an upset -- Vert (the away/lower seed) wins, proving
    // the resolver follows the real score, never the seed number.
    await submitScore(cookie, csrfToken, { event_id: semifinal2.id, home_score: 3, away_score: 4 });

    const finalRow = await env.DB.prepare('SELECT home_team, away_team FROM events WHERE id = ?').bind(final.id).first();
    expect(finalRow).toEqual({ home_team: 'Rouge', away_team: 'Vert' });
  });

  it('a tied playoff game has no tiebreak -- it stays unresolved (and says so on the page), while the OTHER, decided semifinal still advances normally', async () => {
    const { cookie, csrfToken, semifinal1, semifinal2, final } = await setUpFourTeamBracket('p5.tie@example.com', '203.0.206.003');
    await submitScore(cookie, csrfToken, { event_id: semifinal1.id, home_score: 3, away_score: 3 }); // tied -- no winner to advance
    await submitScore(cookie, csrfToken, { event_id: semifinal2.id, home_score: 4, away_score: 1 }); // Bleu (home) wins decisively

    const finalRow = await env.DB.prepare('SELECT home_team, away_team FROM events WHERE id = ?').bind(final.id).first();
    expect(finalRow.home_team).toBeNull(); // semifinal 1's tie left this slot genuinely unresolved
    expect(finalRow.away_team).toBe('Bleu'); // semifinal 2's real winner still advanced

    const html = await eventDetailHtml(cookie, final.id);
    expect(html).toContain('data-i18n="playoffAwaitingSeedingTitle"'); // still says so, rather than guessing
  });
});

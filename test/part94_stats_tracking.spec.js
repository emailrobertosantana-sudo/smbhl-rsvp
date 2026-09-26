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
import { deriveGoalieRecord } from '../src/leagues.js';
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

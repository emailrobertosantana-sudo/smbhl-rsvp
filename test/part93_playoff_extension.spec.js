// Playoff extension: extends the fixed-teams fixture generator
// (commit f52ca55) with playoffs. THE MODEL (task spec): a league has
// a FIXED NUMBER OF SLOTS (gym time already paid for) -- playoffs
// consume some of those slots, the regular season is whatever
// remains. Fixed-teams only -- meaningless for weekly_draw (teams
// aren't fixed) and headcount (no teams at all), so neither is ever
// offered any of this.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { computePlayoffSlots, buildEliminationBracket, buildPlayoffPlaceholders, playoffRoleLabel, resolvePlayoffByeSeeds } from '../src/leagues.js';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part93-playoff-extension-secret';

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
async function updatePlayoffs(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/settings/playoffs', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}
async function matchupsPreview(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/season/matchups-preview', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body || {})
  });
  return { status: res.status, json: await res.json() };
}
async function matchupsConfirm(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/season/matchups-confirm', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body || {})
  });
  return { status: res.status, json: await res.json() };
}
async function bulkCreateEvents(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events/bulk', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}
async function eventDetailHtml(cookie, eventId) {
  return (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } })).text();
}
async function scheduleHtml(cookie) {
  return (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
}
async function settingsHtml(cookie) {
  return (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
}
async function onboardingHtml(cookie, step) {
  return (await SELF.fetch(`http://example.com/onboarding/season?step=${step}`, { headers: { cookie } })).text();
}

describe('Playoff extension, Part 2: the slot arithmetic (computePlayoffSlots)', () => {
  it('single_elimination: N-1 games, no bye for even N, no third place below 4 teams', () => {
    expect(computePlayoffSlots({ format: 'single_elimination', numTeams: 2, thirdPlace: false }).playoffSlots).toBe(1);
    expect(computePlayoffSlots({ format: 'single_elimination', numTeams: 4, thirdPlace: false }).playoffSlots).toBe(3);
    expect(computePlayoffSlots({ format: 'single_elimination', numTeams: 8, thirdPlace: false }).playoffSlots).toBe(7);
  });

  // Schedule-generation redesign task (Group D): REVOKES this
  // function's own earlier "+1 flat bye slot" decision -- a bye is
  // never a real game and never reserves gym time or an event. hasBye
  // is still reported (a genuine fact -- which team sits out round 1),
  // just no longer added to playoffSlots.
  it('a bye never costs a slot: odd team counts (3, 5) still report hasBye=true, but no +1; even counts (2, 4, 8) get none either way', () => {
    const r2 = computePlayoffSlots({ format: 'single_elimination', numTeams: 2, thirdPlace: false });
    const r3 = computePlayoffSlots({ format: 'single_elimination', numTeams: 3, thirdPlace: false });
    const r4 = computePlayoffSlots({ format: 'single_elimination', numTeams: 4, thirdPlace: false });
    const r5 = computePlayoffSlots({ format: 'single_elimination', numTeams: 5, thirdPlace: false });
    const r8 = computePlayoffSlots({ format: 'single_elimination', numTeams: 8, thirdPlace: false });
    expect(r2.hasBye).toBe(false); expect(r2.playoffSlots).toBe(2 - 1);
    expect(r3.hasBye).toBe(true); expect(r3.playoffSlots).toBe(3 - 1); // no +1 anymore
    expect(r4.hasBye).toBe(false); expect(r4.playoffSlots).toBe(4 - 1);
    expect(r5.hasBye).toBe(true); expect(r5.playoffSlots).toBe(5 - 1); // no +1 anymore
    expect(r8.hasBye).toBe(false); expect(r8.playoffSlots).toBe(8 - 1);
  });

  it('third-place game: +1 slot, but only for >=4 teams -- structurally meaningless below that (no two real semifinal losers exist)', () => {
    expect(computePlayoffSlots({ format: 'single_elimination', numTeams: 2, thirdPlace: true }).playoffSlots).toBe(1); // unchanged -- guarded off
    expect(computePlayoffSlots({ format: 'single_elimination', numTeams: 3, thirdPlace: true }).playoffSlots).toBe(2); // unchanged -- guarded off, no bye slot either
    expect(computePlayoffSlots({ format: 'single_elimination', numTeams: 4, thirdPlace: true }).playoffSlots).toBe(4); // 3 + 1
    expect(computePlayoffSlots({ format: 'single_elimination', numTeams: 5, thirdPlace: true }).playoffSlots).toBe(5); // 4 + 1 (third place), no bye slot
    expect(computePlayoffSlots({ format: 'single_elimination', numTeams: 8, thirdPlace: true }).playoffSlots).toBe(8); // 7 + 1
  });

  it('best_of_n: multiplies real games (base + third place) by the series length -- a bye never costs a slot, so there is nothing flat left to keep un-multiplied', () => {
    // 4 teams, best of 3, no third place: (4-1)*3 = 9, no bye.
    expect(computePlayoffSlots({ format: 'best_of_n', numTeams: 4, thirdPlace: false, bestOf: 3 }).playoffSlots).toBe(9);
    // Same, with third place: (3+1)*3 = 12.
    expect(computePlayoffSlots({ format: 'best_of_n', numTeams: 4, thirdPlace: true, bestOf: 3 }).playoffSlots).toBe(12);
    // 5 teams (odd -- bye), best of 3, no third place: (5-1)*3 = 12, no bye slot.
    expect(computePlayoffSlots({ format: 'best_of_n', numTeams: 5, thirdPlace: false, bestOf: 3 }).playoffSlots).toBe(12);
    // Best-of-1 is identical to single_elimination.
    expect(computePlayoffSlots({ format: 'best_of_n', numTeams: 8, thirdPlace: false, bestOf: 1 }).playoffSlots)
      .toBe(computePlayoffSlots({ format: 'single_elimination', numTeams: 8, thirdPlace: false }).playoffSlots);
  });

  it('reserved_slots: the admin\'s own direct number, no bracket math at all', () => {
    expect(computePlayoffSlots({ format: 'reserved_slots', reservedSlots: 5 }).playoffSlots).toBe(5);
    expect(computePlayoffSlots({ format: 'reserved_slots', reservedSlots: 5 }).hasBye).toBe(false);
  });
});

describe('Playoff extension, Part 2/3: buildPlayoffPlaceholders matches computePlayoffSlots exactly, always', () => {
  function countPlaceholders(groups) { return groups.reduce((n, g) => n + g.length, 0); }

  for (const numTeams of [2, 3, 4, 5, 8]) {
    for (const thirdPlace of [false, true]) {
      it(`single_elimination, ${numTeams} teams, thirdPlace=${thirdPlace}: placeholder count matches the arithmetic`, () => {
        const expected = computePlayoffSlots({ format: 'single_elimination', numTeams, thirdPlace }).playoffSlots;
        const groups = buildPlayoffPlaceholders({ format: 'single_elimination', numTeams, thirdPlace });
        expect(countPlaceholders(groups)).toBe(expected);
      });
    }
  }

  it('best_of_n placeholder count matches the arithmetic too', () => {
    const expected = computePlayoffSlots({ format: 'best_of_n', numTeams: 5, thirdPlace: true, bestOf: 3 }).playoffSlots;
    const groups = buildPlayoffPlaceholders({ format: 'best_of_n', numTeams: 5, thirdPlace: true, bestOf: 3 });
    expect(countPlaceholders(groups)).toBe(expected);
  });

  it('reserved_slots creates exactly X placeholders, all role "reserved", no seeds', () => {
    const groups = buildPlayoffPlaceholders({ format: 'reserved_slots', reservedSlots: 4 });
    expect(groups.length).toBe(4);
    const flat = groups.flat();
    expect(flat.every(p => p.role === 'reserved' && p.seedA === null && p.seedB === null)).toBe(true);
  });

  it('4-team single-elimination uses standard crisscross seeding (1v4, 2v3), matching the task\'s own worked example', () => {
    const bracket = buildEliminationBracket(4);
    expect(bracket).toEqual([
      [{ seedA: 1, seedB: 4 }, { seedA: 2, seedB: 3 }],
      [{ seedA: 1, seedB: 2 }]
    ]);
  });

  it('playoffRoleLabel matches the task\'s own examples exactly, both languages, for a round-1 (real seed) matchup', () => {
    expect(playoffRoleLabel({ role: 'semifinal', matchupIndexInRound: 1, seedA: 1, seedB: 4, seriesLength: 1 }, 'en'))
      .toBe('Semi-final 1 -- seed 1 vs seed 4');
    expect(playoffRoleLabel({ role: 'semifinal', matchupIndexInRound: 1, seedA: 1, seedB: 4, seriesLength: 1 }, 'fr'))
      .toBe('Demi-finale 1 -- tête de série 1 contre tête de série 4');
    expect(playoffRoleLabel({ role: 'final', seriesLength: 1 }, 'en')).toBe('Final');
    expect(playoffRoleLabel({ role: 'final', seriesLength: 1 }, 'fr')).toBe('Finale');
    expect(playoffRoleLabel({ role: 'third_place', seriesLength: 1 }, 'en')).toBe('Third-place game');
    expect(playoffRoleLabel({ role: 'third_place', seriesLength: 1 }, 'fr')).toBe('Match pour la 3e place');
    expect(playoffRoleLabel({ role: 'reserved', matchupIndexInRound: 1, seriesLength: 1 }, 'en')).toBe('Playoff game 1');
  });

  // Schedule-generation redesign task (Group D): "seeds are only
  // meaningful in round one" -- a LATER round now reads "Winner <short
  // label>" for a side fed by an unresolved earlier matchup, instead
  // of the earlier (misleading) fake seed number. A side fed by a BYE
  // is still a real, already-known seed, rendered exactly like a
  // round-1 seed -- the two can even mix on the same matchup.
  it('playoffRoleLabel: a later round with two real feeder matchups reads "Winner SF1 vs Winner SF2", never a seed number', () => {
    expect(playoffRoleLabel({ role: 'final', feederA: { kind: 'matchup', role: 'semifinal', matchupIndexInRound: 1 }, feederB: { kind: 'matchup', role: 'semifinal', matchupIndexInRound: 2 }, seriesLength: 1 }, 'en'))
      .toBe('Final -- Winner SF1 vs Winner SF2');
    expect(playoffRoleLabel({ role: 'final', feederA: { kind: 'matchup', role: 'semifinal', matchupIndexInRound: 1 }, feederB: { kind: 'matchup', role: 'semifinal', matchupIndexInRound: 2 }, seriesLength: 1 }, 'fr'))
      .toBe('Finale -- Gagnant DF1 contre Gagnant DF2');
  });

  it('playoffRoleLabel: a later round can mix a real bye seed on one side with an unresolved matchup on the other', () => {
    expect(playoffRoleLabel({ role: 'semifinal', matchupIndexInRound: 1, feederA: { kind: 'bye', seed: 1 }, feederB: { kind: 'matchup', role: 'quarterfinal', matchupIndexInRound: 1 }, seriesLength: 1 }, 'en'))
      .toBe('Semi-final 1 -- seed 1 vs Winner QF1');
  });

  it('buildPlayoffPlaceholders: round 1 keeps real seedA/seedB; every later round gets feederA/feederB instead, never both', () => {
    const groups = buildPlayoffPlaceholders({ format: 'single_elimination', numTeams: 8, thirdPlace: false });
    const flat = groups.flat();
    const round1 = flat.filter(m => m.role === 'quarterfinal');
    const later = flat.filter(m => m.role === 'semifinal' || m.role === 'final');
    expect(round1.every(m => m.seedA && m.seedB && !m.feederA && !m.feederB)).toBe(true);
    expect(later.every(m => !m.seedA && !m.seedB && m.feederA && m.feederB)).toBe(true);
  });

  it('buildPlayoffPlaceholders no longer produces a bye placeholder at all -- resolvePlayoffByeSeeds reports it purely informationally instead', () => {
    const groups = buildPlayoffPlaceholders({ format: 'single_elimination', numTeams: 5, thirdPlace: false });
    expect(groups.flat().some(m => m.role === 'bye')).toBe(false);
    expect(resolvePlayoffByeSeeds(5).length).toBeGreaterThan(0);
    expect(resolvePlayoffByeSeeds(4)).toEqual([]); // even count -- no bye at all
  });

  it('buildPlayoffPlaceholders never puts more than one game on the same group -- no more staggering several simultaneous games onto one invented date', () => {
    const groups = buildPlayoffPlaceholders({ format: 'single_elimination', numTeams: 8, thirdPlace: false });
    expect(groups.every(g => g.length === 1)).toBe(true);
  });
});

describe('Playoff extension, Part 1: onboarding + Settings (fixed-teams only)', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a fixed-teams league gets the conditional "playoffs" step, right between "teams" and "reminders", and the flow total becomes 8', async () => {
    const { cookie, csrfToken } = await signup('p1.step@example.com', '203.0.201.001');
    await createLeague(cookie, csrfToken, { name: 'Step League', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const step3 = await onboardingHtml(cookie, 3);
    expect(step3).toContain('id="ob_playoffs_enabled"');
    expect(step3).toMatch(/aria-valuenow="6" aria-valuemax="8"|aria-valuemax="8" aria-valuenow="6"/);
  });

  it('weekly_draw and headcount onboarding never show a playoffs step -- their own flow totals (6) are unaffected', async () => {
    const { cookie: wdCookie, csrfToken: wdCsrf } = await signup('p1.wdstep@example.com', '203.0.201.002');
    await createLeague(wdCookie, wdCsrf, { name: 'WD Step League', teamStructure: 'weekly_draw', teamNames: ['A', 'B', 'C'], tracksStats: true });
    await publishSeason(wdCookie, wdCsrf, { season_name: 'S1' });
    for (let step = 1; step <= 4; step++) {
      const html = await onboardingHtml(wdCookie, step);
      expect(html).not.toContain('id="ob_playoffs_enabled"');
    }

    const { cookie: hcCookie, csrfToken: hcCsrf } = await signup('p1.hcstep@example.com', '203.0.201.003');
    await createLeague(hcCookie, hcCsrf, { name: 'HC Step League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12, tracksStats: true });
    await publishSeason(hcCookie, hcCsrf, { season_name: 'S1', min_players: 8, max_players: 12 });
    for (let step = 1; step <= 3; step++) {
      const html = await onboardingHtml(hcCookie, step);
      expect(html).not.toContain('id="ob_playoffs_enabled"');
    }
  });

  it('POST /league/settings/playoffs sets and later edits the league\'s own stored preferences', async () => {
    const { cookie, csrfToken } = await signup('p1.settings@example.com', '203.0.201.004');
    await createLeague(cookie, csrfToken, { name: 'Settings League', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const set = await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: true, playoff_format: 'single_elimination', playoff_teams: 4, playoff_third_place: true });
    expect(set.status).toBe(200);
    expect(set.json.settings.playoffsEnabled).toBe(true);

    const html = await settingsHtml(cookie);
    expect(html).toContain('id="se_playoffs_enabled"');
    expect(html).toContain('aria-checked="true"'); // playoffs_enabled reflected

    // Editable later -- change format entirely.
    const edit = await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: true, playoff_format: 'reserved_slots', playoff_reserved_slots: 4 });
    expect(edit.status).toBe(200);
    expect(edit.json.settings.format).toBe('reserved_slots');

    // "No" clears everything.
    const off = await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: false });
    expect(off.status).toBe(200);
    expect(off.json.settings.playoffsEnabled).toBe(false);
  });

  it('playoff_teams is capped at this league\'s own real team count, never more', async () => {
    const { cookie, csrfToken } = await signup('p1.cap@example.com', '203.0.201.005');
    await createLeague(cookie, csrfToken, { name: 'Cap League', teamNames: ['A', 'B', 'C'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const res = await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: true, playoff_format: 'single_elimination', playoff_teams: 4 });
    expect(res.status).toBe(400);
    expect(res.json.errorKey).toBe('INVALID_PLAYOFF_TEAMS');
  });

  it('rejects for weekly_draw and headcount leagues -- playoffs are fixed-teams only', async () => {
    const { cookie: wdCookie, csrfToken: wdCsrf } = await signup('p1.wdreject@example.com', '203.0.201.006');
    await createLeague(wdCookie, wdCsrf, { name: 'WD Reject League', teamStructure: 'weekly_draw', teamNames: ['A', 'B'], tracksStats: true });
    const wdRes = await updatePlayoffs(wdCookie, wdCsrf, { playoffs_enabled: true, playoff_format: 'single_elimination', playoff_teams: 2 });
    expect(wdRes.status).toBe(409);
    expect(wdRes.json.errorKey).toBe('PLAYOFFS_REQUIRE_FIXED_TEAMS');

    const { cookie: hcCookie, csrfToken: hcCsrf } = await signup('p1.hcreject@example.com', '203.0.201.007');
    await createLeague(hcCookie, hcCsrf, { name: 'HC Reject League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12, tracksStats: true });
    const hcRes = await updatePlayoffs(hcCookie, hcCsrf, { playoffs_enabled: true, playoff_format: 'reserved_slots', playoff_reserved_slots: 2 });
    expect(hcRes.status).toBe(409);
    expect(hcRes.json.errorKey).toBe('PLAYOFFS_REQUIRE_FIXED_TEAMS');
  });
});

// Schedule-generation redesign task (Group D): this generator is now
// PLAYOFF-ONLY (the regular season is assigned onto existing events
// instead -- see part92's own Part 3 describe block). No more
// total_slots/regular-season-budget arithmetic: the playoff game count
// comes entirely from the league's own stored preferences, and every
// game it creates is a playoff placeholder, never a regular-season one.
// Scheduling correction task (Part 1): ONE POOL OF SLOTS. Commit
// 4aebb53 split this into a separate, event-CREATING playoff
// generator -- wrong, per an over-broad instruction: playoffs don't
// get gym time out of nowhere, they use the same booked slots as
// everything else. Replaced by a single preview/confirm
// (/league/season/matchups-preview, matchups-confirm) that covers the
// regular season AND the playoffs together: playoff games take the
// LAST N chronological events (N from computePlayoffSlots), every
// earlier event is regular season. Never creates an event, for
// either half.
describe('Playoff extension, Part 2/3: one pool of slots, end to end', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  // THE WORKED EXAMPLE (task spec): 25 events, 4 teams, all 4 in the
  // playoffs, single elimination with a third-place game -> 4 playoff
  // slots (semifinal 1, semifinal 2, the final, the consolation), 21
  // regular-season slots -- a 4-team round robin is 6 games, so 21 is
  // 3 complete rounds plus a partial fourth of 3 games.
  it('the worked example: 25 slots, 4 teams, single-elimination + third place -> 4 playoff slots, 21 regular season, 3 full rounds plus a partial fourth', async () => {
    const { cookie, csrfToken } = await signup('p1.worked@example.com', '203.0.201.101');
    const league = await createLeague(cookie, csrfToken, { name: 'Worked Example League', teamNames: ['Rouge', 'Bleu', 'Vert', 'Jaune'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: true, playoff_format: 'single_elimination', playoff_teams: 4, playoff_third_place: true });
    const bulk = await bulkCreateEvents(cookie, csrfToken, { startDate: '2099-01-05', occurrences: 25, start_time: '10:30', end_time: '11:30' });
    expect(bulk.json.createdCount).toBe(25);

    const { status, json } = await matchupsPreview(cookie, csrfToken, {});
    expect(status).toBe(200);
    expect(json.arithmetic).toEqual({
      totalSlots: 25, playoffSlots: 4, regularSlots: 21, gamesPerCycle: 6,
      regularSeasonFullRounds: 3, regularSeasonPartialRoundGames: 3
    });
    expect(json.regularPlan.length).toBe(21);
    expect(json.playoffPlan.length).toBe(4);
    // The playoff games are the LAST 4 events chronologically.
    const allDates = [...json.regularPlan.map(p => p.date), ...json.playoffPlan.map(p => p.date)].sort();
    expect(json.playoffPlan.map(p => p.date)).toEqual(allDates.slice(-4));
    expect(json.regularPlan.every(p => allDates.slice(-4).indexOf(p.date) === -1)).toBe(true);
    // The specific 4 playoff slots: SF1, SF2, Final, consolation (third place).
    expect(json.playoffPlan.map(p => p.meta.role)).toEqual(['semifinal', 'semifinal', 'final', 'third_place']);
    expect(json.playoffPlan[0].meta.seedA).toBe(1); expect(json.playoffPlan[0].meta.seedB).toBe(4);
    expect(json.playoffPlan[1].meta.seedA).toBe(2); expect(json.playoffPlan[1].meta.seedB).toBe(3);

    const confirm = await matchupsConfirm(cookie, csrfToken, {});
    expect(confirm.status).toBe(200);
    expect(confirm.json.updatedCount).toBe(25);

    const regularRows = (await env.DB.prepare('SELECT id, home_team, away_team FROM events WHERE league_id = ? AND is_playoff = 0').bind(league.id).all()).results;
    const playoffRows = (await env.DB.prepare('SELECT id, is_playoff, home_team, away_team, playoff_meta FROM events WHERE league_id = ? AND is_playoff = 1 ORDER BY date').bind(league.id).all()).results;
    expect(regularRows.length).toBe(21);
    expect(regularRows.every(r => r.home_team && r.away_team)).toBe(true);
    expect(playoffRows.length).toBe(4);
    expect(playoffRows.every(r => r.home_team === null && r.away_team === null)).toBe(true); // seeded later, by resolvePlayoffSeeding
    expect(JSON.parse(playoffRows[0].playoff_meta).role).toBe('semifinal');

    // Never a single event created -- exactly the 25 that were there before.
    const total = await env.DB.prepare('SELECT COUNT(*) c FROM events WHERE league_id = ?').bind(league.id).first();
    expect(total.c).toBe(25);
  });

  it('playoffs disabled: every slot is regular season', async () => {
    const { cookie, csrfToken } = await signup('p1.nodisabled@example.com', '203.0.201.102');
    await createLeague(cookie, csrfToken, { name: 'No Playoffs League', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await bulkCreateEvents(cookie, csrfToken, { startDate: '2099-01-05', occurrences: 10 });

    const { json } = await matchupsPreview(cookie, csrfToken, {});
    expect(json.arithmetic.playoffSlots).toBe(0);
    expect(json.arithmetic.regularSlots).toBe(10);
    expect(json.regularPlan.length).toBe(10);
    expect(json.playoffPlan.length).toBe(0);
  });

  it('too few slots for the configured playoffs alone: refuses outright, explaining the shortfall -- never invents a slot for either half', async () => {
    const { cookie, csrfToken } = await signup('p1.tooshort@example.com', '203.0.201.103');
    const league = await createLeague(cookie, csrfToken, { name: 'Too Short League', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: true, playoff_format: 'single_elimination', playoff_teams: 4, playoff_third_place: true }); // needs 4 slots
    await bulkCreateEvents(cookie, csrfToken, { startDate: '2099-01-05', occurrences: 3 });

    const { status, json } = await matchupsPreview(cookie, csrfToken, {});
    expect(status).toBe(409);
    expect(json.errorKey).toBe('MATCHUPS_TOO_FEW_SLOTS');
    expect(json.playoffSlots).toBe(4);
    expect(json.totalSlots).toBe(3);

    const confirmRes = await matchupsConfirm(cookie, csrfToken, {});
    expect(confirmRes.status).toBe(409);
    expect(confirmRes.json.errorKey).toBe('MATCHUPS_TOO_FEW_SLOTS');
    const row = await env.DB.prepare('SELECT COUNT(*) c FROM events WHERE league_id = ? AND home_team IS NOT NULL').bind(league.id).first();
    expect(row.c).toBe(0); // nothing written on refusal
  });

  it('events added or deleted later: the split recalculates on the next preview rather than being stored as gospel', async () => {
    const { cookie, csrfToken } = await signup('p1.recalc@example.com', '203.0.201.104');
    const league = await createLeague(cookie, csrfToken, { name: 'Recalc League', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: true, playoff_format: 'single_elimination', playoff_teams: 4, playoff_third_place: false }); // 3 slots
    await bulkCreateEvents(cookie, csrfToken, { startDate: '2099-01-05', occurrences: 9 });
    await matchupsConfirm(cookie, csrfToken, {});
    let playoffCount = (await env.DB.prepare('SELECT COUNT(*) c FROM events WHERE league_id = ? AND is_playoff = 1').bind(league.id).first()).c;
    expect(playoffCount).toBe(3);

    // Book 3 more weeks of gym time -- playoffs should now push out to
    // the NEW last 3 events, not stay where they were.
    await bulkCreateEvents(cookie, csrfToken, { startDate: '2099-04-06', occurrences: 3 });
    const { json } = await matchupsPreview(cookie, csrfToken, {});
    expect(json.arithmetic.totalSlots).toBe(12);
    expect(json.arithmetic.playoffSlots).toBe(3);
    const lastThreeDates = json.playoffPlan.map(p => p.date);
    expect(lastThreeDates).toEqual(['2099-04-06', '2099-04-13', '2099-04-20']);

    await matchupsConfirm(cookie, csrfToken, {});
    playoffCount = (await env.DB.prepare('SELECT COUNT(*) c FROM events WHERE league_id = ? AND is_playoff = 1').bind(league.id).first()).c;
    expect(playoffCount).toBe(3); // still exactly 3 -- reclassified, not accumulated
  });

  it('a playoff placeholder\'s event detail page reads as "awaiting seeding", not a misconfigured regular-season game -- in both languages', async () => {
    const { cookie, csrfToken } = await signup('p3.placeholder@example.com', '203.0.201.105');
    await createLeague(cookie, csrfToken, { name: 'Placeholder League', teamNames: ['Rouge', 'Bleu', 'Vert', 'Jaune'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: true, playoff_format: 'single_elimination', playoff_teams: 4, playoff_third_place: false });
    await bulkCreateEvents(cookie, csrfToken, { startDate: '2099-01-05', occurrences: 9 }); // 6 regular + 3 playoff

    const confirm = await matchupsConfirm(cookie, csrfToken, {});
    expect(confirm.status).toBe(200);
    const playoffEvent = await env.DB.prepare('SELECT id FROM events WHERE league_id = ? AND is_playoff = 1 ORDER BY date LIMIT 1')
      .bind((await env.DB.prepare('SELECT id FROM leagues WHERE name = ?').bind('Placeholder League').first()).id).first();
    expect(playoffEvent).toBeTruthy();

    const html = await eventDetailHtml(cookie, playoffEvent.id);
    expect(html).toContain('data-i18n="playoffAwaitingSeedingTitle"');
    expect(html).not.toContain('data-i18n="noMatchupSetTitle"'); // the REGULAR-season message never shows for a playoff game
    expect((html.match(/class="[^"]*\bev-team\b[^"]*"/g) || []).length).toBe(0); // no team roster cards -- nothing to show yet

    const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/);
    const dict = JSON.parse(m[1]);
    expect(dict.en.playoffAwaitingSeedingTitle).toBe('Playoff game -- awaiting results');
    expect(dict.fr.playoffAwaitingSeedingTitle).toBe('Match de séries -- en attente des résultats');
  });

  it('the final\'s own placeholder reads "Winner SF1 vs Winner SF2" before either semifinal is decided', async () => {
    const { cookie, csrfToken } = await signup('p3.winnerlabel@example.com', '203.0.201.106');
    const league = await createLeague(cookie, csrfToken, { name: 'Winner Label League', teamNames: ['Rouge', 'Bleu', 'Vert', 'Jaune'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: true, playoff_format: 'single_elimination', playoff_teams: 4, playoff_third_place: false });
    await bulkCreateEvents(cookie, csrfToken, { startDate: '2099-01-05', occurrences: 9 });
    await matchupsConfirm(cookie, csrfToken, {});

    const rows = (await env.DB.prepare('SELECT id, playoff_meta FROM events WHERE league_id = ? AND is_playoff = 1').bind(league.id).all()).results;
    const finalRow = rows.find(r => (JSON.parse(r.playoff_meta || 'null') || {}).role === 'final');
    expect(finalRow).toBeTruthy();

    // The event-detail page's own playoff-role line is server-rendered
    // in whatever language resolveServerLang resolves (no client-side
    // FR/EN toggle for this specific line) -- French by default here,
    // matching this whole codebase's own FR-primary convention.
    const html = await eventDetailHtml(cookie, finalRow.id);
    expect(html).toContain('Gagnant DF1');
    expect(html).toContain('Gagnant DF2');
    expect(html).not.toMatch(/tête de série \d/); // never a stale seed number beyond round one
  });

  it('byes produce no event at all -- an odd team count\'s bye seeds are informational only', async () => {
    const { cookie, csrfToken } = await signup('p3.byenoevent@example.com', '203.0.201.107');
    await createLeague(cookie, csrfToken, { name: 'Bye No Event League', teamNames: ['A', 'B', 'C', 'D', 'E'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: true, playoff_format: 'single_elimination', playoff_teams: 5, playoff_third_place: false });
    await bulkCreateEvents(cookie, csrfToken, { startDate: '2099-01-05', occurrences: 14 }); // 10 regular (5 teams: 1 full cycle=10 games) + 4 playoff

    const { json } = await matchupsPreview(cookie, csrfToken, {});
    expect(json.arithmetic.playoffSlots).toBe(4); // 5-1, no bye slot
    expect(json.playoffPlan.length).toBe(4); // exactly the real games -- no extra slot for any bye
    expect(json.byeSeeds.length).toBe(3); // informational only
  });

  it('reserved-slot mode: exactly X slots are classified playoff, with null matchups, and no bye note at all (no bracket)', async () => {
    const { cookie, csrfToken } = await signup('p3.reserved@example.com', '203.0.201.108');
    const league = await createLeague(cookie, csrfToken, { name: 'Reserved League', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: true, playoff_format: 'reserved_slots', playoff_reserved_slots: 5 });
    await bulkCreateEvents(cookie, csrfToken, { startDate: '2099-01-05', occurrences: 11 }); // 6 regular + 5 reserved

    const preview = await matchupsPreview(cookie, csrfToken, {});
    expect(preview.json.byeSeeds).toEqual([]);
    const confirm = await matchupsConfirm(cookie, csrfToken, {});
    expect(confirm.status).toBe(200);

    const playoffRows = (await env.DB.prepare('SELECT home_team, away_team FROM events WHERE league_id = ? AND is_playoff = 1').bind(league.id).all()).results;
    expect(playoffRows.length).toBe(5);
    expect(playoffRows.every(r => r.home_team === null && r.away_team === null)).toBe(true);
    const total = await env.DB.prepare('SELECT COUNT(*) c FROM events WHERE league_id = ?').bind(league.id).first();
    expect(total.c).toBe(11); // never created -- same count as before
  });

  it('weekly_draw and headcount are offered no matchup-assignment action at all, playoffs configured or not', async () => {
    const { cookie: wdCookie, csrfToken: wdCsrf } = await signup('p3.wdnone@example.com', '203.0.201.109');
    await createLeague(wdCookie, wdCsrf, { name: 'WD None League', teamStructure: 'weekly_draw', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
    await publishSeason(wdCookie, wdCsrf, { season_name: 'S1' });
    expect(await scheduleHtml(wdCookie)).not.toContain('id="sc_matchups_panel"');
    const wdFixture = await matchupsPreview(wdCookie, wdCsrf, {});
    expect(wdFixture.status).toBe(409);
    expect(wdFixture.json.errorKey).toBe('FIXTURE_REQUIRES_FIXED_TEAMS');

    const { cookie: hcCookie, csrfToken: hcCsrf } = await signup('p3.hcnone@example.com', '203.0.201.110');
    await createLeague(hcCookie, hcCsrf, { name: 'HC None League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12, tracksStats: true });
    await publishSeason(hcCookie, hcCsrf, { season_name: 'S1', min_players: 8, max_players: 12 });
    expect(await scheduleHtml(hcCookie)).not.toContain('id="sc_matchups_panel"');
    const hcFixture = await matchupsPreview(hcCookie, hcCsrf, {});
    expect(hcFixture.status).toBe(409);
    expect(hcFixture.json.errorKey).toBe('FIXTURE_REQUIRES_FIXED_TEAMS');
  });
});

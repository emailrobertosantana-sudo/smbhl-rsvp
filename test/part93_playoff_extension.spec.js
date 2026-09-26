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
async function fixturePreview(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/season/fixture-preview', {
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
describe('Playoff extension, Part 2/3: the playoff generator, end to end', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the preview shows the real games and the bye seed (if any) BEFORE anything is generated, writing nothing to the database', async () => {
    const { cookie, csrfToken } = await signup('p2.split@example.com', '203.0.201.101');
    const league = await createLeague(cookie, csrfToken, { name: 'Split League', teamNames: ['Rouge', 'Bleu', 'Vert', 'Jaune', 'Noir'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: true, playoff_format: 'single_elimination', playoff_teams: 5, playoff_third_place: false });

    const { status, json } = await fixturePreview(cookie, csrfToken, { start_date: '2099-01-05', interval_days: 7, time: '18:00', venue: 'Main Gym' });
    expect(status).toBe(200);
    const totalGames = json.playoffs.reduce((n, r) => n + r.games.length, 0);
    expect(totalGames).toBe(4); // 5 teams: N-1 = 4 real games, no slot for any bye
    // 5 teams pads to an 8-slot bracket -- seeds 1/2/3 all skip round 1
    // (only the 4-vs-5 pairing is a real first-round game), so THREE
    // seeds carry a bye note here, none of them consuming a slot.
    expect(json.byeSeeds.length).toBe(3);
    // Every group is exactly one game -- never staggered onto a shared date.
    expect(json.playoffs.every(r => r.games.length === 1)).toBe(true);

    const row = await env.DB.prepare('SELECT COUNT(*) c FROM events WHERE league_id = ?').bind(league.id).first();
    expect(row.c).toBe(0);
  });

  it('rejects when playoffs are not turned on for this league', async () => {
    const { cookie, csrfToken } = await signup('p2.notconfigured@example.com', '203.0.201.102');
    await createLeague(cookie, csrfToken, { name: 'Not Configured League', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const { status, json } = await fixturePreview(cookie, csrfToken, { start_date: '2099-01-05' });
    expect(status).toBe(409);
    expect(json.errorKey).toBe('PLAYOFFS_NOT_CONFIGURED');
  });

  it('reserved-slot mode creates exactly X TBD events on approval, with null matchups, and no bye note at all (no bracket)', async () => {
    const { cookie, csrfToken } = await signup('p3.reserved@example.com', '203.0.201.103');
    const league = await createLeague(cookie, csrfToken, { name: 'Reserved League', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: true, playoff_format: 'reserved_slots', playoff_reserved_slots: 5 });

    const params = { start_date: '2099-01-05', interval_days: 7 };
    const preview = await fixturePreview(cookie, csrfToken, params);
    expect(preview.json.byeSeeds).toEqual([]);
    const approve = await fixtureApprove(cookie, csrfToken, params);
    expect(approve.status).toBe(200);

    const playoffEvents = approve.json.created.filter(e => e.is_playoff);
    expect(playoffEvents.length).toBe(5);
    expect(playoffEvents.every(e => e.home_team === null && e.away_team === null)).toBe(true);

    const row = await env.DB.prepare('SELECT COUNT(*) c FROM events WHERE league_id = ? AND is_playoff = 1').bind(league.id).first();
    expect(row.c).toBe(5);
    // Never a single regular-season event -- this route only ever
    // creates playoff placeholders now.
    const regularRow = await env.DB.prepare('SELECT COUNT(*) c FROM events WHERE league_id = ? AND is_playoff = 0').bind(league.id).first();
    expect(regularRow.c).toBe(0);
  });

  it('a playoff placeholder\'s event detail page reads as "awaiting seeding", not a misconfigured regular-season game -- in both languages', async () => {
    const { cookie, csrfToken } = await signup('p3.placeholder@example.com', '203.0.201.104');
    await createLeague(cookie, csrfToken, { name: 'Placeholder League', teamNames: ['Rouge', 'Bleu', 'Vert', 'Jaune'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: true, playoff_format: 'single_elimination', playoff_teams: 4, playoff_third_place: false });

    const approve = await fixtureApprove(cookie, csrfToken, { start_date: '2099-01-05', interval_days: 7, time: '18:00', venue: 'Main Gym' }); // 3 playoff games (SF1, SF2, Final)
    expect(approve.status).toBe(200);
    expect(approve.json.createdCount).toBe(3);
    const playoffEvent = approve.json.created.find(e => e.is_playoff);
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
    const { cookie, csrfToken } = await signup('p3.winnerlabel@example.com', '203.0.201.105');
    await createLeague(cookie, csrfToken, { name: 'Winner Label League', teamNames: ['Rouge', 'Bleu', 'Vert', 'Jaune'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await updatePlayoffs(cookie, csrfToken, { playoffs_enabled: true, playoff_format: 'single_elimination', playoff_teams: 4, playoff_third_place: false });

    const approve = await fixtureApprove(cookie, csrfToken, { start_date: '2099-01-05', interval_days: 7 });
    const rows = (await env.DB.prepare(
      `SELECT id, playoff_meta FROM events WHERE id IN (${approve.json.created.map(() => '?').join(',')})`
    ).bind(...approve.json.created.map(e => e.id)).all()).results;
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

  it('weekly_draw and headcount are offered no playoff generator at all, playoffs configured or not', async () => {
    const { cookie: wdCookie, csrfToken: wdCsrf } = await signup('p3.wdnone@example.com', '203.0.201.106');
    await createLeague(wdCookie, wdCsrf, { name: 'WD None League', teamStructure: 'weekly_draw', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
    await publishSeason(wdCookie, wdCsrf, { season_name: 'S1' });
    expect(await scheduleHtml(wdCookie)).not.toContain('id="sc_playoff_panel"');
    const wdFixture = await fixturePreview(wdCookie, wdCsrf, { start_date: '2099-01-05' });
    expect(wdFixture.status).toBe(409);
    expect(wdFixture.json.errorKey).toBe('FIXTURE_REQUIRES_FIXED_TEAMS');

    const { cookie: hcCookie, csrfToken: hcCsrf } = await signup('p3.hcnone@example.com', '203.0.201.107');
    await createLeague(hcCookie, hcCsrf, { name: 'HC None League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12, tracksStats: true });
    await publishSeason(hcCookie, hcCsrf, { season_name: 'S1', min_players: 8, max_players: 12 });
    expect(await scheduleHtml(hcCookie)).not.toContain('id="sc_playoff_panel"');
    const hcFixture = await fixturePreview(hcCookie, hcCsrf, { start_date: '2099-01-05' });
    expect(hcFixture.status).toBe(409);
    expect(hcFixture.json.errorKey).toBe('FIXTURE_REQUIRES_FIXED_TEAMS');
  });
});

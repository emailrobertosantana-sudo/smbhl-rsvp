// Matchups, night by night (leagues.js planNightAwareMatchups): whether
// anyone must play twice in a night is decided by the slot structure, and
// said; a team's two games are back to back; the distribution is reported;
// one matchup can be changed in place. SMBHL's round robin is untouched.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { classifyNight, planNightAwareMatchups, computeMatchupDistribution, groupNights } from '../src/leagues.js';
import { generateRoundRobinRounds } from '../src/season_config.js';
import { generateRoundRobinRounds as hubRounds } from '../src/season_hub.js';

// n weekly nights, each with the given slot times (same time = concurrent).
function nights(n, times) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const date = new Date(Date.UTC(2099, 0, 5 + 7 * k)).toISOString().slice(0, 10);
    times.forEach((t, i) => out.push({ id: `ev:${date}:${i}`, date, start_time: t }));
  }
  return out;
}
function run(teams, evs) {
  const { plan } = planNightAwareMatchups(evs, teams, 'fill_blanks');
  const byId = new Map(evs.map(e => [e.id, e]));
  const games = plan.map(p => ({ ...byId.get(p.eventId), home_team: p.home, away_team: p.away }));
  return { plan, games, dist: computeMatchupDistribution(games, teams) };
}
// For each night: each team's slot positions (by time group).
function perNight(games) {
  return groupNights(games).map(n => {
    const at = {};
    n.events.forEach((ev, i) => { for (const t of [ev.home_team, ev.away_team]) (at[t] = at[t] || []).push(n.groupOf[i]); });
    return at;
  });
}

describe('Which case a night is, from its slots and teams', () => {
  it('4 slots (2 concurrent pairs), 4 teams: UNAVOIDABLE; 3 teams: PARTLY; 2 slots, 3 teams: PARTLY; 2 slots, 4 or 5 teams: AVOIDABLE', () => {
    expect(classifyNight(4, 4).kind).toBe('unavoidable');
    expect(classifyNight(4, 3).kind).toBe('partly_avoidable');
    expect(classifyNight(2, 3).kind).toBe('partly_avoidable');
    expect(classifyNight(2, 4).kind).toBe('avoidable');
    expect(classifyNight(2, 5).kind).toBe('avoidable');
    expect(classifyNight(1, 4).kind).toBe('avoidable');
  });
});

describe('The three cases, scheduled', () => {
  it('4 slots in 2 concurrent pairs, 4 teams: concludes UNAVOIDABLE, everyone twice a night, back to back, never two at once, no warning', () => {
    const teams = ['Red', 'Blue', 'White', 'Black'];
    const { games, dist } = run(teams, nights(6, ['20:30', '20:30', '21:30', '21:30']));
    expect(dist.case).toBe('unavoidable');
    expect(dist.gamesPerTeamPerNight).toBe(2);
    expect(dist.warnings).toEqual([]);
    for (const at of perNight(games)) for (const t of teams) expect([...at[t]].sort()).toEqual([0, 1]);
    for (const r of dist.teams) expect(r.doubleNights).toBe(6);
    // Every pairing, evenly (24 games, 6 pairs).
    const pairs = {};
    for (const g of games) { const k = [g.home_team, g.away_team].sort().join('-'); pairs[k] = (pairs[k] || 0) + 1; }
    expect(Object.values(pairs).sort()).toEqual([4, 4, 4, 4, 4, 4]);
  });

  it('2 slots, 3 teams (the Oct 7 shape): concludes PARTLY; the team playing twice rotates evenly, its games back to back', () => {
    const teams = ['Red', 'White', 'Blue'];
    const { games, dist } = run(teams, nights(9, ['22:30', '23:30']));
    expect(dist.case).toBe('partly_avoidable');
    expect(dist.teams.map(r => r.doubleNights)).toEqual([3, 3, 3]);
    expect(dist.teams.map(r => r.games)).toEqual([12, 12, 12]); // 18 games, 36 places
    expect(dist.warnings).toEqual([]); // back to back: no wait
    for (const at of perNight(games)) {
      const doubles = teams.filter(t => (at[t] || []).length === 2);
      expect(doubles.length).toBe(1);
      expect(at[doubles[0]]).toEqual([0, 1]);
    }
  });

  it('4 slots, 3 teams: concludes PARTLY; who plays the extra game rotates evenly over the season', () => {
    const teams = ['Red', 'White', 'Blue'];
    const { games, dist } = run(teams, nights(9, ['19:00', '20:00', '21:00', '22:00']));
    expect(dist.case).toBe('partly_avoidable');
    const extra = Object.fromEntries(teams.map(t => [t, 0]));
    for (const at of perNight(games)) for (const t of teams) if ((at[t] || []).length === 3) extra[t]++;
    expect(Object.values(extra)).toEqual([6, 6, 6]); // 2 of 3 teams take a 3rd game each night: 18 turns, 6 each
    const counts = dist.teams.map(r => r.games);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('an avoidable structure (2 slots, 4 teams; 3 slots, 6 teams) schedules nobody twice in a night', () => {
    for (const [teams, times] of [[['A', 'B', 'C', 'D'], ['19:00', '20:00']], [['A', 'B', 'C', 'D', 'E', 'F'], ['19:00', '20:00', '21:00']]]) {
      const { games, dist } = run(teams, nights(8, times));
      expect(dist.case).toBe('avoidable');
      expect(dist.teams.every(r => r.doubleNights === 0)).toBe(true);
      for (const at of perNight(games)) for (const t of Object.keys(at)) expect(at[t].length).toBe(1);
    }
  });

  it('when a team must play twice, the two games are back to back (5 teams, 3 slots: one team twice, in consecutive slots)', () => {
    const teams = ['A', 'B', 'C', 'D', 'E'];
    const { games, dist } = run(teams, nights(10, ['19:00', '20:00', '21:00']));
    expect(dist.case).toBe('partly_avoidable');
    for (const at of perNight(games)) {
      const doubles = Object.keys(at).filter(t => at[t].length === 2);
      expect(doubles.length).toBe(1);
      const [a, b] = at[doubles[0]];
      expect(Math.abs(a - b)).toBe(1);
    }
    expect(dist.teams.map(r => r.doubleNights)).toEqual([2, 2, 2, 2, 2]);
  });

  it('fill_blanks keeps an assigned game and balances around it', () => {
    const teams = ['Red', 'White', 'Blue'];
    const evs = nights(3, ['22:30', '23:30']);
    evs[0].home_team = 'Red'; evs[0].away_team = 'White';
    const { plan } = planNightAwareMatchups(evs, teams, 'fill_blanks');
    expect(plan[0]).toMatchObject({ home: 'Red', away: 'White', alreadyAssigned: true, willWrite: false });
  });
});

describe('SMBHL is unaffected', () => {
  it('generateRoundRobinRounds (shared with SMBHL\'s season hub) returns exactly what it did', () => {
    const four = [[{ home: 'Red', away: 'Black' }, { home: 'Blue', away: 'White' }], [{ home: 'White', away: 'Red' }, { home: 'Blue', away: 'Black' }], [{ home: 'Red', away: 'Blue' }, { home: 'White', away: 'Black' }]];
    expect(generateRoundRobinRounds(['Red', 'Blue', 'White', 'Black'])).toEqual(four);
    expect(hubRounds).toBe(generateRoundRobinRounds);
    expect(generateRoundRobinRounds(['A', 'B', 'C'])).toEqual([[{ home: 'B', away: 'C' }], [{ home: 'C', away: 'A' }], [{ home: 'A', away: 'B' }]]);
  });
});

/* ---------- through the routes and the page ---------- */

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.145.${++ip}` },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = async (s, path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const page = async (s, path) => (await SELF.fetch('http://example.com' + path, { headers: { cookie: s.cookie } })).text();

beforeAll(async () => {
  env.AUTH_SECRET = 'p145-auth';
  await applyRealSchema(env);
});

describe('After generating: the distribution is reported, and one matchup is editable in place', () => {
  it('preview and confirm report the distribution; the Schedule page shows it; one game\'s matchup changes without regenerating', async () => {
    const s = await signup('p145.flow@example.com');
    const league = (await (await post(s, '/leagues/create', { name: 'P145 Flow', teamNames: ['Red', 'White', 'Blue'] })).json()).league;
    await post(s, '/league/season/publish', { season_name: 'S1' });
    await post(s, '/league/events/bulk', { startDate: '2099-10-07', occurrences: 3, start_time: '22:30', end_time: '23:30', venue: 'Letendre' });
    await post(s, '/league/events/bulk', { startDate: '2099-10-07', occurrences: 3, start_time: '23:30', end_time: '00:30', venue: 'Letendre' });
    const preview = await (await post(s, '/league/season/matchups-preview', {})).json();
    expect(preview.distribution.case).toBe('partly_avoidable');
    expect(preview.distribution.text.summary.fr).toBe("Avec 2 matchs par soir et 3 équipes, certaines équipes doivent jouer plus que les autres chaque soir : c'est réparti également sur la saison.");
    expect(preview.distribution.text.summary.en).toBe('With 2 games a night and 3 teams, some teams must play more than the others every night: this is shared evenly over the season.');
    expect(preview.distribution.teams.map(r => r.doubleNights)).toEqual([1, 1, 1]);
    const confirm = await (await post(s, '/league/season/matchups-confirm', {})).json();
    expect(confirm.distribution.case).toBe('partly_avoidable');

    let html = await page(s, '/league/schedule');
    expect(html).toContain('id="sc_distribution"');
    expect(html).toContain('data-case="partly_avoidable"');
    expect(html).toContain('<tr data-dist-team="Red"><td>Red</td><td class="tnum">4</td><td class="tnum">1</td></tr>');

    // One game, in place: its row has the editor; the others and the time stay as they were.
    const rows = (await env.DB.prepare('SELECT id, home_team, away_team, start_time, end_time, venue FROM events WHERE league_id = ? ORDER BY date, start_time').bind(league.id).all()).results;
    const target = rows[0];
    expect(html).toContain(`onclick="toggleMatchupEdit('${target.id}')"`);
    const other = rows.find(r => r.home_team !== target.home_team || r.away_team !== target.away_team);
    const newAway = ['Red', 'White', 'Blue'].find(t => t !== target.home_team && t !== target.away_team);
    const res = await (await post(s, '/league/events/matchup', { event_id: target.id, home_team: target.home_team, away_team: newAway })).json();
    expect(res.ok).toBe(true);
    const after = (await env.DB.prepare('SELECT id, home_team, away_team, start_time, end_time, venue FROM events WHERE league_id = ? ORDER BY date, start_time').bind(league.id).all()).results;
    expect(after[0]).toEqual({ ...target, away_team: newAway });
    expect(after.find(r => r.id === other.id)).toEqual(other);
    // The same team twice is refused, with a translated reason.
    const same = await (await post(s, '/league/events/matchup', { event_id: target.id, home_team: 'Red', away_team: 'Red' })).json();
    expect(same.errorKey).toBe('MATCHUP_TEAMS_SAME');
    // The page's distribution follows the hand edit.
    html = await page(s, '/league/schedule');
    expect(html).toContain('id="sc_distribution"');
  });

  it('4 slots in 2 concurrent pairs with 4 teams: the page says UNAVOIDABLE, nothing to balance', async () => {
    const s = await signup('p145.smbhlshape@example.com');
    await post(s, '/leagues/create', { name: 'P145 Four', teamNames: ['Red', 'Blue', 'White', 'Black'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    for (const [t, v] of [['20:30', 'Gym 1'], ['20:30', 'Gym 2'], ['21:30', 'Gym 1'], ['21:30', 'Gym 2']]) {
      await post(s, '/league/events/bulk', { startDate: '2099-10-04', occurrences: 3, start_time: t, venue: v });
    }
    await post(s, '/league/season/matchups-confirm', {});
    const html = await page(s, '/league/schedule');
    expect(html).toContain('data-case="unavoidable"');
    expect(html).toContain('data-date-en="With 4 games a night and 4 teams, every team plays 2 times every night: nothing to balance."');
    expect(html).not.toContain('class="sc-dist-warn"');
  });
});

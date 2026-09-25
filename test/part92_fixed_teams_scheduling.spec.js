// Fixed-teams investigation follow-up batch (Parts 1-3): fixed teams
// had barely been exercised end to end. This file locks Part 1's fix
// first -- src/index.js's handleLeagueEventDetailPage used to loop
// over EVERY team in a 'fixed' league for every event, as if all of
// them played that one game. Correct by coincidence for a 2-team
// league (both genuinely do play); wrong for any larger one (a
// 4-team league showed all 4 team cards -- rosters, shortage badges,
// invite buttons -- for a game only 2 of them are actually in).
// weekly_draw and headcount are unaffected: each of their own team
// cards already means something different (weekly_draw's is this
// week's real draw result; headcount's is the league's one implicit
// pool).
//
// There's no stored matchup yet at this point in the batch (Part 2
// adds ev.home_team/ev.away_team) -- until then, a >2-team fixed
// event's real matchup is unknown, so the page renders an explicit
// "no matchup set" state instead of guessing. Parts 2/3's own tests
// are appended to this same file as they land.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part92-fixed-teams-scheduling-secret';

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
async function createEvent(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).event;
}
async function createEventRaw(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}
async function updateEvent(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events/update', {
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
async function publicHtml(leagueId) {
  return (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(leagueId)}`)).text();
}

describe('Part 1 (fixed-teams investigation follow-up): the event page shows only the teams actually playing', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a 4-team fixed league: no team cards render for an event with no known matchup -- a "no matchup set" state instead, in both languages', async () => {
    const { cookie, csrfToken } = await signup('p1.fourteam@example.com', '203.0.197.001');
    await createLeague(cookie, csrfToken, { name: 'Four Team League', teamNames: ['Rouge', 'Bleu', 'Vert', 'Jaune'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-03-01', season: 'S1' });

    const html = await eventDetailHtml(cookie, ev.id);
    // None of the 4 team names render as a team-card heading.
    for (const team of ['Rouge', 'Bleu', 'Vert', 'Jaune']) {
      expect(html).not.toContain(`>${team}</h2>`);
    }
    expect(html).not.toContain('class="nl-badge nl-badge--short"');
    expect(html).not.toContain('class="nl-badge nl-badge--in">');
    expect((html.match(/class="ev-team"/g) || []).length).toBe(0);
    expect(html).toContain('data-i18n="noMatchupSetTitle">Aucun match déterminé<');
    expect(html).toContain('data-i18n="noMatchupSetDesc"');

    // Confirm the EN string exists in the page's own i18n dict (client
    // FR/EN toggle), not only the French server-rendered fallback.
    const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/);
    expect(m).toBeTruthy();
    const dict = JSON.parse(m[1]);
    expect(dict.en.noMatchupSetTitle).toBe('No matchup set');
    expect(dict.en.noMatchupSetDesc).toBe("This league has more than two teams -- who's playing needs to be known before rosters can be shown.");
  });

  it('a 2-team fixed league: both teams still render, completely unchanged -- no matchup data is needed when both teams always play', async () => {
    const { cookie, csrfToken } = await signup('p1.twoteam@example.com', '203.0.197.002');
    await createLeague(cookie, csrfToken, { name: 'Two Team League', teamNames: ['Rouge', 'Bleu'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-03-01', season: 'S1' });

    const html = await eventDetailHtml(cookie, ev.id);
    expect(html).toContain('>Rouge</h2>');
    expect(html).toContain('>Bleu</h2>');
    expect((html.match(/class="[^"]*\bev-team\b[^"]*"/g) || []).length).toBe(2);
    expect(html).not.toContain('data-i18n="noMatchupSetTitle"');
  });

  it('a 3-team fixed league also gets the "no matchup set" state (not just 4+)', async () => {
    const { cookie, csrfToken } = await signup('p1.threeteam@example.com', '203.0.197.003');
    await createLeague(cookie, csrfToken, { name: 'Three Team League', teamNames: ['A', 'B', 'C'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-03-01', season: 'S1' });

    const html = await eventDetailHtml(cookie, ev.id);
    expect((html.match(/class="[^"]*\bev-team\b[^"]*"/g) || []).length).toBe(0);
    expect(html).toContain('data-i18n="noMatchupSetTitle"');
  });

  it('a weekly_draw league with 4 teams is completely unaffected -- its own pool/draw cards render exactly as before', async () => {
    const { cookie, csrfToken } = await signup('p1.weeklydraw@example.com', '203.0.197.004');
    await createLeague(cookie, csrfToken, { name: 'Weekly Draw Four League', teamStructure: 'weekly_draw', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-03-01', season: 'S1' });

    const html = await eventDetailHtml(cookie, ev.id);
    expect(html).not.toContain('data-i18n="noMatchupSetTitle"');
    // Pre-draw pool card (Group A fix, this same page) still renders.
    expect(html).toContain('data-i18n="poolTitle"');
  });

  it('a headcount league is completely unaffected -- its own single pool card renders exactly as before', async () => {
    const { cookie, csrfToken } = await signup('p1.headcount@example.com', '203.0.197.005');
    await createLeague(cookie, csrfToken, { name: 'Headcount League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12, tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1', min_players: 8, max_players: 12 });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-03-01', season: 'S1' });

    const html = await eventDetailHtml(cookie, ev.id);
    expect(html).not.toContain('data-i18n="noMatchupSetTitle"');
    expect(html).toContain('data-i18n="poolTitle">Joueurs<');
  });
});

// Part 2 (fixed-teams scheduling task): events get a real matchup.
// migrate-045.sql adds events.home_team/away_team. "One event is one
// game between two teams" -- a league playing multiple games in the
// same timeslot creates SEPARATE events, distinguished by VENUE (or
// time), not folded into one event with two matchups. Home/away is
// stored but never LABELLED anywhere in the UI (decision: in a shared
// gym the distinction isn't meaningful) -- only "Team A vs Team B" is
// shown, in stored order.
describe('Part 2 (fixed-teams scheduling task): events get a real matchup', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('POST /league/events accepts home_team/away_team for a fixed league and the event page shows exactly those two teams', async () => {
    const { cookie, csrfToken } = await signup('p2.matchup@example.com', '203.0.198.001');
    await createLeague(cookie, csrfToken, { name: 'Matchup League', teamNames: ['Rouge', 'Bleu', 'Vert', 'Jaune'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-04-01', season: 'S1', home_team: 'Vert', away_team: 'Jaune' });
    expect(ev.home_team).toBe('Vert');
    expect(ev.away_team).toBe('Jaune');

    const html = await eventDetailHtml(cookie, ev.id);
    expect(html).toContain('>Vert</h2>');
    expect(html).toContain('>Jaune</h2>');
    expect(html).not.toContain('>Rouge</h2>');
    expect(html).not.toContain('>Bleu</h2>');
    expect(html).not.toContain('data-i18n="noMatchupSetTitle"');
    expect((html.match(/class="[^"]*\bev-team\b[^"]*"/g) || []).length).toBe(2);
  });

  it('rejects home_team === away_team, and rejects a team name not in this season', async () => {
    const { cookie, csrfToken } = await signup('p2.badmatchup@example.com', '203.0.198.002');
    await createLeague(cookie, csrfToken, { name: 'Bad Matchup League', teamNames: ['Rouge', 'Bleu', 'Vert'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const same = await createEventRaw(cookie, csrfToken, { date: '2099-04-01', season: 'S1', home_team: 'Rouge', away_team: 'Rouge' });
    expect(same.status).toBe(400);
    expect(same.json.errorKey).toBe('MATCHUP_TEAMS_SAME');

    const unknown = await createEventRaw(cookie, csrfToken, { date: '2099-04-02', season: 'S1', home_team: 'Rouge', away_team: 'Not A Real Team' });
    expect(unknown.status).toBe(400);
    expect(unknown.json.errorKey).toBe('MATCHUP_TEAM_UNKNOWN');

    const onlyOne = await createEventRaw(cookie, csrfToken, { date: '2099-04-03', season: 'S1', home_team: 'Rouge' });
    expect(onlyOne.status).toBe(400);
    expect(onlyOne.json.errorKey).toBe('MATCHUP_TEAMS_REQUIRED');
  });

  it('weekly_draw and headcount leagues are completely unaffected -- home_team/away_team in the request body is silently ignored, never stored', async () => {
    const { cookie: wdCookie, csrfToken: wdCsrf } = await signup('p2.weeklydraw@example.com', '203.0.198.003');
    await createLeague(wdCookie, wdCsrf, { name: 'WD Matchup Ignore League', teamStructure: 'weekly_draw', teamNames: ['A', 'B', 'C'], tracksStats: true });
    await publishSeason(wdCookie, wdCsrf, { season_name: 'S1' });
    const wdEv = await createEvent(wdCookie, wdCsrf, { date: '2099-04-01', season: 'S1', home_team: 'A', away_team: 'B' });
    expect(wdEv.home_team).toBeNull();
    expect(wdEv.away_team).toBeNull();

    const { cookie: hcCookie, csrfToken: hcCsrf } = await signup('p2.headcount@example.com', '203.0.198.004');
    await createLeague(hcCookie, hcCsrf, { name: 'HC Matchup Ignore League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12, tracksStats: true });
    await publishSeason(hcCookie, hcCsrf, { season_name: 'S1', min_players: 8, max_players: 12 });
    const hcEv = await createEvent(hcCookie, hcCsrf, { date: '2099-04-01', season: 'S1', home_team: 'Tous', away_team: 'Nope' });
    expect(hcEv.home_team).toBeNull();
    expect(hcEv.away_team).toBeNull();
  });

  it('POST /league/events/update can set a matchup on an event created without one, and later clear it', async () => {
    const { cookie, csrfToken } = await signup('p2.setlater@example.com', '203.0.198.005');
    await createLeague(cookie, csrfToken, { name: 'Set Later League', teamNames: ['Rouge', 'Bleu', 'Vert'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-04-01', season: 'S1' });

    let html = await eventDetailHtml(cookie, ev.id);
    expect(html).toContain('data-i18n="noMatchupSetTitle"');

    const set = await updateEvent(cookie, csrfToken, { event_id: ev.id, home_team: 'Rouge', away_team: 'Bleu' });
    expect(set.status).toBe(200);
    expect(set.json.event.home_team).toBe('Rouge');
    expect(set.json.event.away_team).toBe('Bleu');

    html = await eventDetailHtml(cookie, ev.id);
    expect(html).not.toContain('data-i18n="noMatchupSetTitle"');
    expect(html).toContain('>Rouge</h2>');
    expect(html).toContain('>Bleu</h2>');

    const cleared = await updateEvent(cookie, csrfToken, { event_id: ev.id, home_team: '', away_team: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.json.event.home_team).toBeNull();
    html = await eventDetailHtml(cookie, ev.id);
    expect(html).toContain('data-i18n="noMatchupSetTitle"');
  });

  it('omitting home_team/away_team entirely on an update leaves an existing matchup untouched (partial-update semantics, same as every other field on this route)', async () => {
    const { cookie, csrfToken } = await signup('p2.partialupdate@example.com', '203.0.198.006');
    await createLeague(cookie, csrfToken, { name: 'Partial Update League', teamNames: ['Rouge', 'Bleu', 'Vert'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await createEvent(cookie, csrfToken, { date: '2099-04-01', season: 'S1', home_team: 'Rouge', away_team: 'Bleu' });

    const res = await updateEvent(cookie, csrfToken, { event_id: ev.id, venue: 'New Venue' });
    expect(res.status).toBe(200);
    expect(res.json.event.home_team).toBe('Rouge');
    expect(res.json.event.away_team).toBe('Bleu');
  });

  describe('two events sharing a date and time, differing only by venue', () => {
    async function setUpTwoSimultaneousEvents() {
      const { cookie, csrfToken } = await signup(`p2.simul.${Math.random()}@example.com`, `203.0.198.${Math.floor(Math.random() * 900 + 10)}`);
      const league = await createLeague(cookie, csrfToken, { name: `Simul League ${Math.random()}`, teamNames: ['Rouge', 'Bleu', 'Vert', 'Jaune'], tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });
      const gym1 = await createEvent(cookie, csrfToken, { date: '2099-05-10', start_time: '10:30', season: 'S1', venue: 'Letendre Gym 1', home_team: 'Rouge', away_team: 'Bleu' });
      const gym2 = await createEvent(cookie, csrfToken, { date: '2099-05-10', start_time: '10:30', season: 'S1', venue: 'Letendre Gym 2', home_team: 'Vert', away_team: 'Jaune' });
      return { cookie, csrfToken, league, gym1, gym2 };
    }

    it('both events are created successfully with distinct ids, same date and time, different venue', async () => {
      const { gym1, gym2 } = await setUpTwoSimultaneousEvents();
      expect(gym1.id).not.toBe(gym2.id);
      expect(gym1.date).toBe(gym2.date);
      expect(gym1.start_time).toBe(gym2.start_time);
      expect(gym1.venue).toBe('Letendre Gym 1');
      expect(gym2.venue).toBe('Letendre Gym 2');
    });

    it('the event detail page for EACH event shows only its own matchup, not the other event\'s teams', async () => {
      const { cookie, gym1, gym2 } = await setUpTwoSimultaneousEvents();
      const html1 = await eventDetailHtml(cookie, gym1.id);
      expect(html1).toContain('>Rouge</h2>');
      expect(html1).toContain('>Bleu</h2>');
      expect(html1).not.toContain('>Vert</h2>');
      expect(html1).not.toContain('>Jaune</h2>');

      const html2 = await eventDetailHtml(cookie, gym2.id);
      expect(html2).toContain('>Vert</h2>');
      expect(html2).toContain('>Jaune</h2>');
      expect(html2).not.toContain('>Rouge</h2>');
      expect(html2).not.toContain('>Bleu</h2>');
    });

    it('the schedule page lists both events, each with its own venue and matchup', async () => {
      const { cookie, gym1, gym2 } = await setUpTwoSimultaneousEvents();
      const html = await scheduleHtml(cookie);
      expect(html).toContain('Letendre Gym 1');
      expect(html).toContain('Letendre Gym 2');
      expect(html).toContain('Rouge');
      expect(html).toContain('Bleu');
      expect(html).toContain('Vert');
      expect(html).toContain('Jaune');
      expect(html).toContain(`e=${encodeURIComponent(gym1.id)}`);
      expect(html).toContain(`e=${encodeURIComponent(gym2.id)}`);
    });

    it('the public page lists both events (regression: the hero and headcount/weekly_draw lookups used to recompute an event id from its date alone, which is no longer safe once two events can share a date)', async () => {
      const { league, gym1, gym2 } = await setUpTwoSimultaneousEvents();
      const html = await publicHtml(league.id);
      expect(html).toContain('Letendre Gym 1');
      expect(html).toContain('Letendre Gym 2');
      // Whichever of the two the hero picked as "next game", it must be
      // a REAL, fetchable event -- confirms the id wasn't corrupted by
      // a date-only recompute (would 404 or silently show event data
      // that belongs to a different row than its own venue/matchup).
      expect(html).not.toContain('undefined');
    });

    it('RSVPs set on one event never affect the other, even though they share a date and time', async () => {
      const { cookie, csrfToken, gym1, gym2 } = await setUpTwoSimultaneousEvents();
      const contact = await (await SELF.fetch('http://example.com/league/contacts', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Simul Player', role: 'roster' })
      })).json().then(r => r.contact);

      const rsvpRes = await SELF.fetch('http://example.com/league/rsvp/admin', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: gym1.id, player_id: contact.player_id, status: 'in' })
      });
      expect(rsvpRes.status).toBe(200);

      const gym1Row = await env.DB.prepare('SELECT status FROM rsvp WHERE event_id = ? AND player_id = ?').bind(gym1.id, contact.player_id).first();
      expect(gym1Row.status).toBe('in');
      const gym2Row = await env.DB.prepare('SELECT status FROM rsvp WHERE event_id = ? AND player_id = ?').bind(gym2.id, contact.player_id).first();
      expect(gym2Row).toBeNull();
    });

    it('the dashboard "Cette semaine" card shows BOTH events when they share the nearest upcoming date, not just one', async () => {
      const { cookie } = await setUpTwoSimultaneousEvents();
      const html = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
      expect(html).toContain('Letendre Gym 1');
      expect(html).toContain('Letendre Gym 2');
    });
  });

  it('the schedule page\'s create-event form offers a matchup picker for a >2-team fixed league, and omits it for a 2-team fixed league, weekly_draw, and headcount', async () => {
    const { cookie: c1, csrfToken: t1 } = await signup('p2.picker.four@example.com', '203.0.198.101');
    await createLeague(c1, t1, { name: 'Picker Four League', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
    await publishSeason(c1, t1, { season_name: 'S1' });
    expect(await scheduleHtml(c1)).toContain('id="e_home_team"');

    const { cookie: c2, csrfToken: t2 } = await signup('p2.picker.two@example.com', '203.0.198.102');
    await createLeague(c2, t2, { name: 'Picker Two League', teamNames: ['A', 'B'], tracksStats: true });
    await publishSeason(c2, t2, { season_name: 'S1' });
    expect(await scheduleHtml(c2)).not.toContain('id="e_home_team"');

    const { cookie: c3, csrfToken: t3 } = await signup('p2.picker.wd@example.com', '203.0.198.103');
    await createLeague(c3, t3, { name: 'Picker WD League', teamStructure: 'weekly_draw', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
    await publishSeason(c3, t3, { season_name: 'S1' });
    expect(await scheduleHtml(c3)).not.toContain('id="e_home_team"');
  });
});

// Part 3 (fixed-teams scheduling task): the fixture generator.
// Reuses generateRoundRobinRounds (season_config.js, shared verbatim
// with SMBHL's own season_hub.js -- see season_hub.spec.js for proof
// SMBHL's own output is byte-identical after the extraction). A
// PROPOSAL the admin reviews and approves, never writing events
// directly -- preview computes it without touching the DB; approve
// regenerates the exact same proposal server-side (never trusting a
// client-supplied fixture list) and creates real events through the
// same createLeagueEventRow every other event-creation route uses.
describe('Part 3 (fixed-teams scheduling task): the fixture generator', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

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
  // THE MODEL: total_slots is a GAME count (gym time already paid
  // for), not a date/round count -- one full round-robin cycle for N
  // teams is always N*(N-1)/2 games (everyone plays everyone once),
  // regardless of how those games are spread across dates.
  function fullCycleGames(numTeams) { return numTeams * (numTeams - 1) / 2; }
  function allTeamsAppearBalanced(rounds, teams) {
    const gamesPerTeam = Object.fromEntries(teams.map(t => [t, 0]));
    for (const round of rounds) {
      const playing = new Set();
      for (const g of round.games) {
        // No team plays itself, and no team plays twice in the same round.
        expect(g.home).not.toBe(g.away);
        expect(playing.has(g.home)).toBe(false);
        expect(playing.has(g.away)).toBe(false);
        playing.add(g.home); playing.add(g.away);
        gamesPerTeam[g.home]++; gamesPerTeam[g.away]++;
      }
    }
    return gamesPerTeam;
  }

  for (const teams of [
    ['Rouge', 'Bleu', 'Vert'],
    ['Rouge', 'Bleu', 'Vert', 'Jaune'],
    ['Rouge', 'Bleu', 'Vert', 'Jaune', 'Noir']
  ]) {
    it(`produces a valid balanced round robin for ${teams.length} teams`, async () => {
      const { cookie, csrfToken } = await signup(`p3.rr${teams.length}@example.com`, `203.0.199.${teams.length}0`);
      await createLeague(cookie, csrfToken, { name: `RR ${teams.length} League`, teamNames: teams, tracksStats: true });
      await publishSeason(cookie, csrfToken, { season_name: 'S1' });

      const totalSlots = fullCycleGames(teams.length);
      const { status, json } = await fixturePreview(cookie, csrfToken, {
        total_slots: totalSlots, start_date: '2099-09-06', interval_days: 7, time: '18:00', venue: 'Main Gym'
      });
      expect(status).toBe(200);
      expect(json.arithmetic.regularSeasonSlots).toBe(totalSlots);
      expect(json.arithmetic.regularSeasonSlotsUsed).toBe(totalSlots); // no playoffs configured -- no leftover
      expect(json.playoffs).toEqual([]);
      const gamesPerTeam = allTeamsAppearBalanced(json.regularSeason, teams);
      // A full single round-robin cycle: every team plays every other
      // team exactly once, so each plays (n-1) games total.
      for (const t of teams) expect(gamesPerTeam[t]).toBe(teams.length - 1);
    });
  }

  it('preview writes nothing to the database', async () => {
    const { cookie, csrfToken } = await signup('p3.nowrite@example.com', '203.0.199.101');
    const league = await createLeague(cookie, csrfToken, { name: 'No Write League', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const { status, json } = await fixturePreview(cookie, csrfToken, { total_slots: 3, start_date: '2099-09-06', time: '18:00', venue: 'Gym' });
    expect(status).toBe(200);
    const gameCount = json.regularSeason.reduce((n, r) => n + r.games.length, 0);
    expect(gameCount).toBe(3);

    const row = await env.DB.prepare('SELECT COUNT(*) c FROM events WHERE league_id = ?').bind(league.id).first();
    expect(row.c).toBe(0);
  });

  it('approve creates real events with matchups matching the preview exactly, and the schedule page shows them', async () => {
    const { cookie, csrfToken } = await signup('p3.approve@example.com', '203.0.199.102');
    const league = await createLeague(cookie, csrfToken, { name: 'Approve League', teamNames: ['Rouge', 'Bleu', 'Vert', 'Jaune'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const params = { total_slots: 6, start_date: '2099-09-06', interval_days: 7, time: '18:00', venue: 'Main Gym' };
    const preview = await fixturePreview(cookie, csrfToken, params);
    const approve = await fixtureApprove(cookie, csrfToken, params);
    expect(approve.status).toBe(200);

    const expectedGameCount = preview.json.regularSeason.reduce((n, r) => n + r.games.length, 0);
    expect(approve.json.createdCount).toBe(expectedGameCount);
    expect(approve.json.skippedCount).toBe(0);

    const row = await env.DB.prepare('SELECT COUNT(*) c FROM events WHERE league_id = ?').bind(league.id).first();
    expect(row.c).toBe(expectedGameCount);

    // Round 2 (index 1) has 2 simultaneous games (4-team round robin) --
    // staggered by 1 hour at the same venue, per this task's own
    // decision, rather than colliding.
    const round2 = preview.json.regularSeason[1];
    expect(round2.games.length).toBe(2);
    expect(round2.games[0].start_time).toBe('18:00');
    expect(round2.games[1].start_time).toBe('19:00');
    expect(round2.games[0].date).toBe(round2.games[1].date);
    expect(round2.games[0].venue).toBe(round2.games[1].venue);

    const html = await scheduleHtml(cookie);
    for (const t of ['Rouge', 'Bleu', 'Vert', 'Jaune']) expect(html).toContain(t);
  });

  it('rejects for weekly_draw and headcount leagues -- only offered for fixed teams', async () => {
    const { cookie: wdCookie, csrfToken: wdCsrf } = await signup('p3.wdreject@example.com', '203.0.199.103');
    await createLeague(wdCookie, wdCsrf, { name: 'WD Reject League', teamStructure: 'weekly_draw', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
    await publishSeason(wdCookie, wdCsrf, { season_name: 'S1' });
    const wdRes = await fixturePreview(wdCookie, wdCsrf, { rounds: 2, start_date: '2099-09-06' });
    expect(wdRes.status).toBe(409);
    expect(wdRes.json.errorKey).toBe('FIXTURE_REQUIRES_FIXED_TEAMS');

    const { cookie: hcCookie, csrfToken: hcCsrf } = await signup('p3.hcreject@example.com', '203.0.199.104');
    await createLeague(hcCookie, hcCsrf, { name: 'HC Reject League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 12, tracksStats: true });
    await publishSeason(hcCookie, hcCsrf, { season_name: 'S1', min_players: 8, max_players: 12 });
    const hcRes = await fixturePreview(hcCookie, hcCsrf, { rounds: 2, start_date: '2099-09-06' });
    expect(hcRes.status).toBe(409);
    expect(hcRes.json.errorKey).toBe('FIXTURE_REQUIRES_FIXED_TEAMS');
  });

  it('rejects when no season has been published yet', async () => {
    const { cookie, csrfToken } = await signup('p3.noseason@example.com', '203.0.199.105');
    await createLeague(cookie, csrfToken, { name: 'No Season League', teamNames: ['A', 'B', 'C', 'D'], tracksStats: true });
    const res = await fixturePreview(cookie, csrfToken, { rounds: 2, start_date: '2099-09-06' });
    expect(res.status).toBe(409);
    expect(res.json.errorKey).toBe('SEASON_REQUIRED');
  });

  it('this route cannot be used against SMBHL', async () => {
    const { cookie, csrfToken } = await signup('p3.smbhlblocked@example.com', '203.0.199.106');
    const res = await fixturePreview(cookie, csrfToken, { rounds: 2, start_date: '2099-09-06' });
    expect(res.status).toBe(404);
    expect(res.json.errorKey).toBe('NO_LEAGUE_FOUND');
  });

  it('SMBHL\'s own round-robin generation is byte-identical after the extraction into season_config.js', async () => {
    const { generateRoundRobinRounds: fromSeasonConfig } = await import('../src/season_config.js');
    const { generateRoundRobinRounds: fromSeasonHub } = await import('../src/season_hub.js');
    expect(fromSeasonHub).toBe(fromSeasonConfig); // literally the same function reference, not just equal output
    const teams = ['Red', 'Blue', 'White', 'Black'];
    expect(fromSeasonHub(teams)).toEqual(fromSeasonConfig(teams));
  });

  it('the schedule page offers the generator panel for a fixed league with >=2 teams, and omits it for weekly_draw/headcount', async () => {
    const { cookie: c1, csrfToken: t1 } = await signup('p3.uifixed@example.com', '203.0.199.201');
    await createLeague(c1, t1, { name: 'UI Fixed League', teamNames: ['A', 'B'], tracksStats: true });
    await publishSeason(c1, t1, { season_name: 'S1' });
    const html1 = await scheduleHtml(c1);
    expect(html1).toContain('id="sc_fixture_panel"');
    expect(html1).toContain('id="fx_total_slots"');
    expect(html1).toContain('data-i18n="fixtureGenBtn"');

    const { cookie: c2, csrfToken: t2 } = await signup('p3.uiwd@example.com', '203.0.199.202');
    await createLeague(c2, t2, { name: 'UI WD League', teamStructure: 'weekly_draw', teamNames: ['A', 'B', 'C'], tracksStats: true });
    await publishSeason(c2, t2, { season_name: 'S1' });
    expect(await scheduleHtml(c2)).not.toContain('id="sc_fixture_panel"');
  });
});

// Part 4 (fixed-teams investigation follow-up batch): small unrelated
// fixes, done last per the task's own explicit ordering.
describe('Part 4: small fixes', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });
  async function dashboardHtml(cookie) {
    return (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
  }

  it('4a: the "Start a new season" description is a complete sentence with the season name at the front, in both languages', async () => {
    const { cookie, csrfToken } = await signup('p4a.sentence@example.com', '203.0.200.001');
    await createLeague(cookie, csrfToken, { name: '4a League', teamNames: ['A', 'B'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'Winter 2026' });

    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toContain('data-date-fr="Winter 2026 fermera et deviendra une saison consultable en lecture seule."');
    expect(html).toContain('data-date-en="Winter 2026 will close and become a read-only, viewable season."');
    // Server-rendered fallback (French by default) also has the real
    // subject at the front, not a bare fragment.
    expect(html).toContain('>Winter 2026 fermera et deviendra une saison consultable en lecture seule.<');
    expect(html).not.toContain('data-i18n="newSeasonDesc"'); // the old, broken static-dict key is gone
  });

  it('4b: "Start a new season" is reachable from the dashboard header, always visible, as a plain link (not a button)', async () => {
    const { cookie, csrfToken } = await signup('p4b.dashlink@example.com', '203.0.200.002');
    await createLeague(cookie, csrfToken, { name: '4b League', teamNames: ['A', 'B'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const html = await dashboardHtml(cookie);
    expect(html).toContain('href="/league/settings#section-new-season" data-i18n="startNewSeasonLink"');
    // A plain <a> link, not a <button> -- same element family as the
    // pre-existing "Edit" link right beside it.
    expect(html).toMatch(/<a href="\/league\/settings#section-new-season"[^>]*>[^<]*<\/a>/);
  });

  it('4c: no French-style space before the colon in English -- "Current season:" and "Tracks stats:" both correctly punctuated per language', async () => {
    const { cookie, csrfToken } = await signup('p4c.colonspacing@example.com', '203.0.200.003');
    await createLeague(cookie, csrfToken, { name: '4c League', teamNames: ['A', 'B'], tracksStats: true });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });

    const dashHtml = await dashboardHtml(cookie);
    const m = dashHtml.match(/var __I18N = (\{[\s\S]*?\});\n/);
    expect(m).toBeTruthy();
    const dashDict = JSON.parse(m[1]);
    expect(dashDict.fr.currentSeasonLabel).toBe('Saison actuelle :'); // French: space before colon
    expect(dashDict.en.currentSeasonLabel).toBe('Current season:'); // English: no space before colon
    // The server-rendered (French-default) page never shows the
    // English no-space form on its own text either.
    expect(dashHtml).not.toContain('Saison actuelle: '); // no-space variant never leaks into French

    // tracksStatsLabel is this same dashboard page's own dict (not Settings').
    expect(dashDict.fr.tracksStatsLabel).toBe('Statistiques suivies :');
    expect(dashDict.en.tracksStatsLabel).toBe('Tracks stats:');
  });
});

// Dual-role players: "Les deux" (item 6). A player (is_goalie 0) who can
// also play goalie (is_backup_goalie 1). Each rule, for SMBHL and for a
// Notre Ligue league:
//  6b  own team's goalie out: the dual-role regular is in goal (the skater
//      count drops by one) and is emailed, whether they said yes before or
//      after the goalie dropped out;
//  6e  the goalie says yes again: the goalie takes the net back, the
//      dual-role player is a skater again, both are emailed; a goalie sub
//      who accepted first keeps the net; a dual-role player in goal first
//      stops the open goalie calls;
//  6c  another team is short a goalie: one alert to the admin, at 48 hours
//      once every goalie sub was called, or earlier once every goalie sub
//      said no; never once the spot is filled; the game page can ask the
//      player or put them in goal;
//  6d  a dual-role sub is in the goalie wave (also when already called as a
//      skater) and, playing as a skater, takes a goalie spot by accepting:
//      they move, and a skater call opens for the spot they leave.
// A league with no dual-role player: nothing runs.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { dualGoalieChecks, dualGoalieAction, acceptAvailability, callSubs, teamState, dualRoleLines } from '../src/index.js';
import { formatEventDate } from '../src/date_format.js';
import { createSessionCookie } from '../src/auth.js';
import { getSeasonConfigForEvent } from '../src/season_config.js';
import { getLeagueSeasonConfig } from '../src/leagues.js';

const H = 3600000;
const BASE = Date.UTC(2099, 10, 1, 15, 30); // a Sunday 10:30 Montreal (15:30Z)
let gameN = 0;
const one = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const rows = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then(r => r.results || []);
const dual = ev => rows("SELECT player_id, payload, cancelled FROM outbox WHERE event_id = ? AND kind = 'dual_role' AND cancelled = 0 ORDER BY id", ev.id);
const subjectOf = r => JSON.parse(r.payload).prerendered.subject;

const PRODUCTS = {
  SMBHL: { league: 'smbhl', p: id => `D${id}`, goalieSubRole: 'sub_goalie', goalieSubIsGoalie: 1 },
  'Notre Ligue': { league: 'lg195', p: id => `lg195:D${id}`, goalieSubRole: 'sub_skater', goalieSubIsGoalie: 1 }
};

async function contact(P, id, name, role, { goalie = 0, dualRole = 0, team = null } = {}) {
  await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, is_backup_goalie, preferred_team, token_salt, league_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 's', ?, 1)`)
    .bind(P.p(id), name, `${String(id).toLowerCase()}.${P.league}@example.com`, role, role === 'roster' ? 0 : 1, goalie, dualRole, team, P.league).run();
}

// A game `hours` from now, Red v Blue.
async function game(P, hours) {
  const n = ++gameN;
  const start = BASE + n * 7 * 24 * H;
  vi.setSystemTime(new Date(start - hours * H));
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', month2: undefined }).formatToParts(new Date(start)).map(x => [x.type, x.value]));
  const iso = `${p.year}-${p.month}-${p.day}`;
  const id = P.league === 'smbhl' ? `smbhl:${iso}` : `lg195:${iso}`;
  const label = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(start)).replace(/,/g, '');
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, home_team, away_team) VALUES (?, ?, 1, ?, 'Aréna', 'open', '10:30', ?, ?, ?)`)
    .bind(id, P.league === 'smbhl' ? 'Fall 2099' : 'S1', P.league === 'smbhl' ? label : iso, P.league, P.league === 'smbhl' ? null : 'Red', P.league === 'smbhl' ? null : 'Blue').run();
  return one('SELECT * FROM events WHERE id = ?', id);
}
const rsvp = (P, ev, id, team, status, role = 'roster') => env.DB.prepare(
  `INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, ?, ?, ?, 'self', ?, ?)
   ON CONFLICT(event_id, player_id) DO UPDATE SET team = excluded.team, status = excluded.status`
).bind(ev.id, P.p(id), team, status, role, new Date().toISOString(), P.league).run();
const cfgOf = (P, ev) => (P.league === 'smbhl' ? getSeasonConfigForEvent(env, ev.id, ev.season) : getLeagueSeasonConfig(env, P.league, ev.season));
const state = async (P, ev, team) => teamState(env.DB, ev.id, team, await cfgOf(P, ev));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  env.RSVP_SECRET = 'p195'; env.PUBLIC_URL = 'https://rsvp.example.com'; env.ADMIN_EMAIL = 'admin@example.com';
  delete env.LEAGUE_PRODUCT;
  await applyRealSchema(env);
  await env.DB.prepare('DELETE FROM contacts').run();
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: 'Fall 2099', seasons: [{ name: 'Fall 2099', config: { teams: [{ name: 'Red' }, { name: 'Blue' }], goaliesPerTeam: 1, skatersPerTeam: 8, minSkaters: 2 }, fixtures: [], standings: [] }], players: [] }));
  await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at) VALUES ('u195', 'owner195@example.com', 'x', '2026-10-01T00:00:00Z')`).run();
  await env.DB.prepare(`INSERT INTO leagues (id, name, team_count, team_names, created_by, created_at, slug, team_structure, language_mode, min_players, max_players, min_goalies) VALUES ('lg195', 'Ligue 195', 2, '["Red","Blue"]', 'u195', '2026-10-01T00:00:00Z', 'ligue-195', 'fixed', 'fr', 2, 10, 1)`).run();
  await env.DB.prepare(`INSERT INTO league_admins (league_id, user_id, created_at) VALUES ('lg195', 'u195', '2026-10-01T00:00:00Z')`).run().catch(() => {});
  for (const P of Object.values(PRODUCTS)) {
    await contact(P, 'GR', 'Gilles Rouge', 'roster', { goalie: 1, team: 'Red' });
    await contact(P, 'DR', 'Dany Deux', 'roster', { dualRole: 1, team: 'Red' });
    await contact(P, 'SR', 'Sam Rouge', 'roster', { team: 'Red' });
    await contact(P, 'TR', 'Tom Rouge', 'roster', { team: 'Red' });
    await contact(P, 'GB', 'Guy Bleu', 'roster', { goalie: 1, team: 'Blue' });
    await contact(P, 'SB', 'Sid Bleu', 'roster', { team: 'Blue' });
    await contact(P, 'GS', 'Gaby Sub', P.goalieSubRole, { goalie: P.goalieSubIsGoalie });
    await contact(P, 'DS', 'Dom Sub', 'sub_skater', { dualRole: 1 });
    await contact(P, 'SS', 'Seb Sub', 'sub_skater');
  }
});
afterAll(() => { vi.useRealTimers(); });

for (const [name, P] of Object.entries(PRODUCTS)) {
  describe(`${name}: 6b, own team's goalie out`, () => {
    it('the dual-role regular says yes with the goalie out: in goal, one skater fewer, emailed', async () => {
      const ev = await game(P, 30);
      await rsvp(P, ev, 'GR', 'Red', 'out'); await rsvp(P, ev, 'DR', 'Red', 'in'); await rsvp(P, ev, 'SR', 'Red', 'in');
      await dualGoalieChecks(env, ev);
      const st = await state(P, ev, 'Red');
      expect(st.goalieIds).toEqual([P.p('DR')]);
      expect(st.skaters).toBe(1);
      const mails = await dual(ev);
      expect(mails.map(m => m.player_id)).toEqual([P.p('DR')]);
      expect(subjectOf(mails[0])).toMatch(/dans les buts/);
    });

    it('said yes before the goalie dropped out: switched and emailed then', async () => {
      const ev = await game(P, 30);
      await rsvp(P, ev, 'GR', 'Red', 'in'); await rsvp(P, ev, 'DR', 'Red', 'in');
      await dualGoalieChecks(env, ev);
      expect(await dual(ev)).toEqual([]);
      await rsvp(P, ev, 'GR', 'Red', 'out');
      await dualGoalieChecks(env, ev);
      expect((await dual(ev)).map(m => m.player_id)).toEqual([P.p('DR')]);
      expect((await state(P, ev, 'Red')).goalieIds).toEqual([P.p('DR')]);
    });
  });

  describe(`${name}: 6e, edge cases`, () => {
    it('the goalie says yes after: the goalie takes the net back, both are emailed', async () => {
      const ev = await game(P, 30);
      await rsvp(P, ev, 'GR', 'Red', 'out'); await rsvp(P, ev, 'DR', 'Red', 'in');
      await dualGoalieChecks(env, ev);
      await rsvp(P, ev, 'GR', 'Red', 'in');
      await dualGoalieChecks(env, ev);
      expect((await state(P, ev, 'Red')).goalieIds).toEqual([P.p('GR')]);
      const mails = await dual(ev);
      // The dual-role player's pending email is the latest one (skater again).
      const toDual = mails.filter(m => m.player_id === P.p('DR'));
      expect(toDual).toHaveLength(1);
      expect(subjectOf(toDual[0])).toMatch(/comme joueur/);
      const toGoalie = mails.filter(m => m.player_id === P.p('GR'));
      expect(toGoalie).toHaveLength(1);
      expect(subjectOf(toGoalie[0])).toMatch(/tu es dans les buts/);
    });

    it('a goalie sub accepted first: the first confirmed goalie wins, the dual-role player stays a skater', async () => {
      const ev = await game(P, 30);
      await rsvp(P, ev, 'GR', 'Red', 'out'); await rsvp(P, ev, 'GS', 'Red', 'in', 'sub'); await rsvp(P, ev, 'DR', 'Red', 'in');
      await dualGoalieChecks(env, ev);
      expect((await state(P, ev, 'Red')).goalieIds).toEqual([P.p('GS')]);
      expect(await dual(ev)).toEqual([]);
    });

    it('the dual-role player in goal first: the open goalie calls are cancelled', async () => {
      const ev = await game(P, 30);
      await rsvp(P, ev, 'GB', 'Blue', 'in');
      await rsvp(P, ev, 'GR', 'Red', 'out');
      await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at, league_id) VALUES ('sub_call', ?, ?, 'Red', ?, '{"need":"goalie"}', '2200-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)`)
        .bind(ev.id, P.p('GS'), `call:${ev.id}:goalie:${P.p('GS')}`, P.league).run();
      await rsvp(P, ev, 'DR', 'Red', 'in');
      await dualGoalieChecks(env, ev);
      expect((await one('SELECT cancelled FROM outbox WHERE dedup_key = ?', `call:${ev.id}:goalie:${P.p('GS')}`)).cancelled).toBe(1);
    });
  });

  describe(`${name}: 6c, another team short a goalie`, () => {
    const setup = async hours => {
      const ev = await game(P, hours);
      await rsvp(P, ev, 'GR', 'Red', 'in'); await rsvp(P, ev, 'DR', 'Red', 'in'); await rsvp(P, ev, 'SR', 'Red', 'in'); await rsvp(P, ev, 'TR', 'Red', 'in');
      await rsvp(P, ev, 'GB', 'Blue', 'out'); await rsvp(P, ev, 'SB', 'Blue', 'in');
      return ev;
    };
    const alerts = ev => rows("SELECT to_addr FROM (SELECT json_extract(payload, '$.prerendered.to') AS to_addr FROM outbox WHERE event_id = ? AND kind = 'dual_goalie_alert')", ev.id);
    const called = (ev, id) => env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, sent_at, created_at, league_id) VALUES ('sub_call', ?, ?, 'Blue', ?, '{"need":"goalie"}', '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z', '2026-01-01T00:00:00Z', ?)`)
      .bind(ev.id, P.p(id), `call:${ev.id}:goalie:${P.p(id)}`, P.league).run();

    it('at 48 hours, every goalie sub called: one alert, once', async () => {
      const ev = await setup(40);
      expect(await dualGoalieChecks(env, ev)).toBe(0); // the goalie sub was not called yet
      await called(ev, 'GS');
      await dualGoalieChecks(env, ev);
      await dualGoalieChecks(env, ev);
      expect(await alerts(ev)).toHaveLength(1);
    });

    it('earlier than 48 hours: only once every goalie sub said no', async () => {
      const ev = await setup(60);
      await called(ev, 'GS');
      await dualGoalieChecks(env, ev);
      expect(await alerts(ev)).toHaveLength(0);
      await env.DB.prepare(`INSERT INTO availability (event_id, player_id, need, status, answered_at, league_id) VALUES (?, ?, 'goalie', 'no', ?, ?)`).bind(ev.id, P.p('GS'), new Date().toISOString(), P.league).run();
      await dualGoalieChecks(env, ev);
      expect(await alerts(ev)).toHaveLength(1);
    });

    it('not at all once the spot is filled', async () => {
      const ev = await setup(40);
      await called(ev, 'GS');
      await rsvp(P, ev, 'GB', 'Blue', 'in');
      await dualGoalieChecks(env, ev);
      expect(await alerts(ev)).toHaveLength(0);
    });

    it("the game page: ask, or put in goal (one skater fewer for the player's team)", async () => {
      const ev = await setup(40);
      const ask = await dualGoalieAction(env, ev, P.p('DR'), 'Blue', 'ask');
      expect(ask.ok).toBe(true);
      expect(await one("SELECT 1 AS x FROM outbox WHERE event_id = ? AND kind = 'dual_role' AND dedup_key = ?", ev.id, `dual_ask:${ev.id}:${P.p('DR')}:Blue`)).toBeTruthy();
      const redBefore = (await state(P, ev, 'Red')).skaters;
      const sw = await dualGoalieAction(env, ev, P.p('DR'), 'Blue', 'switch');
      expect(sw).toMatchObject({ ok: true, switched: true, from: 'Red', to: 'Blue' });
      expect((await state(P, ev, 'Blue')).goalieIds).toEqual([P.p('DR')]);
      expect((await state(P, ev, 'Red')).skaters).toBe(redBefore - 1);
      expect((await dual(ev)).some(m => m.player_id === P.p('DR') && /dans les buts/.test(subjectOf(m)))).toBe(true);
      expect((await dualGoalieAction(env, ev, P.p('SR'), 'Red', 'switch')).errorKey).toBe('DUAL_TEAM_NOT_SHORT');
    });
  });

  describe(`${name}: 6d, a dual-role sub`, () => {
    it('is in the goalie wave, also when already called as a skater', async () => {
      const ev = await game(P, 30);
      await rsvp(P, ev, 'GB', 'Blue', 'out');
      await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, sent_at, created_at, league_id) VALUES ('sub_call', ?, ?, 'Red', ?, '{"need":"skater"}', '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z', '2026-01-01T00:00:00Z', ?)`)
        .bind(ev.id, P.p('DS'), `call:${ev.id}:skater:${P.p('DS')}`, P.league).run();
      await callSubs(env, ev, 'Blue', 'goalie', 0, P.league, P.league !== 'smbhl', true, true);
      const goalieCalls = (await rows("SELECT player_id FROM outbox WHERE event_id = ? AND dedup_key LIKE 'call:%:goalie:%'", ev.id)).map(r => r.player_id).sort();
      expect(goalieCalls).toEqual([P.p('DS'), P.p('GS')].sort());
    });

    it('playing as a skater, accepts a goalie spot: moves there, and a skater call opens for the spot left', async () => {
      const ev = await game(P, 30);
      await rsvp(P, ev, 'GR', 'Red', 'in'); await rsvp(P, ev, 'GB', 'Blue', 'out');
      await rsvp(P, ev, 'DS', 'Red', 'in', 'sub');
      const r = await acceptAvailability(env, ev, P.p('DS'), 'goalie');
      expect(r).toMatchObject({ placed: 'Blue', switched: true });
      expect((await one('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?', ev.id, P.p('DS'))).team).toBe('Blue');
      expect((await state(P, ev, 'Blue')).goalieIds).toEqual([P.p('DS')]);
      expect(await one("SELECT 1 AS x FROM outbox WHERE event_id = ? AND dedup_key = ?", ev.id, `call:${ev.id}:skater:${P.p('SS')}`)).toBeTruthy();
    });

    it('a goalie already took the spot: stays a skater', async () => {
      const ev = await game(P, 30);
      await rsvp(P, ev, 'GR', 'Red', 'in'); await rsvp(P, ev, 'GB', 'Blue', 'in');
      await rsvp(P, ev, 'DS', 'Red', 'in', 'sub');
      expect(await acceptAvailability(env, ev, P.p('DS'), 'goalie')).toEqual({ placed: 'Red' });
    });
  });
}

describe('a league with no dual-role player: nothing runs', () => {
  it('no email, no setting written, the goalie wave as before', async () => {
    await env.DB.prepare(`INSERT INTO leagues (id, name, team_count, team_names, created_by, created_at, slug, team_structure, language_mode) VALUES ('lg195b', 'Ligue sans deux', 2, '["Red","Blue"]', 'u195', '2026-10-01T00:00:00Z', 'ligue-195b', 'fixed', 'fr')`).run();
    const P = { league: 'lg195b', p: id => `lg195b:${id}` };
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id, is_active) VALUES ('lg195b:G', 'Goal Sub', 'g.b@example.com', 'sub_skater', 1, 1, 's', 'lg195b', 1), ('lg195b:S', 'Skate Sub', 's.b@example.com', 'sub_skater', 1, 0, 's', 'lg195b', 1)`).run();
    const start = BASE + 900 * 24 * H;
    vi.setSystemTime(new Date(start - 30 * H));
    const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(start));
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, home_team, away_team) VALUES (?, 'S1', 1, ?, 'Aréna', 'open', '10:30', 'lg195b', 'Red', 'Blue')`).bind(`lg195b:${iso}`, iso).run();
    const ev = await one('SELECT * FROM events WHERE id = ?', `lg195b:${iso}`);
    expect(await dualGoalieChecks(env, ev)).toBe(0);
    expect(await one("SELECT 1 AS x FROM settings WHERE key LIKE ?", `dual_%${ev.id}%`)).toBeNull();
    await callSubs(env, ev, 'Blue', 'goalie', 0, 'lg195b', true, true, true);
    expect((await rows("SELECT player_id FROM outbox WHERE event_id = ? AND kind = 'sub_call'", ev.id)).map(r => r.player_id)).toEqual(['lg195b:G']);
  });
});

describe('6a: Joueur / Gardien / Les deux', () => {
  it('SMBHL people page: one choice of three, for a regular and for a sub', async () => {
    env.ADMIN_KEY = 'p195-admin';
    const post = body => SELF.fetch('http://example.com/admin/contacts', { method: 'POST', headers: { 'x-admin': 'p195-admin', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const flags = id => one('SELECT role, is_goalie, is_backup_goalie FROM contacts WHERE player_id = ?', id);
    expect((await post({ action: 'play_role', player_id: 'NOPE', play_role: 'both' })).status).toBe(404);
    // DSR: an SMBHL regular (Sam Rouge); DSS: an SMBHL sub (Seb Sub).
    await post({ action: 'play_role', player_id: 'DSR', play_role: 'both' });
    expect(await flags('DSR')).toMatchObject({ role: 'roster', is_goalie: 0, is_backup_goalie: 1 });
    await post({ action: 'play_role', player_id: 'DSS', play_role: 'goalie' });
    expect(await flags('DSS')).toMatchObject({ role: 'sub_goalie', is_goalie: 1, is_backup_goalie: 0 });
    await post({ action: 'play_role', player_id: 'DSS', play_role: 'both' });
    expect(await flags('DSS')).toMatchObject({ role: 'sub_skater', is_goalie: 0, is_backup_goalie: 1 });
    await post({ action: 'play_role', player_id: 'DSS', play_role: 'skater' });
    expect(await flags('DSS')).toMatchObject({ role: 'sub_skater', is_goalie: 0, is_backup_goalie: 0 });
    expect((await post({ action: 'play_role', player_id: 'DSS', play_role: 'nope' })).status).toBe(400);
    const page = await (await SELF.fetch('http://example.com/admin/people', { headers: { 'x-admin': 'p195-admin' } })).text();
    expect(page).toContain('playBoth: "Les deux"');
    expect(page).toContain('data-play-role');
  });
});

// Batch 2, item 1: the dual-role copy names the game's day, never "ce soir"
// or "tonight" (these emails can go out days ahead; SMBHL plays Sunday
// mornings). Every email the tests above queued, both products, and the
// panels, in French and English.
describe('the dual-role copy names the day, never "tonight"', () => {
  const NIGHT = /ce soir|tonight|cette nuit/i;
  const isoOf = ev => ev.id.match(/\d{4}-\d{2}-\d{2}/)[0];
  const dayOf = (ev, lang) => formatEventDate(isoOf(ev), lang, 'long', false);

  it('every dual-role email and admin alert, French and English', async () => {
    const mails = await rows("SELECT o.kind, o.league_id, o.event_id, o.payload FROM outbox o WHERE o.kind IN ('dual_role', 'dual_goalie_alert')");
    const subjects = { smbhl: [], lg195: [] };
    for (const m of mails) {
      const p = JSON.parse(m.payload).prerendered;
      const ev = await one('SELECT id FROM events WHERE id = ?', m.event_id);
      for (const part of [p.subject, p.text, p.html]) expect(part).not.toMatch(NIGHT);
      expect(p.text.toLowerCase()).toContain(dayOf(ev, 'fr').toLowerCase());
      // SMBHL is bilingual; the Notre Ligue league here is French only.
      if (m.league_id === 'smbhl') expect(p.text).toContain(formatEventDate(isoOf(ev), 'en', 'long'));
      subjects[m.league_id].push(p.subject);
    }
    for (const league of ['smbhl', 'lg195']) {
      const all = subjects[league].join('\n');
      // to_goalie and goalie_back, to_skater, ask, the admin alert.
      expect(all).toMatch(/^\S+ \d+ \S+ : tu es dans les buts/m);
      expect(all).toMatch(/^\S+ \d+ \S+ : tu joues comme joueur/m);
      expect(all).toMatch(/cherche un gardien/);
      expect(all).toMatch(/Gardien manquant/);
    }
    expect(subjects.smbhl.join('\n')).toMatch(/[A-Z]\w+ [A-Z][a-z]+ \d+: you're in goal/);
    expect(subjects.smbhl.join('\n')).toMatch(/[A-Z]\w+ [A-Z][a-z]+ \d+: you play as a skater/);
  });

  it('the role line in the game-day and placement emails', async () => {
    const ev = { id: 'smbhl:2099-11-29', date: 'Sunday November 29 2099' };
    expect(dualRoleLines({ dualRole: 'goalie' }, ev)).toEqual({ fr: '🥅 Dimanche 29 nov. : tu es dans les buts.', en: "🥅 Sunday Nov 29: you're in goal." });
    expect(dualRoleLines({ dualRole: 'skater' }, ev)).toEqual({ fr: '🏒 Dimanche 29 nov. : tu joues comme joueur.', en: '🏒 Sunday Nov 29: you play as a skater.' });
    expect(dualRoleLines({}, ev)).toBeNull();
  });

  const shortBlue = async P => {
    const ev = await game(P, 40);
    await rsvp(P, ev, 'GR', 'Red', 'in'); await rsvp(P, ev, 'DR', 'Red', 'in'); await rsvp(P, ev, 'SR', 'Red', 'in');
    await rsvp(P, ev, 'GB', 'Blue', 'out'); await rsvp(P, ev, 'SB', 'Blue', 'in');
    return ev;
  };

  it('the SMBHL board panel: the day comes with the data, in both languages', async () => {
    env.ADMIN_KEY = 'p195-admin';
    const ev = await shortBlue(PRODUCTS.SMBHL);
    const d = await (await SELF.fetch(`http://example.com/admin/board/data?e=${encodeURIComponent(ev.id)}`, { headers: { 'x-admin': 'p195-admin' } })).json();
    expect(d.dualGoalies.players.length).toBeGreaterThan(0);
    expect(d.dualGoalies.when).toEqual({ fr: dayOf(ev, 'fr'), en: dayOf(ev, 'en') });
    const page = await (await SELF.fetch('http://example.com/admin/board', { headers: { 'x-admin': 'p195-admin' } })).text();
    expect(page).toContain("dualDesc: 'Pas de gardien pour {teams}. Ces joueurs jouent aux deux positions et jouent {when} :'");
    expect(page).toContain("dualDesc: 'No goalie for {teams}. These players play both positions and are playing {when}:'");
    expect(page).not.toMatch(NIGHT);
  });

  it('the Notre Ligue game page panel, French and English', async () => {
    const P = PRODUCTS['Notre Ligue'];
    const ev = await shortBlue(P);
    env.AUTH_SECRET = env.AUTH_SECRET || 'p195-auth';
    const cookie = (await createSessionCookie(env, 'u195', 0)).split(';')[0];
    const html = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(ev.id)}`, { headers: { cookie } })).text();
    expect(html).toContain('data-dual-team="Blue"');
    expect(html).toContain(`Ces joueurs jouent aux deux positions et jouent ${dayOf(ev, 'fr')} avec une autre équipe :`);
    expect(html).toContain(`These players play both positions and are playing ${dayOf(ev, 'en')} with another team:`);
    expect(html).not.toMatch(NIGHT);
  });
});

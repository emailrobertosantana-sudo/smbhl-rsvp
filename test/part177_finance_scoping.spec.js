// Finance, phase 1: the data layer. season_pricing, player_dues and
// season_costs are keyed by league (migrate-054) and every finance query
// is scoped by league (src/finance_store.js).
//  - two leagues with the same season name keep separate pricing, dues
//    and costs;
//  - no finance SQL is written outside finance_store.js, and every
//    statement there filters or writes league_id;
//  - migrate-054 carries every row across unchanged;
//  - SMBHL's finance page, its invite / game-day balance lookups (the
//    sample-invite route runs the same ones) and the season hub's pricing
//    writes give exactly what they gave before -- SMBHL_DIGEST below was
//    recorded on the code and schema before this change.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { installMailCapture, removeMailCapture } from './support/league_season.js';
import * as store from '../src/finance_store.js';

const sources = import.meta.glob('../src/*.js', { eager: true, query: '?raw', import: 'default' });
const migration054 = import.meta.glob('../migrate-054.sql', { eager: true, query: '?raw', import: 'default' })['../migrate-054.sql'];

beforeAll(async () => {
  env.ADMIN_KEY = 'p177-admin'; env.RSVP_SECRET = 'p177r'; env.RESEND_API_KEY = 'x'; env.MAIL_DAILY_CAP = '';
  await applyRealSchema(env);
  installMailCapture();
});
afterAll(() => removeMailCapture());

describe('Two leagues with a season of the same name', () => {
  it('keep separate pricing, dues and costs', async () => {
    const A = 'lg-a-p177', B = 'lg-b-p177', S = 'Fall 2026';
    await store.saveSeasonPricing(env.DB, A, S, { pricePlayer: 200, priceGoalie: 0, priceSubPlayer: 12, priceSubGoalie: 0, etransferPhone: 'A-phone' });
    await store.saveSeasonPricing(env.DB, B, S, { pricePlayer: 90, priceGoalie: 45, priceSubPlayer: 8, priceSubGoalie: 4, etransferPhone: 'B-phone' });
    await store.saveSeasonPricing(env.DB, A, S, { pricePlayer: 210, priceGoalie: 0, priceSubPlayer: 12, priceSubGoalie: 0, etransferPhone: 'A-phone' }); // an update, A only
    expect((await store.getSeasonPricing(env.DB, A, S)).price_player).toBe(210);
    expect((await store.getSeasonPricing(env.DB, B, S)).price_player).toBe(90);
    expect(await store.listPricingSeasons(env.DB, A)).toEqual([S]);

    // Same player id in both (league ids are normally prefixed; the key must not rely on it).
    await store.savePlayerDues(env.DB, A, S, 'P1', { customDue: null, amountPaid: 50, notes: 'A' });
    await store.savePlayerDues(env.DB, B, S, 'P1', { customDue: 30, amountPaid: 10, notes: 'B' });
    expect((await store.getPlayerDues(env.DB, A, S, 'P1')).amount_paid).toBe(50);
    expect((await store.getPlayerDues(env.DB, B, S, 'P1')).custom_due).toBe(30);
    expect((await store.listSeasonDues(env.DB, A, S)).map(r => r.notes)).toEqual(['A']);

    await store.saveSeasonCost(env.DB, A, { id: 'cost-a', season: S, category: 'rental', description: 'Ice A', amount: 500 });
    await store.saveSeasonCost(env.DB, B, { id: 'cost-b', season: S, category: 'rental', description: 'Ice B', amount: 300 });
    // B can neither overwrite nor delete A's cost by its id.
    await store.saveSeasonCost(env.DB, B, { id: 'cost-a', season: S, category: 'other', description: 'hijack', amount: 1 });
    await store.deleteSeasonCost(env.DB, B, 'cost-a', S);
    expect((await store.listSeasonCosts(env.DB, A, S)).map(c => [c.id, c.description, c.amount])).toEqual([['cost-a', 'Ice A', 500]]);
    expect((await store.listSeasonCosts(env.DB, B, S)).map(c => c.id)).toEqual(['cost-b']);
  });
});

describe('Every finance query is scoped by league', () => {
  it('no finance SQL outside finance_store.js, and every statement in it names league_id', () => {
    const tables = /\b(season_pricing|player_dues|season_costs)\b/;
    const sqlish = /(SELECT|INSERT|UPDATE|DELETE|FROM|INTO)\b[^`'"]*\b(season_pricing|player_dues|season_costs)\b/i;
    for (const [path, src] of Object.entries(sources)) {
      if (/finance_store\.js$|schema_manifest\.js$/.test(path)) continue;
      const hits = src.split('\n').filter(l => sqlish.test(l) && !/^\s*\/\//.test(l));
      expect(hits, path).toEqual([]);
      if (/hard_delete\.js$/.test(path)) expect(src).toMatch(/DELETE FROM \$\{table\} WHERE league_id = \?/);
    }
    // Code only: comments are prose (and have apostrophes).
    const storeSrc = sources['../src/finance_store.js'].split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    const statements = storeSrc.match(/`[^`]*\b(season_pricing|player_dues|season_costs)\b[^`]*`|'[^']*\b(season_pricing|player_dues|season_costs)\b[^']*'/g) || [];
    expect(statements.length).toBeGreaterThanOrEqual(10);
    for (const s of statements) expect(s, s).toMatch(/league_id/);
    expect(tables.test(storeSrc)).toBe(true);
  });
});

describe('migrate-054 carries every row across', () => {
  it('the pre-054 tables (production\'s exact DDL) with rows in two leagues: same rows, same values, new keys', async () => {
    // Production's DDL before 054 (sqlite_master, read 2026-09-29), under
    // scratch names so the suite's own tables are untouched.
    const ddl = [
      `CREATE TABLE season_pricing (season TEXT PRIMARY KEY, price_player REAL NOT NULL DEFAULT 180, price_goalie REAL NOT NULL DEFAULT 0, price_sub_player REAL NOT NULL DEFAULT 15, price_sub_goalie REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, etransfer_phone TEXT, league_id TEXT NOT NULL DEFAULT 'smbhl')`,
      `CREATE TABLE player_dues (season TEXT NOT NULL, player_id TEXT NOT NULL, custom_due REAL, adjustment REAL NOT NULL DEFAULT 0, amount_paid REAL NOT NULL DEFAULT 0, notes TEXT, updated_at TEXT NOT NULL, league_id TEXT NOT NULL DEFAULT 'smbhl', settled_nights INTEGER, PRIMARY KEY (season, player_id))`,
      `CREATE TABLE season_costs (id TEXT PRIMARY KEY, season TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, league_id TEXT NOT NULL DEFAULT 'smbhl')`
    ];
    // Run the migration in a scratch schema: rename the suite's tables away, then back.
    const suiteTables = ['season_pricing', 'player_dues', 'season_costs'];
    for (const t of suiteTables) await env.DB.exec(`ALTER TABLE ${t} RENAME TO keep_${t}`);
    try {
      for (const d of ddl) await env.DB.exec(d.replace(/\s+/g, ' '));
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO season_pricing VALUES ('Fall 2026', 220, 0, 15, 0, '2026-09-01', '514-000-0000', 'smbhl')`),
        env.DB.prepare(`INSERT INTO season_pricing VALUES ('Winter 2027', 230, 10, 16, 2, '2026-09-02', NULL, 'smbhl')`),
        ...Array.from({ length: 30 }, (_, i) => env.DB.prepare(`INSERT INTO player_dues VALUES ('Fall 2026', ?, ?, ?, ?, ?, '2026-09-03', 'smbhl', ?)`)
          .bind(`P${String(i).padStart(4, '0')}`, i % 5 === 0 ? 150 : null, i % 7 === 0 ? -5 : 0, i * 7.5, i % 3 === 0 ? `note ${i}` : null, i % 4 === 0 ? i : null)),
        env.DB.prepare(`INSERT INTO season_costs VALUES ('c1', 'Fall 2026', 'rental', 'Ice', 1200, '2026-09-01', '2026-09-01', 'smbhl')`),
        env.DB.prepare(`INSERT INTO season_costs VALUES ('c2', 'Fall 2026', 'equipment', 'Pucks', 80.5, '2026-09-01', '2026-09-01', 'smbhl')`),
        env.DB.prepare(`INSERT INTO season_costs VALUES ('c3', 'Fall 2026', 'other', 'Trophy', 45, '2026-09-01', '2026-09-01', 'smbhl')`)
      ]);
      const snap = async () => ({
        pricing: (await env.DB.prepare('SELECT * FROM season_pricing ORDER BY league_id, season').all()).results,
        dues: (await env.DB.prepare('SELECT * FROM player_dues ORDER BY league_id, season, player_id').all()).results,
        costs: (await env.DB.prepare('SELECT * FROM season_costs ORDER BY id').all()).results
      });
      const before = await snap();
      expect([before.pricing.length, before.dues.length, before.costs.length]).toEqual([2, 30, 3]);
      for (const stmt of migration054.split(/;\s*\n/).map(s => s.replace(/--[^\n]*/g, '').trim()).filter(Boolean)) await env.DB.exec(stmt.replace(/\s+/g, ' '));
      const after = await snap();
      expect([after.pricing.length, after.dues.length, after.costs.length]).toEqual([2, 30, 3]);
      expect(after).toEqual(before); // every column of every row
      // The new keys: a second league's row of the same season now fits.
      await env.DB.prepare(`INSERT INTO season_pricing (league_id, season, price_player, updated_at) VALUES ('other', 'Fall 2026', 99, 'x')`).run();
      await env.DB.prepare(`INSERT INTO player_dues (league_id, season, player_id, updated_at) VALUES ('other', 'Fall 2026', 'P0001', 'x')`).run();
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM season_pricing WHERE season = 'Fall 2026'").first()).n).toBe(2);
      const pk = t => env.DB.prepare(`SELECT name FROM pragma_table_info('${t}') WHERE pk > 0 ORDER BY pk`).all();
      expect((await pk('season_pricing')).results.map(r => r.name)).toEqual(['league_id', 'season']);
      expect((await pk('player_dues')).results.map(r => r.name)).toEqual(['league_id', 'season', 'player_id']);
    } finally {
      for (const t of suiteTables) { await env.DB.exec(`DROP TABLE IF EXISTS ${t}`); await env.DB.exec(`ALTER TABLE keep_${t} RENAME TO ${t}`); }
    }
  });
});

// ---- SMBHL, identical -----------------------------------------------------
// A season of SMBHL finance: regulars (one on a custom due, one overpaid
// into credit, one partial), a regular goalie, subs charged from data.json
// games played (one settled nights, one with no games), a sub goalie,
// costs, and an open game not yet played -- plus a demo league with the
// SAME season name and its own pricing, dues, costs, contacts and games,
// which must change nothing on SMBHL's side.
const SEASON = 'Fall 2026';
async function smbhlFixture({ otherLeague }) {
  const players = [
    ['P9001', 'Reg Skater', 'roster', 0, 0, 'Red'], ['P9002', 'Reg Custom', 'roster', 0, 0, 'Red'],
    ['P9003', 'Reg Credit', 'roster', 0, 0, 'Blue'], ['P9004', 'Reg Partial', 'roster', 0, 0, 'Blue'],
    ['P9005', 'Reg Goalie', 'roster', 1, 0, 'Blue'], ['P9006', 'Sub Three', 'sub_skater', 0, 1, null],
    ['P9007', 'Sub Settled', 'sub_skater', 0, 1, null], ['P9008', 'Sub Goalie', 'sub_goalie', 1, 1, null],
    ['P9009', 'Sub Nothing', 'sub_skater', 0, 1, null]
  ];
  for (const [id, name, role, g, sub, team] of players) {
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_goalie, is_sub, preferred_team, token_salt, league_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'smbhl')`)
      .bind(id, name, `${id.toLowerCase()}@example.com`, role, g, sub, team, `salt-${id}`).run();
  }
  await env.SHEETS_KV.put('data_json', JSON.stringify({
    current_season: SEASON, seasons: [{ name: SEASON }],
    players: [
      { id: 'P9001', name: 'Reg Skater', seasons: { [SEASON]: { team: 'Red', gp: 4 } } },
      { id: 'P9002', name: 'Reg Custom', seasons: { [SEASON]: { team: 'Red', gp: 4 } } },
      { id: 'P9003', name: 'Reg Credit', seasons: { [SEASON]: { team: 'Blue', gp: 2 } } },
      { id: 'P9004', name: 'Reg Partial', seasons: { [SEASON]: { team: 'Blue', gp: 4 } } },
      { id: 'P9005', name: 'Reg Goalie', seasons: { [SEASON]: { team: 'Blue', gp: 4, pos: 'G' } }, gseasons: { [SEASON]: { team: 'Blue', gp: 4 } } },
      { id: 'P9006', name: 'Sub Three', seasons: { [SEASON]: { team: null, gp: 3 } } },
      { id: 'P9007', name: 'Sub Settled', seasons: { [SEASON]: { team: null, gp: 4 } } },
      { id: 'P9008', name: 'Sub Goalie', seasons: { [SEASON]: { team: null, gp: 2, pos: 'G' } }, gseasons: { [SEASON]: { team: null, gp: 2 } } },
      { id: 'P9009', name: 'Sub Nothing', seasons: { [SEASON]: { team: null, gp: 0 } } }
    ]
  }));
  const ev = async (id, state, week) => env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, ?, ?, ?, 'Letendre', ?, '10:30', 'smbhl')`).bind(id, SEASON, week, id, state).run();
  await ev('2026-09-06', 'done', 1); await ev('2026-09-13', 'locked', 2); await ev('2026-09-20', 'open', 3);
  const rsvp = (e, p, team, role, status = 'in') => env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, ?, ?, ?, '2026-09-01', 'smbhl')`).bind(e, p, team, status, role).run();
  for (const [p, t] of [['P9001', 'Red'], ['P9002', 'Red'], ['P9003', 'Blue'], ['P9004', 'Blue'], ['P9005', 'Blue']]) { await rsvp('2026-09-06', p, t, 'roster'); await rsvp('2026-09-13', p, t, 'roster'); }
  await rsvp('2026-09-13', 'P9006', 'Red', 'sub'); await rsvp('2026-09-20', 'P9009', 'Red', 'sub');
  const admin = { 'x-admin': env.ADMIN_KEY, 'content-type': 'application/json' };
  const post = (path, body) => SELF.fetch(`http://example.com${path}`, { method: 'POST', headers: admin, body: JSON.stringify(body) });
  await post('/admin/finances/pricing', { season: SEASON, price_player: 220, price_goalie: 0, price_sub_player: 15, price_sub_goalie: 0, etransfer_phone: '514-000-0000' });
  await post('/admin/finances/player', { season: SEASON, player_id: 'P9002', custom_due: 150, amount_paid: 0, notes: 'late start' });
  await post('/admin/finances/player', { season: SEASON, player_id: 'P9003', amount_paid: 260, notes: 'overpaid' });
  await post('/admin/finances/player', { season: SEASON, player_id: 'P9004', amount_paid: 100 });
  await post('/admin/finances/player', { season: SEASON, player_id: 'P9007', amount_paid: 30 });
  await env.DB.prepare(`UPDATE player_dues SET settled_nights = 1 WHERE player_id = 'P9007'`).run();
  await post('/admin/finances/cost', { id: 'c-ice', season: SEASON, category: 'rental', description: 'Ice', amount: 1200 });
  await post('/admin/finances/cost', { id: 'c-pucks', season: SEASON, category: 'equipment', description: 'Pucks', amount: 80.5 });
  await post('/admin/finances/cost', { id: 'c-gone', season: SEASON, category: 'other', description: 'Deleted', amount: 5 });
  await post('/admin/finances/cost/delete', { id: 'c-gone', season: SEASON });
  // Another league, the same season name, and everything in it.
  const L = 'demo-same-season';
  if (!otherLeague) return { post, otherLeagueWrites: async () => {} };
  await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_goalie, is_sub, token_salt, league_id) VALUES ('${L}:P0001', 'Other League', 'other@example.com', 'roster', 0, 0, 's', ?)`).bind(L).run();
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES ('${L}:2026-09-13', ?, 2, '2026-09-13', 'Elsewhere', 'locked', '19:00', ?)`).bind(SEASON, L).run();
  await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES ('${L}:2026-09-13', '${L}:P0001', 'Tous', 'in', 'roster', 'x', ?)`).bind(L).run();
  const otherLeagueWrites = async () => {
    await store.saveSeasonPricing(env.DB, L, SEASON, { pricePlayer: 1, priceGoalie: 1, priceSubPlayer: 1, priceSubGoalie: 1, etransferPhone: 'other' });
    await store.savePlayerDues(env.DB, L, SEASON, 'P9001', { customDue: 1, amountPaid: 999, notes: 'other league' });
    await store.saveSeasonCost(env.DB, L, { id: 'c-other', season: SEASON, category: 'rental', description: 'Other ice', amount: 7 });
  };
  return { post, otherLeagueWrites };
}

// What SMBHL reads from the finance tables, as numbers.
async function smbhlDigest(post) {
  const data = await (await SELF.fetch(`http://example.com/admin/finances/data?s=${encodeURIComponent(SEASON)}`, { headers: { 'x-admin': env.ADMIN_KEY } })).json();
  const players = data.players.map(p => [p.player_id, p.is_sub, p.games_played, p.total_due, p.amount_paid, p.outstanding, p.credit || 0, p.status]).sort((a, b) => a[0] < b[0] ? -1 : 1);
  const samples = await (await post('/api/send-sample-invites', { event_id: '2026-09-13', reg_player_id: 'P9004', sub_player_id: 'P9006' })).json();
  await post('/admin/season/config', { seasonName: 'Winter 2027', fees: { regularDues: 240, subFee: 18 } });
  const hub = await env.DB.prepare(`SELECT price_player, price_goalie, price_sub_player, price_sub_goalie, etransfer_phone FROM season_pricing WHERE season = 'Winter 2027' AND league_id = 'smbhl'`).first();
  return {
    seasons: [...data.allSeasons].sort(), pricing: [data.pricing.price_player, data.pricing.price_goalie, data.pricing.price_sub_player, data.pricing.price_sub_goalie, data.pricing.etransfer_phone],
    summary: data.summary, costSummary: data.costSummary, costs: data.costs.map(c => [c.id, c.category, c.amount]).sort(),
    players, samples: (samples.sent_samples || []).map(r => [r.type, r.balance]), hub
  };
}

// Recorded on the code and schema BEFORE this change (git stash of src/ and
// migrate-054.sql; this fixture without the other league's writes, which
// that code could not scope). It must not move.
const SMBHL_DIGEST = { "seasons": [ "Fall 2026" ], "pricing": [ 220, 0, 15, 0, "514-000-0000" ], "summary": { "totalDue": 915, "totalPaid": 390, "totalOutstanding": 565, "totalCredit": 40, "totalCosts": 1280.5, "netBalance": -890.5, "netProjected": -365.5, "countPaid": 3, "countUnpaid": 5, "countTotal": 8 }, "costSummary": { "rental": 1200, "equipment": 80.5, "technology": 0, "other": 0, "totalCosts": 1280.5 }, "costs": [ [ "c-ice", "rental", 1200 ], [ "c-pucks", "equipment", 80.5 ] ], "players": [ [ "P9001", false, 4, 220, 0, 220, 0, "unpaid" ], [ "P9002", false, 4, 150, 0, 150, 0, "unpaid" ], [ "P9003", false, 2, 220, 260, -40, 40, "paid" ], [ "P9004", false, 4, 220, 100, 120, 0, "partial" ], [ "P9005", false, 4, 0, 0, 0, 0, "exempt" ], [ "P9006", true, 3, 45, 0, 45, 0, "unpaid" ], [ "P9007", true, 4, 60, 30, 30, 0, "partial" ], [ "P9008", true, 2, 0, 0, 0, 0, "exempt" ] ], "samples": [ [ "regular", 120 ], [ "sub", 45 ] ], "hub": { "price_player": 240, "price_goalie": 0, "price_sub_player": 18, "price_sub_goalie": 0, "etransfer_phone": null } };

describe('SMBHL behaves exactly as before', () => {
  it('finance page, invite / game-day balances and the season hub\'s pricing write: the recorded numbers, with another league\'s same-season rows beside them', async () => {
    // The baseline was recorded with SMBHL alone (the code before could
    // not keep another league out: its player showed on this page, charged
    // $220); now the other league's same-season rows are there too.
    const { post, otherLeagueWrites } = await smbhlFixture({ otherLeague: !!SMBHL_DIGEST });
    await otherLeagueWrites();
    const digest = await smbhlDigest(post);
    if (!SMBHL_DIGEST) throw new Error('DIGEST ' + JSON.stringify(digest));
    expect(digest).toEqual(SMBHL_DIGEST);
  });
});

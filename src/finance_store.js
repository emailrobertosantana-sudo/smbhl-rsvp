// Every read and write of the finance tables -- season_pricing,
// player_dues, season_costs -- goes through here, and every one is scoped
// by league. Before migrate-054 the tables were keyed by season alone
// (pricing) and by (season, player) (dues), and no query filtered by
// league_id: two leagues with a season of the same name shared one
// pricing row, and a league's invite and game-day emails read SMBHL's
// prices and dues whenever its season name matched one of SMBHL's.
// test/part177_finance_scoping.spec.js checks that no finance SQL is
// written anywhere else.
//
// Upserts use a final ON CONFLICT DO UPDATE with no target: it matches
// whatever the table's key is, so this code runs the same against the
// tables before migrate-054 (keyed by season) and after (keyed by league
// and season) -- the code and the migration can be deployed in either
// order.

// ---- season_pricing: one row per league and season ----

export async function getSeasonPricing(db, leagueId, season) {
  if (!season) return null;
  return db.prepare('SELECT * FROM season_pricing WHERE league_id = ? AND season = ?').bind(leagueId, season).first();
}

export async function listPricingSeasons(db, leagueId) {
  return ((await db.prepare('SELECT DISTINCT season FROM season_pricing WHERE league_id = ?').bind(leagueId).all()).results || []).map(r => r.season);
}

// Every price column, as the finance page saves them.
export async function saveSeasonPricing(db, leagueId, season, { pricePlayer, priceGoalie, priceSubPlayer, priceSubGoalie, etransferPhone }, now = new Date().toISOString()) {
  await db.prepare(
    `INSERT INTO season_pricing (league_id, season, price_player, price_goalie, price_sub_player, price_sub_goalie, etransfer_phone, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET
       price_player = excluded.price_player,
       price_goalie = excluded.price_goalie,
       price_sub_player = excluded.price_sub_player,
       price_sub_goalie = excluded.price_sub_goalie,
       etransfer_phone = excluded.etransfer_phone,
       updated_at = excluded.updated_at`
  ).bind(leagueId, season, pricePlayer, priceGoalie, priceSubPlayer, priceSubGoalie, etransferPhone, now).run();
}

// A league season's prices and pricing mode (the league product's
// Finances page, migrate-055): 'season' -- regulars pay the season fee,
// subs per game; 'per_game' -- everyone per game (the per-game prices are
// price_sub_player / price_sub_goalie either way).
export async function saveLeagueSeasonPricing(db, leagueId, season, { mode, pricePlayer, priceGoalie, pricePerGamePlayer, pricePerGameGoalie }, now = new Date().toISOString()) {
  await db.prepare(
    `INSERT INTO season_pricing (league_id, season, pricing_mode, price_player, price_goalie, price_sub_player, price_sub_goalie, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET
       pricing_mode = excluded.pricing_mode,
       price_player = excluded.price_player,
       price_goalie = excluded.price_goalie,
       price_sub_player = excluded.price_sub_player,
       price_sub_goalie = excluded.price_sub_goalie,
       updated_at = excluded.updated_at`
  ).bind(leagueId, season, mode, pricePlayer, priceGoalie, pricePerGamePlayer, pricePerGameGoalie, now).run();
}

// The regular and sub player prices only (SMBHL's season hub): a new row
// gets 0 for the goalie prices; an existing row keeps its goalie prices
// and e-transfer phone.
export async function saveSeasonPlayerPrices(db, leagueId, season, pricePlayer, priceSubPlayer) {
  await db.prepare(
    `INSERT INTO season_pricing (league_id, season, price_player, price_goalie, price_sub_player, price_sub_goalie, updated_at)
     VALUES (?, ?, ?, 0, ?, 0, datetime('now'))
     ON CONFLICT DO UPDATE SET
       price_player = excluded.price_player,
       price_sub_player = excluded.price_sub_player,
       updated_at = excluded.updated_at`
  ).bind(leagueId, season, pricePlayer, priceSubPlayer).run();
}

// ---- player_dues: one row per league, season and player ----

export async function getPlayerDues(db, leagueId, season, playerId) {
  if (!season || !playerId) return null;
  return db.prepare('SELECT * FROM player_dues WHERE league_id = ? AND season = ? AND player_id = ?').bind(leagueId, season, playerId).first();
}

export async function listSeasonDues(db, leagueId, season) {
  return (await db.prepare('SELECT * FROM player_dues WHERE league_id = ? AND season = ?').bind(leagueId, season).all()).results || [];
}

// custom_due (null: the price applies), amount_paid, notes; adjustment is
// reset to 0 and settled_nights left as it is, as the finance page always
// saved them.
export async function savePlayerDues(db, leagueId, season, playerId, { customDue, amountPaid, notes }, now = new Date().toISOString()) {
  await db.prepare(
    `INSERT INTO player_dues (league_id, season, player_id, custom_due, adjustment, amount_paid, notes, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT DO UPDATE SET
       custom_due = excluded.custom_due,
       adjustment = 0,
       amount_paid = excluded.amount_paid,
       notes = excluded.notes,
       updated_at = excluded.updated_at`
  ).bind(leagueId, season, playerId, customDue, amountPaid, notes, now).run();
}

// ---- season_costs: keyed by id, always read and changed within a league ----

export async function listSeasonCosts(db, leagueId, season) {
  return (await db.prepare(
    'SELECT id, season, category, description, amount, created_at FROM season_costs WHERE league_id = ? AND season = ? ORDER BY created_at DESC'
  ).bind(leagueId, season).all()).results || [];
}

// A cost with an id that belongs to another league is left alone (the
// update only applies within the same league).
export async function saveSeasonCost(db, leagueId, { id, season, category, description, amount }, now = new Date().toISOString()) {
  await db.prepare(
    `INSERT INTO season_costs (id, league_id, season, category, description, amount, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       category = excluded.category,
       description = excluded.description,
       amount = excluded.amount,
       updated_at = excluded.updated_at
     WHERE season_costs.league_id = excluded.league_id`
  ).bind(id, leagueId, season, category, description, amount, now, now).run();
}

export async function deleteSeasonCost(db, leagueId, id, season = null) {
  if (season) {
    await db.prepare('DELETE FROM season_costs WHERE league_id = ? AND id = ? AND season = ?').bind(leagueId, id, season).run();
  } else {
    await db.prepare('DELETE FROM season_costs WHERE league_id = ? AND id = ?').bind(leagueId, id).run();
  }
}

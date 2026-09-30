// The dues rules, shared by SMBHL's finance page and the league product's
// (the rules only -- where games played and prices come from differs).
//
// A player's base price: a regular pays the season fee (goalie or player
// price); a sub pays games played x the per-game price. A league season
// in 'per_game' mode charges everyone per game. A custom due, when set,
// replaces the base price (never below 0). Then:
//   outstanding = due - paid (negative: overpaid)
//   credit      = what was paid beyond the due (owed back to the player,
//                 never shown as 0)
//   status      = 'exempt' (nothing due) | 'paid' | 'partial' (paid
//                 something, not all) | 'unpaid'

export const PRICING_MODES = ['season', 'per_game'];

export function basePriceFor({ isSub, isGoalie, gamesPlayed, pricing, mode = 'season' }) {
  const games = Number(gamesPlayed || 0);
  const perGame = isGoalie ? Number(pricing.price_sub_goalie || 0) : Number(pricing.price_sub_player || 0);
  if (mode === 'per_game' || isSub) return games * perGame;
  return isGoalie ? Number(pricing.price_goalie || 0) : Number(pricing.price_player || 0);
}

export function settleDues({ basePrice, customDue, amountPaid }) {
  const custom = (customDue !== null && customDue !== undefined && customDue !== '') ? Number(customDue) : null;
  const totalDue = custom !== null ? Math.max(0, custom) : basePrice;
  const paid = Number(amountPaid || 0);
  const outstanding = totalDue - paid;
  const credit = Math.max(0, paid - totalDue);
  let status = 'unpaid';
  if (totalDue === 0) status = 'exempt';
  else if (paid >= totalDue) status = 'paid';
  else if (paid > 0) status = 'partial';
  return { customDue: custom, totalDue, amountPaid: paid, outstanding, credit, status };
}

// The season's totals, as both pages show them.
export function financeSummary(players, costs) {
  const totalCosts = costs.reduce((sum, c) => sum + Number(c.amount || 0), 0);
  const totalDue = players.reduce((sum, p) => sum + p.total_due, 0);
  const totalPaid = players.reduce((sum, p) => sum + p.amount_paid, 0);
  return {
    totalDue,
    totalPaid,
    totalOutstanding: players.reduce((sum, p) => sum + Math.max(0, p.outstanding), 0),
    totalCredit: players.reduce((sum, p) => sum + (p.credit || 0), 0),
    totalCosts,
    netBalance: totalPaid - totalCosts,
    netProjected: totalDue - totalCosts,
    countPaid: players.filter(p => p.status === 'paid' || p.status === 'exempt').length,
    countUnpaid: players.filter(p => p.status === 'unpaid' || p.status === 'partial').length,
    countTotal: players.length
  };
}

export const COST_CATEGORIES = ['rental', 'equipment', 'technology', 'other'];
export function costSummary(costs) {
  const byCat = cat => costs.filter(c => c.category === cat).reduce((sum, c) => sum + Number(c.amount || 0), 0);
  return { rental: byCat('rental'), equipment: byCat('equipment'), technology: byCat('technology'), other: byCat('other'), totalCosts: costs.reduce((sum, c) => sum + Number(c.amount || 0), 0) };
}

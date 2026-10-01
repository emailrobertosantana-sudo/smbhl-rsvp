// How long before a game a Notre Ligue league's subs may be called: a
// league setting, 72 hours unless the league chose otherwise.
//
// Before this setting, every league called subs as soon as a game within
// 8 days (SHORTFALL_HORIZON_HOURS, 192 h, src/index.js) was short at a
// position. SMBHL keeps exactly that: it is never read for a window.
//
// Only the automatic calls wait for the window (a game short at a cron
// pass, a player dropping out, a sub just added or made a sub). An admin's
// own "Invite players" or "Invite a goalie" on a game's page calls at once,
// whatever the window.
//
// Stored in the settings table, one row per league (no column, no
// migration), removed with the league (src/hard_delete.js):
//   key    league_sub_calls:<league id>
//   value  { "hours": 72 }
// The choices go up to 192 hours: the cron never looks further ahead.
export const SUB_CALL_HOURS_DEFAULT = 72;
export const SUB_CALL_HOURS_CHOICES = [24, 48, 72, 96, 168, 192];
export const subCallsKey = leagueId => `league_sub_calls:${leagueId}`;

export async function getSubCallHours(db, leagueId) {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(subCallsKey(leagueId)).first();
    const h = row && row.value ? Number(JSON.parse(row.value).hours) : NaN;
    if (SUB_CALL_HOURS_CHOICES.includes(h)) return h;
  } catch (_) {}
  return SUB_CALL_HOURS_DEFAULT;
}

export async function saveSubCallHours(db, leagueId, hours) {
  await db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(subCallsKey(leagueId), JSON.stringify({ hours })).run();
}

// The window in words: "72 heures" / "72 hours" up to 72, then days
// ("4 jours", "7 jours", "8 jours").
export function subCallWindowText(hours, lang) {
  if (hours <= 72) return lang === 'en' ? `${hours} hours` : `${hours} heures`;
  const days = Math.round(hours / 24);
  return lang === 'en' ? `${days} days` : `${days} jours`;
}

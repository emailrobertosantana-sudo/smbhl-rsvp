// Hard bounces, per league contact (season simulation, 2026-10-02, problem
// C1: a refused address got 32 emails over a season, and the admin a daily
// "1 email could not be sent" that never said whose). After
// BOUNCE_STOP_AFTER hard bounces to the address on file, nothing more is
// sent to it; the players page flags the player for the admin, who fixes
// the address (a new address starts clean) or clears the flag.
//
// Kept in `settings` (no migration): key bounce:<player_id>, value
// { address, count, last }, league_id the league (a league's deletion
// removes it). League contacts only; SMBHL is never read or written.
import { SMBHL_LEAGUE_ID } from './league_ids.js';

export const BOUNCE_STOP_AFTER = 2;
// A permanent failure that means the address itself is refused.
export const BOUNCE_ERROR = /^resend 4(00|04|09|22)|^cloudflare: .*(suppress|invalid recipient|recipient.*(not allowed|rejected)|not a valid)|invalid email format/i;
export const isBounceError = msg => BOUNCE_ERROR.test(String(msg || ''));

const key = playerId => `bounce:${playerId}`;
const parse = v => { try { return JSON.parse(v); } catch (_) { return null; } };
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const isLeague = id => !!id && id !== 'system' && id !== SMBHL_LEAGUE_ID;

// After a send to a league contact failed for good with a bounce.
export async function recordBounce(db, leagueId, playerId, address, now = new Date()) {
  if (!isLeague(leagueId) || !playerId || !address) return null;
  const prev = parse((await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key(playerId)).first() || {}).value);
  const count = prev && same(prev.address, address) ? Number(prev.count || 0) + 1 : 1;
  const v = { address: String(address).trim().toLowerCase(), count, last: now.toISOString() };
  await db.prepare('INSERT INTO settings (key, value, league_id) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key(playerId), JSON.stringify(v), leagueId).run();
  return v;
}

// Whether the contact's current address is stopped (bounced
// BOUNCE_STOP_AFTER times). A changed address is not.
export async function addressStopped(db, playerId, currentEmail) {
  if (!playerId || !currentEmail) return false;
  const v = parse((await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key(playerId)).first() || {}).value);
  return !!(v && same(v.address, currentEmail) && Number(v.count) >= BOUNCE_STOP_AFTER);
}

// The league's stopped contacts: Set of player ids whose current address
// is stopped. For the players page and the broadcast.
export async function stoppedContacts(db, leagueId) {
  const rows = (await db.prepare(
    `SELECT s.key, s.value, c.email FROM settings s JOIN contacts c ON c.player_id = substr(s.key, 8)
      WHERE s.league_id = ? AND substr(s.key, 1, 7) = 'bounce:'`
  ).bind(leagueId).all()).results || [];
  const out = new Set();
  for (const r of rows) {
    const v = parse(r.value);
    if (v && same(v.address, r.email) && Number(v.count) >= BOUNCE_STOP_AFTER) out.add(r.key.slice(7));
  }
  return out;
}

// The admin cleared the flag (the address is right after all).
export async function clearBounce(db, leagueId, playerId) {
  const r = await db.prepare('DELETE FROM settings WHERE key = ? AND league_id = ?').bind(key(playerId), leagueId).run();
  return (r && r.meta && r.meta.changes) || 0;
}

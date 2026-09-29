// Nights (D1, decided 2026-09-30): a league's games on the same day form a
// NIGHT, played by one group of players. Which of a night's games overlap
// decides where a player can be: games that overlap (two at 10:30) split
// the group, games that follow each other (10:30 then 11:30) take all of
// it. This file is the pure part -- times, overlap, clusters; the reads
// and writes are in index.js (writeLeagueNightStatus and its guards).
//
// Hourly pickup with a different group at each hour is out of scope: a
// night is one group.

// 'HH:MM' -> minutes since midnight, or null.
export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// A game's time on its day, in minutes: { start, end }. An end at or before
// the start is the next day (23:30 to 00:30). No end: end is null (a game
// created before end times were required). No start: null.
export function gameInterval(ev) {
  const start = toMinutes(ev && ev.start_time);
  if (start == null) return null;
  let end = toMinutes(ev.end_time);
  if (end != null && end <= start) end += 1440;
  return { start, end };
}

// Two games of the same day overlap when each starts before the other
// ends. A game with no end time (created before they were required)
// overlaps another only when both start at the same time -- the same rule
// the matchup planner has always used (groupNights) -- and a game with no
// start time overlaps nothing.
export function gamesOverlap(a, b) {
  if (!a || !b || a.id === b.id || a.date !== b.date) return false;
  const x = gameInterval(a), y = gameInterval(b);
  if (!x || !y) return false;
  if (x.end == null || y.end == null) return x.start === y.start;
  return x.start < y.end && y.start < x.end;
}

// Time order within a night: start time, then id (stable).
export function byStart(a, b) {
  const x = gameInterval(a), y = gameInterval(b);
  const sa = x ? x.start : 1e9, sb = y ? y.start : 1e9;
  if (sa !== sb) return sa - sb;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

// The night's games split into clusters of games that overlap, directly or
// through another game (10:00-11:00, 10:30-11:30 and 11:15-12:00 are one
// cluster). Each cluster is in time order, and the clusters too. A player
// is in at most one game per cluster; back-to-back games are separate
// clusters, so a player can be in each.
export function concurrencyClusters(games) {
  const list = [...games].sort(byStart);
  const parent = list.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      if (gamesOverlap(list[i], list[j])) parent[find(j)] = find(i);
  const groups = new Map();
  list.forEach((g, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(g);
  });
  return [...groups.values()];
}

// The games of `games` that overlap `ev`.
export function overlappingGames(ev, games) {
  return games.filter(g => gamesOverlap(ev, g));
}

// Another of the league's games that night, overlapping `game`, that one of
// `teams` already plays -- a team can't play two games at once.
export async function teamClash(db, leagueId, game, teams) {
  const others = (await db.prepare(
    `SELECT * FROM events WHERE league_id = ? AND date = ? AND id != ? AND state != 'cancelled'`
  ).bind(leagueId, game.date, game.id).all()).results || [];
  return others.find(o => gamesOverlap(game, o) && o.home_team && o.away_team
    && teams.some(t => t === o.home_team || t === o.away_team)) || null;
}

// The players who are in `game` and in another game that would overlap it
// with `game`'s times as given (an edit is checked before it is saved).
export async function doubleBookedPlayers(db, leagueId, game) {
  const others = ((await db.prepare(
    `SELECT * FROM events WHERE league_id = ? AND date = ? AND id != ? AND state != 'cancelled'`
  ).bind(leagueId, game.date, game.id).all()).results || []).filter(o => gamesOverlap(game, o));
  if (!others.length) return [];
  return ((await db.prepare(
    `SELECT DISTINCT c.name FROM rsvp a
       JOIN rsvp b ON b.player_id = a.player_id
       JOIN contacts c ON c.player_id = a.player_id
      WHERE a.event_id = ? AND a.status = 'in' AND b.status = 'in'
        AND b.event_id IN (${others.map(() => '?').join(',')})
      ORDER BY c.name`
  ).bind(game.id, ...others.map(o => o.id)).all()).results || []).map(r => r.name);
}

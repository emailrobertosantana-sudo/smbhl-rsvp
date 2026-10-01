// For tests written before Notre Ligue's sub-call window (src/
// sub_call_window.js, 72 hours by default). They test something else
// (identity, the duplicate guard, waves, quiet hours...) with games several
// days out. The window itself is tested in test/part192_sub_call_window.spec.js.
import { eventStart } from '../../src/league_ids.js';

// Every league the test database creates gets the window those tests were
// written for, 192 hours (the 8-day horizon): a trigger, so it applies
// however and whenever the test creates a league.
export async function wideSubCallWindow(env) {
  await env.DB.prepare(
    `CREATE TRIGGER IF NOT EXISTS test_wide_sub_call_window AFTER INSERT ON leagues
     BEGIN
       INSERT OR REPLACE INTO settings (key, value) VALUES ('league_sub_calls:' || NEW.id, '{"hours":192}');
     END`
  ).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO settings (key, value) SELECT 'league_sub_calls:' || id, '{"hours":192}' FROM leagues`
  ).run();
}

// For a test that creates a game beyond the window (so creating it calls
// nobody) and then tests what a player dropping out does: a drop-out calls
// subs only inside the league's window, so the clock moves to hoursBefore
// the game's real start (eventStart: the date in the event id plus its
// start time; moving the date column alone changes nothing). The test
// restores real timers after.
export async function clockIntoWindow(vi, env, eventId, hoursBefore = 100) {
  const ev = await env.DB.prepare('SELECT id, start_time FROM events WHERE id = ?').bind(eventId).first();
  const start = eventStart(ev);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(start.getTime() - hoursBefore * 3600000));
}

// A date (YYYY-MM-DD, Montreal) n days from now: for a test whose drop-out
// must call subs, inside the league's window.
export function daysFromNow(n) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(Date.now() + n * 86400000)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

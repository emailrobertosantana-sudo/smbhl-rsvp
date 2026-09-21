/* Creates one game night in the database: the event row, plus a pending
   RSVP row for every rostered player, with their team.

   Usage:  node make-event-sql.js 2          (2 = week number)
   Needs:  data.json in this folder
   Output: event-week2.sql
*/
const fs = require('fs');
const week = parseInt(process.argv[2], 10);
if (!week) { console.error('Usage: node make-event-sql.js <week>'); process.exit(1); }
if (!fs.existsSync('data.json')) { console.error('data.json not found in this folder.'); process.exit(1); }

const d = JSON.parse(fs.readFileSync('data.json', 'utf8'));
const seasonName = d.current_season;
const season = d.seasons.find(s => s.name === seasonName);
if (!season) { console.error('season not found: ' + seasonName); process.exit(1); }

const fx = (season.fixtures || []).filter(f => f.week === week);
if (!fx.length) { console.error('No fixtures for week ' + week); process.exit(1); }

// id is the calendar date, e.g. 2026-09-20 — parsed from "Sunday September 20, 2026"
const label = fx[0].date;
const dt = new Date(label.replace(/^[A-Za-z]+\s+/, ''));
if (isNaN(dt)) { console.error('Could not parse date: ' + label); process.exit(1); }
const id = dt.getFullYear() + '-' +
  String(dt.getMonth() + 1).padStart(2, '0') + '-' +
  String(dt.getDate()).padStart(2, '0');

const q = s => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
const now = new Date().toISOString();
const out = [`-- week ${week}, ${label}`];

// time window for the night: earliest start, latest finish across the week's
// fixtures. Both gyms run at once, so this is one window for all four teams.
// Stored per event, not hardcoded — a week with different hours just works.
function toMin(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(t || '').trim());
  if (!m) return null;
  let h = +m[1]; const ap = m[3].toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + (+m[2]);
}
const times = fx.map(f => toMin(f.time)).filter(t => t !== null);
const startMin = times.length ? Math.min(...times) : null;
// a slot is one hour; the night ends an hour after the last one starts
const endMin = times.length ? Math.max(...times) + 60 : null;
const fmt = m => m === null ? null :
  String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const startT = fmt(startMin), endT = fmt(endMin);

out.push(`INSERT INTO events (id,season,week,date,venue,state,start_time,end_time) VALUES (` +
  `${q(id)},${q(seasonName)},${week},${q(label)},${q(fx[0].venue || '')},'open',` +
  `${startT ? q(startT) : 'NULL'},${endT ? q(endT) : 'NULL'}) ` +
  `ON CONFLICT(id) DO UPDATE SET date=excluded.date, venue=excluded.venue, ` +
  `start_time=excluded.start_time, end_time=excluded.end_time;`);

const seen = new Set();
let n = 0;
for (const p of d.players) {
  const v = p.seasons[seasonName];
  const g = (p.gseasons || {})[seasonName];
  const team = (v && v.team) || (g && g.team);
  if (!team || seen.has(p.id)) continue;
  seen.add(p.id);
  out.push(`INSERT INTO rsvp (event_id,player_id,team,status,role,status_by,updated_at) VALUES (` +
    `${q(id)},${q(p.id)},${q(team)},'pending','roster','auto',${q(now)}) ` +
    `ON CONFLICT(event_id,player_id) DO NOTHING;`);
  n++;
}

const file = `event-week${week}.sql`;
fs.writeFileSync(file, out.join('\n') + '\n');
console.log('');
console.log('  ' + file + ' written');
console.log('  event ' + id + ' — ' + label + ' — ' + (startT ? startT + ' to ' + endT + ' — ' : '') + n + ' rostered players');
console.log('');
console.log('  Load it with:');
console.log('    npx wrangler d1 execute smbhl-rsvp --remote --file=./' + file);
console.log('');

// Sub-call rework, Part 2: wave size scales with urgency.
//
// Early in the week subs are called in waves of 5, an hour apart. Inside
// 48 hours of the game (was 12) every eligible sub is called at once --
// a Friday cancellation before a Sunday game must not wait for most of a
// day of hourly waves to work through the pool.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const ADMIN_KEY = 'test-part105-admin';

// Eastern wall-clock date/time `h` hours from now, so eventStart() maps back to it.
function eastern(h) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(Date.now() + h * 3600000));
  const g = t => parts.find(p => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}
// eventStart() reads the date from the event id's trailing YYYY-MM-DD.
async function eventHoursOut(prefix, h) {
  const { date, time } = eastern(h);
  const id = `${prefix}:${date}`;
  await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, 'Fall 2026', 5, 'open', ?, 'smbhl')`)
    .bind(id, date, time).run();
  return id;
}
async function callSubsFor(eventId) {
  const res = await SELF.fetch('http://example.com/admin/subs/call', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin': ADMIN_KEY },
    body: JSON.stringify({ event_id: eventId, team: 'Red', need: 'skater' })
  });
  expect(res.status).toBe(200);
  const rows = (await env.DB.prepare(`SELECT send_after FROM outbox WHERE event_id = ? AND kind = 'sub_call' ORDER BY id`).bind(eventId).all()).results;
  const t0 = new Date(rows[0].send_after).getTime();
  return rows.map(r => Math.round((new Date(r.send_after).getTime() - t0) / 60000));
}

beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  env.RSVP_SECRET = 'test-part105-rsvp';
  await applyRealSchema(env);
  // Quiet hours would push every wave to 07:00 when the suite runs at night.
  await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('email_cadence_settings', ?)`)
    .bind(JSON.stringify({ quiet_hours_enabled: false })).run();
  for (let i = 1; i <= 12; i++) {
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, 'sub_skater', 1, 0, 'salt', 'smbhl')`)
      .bind(`S105${String(i).padStart(2, '0')}`, `Sub ${i}`, `s105.${i}@example.com`).run();
  }
});

describe('Sub-call waves scale with urgency (48-hour boundary)', () => {
  it('more than 48 hours out: waves of 5, an hour apart', async () => {
    const offsets = await callSubsFor(await eventHoursOut('p105-early', 48.5));
    expect(offsets).toEqual([0, 0, 0, 0, 0, 60, 60, 60, 60, 60, 120, 120]);
  });

  it('inside 48 hours: every eligible sub is called at once', async () => {
    const offsets = await callSubsFor(await eventHoursOut('p105-urgent', 47.5));
    expect(offsets).toEqual(new Array(12).fill(0));
  });
});

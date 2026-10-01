// One cron pass reads each league row, capability flag and league
// data.json once (src/pass_cache.js), and a sub pool that came back empty
// for one team of a game is not read again for the next team. Measured
// on demo's data before this: the same league row loaded 4 times a pass
// and its data.json 4 times; with six busy leagues, 153 queries a pass,
// 45 of them exact repeats. The cache is per pass: env itself never
// carries it, so a request always reads the database as it is.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { wideSubCallWindow } from './support/wide_sub_call_window.js'; // the 8-day sub-call window these tests were written for
import { runCronPass } from '../src/index.js';
import { withPassCache, passCached } from '../src/pass_cache.js';
import { hasCapability } from '../src/super_admin.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.150.${++ip}` },
    body: JSON.stringify({ accept_terms: true, email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = async (s, path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
function montreal(hoursAhead) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(Date.now() + hoursAhead * 3600000));
  const g = t => parts.find(p => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}

// A league with three teams, nobody on them, three games inside the
// shortfall window (every team short in every game) and `subs` subs.
async function league(tag, subs = 0) {
  const s = await signup(`p150.${tag}@example.com`);
  const lg = (await (await post(s, '/leagues/create', { name: `P150 ${tag}`, teamNames: ['Red', 'Blue', 'White'] })).json()).league;
  await post(s, '/league/season/publish', { season_name: 'S1' });
  for (let n = 1; n <= subs; n++) {
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id, is_active) VALUES (?, ?, ?, 'sub_skater', 1, 0, 's', ?, 1)`)
      .bind(`${lg.id}:SUB${n}`, `Sub ${n}`, `p150.${tag}.sub${n}@example.com`, lg.id).run();
  }
  const events = [];
  for (const [i, h] of [[1, 100], [2, 130], [3, 160]]) {
    const { date, time } = montreal(h);
    const id = `${lg.id}:g${i}:${date}`;
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, auto_reminders_enabled) VALUES (?, 'S1', ?, ?, 'Gym', 'open', ?, ?, 1)`)
      .bind(id, i, date, time, lg.id).run();
    events.push(id);
  }
  return { s, id: lg.id, events };
}

// env with every D1 statement and KV read counted.
function countingEnv() {
  const sql = [], kv = [];
  const e = Object.create(env);
  const own = (k, v) => Object.defineProperty(e, k, { value: v, enumerable: true }); // not through env
  own('LEAGUE_PRODUCT', 'true');
  own('HEALTH_ALERTS', 'off');
  own('DB', new Proxy(env.DB, { get: (t, k) => k === 'prepare' ? (q => { sql.push(q.replace(/\s+/g, ' ').trim()); return t.prepare(q); }) : (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }));
  own('SHEETS_KV', new Proxy(env.SHEETS_KV, { get: (t, k) => k === 'get' ? ((key, ...r) => { kv.push(key); return t.get(key, ...r); }) : (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }));
  return { e, sql, kv };
}
const n = (list, re) => list.filter(q => re.test(q)).length;

beforeAll(async () => {
  env.AUTH_SECRET = 'p150-auth'; env.RSVP_SECRET = 'p150';
  await applyRealSchema(env); await wideSubCallWindow(env);
});

describe('The pass cache', () => {
  it('lives on a per-pass copy of env only; a failed load is not kept', async () => {
    const passEnv = withPassCache(env);
    expect(passEnv.DB).toBe(env.DB);
    expect(env.passCache).toBeUndefined();
    let loads = 0;
    expect(await passCached(passEnv, 'k', async () => ++loads)).toBe(1);
    expect(await passCached(passEnv, 'k', async () => ++loads)).toBe(1);
    expect(await passCached(env, 'k', async () => ++loads)).toBe(2); // no cache outside a pass
    await expect(passCached(passEnv, 'bad', async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(await passCached(passEnv, 'bad', async () => 'ok')).toBe('ok');
  });

  it('one cron pass reads the league row, each flag and the league data.json once', async () => {
    const lg = await league('once');
    const { e, sql, kv } = countingEnv();
    await runCronPass(e);
    expect(n(sql, /FROM leagues l LEFT JOIN users u ON u.id = l.created_by WHERE l.id = \?/)).toBe(1);
    const flagReads = n(sql, /SELECT enabled FROM league_capability_flags WHERE league_id = \? AND flag_key = \?/);
    expect(flagReads).toBeGreaterThan(0);
    expect(flagReads).toBeLessThanOrEqual(2); // one per flag the pass asks about
    expect(kv.filter(k => k === `data_json:${lg.id}`).length).toBe(1);
    // 3 games x 3 empty teams x 2 needs: the empty pool is read once per game and need.
    expect(n(sql, /FROM contacts c WHERE c.role = 'sub_skater' AND c.is_goalie (= 1|!= 1) AND c.league_id = \?/)).toBe(3 * 2);
  });

  it('a request after the pass reads the database as it is now, not the pass copy', async () => {
    const lg = await league('fresh');
    const { e } = countingEnv();
    await runCronPass(e);
    expect(env.passCache).toBeUndefined();
    expect(e.passCache).toBeUndefined();
    const before = await hasCapability(env, lg.id, 'advanced_reminders');
    await env.DB.prepare(`INSERT INTO league_capability_flags (league_id, flag_key, enabled, updated_at) VALUES (?, 'advanced_reminders', ?, ?) ON CONFLICT(league_id, flag_key) DO UPDATE SET enabled = excluded.enabled`)
      .bind(lg.id, before ? 0 : 1, new Date().toISOString()).run();
    expect(await hasCapability(env, lg.id, 'advanced_reminders')).toBe(!before);
  });

  it('a pool with subs in it is still read for every team: the first short team calls them, the next finds them already called (as before)', async () => {
    const lg = await league('subs', 2);
    const { e } = countingEnv();
    await runCronPass(e);
    const rows = (await env.DB.prepare(`SELECT event_id, team, player_id FROM outbox WHERE league_id = ? AND kind = 'sub_call' ORDER BY event_id, id`).bind(lg.id).all()).results;
    // Each game: the two subs, called once, for the first short team.
    for (const ev of lg.events) {
      const forEv = rows.filter(r => r.event_id === ev);
      expect(forEv.map(r => r.player_id).sort()).toEqual([`${lg.id}:SUB1`, `${lg.id}:SUB2`]);
      expect(new Set(forEv.map(r => r.team)).size).toBe(1);
    }
  });
});

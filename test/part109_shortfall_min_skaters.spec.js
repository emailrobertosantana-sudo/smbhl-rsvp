// Shortfall trigger: SMBHL's default skater minimum is 7, not 5.
//
// SMBHL's Fall 2026 season has no config, so it runs on defaults. The
// shortfall trigger ("can this team field a game") now uses 7 skaters for
// SMBHL when its season doesn't configure minSkaters. Everything else is
// unchanged: DEFAULT_SEASON_CONFIG.minSkaters stays 5 (it also drives the
// 36-hour check, the admin board, the public team page, and every league-
// product league with no config); the cancellation path still fills to
// skatersPerTeam (8); goaliesPerTeam stays 1; a configured value wins.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { runSchedule, teamState, runLeagueReminders } from '../src/index.js';
import { getSeasonConfig } from '../src/season_config.js';

async function withResend(fn) {
  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) { sent.push(JSON.parse(opts.body).to[0]); return new Response('{"id":"x"}', { status: 200 }); }
    return new Response('{}', { status: 200 });
  };
  try { return { result: await fn(), sent }; } finally { globalThis.fetch = original; }
}
function eastern(h) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(Date.now() + h * 3600000));
  const g = t => parts.find(p => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}
const skaterCalls = (eventId, team) => env.DB.prepare(
  `SELECT count(*) n FROM outbox WHERE event_id = ? AND team = ? AND kind = 'sub_call' AND json_extract(payload, '$.need') = 'skater'`
).bind(eventId, team).first().then(r => r.n);

// One SMBHL game: Red has 1 goalie + 6 skaters available, Blue 1 goalie + 7.
async function smbhlGame(prefix, season, hoursOut) {
  const { date, time } = eastern(hoursOut);
  const eventId = `${prefix}:${date}`;
  await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, ?, 3, 'open', ?, 'smbhl')`).bind(eventId, date, season, time).run();
  for (const [team, skaters] of [['Red', 6], ['Blue', 7]]) {
    const ids = [`${prefix}${team}G`, ...Array.from({ length: skaters }, (_, i) => `${prefix}${team}${i}`)];
    for (const [i, pid] of ids.entries()) {
      await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, 'roster', 0, ?, 's', 'smbhl')`).bind(pid, pid, `${pid.toLowerCase()}@example.com`, i === 0 ? 1 : 0).run();
      await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, ?, 'pending', 'roster', ?, 'smbhl')`).bind(eventId, pid, team, new Date().toISOString()).run();
    }
  }
  return eventId;
}

beforeAll(async () => {
  env.RSVP_SECRET = 'test-part109-rsvp';
  env.RESEND_API_KEY = 'test-part109-resend';
  env.AUTH_SECRET = 'test-part109-auth';
  await applyRealSchema(env);
  await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('email_cadence_settings', ?)`).bind(JSON.stringify({ quiet_hours_enabled: false })).run();
  for (let i = 1; i <= 3; i++) {
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, 'sub_skater', 1, 0, 's', 'smbhl')`).bind(`P109SUB${i}`, `Sub ${i}`, `p109.sub${i}@example.com`).run();
  }
});

describe('SMBHL (season with no config): the shortfall trigger needs 7 skaters', () => {
  it('a 6-skater team calls subs (it did not under the old 5); a 7-skater team does not', async () => {
    await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: 'Fall 2026', seasons: [{ name: 'Fall 2026', fixtures: [], standings: [] }] }));
    const eventId = await smbhlGame('A109', 'Fall 2026', 60);
    await withResend(() => runSchedule(env));
    expect(await skaterCalls(eventId, 'Red')).toBeGreaterThan(0);
    expect(await skaterCalls(eventId, 'Blue')).toBe(0);
  });

  it('the 36-hour check and the admin board still use minSkaters (5): 6 confirmed skaters is not short there', async () => {
    const cfg = getSeasonConfig({ name: 'Fall 2026', fixtures: [], standings: [] });
    expect(cfg.minSkaters).toBe(5);
    expect(cfg.minSkatersConfigured).toBeFalsy();
    const { date } = eastern(61);
    const eventId = `B109:${date}`;
    await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, 'Fall 2026', 3, 'open', '20:00', 'smbhl')`).bind(eventId, date).run();
    for (let i = 0; i < 7; i++) {
      await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, 'Red', 'in', 'roster', ?, 'smbhl')`).bind(eventId, `A109Red${i === 6 ? 'G' : i}`, new Date().toISOString()).run();
    }
    const st = await teamState(env.DB, eventId, 'Red', cfg);
    expect(st).toMatchObject({ goalies: 1, skaters: 6, shortSkaters: false, shortGoalie: false });
  });

  it('the cancellation path still fills to the full team (8): a skater declining from 8 to 7 calls subs', async () => {
    const { date, time } = eastern(62);
    const eventId = `C109:${date}`;
    await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, 'Fall 2026', 3, 'open', ?, 'smbhl')`).bind(eventId, date, time).run();
    const ids = ['C109G', ...Array.from({ length: 8 }, (_, i) => `C109S${i}`)];
    for (const [i, pid] of ids.entries()) {
      await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, 'roster', 0, ?, 's', 'smbhl')`).bind(pid, pid, `${pid.toLowerCase()}@example.com`, i === 0 ? 1 : 0).run();
      await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, 'Blue', 'in', 'roster', ?, 'smbhl')`).bind(eventId, pid, new Date().toISOString()).run();
    }
    const { hmac } = await import('../src/crypto_utils.js');
    const t = await hmac(env.RSVP_SECRET, `p:${eventId}:C109S0:s`);
    await withResend(() => SELF.fetch(`http://example.com/rsvp?e=${encodeURIComponent(eventId)}&p=C109S0&t=${t}&v=out`));
    // 7 skaters left: at the shortfall minimum, but the cancellation path
    // still wants the full 8 -- unchanged.
    expect(await skaterCalls(eventId, 'Blue')).toBeGreaterThan(0);
  });
});

describe('Configured values win; the league product keeps its default', () => {
  it('an SMBHL season with its own minSkaters (4) uses it: a 6-skater team is not short', async () => {
    const cfg = getSeasonConfig({ name: 'Configured', config: { minSkaters: 4 } });
    expect(cfg).toMatchObject({ minSkaters: 4, minSkatersConfigured: true });
    await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: 'Configured', seasons: [{ name: 'Configured', config: { teams: [{ name: 'Red' }, { name: 'Blue' }], minSkaters: 4 } }] }));
    const eventId = await smbhlGame('D109', 'Configured', 63);
    await withResend(() => runSchedule(env));
    expect(await skaterCalls(eventId, 'Red')).toBe(0);
  });

  function extractCookie(res) { return (res.headers.get('set-cookie') || '').split(';')[0]; }
  function extractCsrf(res) { const c = res.headers.getSetCookie().find(x => x.startsWith('csrf_token=')); return c ? c.split(';')[0].split('=')[1] : ''; }
  async function leagueWithTeamOf(tag, players, publish) {
    const s = await SELF.fetch('http://example.com/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.234.${tag}` }, body: JSON.stringify({ email: `p109.l${tag}@example.com`, password: 'a-strong-password-1' }) });
    const cookie = extractCookie(s), csrf = extractCsrf(s);
    const post = (p, b) => SELF.fetch('http://example.com' + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(b) });
    const league = (await (await post('/leagues/create', { name: `P109 L${tag}`, teamNames: ['Otters', 'Falcons'], tracksStats: true })).json()).league;
    await post('/league/season/publish', { season_name: 'S1', ...publish });
    for (let i = 0; i < players; i++) {
      for (const team of ['Otters', 'Falcons']) {
        const c = (await (await post('/league/contacts', { name: `L${tag} ${team} ${i}`, email: `p109.l${tag}.${team}.${i}@example.com`, role: 'roster' })).json()).contact;
        await env.DB.prepare(`UPDATE contacts SET preferred_team = ? WHERE player_id = ?`).bind(team, c.player_id).run();
      }
    }
    await post('/league/contacts', { name: `L${tag} Sub`, email: `p109.l${tag}.sub@example.com`, role: 'sub_skater' });
    const date = new Date(Date.now() + 4 * 24 * 3600000).toISOString().slice(0, 10);
    const ev = (await (await post('/league/events', { date, start_time: '20:00' })).json()).event;
    return { league, ev };
  }

  it('a league with no configured minimum still uses 5, not 7: a 5-player team is not short', async () => {
    const { ev } = await withResend(() => leagueWithTeamOf(1, 5, {})).then(r => r.result);
    await withResend(() => runLeagueReminders(env));
    expect(await skaterCalls(ev.id, 'Otters')).toBe(0);
  });

  it('a league with its own minimum (3) uses it', async () => {
    const { ev } = await withResend(() => leagueWithTeamOf(2, 3, { goalies_per_team: 0, skaters_per_team: 6, min_skaters: 3 })).then(r => r.result);
    await withResend(() => runLeagueReminders(env));
    expect(await skaterCalls(ev.id, 'Otters')).toBe(0);
  });
});

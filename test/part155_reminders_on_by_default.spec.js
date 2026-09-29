// D6 (decided 2026-09-29): reminders are ON for a new league -- one that
// never turned them on sent nothing, not even sub calls. The consequence
// checked: an import into a league with games near a reminder window would
// email the list at the next pass, so the import preview names those games
// (the create-game form already did) and can pause them first (rendered:
// test/rendered/league_admin_ui.spec.mjs, "Import, with reminders on").
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.155.${++ip}` }, body: JSON.stringify({ email, password: 'a-strong-password-1' }) });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = async (s, path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
function local(hoursAhead) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(Date.now() + hoursAhead * 3600000));
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}
async function importNotice(s) {
  const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie: s.cookie } })).text();
  return JSON.parse(html.match(/var IMPORT_REM_GAMES = (\[[\s\S]*?\]);\n/)[1].replace(/\\u003c/g, '<'));
}

beforeAll(async () => { env.AUTH_SECRET = 'p155-auth'; await applyRealSchema(env); });

describe('Reminders on by default', () => {
  it('a new league has all three reminders on', async () => {
    const s = await signup('p155.on@example.com');
    const id = (await (await post(s, '/leagues/create', { name: 'P155 On', teamNames: ['A', 'B'] })).json()).league.id;
    const row = await env.DB.prepare('SELECT reminder_72h_enabled a, reminder_24h_enabled b, reminder_12h_enabled c FROM leagues WHERE id = ?').bind(id).first();
    expect(row).toEqual({ a: 1, b: 1, c: 1 });
  });

  it('the import preview lists the games whose 72h/24h reminder would reach new players within 7 days', async () => {
    const s = await signup('p155.import@example.com');
    const id = (await (await post(s, '/leagues/create', { name: 'P155 Import', teamNames: ['A', 'B'] })).json()).league.id;
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const ins = async (tag, h, armed = 1) => { const { date, time } = local(h); const ev = `${id}:${tag}:${date}`; await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, auto_reminders_enabled) VALUES (?, 'S1', 1, ?, 'Gym', 'open', ?, ?, ?)`).bind(ev, date, time, id, armed).run(); return ev; };
    const soon = await ins('soon', 30);        // 72h window open, 24h in 6 h
    const nextWeek = await ins('week', 200);   // 72h in ~5 days
    await ins('far', 12 * 24);                 // nothing within 7 days
    await ins('paused', 40, 0);                // this game's reminders are paused
    let games = await importNotice(s);
    expect(games.map(g => g.id).sort()).toEqual([soon, nextWeek].sort());
    const soonSteps = games.find(g => g.id === soon).steps;
    expect(soonSteps).toEqual([{ kind: 'reminder_72h', now: true }, { kind: 'reminder_24h', now: false }]);
    expect(games.find(g => g.id === nextWeek).steps).toEqual([{ kind: 'reminder_72h', now: false }]);
    // A reminder already sent does not go to players added later.
    await env.DB.prepare(`INSERT INTO league_reminder_log (event_id, kind, league_id, sent_at, recipient_count) VALUES (?, 'reminder_72h', ?, ?, 0)`).bind(soon, id, new Date().toISOString()).run();
    games = await importNotice(s);
    expect(games.find(g => g.id === soon).steps).toEqual([{ kind: 'reminder_24h', now: false }]);
    // With reminders off, nothing to warn about.
    await post(s, '/league/reminders/settings', { reminder72h: false, reminder24h: false, reminder12h: false });
    expect(await importNotice(s)).toEqual([]);
  });

  it('the notice copy, both languages', async () => {
    const s = await signup('p155.copy@example.com');
    await post(s, '/leagues/create', { name: 'P155 Copy', teamNames: ['A', 'B'] });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie: s.cookie } })).text();
    const dict = JSON.parse(html.match(/var __I18N = (\{[\s\S]*?\});\n/)[1]);
    expect(dict.fr.importRemTitle).toBe('Ces matchs enverront des rappels aux joueurs importés dans les 7 prochains jours :');
    expect(dict.en.importRemTitle).toBe('These games will send reminders to the imported players within the next 7 days:');
    expect(dict.fr.importRemSuppressOne).toBe('Ne pas envoyer de rappels automatiques pour ce match (tu peux les réactiver dans la page du match)');
    expect(dict.en.importRemSuppressOne).toBe("Don't send automatic reminders for this game (you can turn them back on from the game's page)");
  });
});

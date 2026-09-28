// Sub calls no longer name a team (unless the sub's own preferred team is
// the one short). A sub who accepts is placed provisionally -- the page
// says it may change -- and what is emailed depends on how close the game
// is: more than 24 h out, nothing for a system placement or a reshuffle;
// inside 24 h, every placement or move is emailed at once; a sub added by
// hand is always told, with the caveat only when more than 24 h out.
import { env, SELF } from 'cloudflare:test';
import { answerViaEmailLink } from './support/email_link.js';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { hmac } from '../src/crypto_utils.js';
import { drain } from '../src/index.js';

const SEASON = 'Fall 2099';
let sent = [], originalFetch;
const visible = html => html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ');

function montreal(hoursAhead) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(Date.now() + hoursAhead * 3600000));
  const g = t => parts.find(p => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}
async function game(hoursAhead, week) {
  const { date, time } = montreal(hoursAhead);
  const id = `smbhl:${date}`;
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, ?, ?, ?, 'Letendre', 'open', ?, 'smbhl')`).bind(id, SEASON, week, date, time).run();
  return id;
}
const sub = (pid, pref = null) => env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, preferred_team, token_salt, league_id) VALUES (?, ?, ?, 'sub_skater', 1, 0, ?, 's', 'smbhl')`).bind(pid, `${pid} Sub`, `${pid.toLowerCase()}@example.com`, pref).run();
const to = pid => sent.filter(m => m.to[0] === `${pid.toLowerCase()}@example.com`);
const reassign = body => SELF.fetch('http://example.com/admin/subs/reassign', { method: 'POST', headers: { 'x-admin': 'p146-admin', 'content-type': 'application/json' }, body: JSON.stringify(body) });

let FAR, NEAR;
beforeAll(async () => {
  env.RSVP_SECRET = 'p146'; env.RESEND_API_KEY = 'p146'; env.MAIL_DAILY_CAP = '100'; env.ADMIN_KEY = 'p146-admin';
  await applyRealSchema(env);
  await env.DB.prepare('DELETE FROM contacts').run();
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('email_cadence_settings', '{"quiet_hours_enabled":false}')`).run();
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: SEASON, seasons: [{ name: SEASON, standings: [], fixtures: [] }], players: [] }));
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) { sent.push(JSON.parse(opts.body)); return new Response('{"id":"x"}', { status: 200 }); }
    return new Response('{}', { status: 404 });
  };
  FAR = await game(72, 5);   // more than 24 h out
  NEAR = await game(10, 6);  // inside 24 h
  // Red is full for skaters on the far game; the other teams are short.
  for (let i = 1; i <= 14; i++) {
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, preferred_team, token_salt, league_id) VALUES (?, ?, ?, 'roster', 0, 'Red', 's', 'smbhl')`).bind(`R${i}`, `Red Player${i}`, `r${i}@example.com`).run();
    await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, 'Red', 'in', 'roster', '2099-01-01T00:00:00Z', 'smbhl')`).bind(FAR, `R${i}`).run();
  }
  await sub('SNONE');
  await sub('SBLUE', 'Blue');
  await sub('SRED', 'Red');
  for (const p of ['SA', 'SB', 'SC', 'SD', 'SE', 'SF']) await sub(p);
});
afterAll(() => { globalThis.fetch = originalFetch; });
beforeEach(() => { sent = []; });

async function deliverCall(pid) {
  await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at, league_id) VALUES ('sub_call', ?, ?, 'Blue', ?, '{"need":"skater"}', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z', 'smbhl')`).bind(FAR, pid, `call:${pid}`).run();
  await drain(env);
  return to(pid)[0];
}

describe('The invite', () => {
  it('a sub with no preference gets a generic call -- no team named', async () => {
    const m = await deliverCall('SNONE');
    expect(m.subject).toBe('SMBHL cherche un joueur / SMBHL needs a skater');
    expect(m.text).toContain("L'équipe n'est pas encore décidée : si tu es disponible, on te place dans une équipe, et tu reçois ton équipe finale avant le match.");
    expect(m.text).not.toMatch(/Bleu|Blue/);
  });
  it('a sub whose preferred team is the one short gets that team\'s call', async () => {
    const m = await deliverCall('SBLUE');
    expect(m.subject).toBe('Bleu cherche un joueur / Blue needs a skater');
  });
  it('a sub whose preferred team is NOT short gets the generic call, not a false "Red is looking"', async () => {
    const m = await deliverCall('SRED');
    expect(m.subject).toBe('SMBHL cherche un joueur / SMBHL needs a skater');
  });
});

describe('Accepting, more than 24 h out', () => {
  it('lands them on a team provisionally, says it may change, and emails nothing', async () => {
    const at = await hmac(env.RSVP_SECRET, `a:${FAR}:SA:skater:s`);
    const { finalHtml: html } = await answerViaEmailLink((u, i) => SELF.fetch(u, i), `http://example.com/avail?e=${encodeURIComponent(FAR)}&p=SA&n=skater&t=${at}&a=yes`);
    const row = await env.DB.prepare('SELECT team, role, status FROM rsvp WHERE event_id = ? AND player_id = ?').bind(FAR, 'SA').first();
    expect(row.role).toBe('sub');
    expect(row.team).not.toBe('Red'); // Red was full
    expect(html).toContain('Tu joues avec');
    const e = t => t.replace(/'/g, '&#39;');
    expect(html).toContain(e("Ton équipe peut encore changer d'ici le match. Tu recevras ton équipe finale par courriel 24 h avant."));
    expect(html).toContain(e("Your team may still change before the game. You'll get your final team by email 24 hours before."));
    expect(to('SA')).toEqual([]);
    // The same caveat on their own RSVP page.
    const t = await hmac(env.RSVP_SECRET, `p:${FAR}:SA:s`);
    const rsvp = await (await SELF.fetch(`http://example.com/rsvp?e=${encodeURIComponent(FAR)}&p=SA&t=${t}`)).text();
    expect(rsvp).toContain('id="sub_team_caveat"');
  });

  it('a reshuffle more than 24 h out sends nothing', async () => {
    const before = await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(FAR, 'SA').first();
    const target = ['Blue', 'White', 'Black'].find(t => t !== before.team);
    expect((await reassign({ event_id: FAR, player_id: 'SA', team: target })).status).toBe(200);
    expect((await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(FAR, 'SA').first()).team).toBe(target);
    await drain(env);
    expect(to('SA')).toEqual([]);
  });

  it('the game-day email carries the FINAL team, whatever it was queued with', async () => {
    const cur = (await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(FAR, 'SA').first()).team;
    const stale = ['Blue', 'White', 'Black'].find(t => t !== cur);
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at, league_id) VALUES ('gameday', ?, 'SA', ?, 'gd:sa', '{}', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z', 'smbhl')`).bind(FAR, stale).run();
    await drain(env);
    const m = to('SA')[0];
    const shirts = { Blue: 'bleu', White: 'blanc', Black: 'noir' };
    expect(m.text).toContain(`Apporte un chandail ${shirts[cur]}.`);
    expect(m.text).not.toContain(`Apporte un chandail ${shirts[stale]}.`);
  });
});

describe('Inside 24 h, every placement or move is emailed at once', () => {
  it('a late accept: the game-day email goes straight away, with the team and no "may change"', async () => {
    const at = await hmac(env.RSVP_SECRET, `a:${NEAR}:SB:skater:s`);
    const { finalHtml: html } = await answerViaEmailLink((u, i) => SELF.fetch(u, i), `http://example.com/avail?e=${encodeURIComponent(NEAR)}&p=SB&n=skater&t=${at}&a=yes`);
    expect(html).not.toContain('id="sub_team_caveat"');
    const mails = to('SB');
    expect(mails.length).toBe(1);
    const team = (await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(NEAR, 'SB').first()).team;
    expect(mails[0].text).toContain({ Red: 'rouge', Blue: 'bleu', White: 'blanc', Black: 'noir' }[team]);
  });
  it('a late move: emailed again, with the new team', async () => {
    const cur = (await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(NEAR, 'SB').first()).team;
    const target = ['Red', 'Blue', 'White', 'Black'].find(t => t !== cur);
    await reassign({ event_id: NEAR, player_id: 'SB', team: target });
    const mails = to('SB');
    expect(mails.length).toBe(1);
    expect(mails[0].text).toContain({ Red: 'rouge', Blue: 'bleu', White: 'blanc', Black: 'noir' }[target]);
  });
});

describe('A sub added by hand is always told', () => {
  it('more than 24 h out: "you\'re playing with X", with the caveat', async () => {
    await reassign({ event_id: FAR, player_id: 'SC', team: 'Black' });
    const mails = to('SC');
    expect(mails.length).toBe(1);
    expect(mails[0].subject).toBe("Tu joues avec Noir / You're playing with Black");
    expect(mails[0].text).toContain("Les équipes peuvent encore changer d'ici le match : tu recevras ton équipe finale par courriel 24 h avant.");
    expect(mails[0].text).toContain("Teams may still change before the game: you'll get your final team by email 24 hours before.");
  });
  it('inside 24 h: the game-day email, without the caveat', async () => {
    await reassign({ event_id: NEAR, player_id: 'SD', team: 'Black' });
    const mails = to('SD');
    expect(mails.length).toBe(1);
    expect(mails[0].subject).not.toContain('Tu joues avec');
    expect(mails[0].text).toContain('Apporte un chandail noir.');
    expect(mails[0].text).not.toContain('peuvent encore changer');
  });
  // The team page acts on the season's current game (by week: the one more
  // than 24 h out here), so the sub is told their team, with the caveat.
  it('a captain adding a sub from the team page counts as by hand too', async () => {
    const salt = (await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(`teamsalt:${SEASON}:White`).first())?.value;
    const tSalt = salt || 'p146salt';
    if (!salt) await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(`teamsalt:${SEASON}:White`, tSalt).run();
    const t = await hmac(env.RSVP_SECRET, `t:${SEASON}:White:${tSalt}`);
    const res = await SELF.fetch(`http://example.com/team-rsvp?s=${encodeURIComponent(SEASON)}&team=White&t=${t}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'in', sub_action: 'add', player_id: 'SE' }) });
    expect(res.status).toBe(200);
    const mails = to('SE');
    expect(mails.length).toBe(1);
    expect(mails[0].subject).toBe("Tu joues avec Blanc / You're playing with White");
    expect(mails[0].text).toContain("Les équipes peuvent encore changer d'ici le match");
  });
});

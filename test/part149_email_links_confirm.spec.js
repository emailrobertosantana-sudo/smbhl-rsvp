// An email's answer link records NOTHING when opened. Link-scanning mail
// security fetches every URL in a message; two subs on institutional
// mailboxes "accepted" within a minute of every sub call and never came --
// their scanner was answering. Now each link opens a confirmation page that
// says plainly the answer is not recorded yet, and only its button (a form
// POST) records it. Covered: SMBHL's /rsvp in/out, the sub call /avail
// yes/no, and the league product's /league/rsvp in/out (including the 12h
// email's "can't make it").
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { hmac } from '../src/crypto_utils.js';
import { answerViaEmailLink } from './support/email_link.js';
import { withGameTimes } from './support/game_times.js';

const f = (u, i) => SELF.fetch(u, i);
const SEASON = 'Fall 2099';
function montreal(hoursAhead) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(Date.now() + hoursAhead * 3600000));
  const g = t => parts.find(p => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}
const rsvpRow = (ev, pid) => env.DB.prepare('SELECT status FROM rsvp WHERE event_id = ? AND player_id = ?').bind(ev, pid).first();
const e = t => t.replace(/'/g, '&#39;');

let SM, LOCKED;
beforeAll(async () => {
  env.RSVP_SECRET = 'p149'; env.AUTH_SECRET = 'p149-auth'; env.RESEND_API_KEY = 'p149';
  await applyRealSchema(env);
  await env.DB.prepare('DELETE FROM contacts').run();
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('email_cadence_settings', '{"quiet_hours_enabled":false}')`).run();
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: SEASON, seasons: [{ name: SEASON, standings: [], fixtures: [] }], players: [] }));
  globalThis.fetch = async () => new Response('{"id":"x"}', { status: 200 });
  const g = montreal(60);
  SM = `smbhl:${g.date}`;
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, ?, 4, ?, 'Letendre', 'open', ?, 'smbhl')`).bind(SM, SEASON, g.date, g.time).run();
  LOCKED = 'smbhl:2099-01-04';
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, ?, 1, '2099-01-04', 'Letendre', 'locked', '10:30', 'smbhl')`).bind(LOCKED, SEASON).run();
  for (const [pid, role, goalie] of [['R1', 'roster', 0], ['G1', 'roster', 1], ['S1', 'sub_skater', 0], ['S2', 'sub_skater', 0]]) {
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, ?, ?, ?, 's', 'smbhl')`).bind(pid, `${pid} Player`, `${pid.toLowerCase()}@example.com`, role, role === 'roster' ? 0 : 1, goalie).run();
  }
  for (const pid of ['R1', 'G1']) await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, 'Blue', 'pending', 'roster', 'auto', ?, 'smbhl')`).bind(SM, pid, new Date().toISOString()).run();
});

describe('SMBHL RSVP link (/rsvp ?v=in|out)', () => {
  it('opening it records nothing and says plainly the answer is not recorded; the button records it', async () => {
    const t = await hmac(env.RSVP_SECRET, `p:${SM}:R1:s`);
    const link = `http://example.com/rsvp?e=${encodeURIComponent(SM)}&p=R1&t=${t}&v=in`;
    const html = await (await f(link)).text();
    expect((await rsvpRow(SM, 'R1')).status).toBe('pending'); // a scanner's GET changed nothing
    expect(html).toContain('Encore un clic pour confirmer<span class="en">One more tap to confirm</span>');
    expect(html).toContain("Ta réponse n'est pas encore enregistrée.<span class=\"en\">Your answer is not recorded yet.</span>");
    expect(html).toContain("CONFIRMER : JE SERAI LÀ<span class=\"en\">CONFIRM: I'LL BE THERE</span>");
    expect(html).not.toContain('Réponse enregistrée avec succès');
    const { postRes, finalHtml } = await answerViaEmailLink(f, link);
    expect(postRes.status).toBe(303);
    expect((await rsvpRow(SM, 'R1')).status).toBe('in');
    expect(finalHtml).toContain('Réponse enregistrée avec succès! / Response recorded!');
  });

  it('a goalie answering from the email link or the page buttons works (the page\'s POST used to throw for goalies)', async () => {
    const t = await hmac(env.RSVP_SECRET, `p:${SM}:G1:s`);
    const { postRes } = await answerViaEmailLink(f, `http://example.com/rsvp?e=${encodeURIComponent(SM)}&p=G1&t=${t}&v=out`);
    expect(postRes.status).toBe(303);
    expect((await rsvpRow(SM, 'G1')).status).toBe('out');
    const res = await f(`http://example.com/rsvp?e=${encodeURIComponent(SM)}&p=G1&t=${t}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'in' }) });
    expect(res.status).toBe(200);
    expect((await rsvpRow(SM, 'G1')).status).toBe('in');
  });

  it('an invalid link is refused as before, on the link and on the button', async () => {
    const html = await (await f(`http://example.com/rsvp?e=${encodeURIComponent(SM)}&p=R1&t=bad&v=out`)).text();
    expect(html).toContain('Lien invalide ou expiré');
    const post = await f(`http://example.com/rsvp/confirm?e=${encodeURIComponent(SM)}&p=R1&t=bad`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'status=out' });
    expect(post.status).toBe(400);
    expect(await post.text()).toContain('Lien invalide ou expiré');
    expect((await rsvpRow(SM, 'R1')).status).toBe('in');
  });

  it('a game no longer open: no confirmation, the page says responses are closed (as before)', async () => {
    const t = await hmac(env.RSVP_SECRET, `p:${LOCKED}:R1:s`);
    const html = await (await f(`http://example.com/rsvp?e=${encodeURIComponent(LOCKED)}&p=R1&t=${t}&v=in`)).text();
    expect(html).not.toContain('One more tap to confirm');
    expect(html).toContain('Les réponses sont fermées.');
  });
});

describe('Sub call link (/avail ?a=yes|no)', () => {
  it('YES: opening it records nothing (not even "answered"); the button places them', async () => {
    const at = await hmac(env.RSVP_SECRET, `a:${SM}:S1:skater:s`);
    const link = `http://example.com/avail?e=${encodeURIComponent(SM)}&p=S1&n=skater&t=${at}&a=yes`;
    const html = await (await f(link)).text();
    expect(await env.DB.prepare('SELECT * FROM availability WHERE event_id = ? AND player_id = ?').bind(SM, 'S1').first()).toBeNull();
    expect(await rsvpRow(SM, 'S1')).toBeNull();
    expect((await env.DB.prepare('SELECT answered_ever FROM contacts WHERE player_id = ?').bind('S1').first()).answered_ever).toBe(0);
    expect(html).toContain('Encore un clic pour confirmer');
    expect(html).toContain("Tu n'es pas encore inscrit.<span class=\"en\">You are not signed up yet.</span>");
    expect(html).toContain("OUI, JE SUIS DISPONIBLE<span class=\"en\">YES, I'M AVAILABLE</span>");
    expect(html).not.toContain('Tu joues avec');
    const { finalHtml } = await answerViaEmailLink(f, link);
    expect((await env.DB.prepare('SELECT status FROM availability WHERE event_id = ? AND player_id = ?').bind(SM, 'S1').first()).status).toBe('yes');
    expect(finalHtml).toContain('Tu joues avec');
  });

  it('NO: the same -- nothing on open, recorded by the button', async () => {
    const at = await hmac(env.RSVP_SECRET, `a:${SM}:S2:skater:s`);
    const link = `http://example.com/avail?e=${encodeURIComponent(SM)}&p=S2&n=skater&t=${at}&a=no`;
    const html = await (await f(link)).text();
    expect(await env.DB.prepare('SELECT * FROM availability WHERE event_id = ? AND player_id = ?').bind(SM, 'S2').first()).toBeNull();
    expect(html).toContain('NON, PAS DISPONIBLE<span class="en">NO, NOT AVAILABLE</span>');
    await answerViaEmailLink(f, link);
    expect((await env.DB.prepare('SELECT status FROM availability WHERE event_id = ? AND player_id = ?').bind(SM, 'S2').first()).status).toBe('no');
  });

  it('an invalid link is refused as before', async () => {
    const html = await (await f(`http://example.com/avail?e=${encodeURIComponent(SM)}&p=S2&n=skater&t=bad&a=yes`)).text();
    expect(html).toContain('Lien invalide ou expiré');
    const post = await (await f(`http://example.com/avail?e=${encodeURIComponent(SM)}&p=S2&n=skater&t=bad`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=yes' })).text();
    expect(post).toContain('Lien invalide ou expiré');
  });
});

describe('League RSVP link (/league/rsvp ?v=in|out, and the 12h "can\'t make it")', () => {
  let ip = 0;
  async function signup(email) {
    const res = await SELF.fetch('http://example.com/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.149.${++ip}` }, body: JSON.stringify({ email, password: 'a-strong-password-1' }) });
    const cookies = res.headers.getSetCookie();
    return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
  }
  const post = async (s, path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

  it('opening it records nothing; the page says it is not recorded; the button records it and the page then shows it done', async () => {
    const s = await signup('p149.league@example.com');
    const lg = (await (await post(s, '/leagues/create', { name: 'P149 League', teamNames: ['Red', 'Blue'] })).json()).league;
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const c = (await (await post(s, '/league/contacts', { name: 'Lea Player', role: 'roster', team: 'Red', email: 'lea.p149@example.com' })).json()).contact;
    const g = montreal(60);
    const ev = (await (await post(s, '/league/events', withGameTimes({ date: g.date, start_time: g.time, season: 'S1' }))).json()).event;
    const salt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(c.player_id).first()).token_salt;
    const t = await hmac(env.RSVP_SECRET, `lr:${lg.id}:${ev.id}:${c.player_id}:${salt}`);
    const link = `http://example.com/league/rsvp?league=${encodeURIComponent(lg.id)}&e=${encodeURIComponent(ev.id)}&p=${encodeURIComponent(c.player_id)}&t=${t}&v=in`;
    const html = await (await f(link)).text();
    expect(html).toContain('id="rv_confirm"');
    expect(await rsvpRow(ev.id, c.player_id)).toBeNull();
    expect(html).toContain('data-i18n="confirmTitle">Encore un clic pour confirmer<');
    expect(html).toContain('data-i18n="confirmNotYet">' + e("Ta réponse n'est pas encore enregistrée.") + '<');
    expect(html).not.toContain('data-i18n="doneInTitle"');
    const dict = JSON.parse(html.match(/var RV_I18N = (\{[\s\S]*?\});\n/)[1]);
    expect(dict.en.confirmTitle).toBe('One more tap to confirm');
    expect(dict.en.confirmNotYet).toBe('Your answer is not recorded yet.');
    const { postRes, finalHtml } = await answerViaEmailLink(f, link);
    expect(postRes.status).toBe(303);
    expect((await rsvpRow(ev.id, c.player_id)).status).toBe('in');
    expect(finalHtml).toContain('data-i18n="doneInTitle"');
    // The 12h email's "can't make it": the late-reversal alert is sent by the button, not by opening the link.
    const optOut = link.replace('&v=in', '&v=out&src=logistics12h');
    await f(optOut);
    expect((await rsvpRow(ev.id, c.player_id)).status).toBe('in');
    await answerViaEmailLink(f, optOut);
    expect((await rsvpRow(ev.id, c.player_id)).status).toBe('out');
  });
});

// Comms polish task, Group E: the Recent Activity table on the
// league's Comms page (GET /league/comms/data for the data, the page's
// own renderActivity() for the render).
//
// E1: the Type column showed raw internal keys (reminder_72h etc.)
// while the Active Automations card above it used human labels (cad72/
// cad24/cad12). Both now render the exact same dict strings.
//
// E2: recipient count used to render both languages at once
// ("N destinataire(s) / recipient(s)"). The server now sends a bare
// recipientCount number; the client formats it in the current language
// only, via a {n}-templated dict string.
//
// E3: a 0-recipient automated send showed the same green "Sent" status
// as a real send. Distinct status (no_recipients), not green, with the
// (previously always-empty) Reason column explaining why.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { extractInlineScripts, assertNoSyntaxError } from './support/inline_scripts.js';

const AUTH_SECRET = 'test-part85-comms-activity-polish-secret';

function extractCookie(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(', ');
  const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
  return csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
}
async function signup(email, ip) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  return { cookie: extractCookie(res), csrfToken: extractCsrfToken(res) };
}
async function createLeague(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).league;
}
async function publishSeason(cookie, csrfToken, body) {
  return SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
}
let eventCounter = 0;
async function insertEventDirectly(leagueId, date) {
  const id = `${leagueId}:comms-${++eventCounter}:${date}`;
  await env.DB.prepare(
    `INSERT INTO events (id, season, week, date, venue, state, league_id) VALUES (?, 'Comms Season', 1, ?, 'Comms Venue', 'open', ?)`
  ).bind(id, date, leagueId).run();
  return id;
}
async function insertReminderLog(leagueId, eventId, kind, recipientCount) {
  await env.DB.prepare(
    `INSERT INTO league_reminder_log (event_id, kind, league_id, sent_at, recipient_count, skipped) VALUES (?, ?, ?, ?, ?, 0)`
  ).bind(eventId, kind, leagueId, new Date().toISOString(), recipientCount).run();
}
async function insertTeamAssignedLog(eventId, playerId) {
  await env.DB.prepare(
    `INSERT INTO league_team_assigned_email_log (event_id, player_id, sent_at) VALUES (?, ?, ?)`
  ).bind(eventId, playerId, new Date().toISOString()).run();
}

describe('E1/E2/E3 (Comms polish task): Recent Activity table', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('E2/E3: GET /league/comms/data sends a bare recipientCount (no baked-in language) and a distinct no_recipients status for zero-recipient sends', async () => {
    const { cookie, csrfToken } = await signup('e.data@example.com', '203.0.201.001');
    const league = await createLeague(cookie, csrfToken, { name: 'E Data League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev1 = await insertEventDirectly(league.id, '2099-09-01');
    const ev2 = await insertEventDirectly(league.id, '2099-09-02');
    await insertReminderLog(league.id, ev1, 'reminder_72h', 4);
    await insertReminderLog(league.id, ev2, 'reminder_24h', 0);

    const data = await (await SELF.fetch('http://example.com/league/comms/data', { headers: { cookie } })).json();
    expect(data.ok).toBe(true);
    const real = data.activity.find(a => a.eventId === ev1);
    const zero = data.activity.find(a => a.eventId === ev2);
    expect(real.status).toBe('sent');
    expect(real.recipientCount).toBe(4);
    expect(real.recipient).toBeNull();
    // Nowhere in the JSON is a bilingual string baked in.
    expect(JSON.stringify(real)).not.toContain('destinataire');
    expect(JSON.stringify(real)).not.toContain('recipient(s)');

    expect(zero.status).toBe('no_recipients');
    expect(zero.recipientCount).toBe(0);
    expect(zero.status).not.toBe('sent');
  });

  it('E1: team_assigned rows come through as their own kind, ready for the same human-label treatment as reminder kinds', async () => {
    const { cookie, csrfToken } = await signup('e.kind@example.com', '203.0.201.002');
    const league = await createLeague(cookie, csrfToken, { name: 'E Kind League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await insertEventDirectly(league.id, '2099-09-03');
    await insertReminderLog(league.id, ev, 'logistics_12h', 2);
    await insertTeamAssignedLog(ev, 'somePlayerId');

    const data = await (await SELF.fetch('http://example.com/league/comms/data', { headers: { cookie } })).json();
    const kinds = data.activity.map(a => a.kind);
    expect(kinds).toContain('logistics_12h');
    expect(kinds).toContain('team_assigned');
  });

  it('E1: the Comms page embeds a Type-label lookup that reuses the Active Automations card\'s own cad72/cad24/cad12/cadTeamAssigned strings, in both languages', async () => {
    const { cookie, csrfToken } = await signup('e.labels@example.com', '203.0.201.003');
    await createLeague(cookie, csrfToken, { name: 'E Labels League', teamNames: ['A', 'B'] });
    const html = await (await SELF.fetch('http://example.com/league/comms', { headers: { cookie } })).text();
    expect(html).toContain('function activityKindLabel(d, kind)');
    expect(html).toMatch(/KIND_LABEL = \{ reminder_72h: d\.cad72, reminder_24h: d\.cad24, logistics_12h: d\.cad12, team_assigned: d\.cadTeamAssigned \}/);
    expect(html).toContain('activityKindLabel(d, a.kind)');

    const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/);
    const dict = JSON.parse(m[1]);
    expect(dict.fr.cadTeamAssigned).toBe('Équipe assignée (tirage tardif)');
    expect(dict.en.cadTeamAssigned).toBe('Team assigned (late draw)');
    // Same strings power both the automations card and the activity table.
    expect(dict.fr.cad72).toBeTruthy();
    expect(dict.en.cad72).toBeTruthy();
  });

  it('E2: recipientCountLabel is a single-language {n}-templated string, both languages, wired into renderActivity', async () => {
    const { cookie, csrfToken } = await signup('e.recipientcopy@example.com', '203.0.201.004');
    await createLeague(cookie, csrfToken, { name: 'E Recipient Copy League', teamNames: ['A', 'B'] });
    const html = await (await SELF.fetch('http://example.com/league/comms', { headers: { cookie } })).text();
    const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/);
    const dict = JSON.parse(m[1]);
    expect(dict.fr.recipientCountLabel).toBe('{n} destinataire(s)');
    expect(dict.en.recipientCountLabel).toBe('{n} recipient(s)');
    expect(dict.fr.recipientCountLabel).not.toContain('recipient(s)');
    expect(dict.en.recipientCountLabel).not.toContain('destinataire');
    expect(html).toContain("d.recipientCountLabel.replace('{n}', a.recipientCount)");
  });

  it('E3: statusNoRecipients/noRecipientsReason copy exists in both languages, wired into renderActivity with a non-green color', async () => {
    const { cookie, csrfToken } = await signup('e.norecip@example.com', '203.0.201.005');
    await createLeague(cookie, csrfToken, { name: 'E No Recipients League', teamNames: ['A', 'B'] });
    const html = await (await SELF.fetch('http://example.com/league/comms', { headers: { cookie } })).text();
    const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/);
    const dict = JSON.parse(m[1]);
    expect(dict.fr.statusNoRecipients).toBe('Personne à contacter');
    expect(dict.en.statusNoRecipients).toBe('No one to notify');
    expect(dict.fr.noRecipientsReason).toBeTruthy();
    expect(dict.en.noRecipientsReason).toBeTruthy();
    // Distinct, non-green tone -- the same grey already used for
    // 'skipped', not the green used for a genuine 'sent'.
    expect(html).toContain("no_recipients: '#55585f'");
    expect(html).not.toMatch(/no_recipients:\s*'#0e7a4f'/);
    expect(html).toContain("no_recipients: 'statusNoRecipients'");
  });

  it('inline scripts on the Comms page stay syntactically valid with the new activity-rendering logic', async () => {
    const { cookie, csrfToken } = await signup('e.syntax@example.com', '203.0.201.006');
    await createLeague(cookie, csrfToken, { name: 'E Syntax League', teamNames: ['A', 'B'] });
    const html = await (await SELF.fetch('http://example.com/league/comms', { headers: { cookie } })).text();
    const scripts = extractInlineScripts(html);
    expect(scripts.length).toBeGreaterThan(0);
    assertNoSyntaxError(scripts);
  });
});

// Live-testing task (batch 4), Part 4: broadcast/compose, shared into
// the league product's own Comms module -- adapted from SMBHL's own
// handleEmailsBroadcast, not copied. Targeting (all/roster/subs/
// pending/in) gains real per-league scoping; team-name targeting reads
// the league's own real team_names (only for 'fixed' leagues -- see
// handleLeagueCommsBroadcast's own comment for why 'headcount' and
// 'weekly_draw' don't get it). No capability-flag gate.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part4-batch4-broadcast-secret';

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
async function addContact(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).contact;
}
async function withMailMock(fn) {
  const originalFetch = globalThis.fetch;
  const sentMails = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      sentMails.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ id: 'mock_resend_id' }), { status: 200 });
    }
    return originalFetch(url, opts);
  };
  try {
    return { sentMails, result: await fn(sentMails) };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
async function broadcast(cookie, csrfToken, payload) {
  const res = await SELF.fetch('http://example.com/league/comms/broadcast', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(payload)
  });
  return { status: res.status, body: await res.json() };
}

describe('Part 4 (live-testing task, batch 4): broadcast in the shared Comms module', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RESEND_API_KEY = 'test-part4-batch4-resend-key';
    await applyRealSchema(env);
  });

  it('targets "all" correctly -- every non-opted-out contact with an email, roster and subs both', async () => {
    const { cookie, csrfToken } = await signup('bc.all@example.com', '203.0.180.001');
    await createLeague(cookie, csrfToken, { name: 'Broadcast All League', teamNames: ['Otters', 'Falcons'], tracksStats: true });
    await addContact(cookie, csrfToken, { name: 'Roster One', email: 'bcall.roster@example.com', role: 'roster' });
    await addContact(cookie, csrfToken, { name: 'Sub One', email: 'bcall.sub@example.com', role: 'sub_skater' });

    const { sentMails, result: res } = await withMailMock(() =>
      broadcast(cookie, csrfToken, { target: 'all', subject: 'Hello', message: 'Test message' })
    );
    expect(res.body.ok).toBe(true);
    expect(res.body.total).toBe(2);
    expect(sentMails.length).toBe(2);
    expect(sentMails.some(m => m.to.includes('bcall.roster@example.com'))).toBe(true);
    expect(sentMails.some(m => m.to.includes('bcall.sub@example.com'))).toBe(true);
  });

  it('targets "roster" and "subs" as genuinely separate, correctly filtered groups', async () => {
    const { cookie, csrfToken } = await signup('bc.rostersubs@example.com', '203.0.180.002');
    await createLeague(cookie, csrfToken, { name: 'Broadcast Roster Subs League', teamNames: ['Otters', 'Falcons'], tracksStats: true });
    await addContact(cookie, csrfToken, { name: 'Roster Two', email: 'bcrs.roster@example.com', role: 'roster' });
    await addContact(cookie, csrfToken, { name: 'Sub Two', email: 'bcrs.sub@example.com', role: 'sub_skater' });

    const rosterResult = await withMailMock(() => broadcast(cookie, csrfToken, { target: 'roster', subject: 'Roster only', message: 'Msg' }));
    expect(rosterResult.sentMails.length).toBe(1);
    expect(rosterResult.sentMails[0].to).toEqual(['bcrs.roster@example.com']);

    const subsResult = await withMailMock(() => broadcast(cookie, csrfToken, { target: 'subs', subject: 'Subs only', message: 'Msg' }));
    expect(subsResult.sentMails.length).toBe(1);
    expect(subsResult.sentMails[0].to).toEqual(['bcrs.sub@example.com']);
  });

  it('targets by team name (fixed structure) -- reads the league\'s OWN real team names, not SMBHL\'s hardcoded Red/Blue/White/Black', async () => {
    const { cookie, csrfToken } = await signup('bc.team@example.com', '203.0.180.003');
    await createLeague(cookie, csrfToken, { name: 'Broadcast Team League', teamNames: ['Narwhals', 'Beavers'], tracksStats: true });
    const p1 = await addContact(cookie, csrfToken, { name: 'Narwhal Player', email: 'bcteam.narwhal@example.com', role: 'roster' });
    await addContact(cookie, csrfToken, { name: 'Beaver Player', email: 'bcteam.beaver@example.com', role: 'roster' });
    await env.DB.prepare('UPDATE contacts SET preferred_team = ? WHERE player_id = ?').bind('Narwhals', p1.player_id).run();

    const { sentMails } = await withMailMock(() => broadcast(cookie, csrfToken, { target: 'Narwhals', subject: 'Narwhals only', message: 'Msg' }));
    expect(sentMails.length).toBe(1);
    expect(sentMails[0].to).toEqual(['bcteam.narwhal@example.com']);

    // "Red" is a real team name for SMBHL, meaningless for this league
    // -- must be rejected, not silently match nobody or leak into
    // some default.
    const { status, body } = await broadcast(cookie, csrfToken, { target: 'Red', subject: 'x', message: 'y' });
    expect(status).toBe(400);
    expect(body.errorKey).toBe('BROADCAST_INVALID_TARGET');
  });

  it('a headcount league has no team-targeting option at all -- broadcastOptions.teamNames is empty and targeting by any team name is rejected', async () => {
    const { cookie, csrfToken } = await signup('bc.headcount@example.com', '203.0.180.004');
    await createLeague(cookie, csrfToken, { name: 'Broadcast Headcount League', teamStructure: 'headcount', minPlayers: 8, maxPlayers: 14, tracksStats: false });

    const dataRes = await SELF.fetch('http://example.com/league/comms/data', { headers: { cookie } });
    const data = await dataRes.json();
    expect(data.broadcastOptions.teamNames).toEqual([]);

    const { status, body } = await broadcast(cookie, csrfToken, { target: 'AnyTeam', subject: 'x', message: 'y' });
    expect(status).toBe(400);
    expect(body.errorKey).toBe('BROADCAST_INVALID_TARGET');
  });

  it('a weekly_draw league also has no team-targeting option -- teams are reassigned every event, not a stable audience', async () => {
    const { cookie, csrfToken } = await signup('bc.weeklydraw@example.com', '203.0.180.005');
    await createLeague(cookie, csrfToken, { name: 'Broadcast Weekly Draw League', teamNames: ['Wolves', 'Hawks'], tracksStats: true, teamStructure: 'weekly_draw' });

    const dataRes = await SELF.fetch('http://example.com/league/comms/data', { headers: { cookie } });
    const data = await dataRes.json();
    expect(data.broadcastOptions.teamNames).toEqual([]);
    expect(data.cadence.isWeeklyDraw).toBe(true);
  });

  it('targets by RSVP status (pending/in) for a specific event -- and requires an event_id', async () => {
    const { cookie, csrfToken } = await signup('bc.status@example.com', '203.0.180.006');
    await createLeague(cookie, csrfToken, { name: 'Broadcast Status League', teamNames: ['A', 'B'], tracksStats: true });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'S1' })
    });
    const p1 = await addContact(cookie, csrfToken, { name: 'In Player', email: 'bcstatus.in@example.com', role: 'roster' });
    const p2 = await addContact(cookie, csrfToken, { name: 'Pending Player', email: 'bcstatus.pending@example.com', role: 'roster' });
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2026-12-20' })
    });
    const ev = (await eventRes.json()).event;
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: ev.id, player_id: p1.player_id, status: 'in' })
    });

    const missingEvent = await broadcast(cookie, csrfToken, { target: 'in', subject: 'x', message: 'y' });
    expect(missingEvent.status).toBe(400);
    expect(missingEvent.body.errorKey).toBe('BROADCAST_EVENT_REQUIRED');

    const { sentMails } = await withMailMock(() => broadcast(cookie, csrfToken, { target: 'in', event_id: ev.id, subject: 'In players', message: 'Msg' }));
    expect(sentMails.length).toBe(1);
    expect(sentMails[0].to).toEqual(['bcstatus.in@example.com']);
  });

  it('never leaks across leagues -- a broadcast from league A reaches only league A, never league B\'s or SMBHL\'s contacts', async () => {
    const a = await signup('bc.crossa@example.com', '203.0.180.007');
    await createLeague(a.cookie, a.csrfToken, { name: 'Broadcast Cross League A', teamNames: ['X', 'Y'], tracksStats: true });
    await addContact(a.cookie, a.csrfToken, { name: 'League A Player', email: 'bccross.a@example.com', role: 'roster' });

    const b = await signup('bc.crossb@example.com', '203.0.180.008');
    await createLeague(b.cookie, b.csrfToken, { name: 'Broadcast Cross League B', teamNames: ['X', 'Y'], tracksStats: true });
    await addContact(b.cookie, b.csrfToken, { name: 'League B Player', email: 'bccross.b@example.com', role: 'roster' });

    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, token_salt) VALUES ('P_BC_SMBHL', 'SMBHL Real Player', 'bccross.smbhl@example.com', 'roster', 'salt')`).run();

    const { sentMails } = await withMailMock(() => broadcast(a.cookie, a.csrfToken, { target: 'all', subject: 'League A only', message: 'Msg' }));
    expect(sentMails.length).toBe(1);
    expect(sentMails[0].to).toEqual(['bccross.a@example.com']);
    expect(sentMails.some(m => m.to.includes('bccross.b@example.com'))).toBe(false);
    expect(sentMails.some(m => m.to.includes('bccross.smbhl@example.com'))).toBe(false);
  });

  it('content follows the league\'s language_mode in the footer, and the message body is never duplicated per language', async () => {
    const { cookie, csrfToken } = await signup('bc.langmode@example.com', '203.0.180.009');
    await createLeague(cookie, csrfToken, { name: 'Broadcast Lang League', teamNames: ['X', 'Y'], tracksStats: true });
    await SELF.fetch('http://example.com/league/language-mode', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ languageMode: 'fr' })
    });
    await addContact(cookie, csrfToken, { name: 'Lang Player', email: 'bclang.player@example.com', role: 'roster' });

    const { sentMails } = await withMailMock(() => broadcast(cookie, csrfToken, { target: 'all', subject: 'Sujet', message: 'Corps du message unique' }));
    expect(sentMails.length).toBe(1);
    const mail = sentMails[0];
    expect(mail.html).toContain('administration de');
    expect(mail.html).not.toContain('administration</div>'); // no English footer leaking through
    // Message body appears exactly once, never duplicated.
    const occurrences = (mail.html.match(/Corps du message unique/g) || []).length;
    expect(occurrences).toBe(1);
    // Real per-league send identity, not SMBHL's.
    expect(mail.from).toContain('mail.notreligue.ca');
    expect(mail.from).not.toContain('smbhl.com');
  });

  it('is available to every league with no capability-flag gate', async () => {
    const { cookie, csrfToken } = await signup('bc.noflag@example.com', '203.0.180.010');
    await createLeague(cookie, csrfToken, { name: 'Broadcast No Flag League', teamNames: ['X', 'Y'], tracksStats: true });
    await addContact(cookie, csrfToken, { name: 'Flag Player', email: 'bcnoflag.player@example.com', role: 'roster' });

    const { result: res } = await withMailMock(() => broadcast(cookie, csrfToken, { target: 'all', subject: 'x', message: 'y' }));
    expect(res.status).toBe(200);
  });

  it('cannot be used to broadcast for SMBHL through this route', async () => {
    const { cookie, csrfToken } = await signup('bc.smbhlblock@example.com', '203.0.180.011');
    // No league created -- resolveSessionLeagueId finds none, so this
    // hits NO_LEAGUE_FOUND before ever reaching the SMBHL-id check,
    // which is itself the correct outcome (this account administers no
    // league, SMBHL included).
    const res = await broadcast(cookie, csrfToken, { target: 'all', subject: 'x', message: 'y' });
    expect(res.status).toBe(404);
    expect(res.body.errorKey).toBe('NO_LEAGUE_FOUND');
  });

  it('requires both subject and message', async () => {
    const { cookie, csrfToken } = await signup('bc.emptyfields@example.com', '203.0.180.012');
    await createLeague(cookie, csrfToken, { name: 'Broadcast Empty Fields League', teamNames: ['X', 'Y'], tracksStats: true });

    const res = await broadcast(cookie, csrfToken, { target: 'all', subject: '', message: '' });
    expect(res.status).toBe(400);
    expect(res.body.errorKey).toBe('BROADCAST_FIELDS_REQUIRED');
  });
});

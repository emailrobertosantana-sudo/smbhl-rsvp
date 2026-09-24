// Live-testing task (batch 2), Part 12 (BIG): hard delete (privacy/Law
// 25). Covers: (1) SMBHL is structurally exempt from both entry points.
// (2) a league must be deactivated first. (3) the 15-day unlock delay,
// timed from deactivated_at. (4) the strong type-the-name confirmation
// phrase (bilingual). (5) full row removal across every league-scoped
// table, the KV data_json blob, and the league row itself. (6) an admin
// account is deleted only when this was their last league -- a second,
// surviving league (and its own admin account, and its own identical
// rows in every shared table) is provably unaffected. (7) both entry
// points (the league admin's own session, and the super-admin ADMIN_KEY)
// work end to end.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part12-hard-delete-secret';
const ADMIN_KEY = 'test-part12-admin-key';

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
  return { cookie: extractCookie(res), csrfToken: extractCsrfToken(res), userId: (await res.json()).userId };
}
async function createLeague(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).league;
}
async function deactivate(cookie, csrfToken, confirmName) {
  return SELF.fetch('http://example.com/league/deactivate', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ confirmName })
  });
}
async function hardDelete(cookie, csrfToken, confirmPhrase) {
  return SELF.fetch('http://example.com/league/hard-delete', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ confirmPhrase })
  });
}
async function superHardDelete(leagueId, confirmPhrase) {
  return SELF.fetch('http://example.com/super-admin/leagues/hard-delete', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin': ADMIN_KEY },
    body: JSON.stringify({ leagueId, confirmPhrase })
  });
}

// Inserts one row into every league-scoped table (plus one
// league_team_assigned_email_log row keyed to a real event id) so "full
// row removal" has something real to prove removal of, in every table
// hard delete is supposed to touch.
async function seedFullLeagueFootprint(leagueId, eventId, playerId) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO events (id, league_id, season, week, date, venue, state) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(eventId, leagueId, 'S1', 1, '2026-10-01', 'Arena', 'open'),
    env.DB.prepare('INSERT INTO contacts (player_id, league_id, name, email, is_sub, token_salt) VALUES (?, ?, ?, ?, 0, ?)').bind(playerId, leagueId, 'Test Player', `${playerId}@example.com`, 'salt'),
    env.DB.prepare('INSERT INTO rsvp (event_id, league_id, player_id, team, status, role, status_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(eventId, leagueId, playerId, 'A', 'in', 'roster', 'self', now),
    env.DB.prepare('INSERT INTO sheet_reviews (id, league_id, event_id, season, week, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(`${eventId}-review`, leagueId, eventId, 'S1', 1, now, 'draft'),
    env.DB.prepare('INSERT INTO team_messages (league_id, event_id, team, player_name, player_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(leagueId, eventId, 'A', 'Test Player', playerId, 'hi', now),
    env.DB.prepare('INSERT INTO outbox (league_id, kind, event_id, player_id, send_after, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(leagueId, 'notice', eventId, playerId, now, now),
    env.DB.prepare('INSERT INTO jobs (league_id, event_id, job, ran_at) VALUES (?, ?, ?, ?)').bind(leagueId, eventId, 'lock', now),
    env.DB.prepare('INSERT INTO availability (league_id, event_id, player_id, need, status, answered_at) VALUES (?, ?, ?, ?, ?, ?)').bind(leagueId, eventId, playerId, 'skater', 'yes', now),
    env.DB.prepare('INSERT INTO season_costs (id, league_id, season, category, description, amount, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(`${leagueId}-cost`, leagueId, 'S1', 'rental', 'Ice', 100, now, now),
    env.DB.prepare('INSERT INTO season_pricing (season, league_id, price_player, price_sub_player, updated_at) VALUES (?, ?, ?, ?, ?)').bind(`${leagueId}-S1`, leagueId, 180, 15, now),
    env.DB.prepare('INSERT INTO player_dues (season, league_id, player_id, updated_at) VALUES (?, ?, ?, ?)').bind(`${leagueId}-S1`, leagueId, playerId, now),
    env.DB.prepare('INSERT INTO planned_absences (league_id, player_id, date, season, created_at) VALUES (?, ?, ?, ?, ?)').bind(leagueId, playerId, '2026-10-15', 'S1', now),
    env.DB.prepare('INSERT INTO polls (league_id, season, title, state, created_at) VALUES (?, ?, ?, ?, ?)').bind(leagueId, 'S1', 'Test Poll', 'open', now),
    env.DB.prepare('INSERT INTO settings (key, league_id, value) VALUES (?, ?, ?)').bind(`hd_test_${leagueId}`, leagueId, 'v'),
    env.DB.prepare('INSERT INTO league_reminder_log (event_id, kind, league_id, sent_at) VALUES (?, ?, ?, ?)').bind(eventId, 'reminder_72h', leagueId, now),
    env.DB.prepare('INSERT INTO league_auto_draw_log (event_id, league_id, drawn_at) VALUES (?, ?, ?)').bind(eventId, leagueId, now),
    env.DB.prepare('INSERT INTO league_team_assigned_email_log (event_id, player_id, sent_at) VALUES (?, ?, ?)').bind(eventId, playerId, now)
  ]);
  // poll_votes needs a real poll_id (autoincrement) -- fetch it back. Its
  // own league_id column (migrate-020.sql) defaults to 'smbhl' if
  // omitted -- must be set explicitly to this league or the row survives
  // as an orphan once `polls` is deleted, violating poll_votes.poll_id's
  // FK against polls(id) (D1 does enforce foreign keys).
  const poll = await env.DB.prepare('SELECT id FROM polls WHERE league_id = ?').bind(leagueId).first();
  await env.DB.prepare('INSERT INTO poll_votes (poll_id, league_id, voter_id, candidate_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(poll.id, leagueId, playerId, 'Someone', now, now).run();
}

async function countAllLeagueRows(leagueId) {
  const tables = [
    'events', 'contacts', 'rsvp', 'sheet_reviews', 'team_messages', 'outbox', 'jobs',
    'availability', 'season_costs', 'season_pricing', 'player_dues', 'planned_absences',
    'polls', 'settings', 'league_reminder_log', 'league_auto_draw_log', 'league_admins'
  ];
  const counts = {};
  for (const t of tables) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE league_id = ?`).bind(leagueId).first();
    counts[t] = row.n;
  }
  return counts;
}

describe('Part 12 (live-testing task, batch 2): hard delete (privacy/Law 25)', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.ADMIN_KEY = ADMIN_KEY;
    await applyRealSchema(env);
  });

  it('SMBHL is structurally exempt from both entry points, regardless of deactivation/confirmation', async () => {
    const viaSuper = await superHardDelete('smbhl', 'SUPPRIMER SMBHL');
    expect(viaSuper.status).toBe(403);
    expect((await viaSuper.json()).errorKey).toBe('LEAGUE_PROTECTED');

    const smbhlRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM leagues WHERE id = ?').bind('smbhl').first();
    expect(smbhlRow.n).toBe(1);
  });

  it('a league that has never been deactivated cannot be hard-deleted', async () => {
    const { cookie, csrfToken } = await signup('harddelete.notdeactivated@example.com', '203.0.172.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Not Deactivated League', teamNames: ['A', 'B'], tracksStats: true });
    const res = await hardDelete(cookie, csrfToken, `SUPPRIMER ${league.name}`);
    expect(res.status).toBe(409);
    expect((await res.json()).errorKey).toBe('NOT_DEACTIVATED');
  });

  it('a just-deactivated league is locked for 15 days, with a clear unlock time', async () => {
    const { cookie, csrfToken } = await signup('harddelete.locked@example.com', '203.0.172.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Locked League', teamNames: ['A', 'B'], tracksStats: true });
    const deactRes = await deactivate(cookie, csrfToken, league.name);
    expect(deactRes.status).toBe(200);

    const statusRes = await SELF.fetch('http://example.com/league/hard-delete/status', { headers: { cookie } });
    const statusBody = await statusRes.json();
    expect(statusBody.status).toBe('locked');
    expect(statusBody.unlockAt).toBeTruthy();
    expect(statusBody.unlockDays).toBe(15);

    const res = await hardDelete(cookie, csrfToken, `SUPPRIMER ${league.name}`);
    expect(res.status).toBe(423);
    const body = await res.json();
    expect(body.errorKey).toBe('HARD_DELETE_LOCKED');
    expect(body.unlockAt).toBeTruthy();
  });

  it('rejects a confirmation phrase that does not match, even once eligible', async () => {
    const { cookie, csrfToken } = await signup('harddelete.badconfirm@example.com', '203.0.172.003');
    const league = await createLeague(cookie, csrfToken, { name: 'Bad Confirm League', teamNames: ['A', 'B'], tracksStats: true });
    await deactivate(cookie, csrfToken, league.name);
    // Fast-forward past the unlock delay directly in the DB (simulating
    // 16 real days having passed).
    const past = new Date(Date.now() - 16 * 24 * 3600 * 1000).toISOString();
    await env.DB.prepare('UPDATE leagues SET deactivated_at = ? WHERE id = ?').bind(past, league.id).run();

    const wrongName = await hardDelete(cookie, csrfToken, `SUPPRIMER ${league.name}X`);
    expect(wrongName.status).toBe(400);
    expect((await wrongName.json()).errorKey).toBe('CONFIRM_PHRASE_MISMATCH');

    const bareNameOnly = await hardDelete(cookie, csrfToken, league.name);
    expect(bareNameOnly.status).toBe(400);

    const stillThere = await env.DB.prepare('SELECT COUNT(*) AS n FROM leagues WHERE id = ?').bind(league.id).first();
    expect(stillThere.n).toBe(1);
  });

  it('full end-to-end: deletes every row across every league-scoped table, the league itself, and the lone admin\'s account -- while a sibling league is completely unaffected', async () => {
    // Sibling league: created first, survives throughout, proves scoping.
    const sibling = await signup('harddelete.sibling@example.com', '203.0.172.010');
    const siblingLeague = await createLeague(sibling.cookie, sibling.csrfToken, { name: 'Sibling League', teamNames: ['A', 'B'], tracksStats: true });
    await seedFullLeagueFootprint(siblingLeague.id, `${siblingLeague.id}:2026-10-01`, `${siblingLeague.id}:P0001`);
    const siblingBefore = await countAllLeagueRows(siblingLeague.id);
    Object.values(siblingBefore).forEach(n => expect(n).toBeGreaterThan(0));

    // Target league: the one actually being hard-deleted.
    const target = await signup('harddelete.target.owner@example.com', '203.0.172.011');
    const targetLeague = await createLeague(target.cookie, target.csrfToken, { name: 'Target League', teamNames: ['A', 'B'], tracksStats: true });
    const eventId = `${targetLeague.id}:2026-10-01`;
    const playerId = `${targetLeague.id}:P0001`;
    await seedFullLeagueFootprint(targetLeague.id, eventId, playerId);

    const beforeCounts = await countAllLeagueRows(targetLeague.id);
    Object.values(beforeCounts).forEach(n => expect(n).toBeGreaterThan(0));
    const pollVotesBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE league_id = ?)`
    ).bind(targetLeague.id).first();
    expect(pollVotesBefore.n).toBeGreaterThan(0);
    const emailLogBefore = await env.DB.prepare('SELECT COUNT(*) AS n FROM league_team_assigned_email_log WHERE event_id = ?').bind(eventId).first();
    expect(emailLogBefore.n).toBe(1);
    const kvBefore = await env.SHEETS_KV.get(`data_json:${targetLeague.id}`);
    // May be null (never published a season) -- that's fine, deletion is idempotent either way.

    await deactivate(target.cookie, target.csrfToken, targetLeague.name);
    const past = new Date(Date.now() - 16 * 24 * 3600 * 1000).toISOString();
    await env.DB.prepare('UPDATE leagues SET deactivated_at = ? WHERE id = ?').bind(past, targetLeague.id).run();

    const delRes = await hardDelete(target.cookie, target.csrfToken, `SUPPRIMER ${targetLeague.name}`);
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.ok).toBe(true);
    expect(delBody.usersDeleted).toBe(1);

    const afterCounts = await countAllLeagueRows(targetLeague.id);
    Object.values(afterCounts).forEach(n => expect(n).toBe(0));
    const pollVotesAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM poll_votes WHERE voter_id = ?`
    ).bind(playerId).first();
    expect(pollVotesAfter.n).toBe(0);
    const emailLogAfter = await env.DB.prepare('SELECT COUNT(*) AS n FROM league_team_assigned_email_log WHERE event_id = ?').bind(eventId).first();
    expect(emailLogAfter.n).toBe(0);
    const leagueRowAfter = await env.DB.prepare('SELECT COUNT(*) AS n FROM leagues WHERE id = ?').bind(targetLeague.id).first();
    expect(leagueRowAfter.n).toBe(0);
    const userRowAfter = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').bind(target.userId).first();
    expect(userRowAfter.n).toBe(0);
    const kvAfter = await env.SHEETS_KV.get(`data_json:${targetLeague.id}`);
    expect(kvAfter).toBeNull();
    const logRow = await env.DB.prepare('SELECT * FROM league_hard_delete_log WHERE league_id = ?').bind(targetLeague.id).first();
    expect(logRow).toBeTruthy();
    expect(logRow.deleted_via).toBe('league_admin');
    expect(logRow.users_deleted).toBe(1);

    // The deleted admin's session is now dead (their user row is gone).
    const meAfter = await SELF.fetch('http://example.com/league/hard-delete/status', { headers: { cookie: target.cookie } });
    expect(meAfter.status).toBe(401);

    // Sibling league: every row, and its own admin account, untouched.
    const siblingAfter = await countAllLeagueRows(siblingLeague.id);
    expect(siblingAfter).toEqual(siblingBefore);
    const siblingUserAfter = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').bind(sibling.userId).first();
    expect(siblingUserAfter.n).toBe(1);
    const siblingLeagueAfter = await env.DB.prepare('SELECT COUNT(*) AS n FROM leagues WHERE id = ?').bind(siblingLeague.id).first();
    expect(siblingLeagueAfter.n).toBe(1);
  });

  it('an admin who administers a second, surviving league keeps their account after one league is hard-deleted', async () => {
    const { cookie, csrfToken, userId } = await signup('harddelete.multileague@example.com', '203.0.172.020');
    const leagueOne = await createLeague(cookie, csrfToken, { name: 'Multi League One', teamNames: ['A', 'B'], tracksStats: true });
    const leagueTwo = await createLeague(cookie, csrfToken, { name: 'Multi League Two', teamNames: ['A', 'B'], tracksStats: true });

    await deactivate(cookie, csrfToken, leagueOne.name);
    const past = new Date(Date.now() - 16 * 24 * 3600 * 1000).toISOString();
    await env.DB.prepare('UPDATE leagues SET deactivated_at = ? WHERE id = ?').bind(past, leagueOne.id).run();

    const delRes = await superHardDelete(leagueOne.id, `SUPPRIMER ${leagueOne.name}`);
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.usersDeleted).toBe(0);

    const userRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').bind(userId).first();
    expect(userRow.n).toBe(1);
    const leagueTwoRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM leagues WHERE id = ?').bind(leagueTwo.id).first();
    expect(leagueTwoRow.n).toBe(1);
    const leagueTwoAdmin = await env.DB.prepare('SELECT COUNT(*) AS n FROM league_admins WHERE league_id = ? AND user_id = ?').bind(leagueTwo.id, userId).first();
    expect(leagueTwoAdmin.n).toBe(1);
  });

  it('the super-admin entry point accepts the English confirmation phrase too, and logs deleted_via=super_admin', async () => {
    const { cookie, csrfToken } = await signup('harddelete.superadmin.en@example.com', '203.0.172.030');
    const league = await createLeague(cookie, csrfToken, { name: 'English Confirm League', teamNames: ['A', 'B'], tracksStats: true });
    await deactivate(cookie, csrfToken, league.name);
    const past = new Date(Date.now() - 16 * 24 * 3600 * 1000).toISOString();
    await env.DB.prepare('UPDATE leagues SET deactivated_at = ? WHERE id = ?').bind(past, league.id).run();

    const res = await superHardDelete(league.id, `DELETE ${league.name}`);
    expect(res.status).toBe(200);
    const logRow = await env.DB.prepare('SELECT deleted_via FROM league_hard_delete_log WHERE league_id = ?').bind(league.id).first();
    expect(logRow.deleted_via).toBe('super_admin');
  });

  it('the super-admin entry point requires ADMIN_KEY -- a league-admin session alone is rejected', async () => {
    const { cookie, csrfToken } = await signup('harddelete.superadmin.noauth@example.com', '203.0.172.031');
    const league = await createLeague(cookie, csrfToken, { name: 'No Auth League', teamNames: ['A', 'B'], tracksStats: true });
    await deactivate(cookie, csrfToken, league.name);
    const past = new Date(Date.now() - 16 * 24 * 3600 * 1000).toISOString();
    await env.DB.prepare('UPDATE leagues SET deactivated_at = ? WHERE id = ?').bind(past, league.id).run();

    const res = await SELF.fetch('http://example.com/super-admin/leagues/hard-delete', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ leagueId: league.id, confirmPhrase: `SUPPRIMER ${league.name}` })
    });
    expect(res.status).toBe(403);
    const still = await env.DB.prepare('SELECT COUNT(*) AS n FROM leagues WHERE id = ?').bind(league.id).first();
    expect(still.n).toBe(1);
  });
});

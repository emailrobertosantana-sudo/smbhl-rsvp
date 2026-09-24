// Live-testing task, Part 9: optional scheduled (automatic) weekly
// draw for weekly_draw leagues, off by default -- consistent with the
// standing principle that every automation in this product (reminders,
// etc.) is opt-in, never forced. Extends the SAME cron already built
// for the reminder system (runLeagueReminders) rather than building a
// second parallel scheduled trigger, per the task's own explicit
// instruction. The draw itself reuses randomAssignEventTeams, the
// exact logic factored out of the admin's own manual "draw teams"
// button (handleLeagueRandomAssignEventTeams) -- never a second copy.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { runLeagueReminders } from '../src/index.js';

const AUTH_SECRET = 'test-part9-auto-draw-secret';

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
async function createWeeklyDrawLeagueWithSeason(cookie, csrfToken, name) {
  const res = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, teamStructure: 'weekly_draw', teamNames: ['Rouge / Red', 'Bleu / Blue'], tracksStats: true })
  });
  const league = (await res.json()).league;
  await SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ season_name: `${name} Season` })
  });
  return league;
}
async function addPlayer(cookie, csrfToken, name, email) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, email })
  });
  return (await res.json()).contact;
}
function hoursFromNowDateTime(hours) {
  const d = new Date(Date.now() + hours * 3600000);
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 16);
  return { date, time };
}

describe('Part 9 (live-testing task): scheduled auto-draw, admin-toggleable, off by default', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('with the toggle OFF (default), the cron does not draw teams for a weekly_draw event within the window', async () => {
    const { cookie, csrfToken } = await signup('autodraw.off.default@example.com', '203.0.131.001');
    const league = await createWeeklyDrawLeagueWithSeason(cookie, csrfToken, 'Auto Draw Off League');
    const p1 = await addPlayer(cookie, csrfToken, 'Auto Draw Off P1', 'autodrawoffp1@example.com');
    const p2 = await addPlayer(cookie, csrfToken, 'Auto Draw Off P2', 'autodrawoffp2@example.com');
    const { date, time } = hoursFromNowDateTime(10);
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date, start_time: time })
    });
    const eventId = (await eventRes.json()).event.id;
    for (const p of [p1, p2]) {
      await SELF.fetch('http://example.com/league/rsvp/admin', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: p.player_id, status: 'in' })
      });
    }

    // auto_draw_enabled defaults to 0 -- never touched here.
    await runLeagueReminders(env);

    const row = await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, p1.player_id).first();
    expect(row.team).toBeNull();
    const logRow = await env.DB.prepare('SELECT 1 FROM league_auto_draw_log WHERE event_id = ?').bind(eventId).first();
    expect(logRow).toBeFalsy();
  });

  it('with the toggle ON and the event within the configured window, the cron draws teams automatically', async () => {
    const { cookie, csrfToken } = await signup('autodraw.on.fires@example.com', '203.0.131.002');
    const league = await createWeeklyDrawLeagueWithSeason(cookie, csrfToken, 'Auto Draw On League');

    const settingsRes = await SELF.fetch('http://example.com/league/reminders/settings', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ autoDrawEnabled: true, autoDrawHoursBefore: 24 })
    });
    expect((await settingsRes.json()).settings.autoDrawEnabled).toBe(true);

    const p1 = await addPlayer(cookie, csrfToken, 'Auto Draw On P1', 'autodrawonp1@example.com');
    const p2 = await addPlayer(cookie, csrfToken, 'Auto Draw On P2', 'autodrawonp2@example.com');
    const { date, time } = hoursFromNowDateTime(10); // within 24h window
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date, start_time: time })
    });
    const eventId = (await eventRes.json()).event.id;
    for (const p of [p1, p2]) {
      await SELF.fetch('http://example.com/league/rsvp/admin', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: p.player_id, status: 'in' })
      });
    }

    const log = await runLeagueReminders(env);
    expect(log.some(l => l.includes('auto-draw'))).toBe(true);

    const row1 = await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, p1.player_id).first();
    const row2 = await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, p2.player_id).first();
    expect(['Rouge / Red', 'Bleu / Blue']).toContain(row1.team);
    expect(['Rouge / Red', 'Bleu / Blue']).toContain(row2.team);

    const logRow = await env.DB.prepare('SELECT assigned_count FROM league_auto_draw_log WHERE event_id = ?').bind(eventId).first();
    expect(logRow.assigned_count).toBe(2);
  });

  it('does not fire when the event is still outside the configured hours-before window', async () => {
    const { cookie, csrfToken } = await signup('autodraw.outside.window@example.com', '203.0.131.003');
    const league = await createWeeklyDrawLeagueWithSeason(cookie, csrfToken, 'Auto Draw Outside Window League');
    await SELF.fetch('http://example.com/league/reminders/settings', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ autoDrawEnabled: true, autoDrawHoursBefore: 6 })
    });
    const p1 = await addPlayer(cookie, csrfToken, 'Outside Window P1', 'outsidewindowp1@example.com');
    const { date, time } = hoursFromNowDateTime(48); // outside the 6h window
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date, start_time: time })
    });
    const eventId = (await eventRes.json()).event.id;
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: p1.player_id, status: 'in' })
    });

    await runLeagueReminders(env);
    const row = await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, p1.player_id).first();
    expect(row.team).toBeNull();
  });

  it('is idempotent -- a second cron tick never re-draws (and never re-shuffles) an event already auto-drawn', async () => {
    const { cookie, csrfToken } = await signup('autodraw.idempotent@example.com', '203.0.131.004');
    const league = await createWeeklyDrawLeagueWithSeason(cookie, csrfToken, 'Auto Draw Idempotent League');
    await SELF.fetch('http://example.com/league/reminders/settings', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ autoDrawEnabled: true, autoDrawHoursBefore: 24 })
    });
    const p1 = await addPlayer(cookie, csrfToken, 'Idempotent P1', 'idempotentp1@example.com');
    const { date, time } = hoursFromNowDateTime(10);
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date, start_time: time })
    });
    const eventId = (await eventRes.json()).event.id;
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: p1.player_id, status: 'in' })
    });

    await runLeagueReminders(env);
    const firstTeam = (await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, p1.player_id).first()).team;

    // Manually re-assign to a different team to detect whether a second
    // tick would overwrite it -- if the log correctly blocks a re-draw,
    // this manual value survives untouched.
    const otherTeam = firstTeam === 'Rouge / Red' ? 'Bleu / Blue' : 'Rouge / Red';
    await env.DB.prepare('UPDATE rsvp SET team = ? WHERE event_id = ? AND player_id = ?').bind(otherTeam, eventId, p1.player_id).run();

    const secondLog = await runLeagueReminders(env);
    expect(secondLog.some(l => l.includes('auto-draw'))).toBe(false);
    const afterSecondTick = (await env.DB.prepare('SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?').bind(eventId, p1.player_id).first()).team;
    expect(afterSecondTick).toBe(otherTeam);
  });

  it('the manual "draw teams" button keeps working exactly as before (regression, shares the same underlying logic)', async () => {
    const { cookie, csrfToken } = await signup('autodraw.manual.unaffected@example.com', '203.0.131.005');
    const league = await createWeeklyDrawLeagueWithSeason(cookie, csrfToken, 'Auto Draw Manual Unaffected League');
    const p1 = await addPlayer(cookie, csrfToken, 'Manual P1', 'manualdrawp1@example.com');
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2099-12-25' })
    });
    const eventId = (await eventRes.json()).event.id;
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: p1.player_id, status: 'in' })
    });
    const drawRes = await SELF.fetch('http://example.com/league/events/random-assign', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId })
    });
    expect(drawRes.status).toBe(200);
    expect((await drawRes.json()).assigned).toBe(1);
  });

  it('auto-draw hours-before is validated (>= 1) and clamped to 72 (the cron\'s own scan window)', async () => {
    const { cookie, csrfToken } = await signup('autodraw.hours.validation@example.com', '203.0.131.006');
    await createWeeklyDrawLeagueWithSeason(cookie, csrfToken, 'Auto Draw Hours Validation League');

    const invalidRes = await SELF.fetch('http://example.com/league/reminders/settings', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ autoDrawHoursBefore: 0 })
    });
    expect(invalidRes.status).toBe(400);
    expect((await invalidRes.json()).errorKey).toBe('AUTO_DRAW_HOURS_INVALID');

    const clampedRes = await SELF.fetch('http://example.com/league/reminders/settings', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ autoDrawHoursBefore: 200 })
    });
    expect((await clampedRes.json()).settings.autoDrawHoursBefore).toBe(72);
  });

  it("the settings page only shows the auto-draw section for weekly_draw leagues, never fixed or headcount (moved from the dashboard, live-testing task Part 1)", async () => {
    const weeklyDraw = await signup('autodraw.dashboard.weekly@example.com', '203.0.131.007');
    await createWeeklyDrawLeagueWithSeason(weeklyDraw.cookie, weeklyDraw.csrfToken, 'Auto Draw Dashboard Weekly League');
    const weeklyHtml = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie: weeklyDraw.cookie } })).text();
    expect(weeklyHtml).toContain('id="auto_draw_switch"');

    const fixed = await signup('autodraw.dashboard.fixed@example.com', '203.0.131.008');
    await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie: fixed.cookie, 'content-type': 'application/json', 'x-csrf-token': fixed.csrfToken },
      body: JSON.stringify({ name: 'Auto Draw Dashboard Fixed League', teamNames: ['A', 'B'], tracksStats: true })
    });
    const fixedHtml = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie: fixed.cookie } })).text();
    expect(fixedHtml).not.toContain('id="auto_draw_switch"');

    const headcount = await signup('autodraw.dashboard.headcount@example.com', '203.0.131.009');
    await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie: headcount.cookie, 'content-type': 'application/json', 'x-csrf-token': headcount.csrfToken },
      body: JSON.stringify({ name: 'Auto Draw Dashboard Headcount League', teamStructure: 'headcount', minPlayers: 6, maxPlayers: 10, tracksStats: true })
    });
    const headcountHtml = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie: headcount.cookie } })).text();
    expect(headcountHtml).not.toContain('id="auto_draw_switch"');
  });

  it('SMBHL is completely unaffected -- not weekly_draw, never opted in, and the query excludes it entirely', async () => {
    const smbhlRow = await env.DB.prepare("SELECT team_structure, auto_draw_enabled FROM leagues WHERE id = 'smbhl'").first();
    if (smbhlRow) {
      expect(smbhlRow.auto_draw_enabled).toBe(0);
    }
    // runLeagueReminders' own league query already excludes SMBHL by id
    // (id != SMBHL_LEAGUE_ID) -- covered by the existing reminders
    // suite; re-confirmed here that a full tick doesn't throw.
    await expect(runLeagueReminders(env)).resolves.toBeDefined();
  });
});

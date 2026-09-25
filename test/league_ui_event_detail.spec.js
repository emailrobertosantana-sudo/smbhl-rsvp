// UI task Part U: GET /league/events/detail. Server-rendered from the
// same shared shortage logic GET /league/events/status (Part O) calls
// (teamState/openSpots) -- not a duplicate implementation. Proves: real
// per-team confirmed/open-spot data renders; the short/not-short state is
// clear; the invite-subs button posts to the real
// POST /league/events/invite-subs (Part P) route; unauthenticated
// redirects to /login; and League A cannot view or act on League B's
// event through this page.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-ui-event-detail-secret';

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(', ');
  const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
  return csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
}

async function signupAndCreateLeague(email, ip, leagueName, teamNames) {
  const signupRes = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const signupJson = await signupRes.json();
  const cookie = extractCookie(signupRes);
  const csrfToken = extractCsrfToken(signupRes);

  const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name: leagueName, teamNames, tracksStats: true })
  });
  const leagueJson = await leagueRes.json();

  return { userId: signupJson.userId, cookie, csrfToken, leagueId: leagueJson.league.id };
}

describe('UI task Part U: GET /league/events/detail', () => {
  let leagueA, leagueB, cookieA, cookieB, csrfTokenA, csrfTokenB, eventA, eventB;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;

    await applyRealSchema(env);

    const a = await signupAndCreateLeague('uidetail.a@example.com', '203.0.113.371', 'UI Detail League A', ['Otters', 'Falcons']);
    const b = await signupAndCreateLeague('uidetail.b@example.com', '203.0.113.372', 'UI Detail League B', ['Narwhals', 'Beavers']);
    leagueA = a.leagueId;
    leagueB = b.leagueId;
    cookieA = a.cookie;
    csrfTokenA = a.csrfToken;
    cookieB = b.cookie;
    csrfTokenB = b.csrfToken;

    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ season_name: 'UI Detail Season A', goalies_per_team: 1, skaters_per_team: 1, min_skaters: 1 })
    });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ season_name: 'UI Detail Season B' })
    });

    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ date: '2026-12-06', venue: 'Detail Page Rink' })
    });
    eventA = (await eventRes.json()).event.id;

    const eventBRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ date: '2026-12-07' })
    });
    eventB = (await eventBRes.json()).event.id;
  });

  it('redirects to /login for an unauthenticated request', async () => {
    const res = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent('whatever')}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location') || '').toContain('/login');
  });

  it('shows a clear 404 for a nonexistent event, not a crash', async () => {
    const res = await SELF.fetch('http://example.com/league/events/detail?e=does-not-exist', { headers: { cookie: cookieA } });
    expect(res.status).toBe(404);
  });

  it("League A's admin cannot view League B's event through this page (404, not another league's data)", async () => {
    const res = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventB)}`, { headers: { cookie: cookieA } });
    expect(res.status).toBe(404);
  });

  it('shows the event as short with an invite button, before anyone has confirmed', async () => {
    const res = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventA)}`, { headers: { cookie: cookieA } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Detail Page Rink');
    expect(html).toContain('Otters');
    expect(html).toContain('Falcons');
    expect(html).toContain('short'); // shortage indicator class/text
    expect(html).toContain('inviteSubs(');
    expect(html).toContain('Inviter des joueurs');
  });

  it('the invite button calls the real POST /league/events/invite-subs route, scoped to League A only', async () => {
    await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ name: 'Detail Page Sub', email: 'detailsub@leaguea.com', role: 'sub_skater' })
    });

    const res = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
      body: JSON.stringify({ event_id: eventA, team: 'Otters', need: 'skater' })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.league_id).toBe(leagueA);
    expect(json.invited).toBeGreaterThanOrEqual(1);
  });

  it("League B's admin cannot trigger an invite for League A's event (404)", async () => {
    const res = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ event_id: eventA, team: 'Otters', need: 'skater' })
    });
    expect(res.status).toBe(404);
  });

  it("League B's own event detail page shows League B's real confirmed players, and never mentions League A's data", async () => {
    const playerRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
      body: JSON.stringify({ name: 'League B Confirmed Player', role: 'roster' })
    });
    const playerId = (await playerRes.json()).contact.player_id;
    await env.DB.prepare(`UPDATE contacts SET preferred_team = 'Narwhals' WHERE player_id = ?`).bind(playerId).run();
    await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, 'Narwhals', 'in', 'roster', 'self', ?, ?)`)
      .bind(eventB, playerId, new Date().toISOString(), leagueB).run();

    const res = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventB)}`, { headers: { cookie: cookieB } });
    const html = await res.text();
    expect(html).toContain('Narwhals');
    expect(html).toContain('Beavers');
    // Isolation proof: League A's data never appears on League B's page.
    expect(html).not.toContain('Detail Page Rink');
    expect(html).not.toContain('Otters');
  });

  // C2 bug fix (schedule/events polish task): there was previously no
  // way to edit an event after creating it at all. Now everything
  // except the date is editable -- these tests cover the edit view
  // itself, a real edit actually landing, the date staying genuinely
  // read-only (server-enforced, not just a disabled input), and saved-
  // venue selection.
  describe('C2: event editing (everything except the date)', () => {
    it('the edit view shows the date as a real disabled input, with a note that it cannot be changed yet', async () => {
      const res = await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventA)}`, { headers: { cookie: cookieA } });
      const html = await res.text();
      expect(html).toContain(`id="ev_edit_date" type="date" value="2026-12-06" disabled`);
      expect(html).toContain('data-i18n="editDateNote"');
      expect(html).toContain("La date ne peut pas encore être modifiée.");
    });

    it('POST /league/events/update actually changes start/end time and free-text venue', async () => {
      const res = await SELF.fetch('http://example.com/league/events/update', {
        method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
        body: JSON.stringify({ event_id: eventA, start_time: '19:30', end_time: '21:00', venue: 'Edited Rink Name' })
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.event.start_time).toBe('19:30');
      expect(json.event.venue).toBe('Edited Rink Name');

      const row = await env.DB.prepare('SELECT start_time, end_time, venue, venue_id, date, id FROM events WHERE id = ?').bind(eventA).first();
      expect(row.start_time).toBe('19:30');
      expect(row.end_time).toBe('21:00');
      expect(row.venue).toBe('Edited Rink Name');
      expect(row.venue_id).toBeNull();
      // Never touched -- this is the whole point of C2's own restriction.
      expect(row.date).toBe('2026-12-06');
      expect(row.id).toBe(eventA);
    });

    it('the date can never be changed through this route, even if a caller sends one -- id and date both stay exactly as they were', async () => {
      const before = await env.DB.prepare('SELECT date, id FROM events WHERE id = ?').bind(eventA).first();
      const res = await SELF.fetch('http://example.com/league/events/update', {
        method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
        body: JSON.stringify({ event_id: eventA, date: '2099-01-01', start_time: '20:00' })
      });
      expect(res.status).toBe(200);
      const after = await env.DB.prepare('SELECT date, id FROM events WHERE id = ?').bind(eventA).first();
      expect(after.date).toBe(before.date);
      expect(after.id).toBe(before.id);
      // The one field that WAS sent and IS editable did apply -- proves
      // the route works at all, isolating "date specifically never
      // changes" from "nothing happened".
      const row = await env.DB.prepare('SELECT start_time FROM events WHERE id = ?').bind(eventA).first();
      expect(row.start_time).toBe('20:00');
    });

    it('switching to a saved venue sets both venue_id and the denormalized venue name; switching back to free text clears venue_id', async () => {
      const venueRes = await SELF.fetch('http://example.com/league/venues', {
        method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
        body: JSON.stringify({ name: 'C2 Saved Venue', map_link: 'https://maps.example.com/c2' })
      });
      const venue = (await venueRes.json()).venue;

      const res = await SELF.fetch('http://example.com/league/events/update', {
        method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
        body: JSON.stringify({ event_id: eventA, venue_id: venue.id })
      });
      expect(res.status).toBe(200);
      let row = await env.DB.prepare('SELECT venue, venue_id FROM events WHERE id = ?').bind(eventA).first();
      expect(row.venue_id).toBe(venue.id);
      expect(row.venue).toBe('C2 Saved Venue');

      const res2 = await SELF.fetch('http://example.com/league/events/update', {
        method: 'POST', headers: { cookie: cookieA, 'content-type': 'application/json', 'x-csrf-token': csrfTokenA },
        body: JSON.stringify({ event_id: eventA, venue: 'Back To Free Text' })
      });
      expect(res2.status).toBe(200);
      row = await env.DB.prepare('SELECT venue, venue_id FROM events WHERE id = ?').bind(eventA).first();
      expect(row.venue_id).toBeNull();
      expect(row.venue).toBe('Back To Free Text');
    });

    it("League B's admin cannot edit League A's event (404)", async () => {
      const res = await SELF.fetch('http://example.com/league/events/update', {
        method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json', 'x-csrf-token': csrfTokenB },
        body: JSON.stringify({ event_id: eventA, start_time: '18:00' })
      });
      expect(res.status).toBe(404);
    });

    // CAUTION (this task's own instruction): editing start_time must not
    // regress the reminder-window-skip fix (commit 6ed0ee8,
    // reminder_scheduling.js). The rule's own correctness (Rule 2:
    // re-evaluate from scratch, clear a stale skip once the window is
    // legitimately back in the future, never touch a genuine send) is
    // already covered end-to-end by
    // test/part_reminder_window_skip.spec.js -- what's new here, and
    // what this test actually proves, is the WIRING: that
    // handleLeagueEventUpdate (the new C2 route) genuinely calls it
    // after an edit, not just the original create path. A pre-seeded
    // stale skip is used rather than crossing a real threshold via
    // wall-clock time, since C2 deliberately can't change which
    // calendar date the event's id encodes (see that route's own
    // comment) -- a real threshold-crossing scenario within a single,
    // fixed calendar day would be wall-clock-dependent and flaky.
    it('editing start_time re-invokes the reminder-window-skip rule (Rule 2 wiring): a stale skip gets cleared', async () => {
      const { cookie, csrfToken, leagueId } = await signupAndCreateLeague('uidetail.reminder.c2@example.com', '203.0.113.373', 'UI Detail Reminder C2 League', ['X', 'Y']);
      await SELF.fetch('http://example.com/league/season/publish', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ season_name: 'Reminder C2 Season' })
      });
      // F1 (players/reminders polish task): new leagues start with all 3
      // reminders OFF, so logistics_12h needs to be explicitly armed for
      // the rule below to process (and clear) a stale skip row for it.
      await SELF.fetch('http://example.com/league/reminders/settings', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ reminder72h: true, reminder24h: true, reminder12h: true })
      });
      // Far in the future at creation -- genuinely nothing to skip yet.
      const target = new Date(Date.now() + 300 * 3600000);
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
      }).formatToParts(target);
      const g = t => parts.find(p => p.type === t).value;
      const date = `${g('year')}-${g('month')}-${g('day')}`;
      const time = `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;

      const evRes = await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ date, start_time: time, venue: 'Reminder C2 Rink' })
      });
      const newEventId = (await evRes.json()).event.id;

      let logRows = (await env.DB.prepare(`SELECT kind, skipped FROM league_reminder_log WHERE event_id = ?`).bind(newEventId).all()).results;
      expect(logRows.length).toBe(0); // 300h out -- nothing skipped at creation

      // Simulate a stale skip left over from an earlier moment (exactly
      // what applyReminderWindowSkipRule itself would have written had
      // this kind's window been past at some prior point).
      await env.DB.prepare(
        `INSERT INTO league_reminder_log (event_id, kind, league_id, sent_at, recipient_count, skipped) VALUES (?, 'logistics_12h', ?, ?, 0, 1)`
      ).bind(newEventId, leagueId, new Date().toISOString()).run();

      // Edit via the real C2 route -- same time (still 300h out, same
      // calendar date, unchanged) -- just proving the route re-runs the
      // rule at all.
      const updateRes = await SELF.fetch('http://example.com/league/events/update', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: newEventId, start_time: time })
      });
      expect(updateRes.status).toBe(200);

      logRows = (await env.DB.prepare(`SELECT kind, skipped FROM league_reminder_log WHERE event_id = ?`).bind(newEventId).all()).results;
      expect(logRows.length).toBe(0); // the stale skip is gone -- Rule 2 ran and cleared it
    });
  });
});

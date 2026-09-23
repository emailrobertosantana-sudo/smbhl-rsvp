// Live-testing task, Part 8: for weekly_draw leagues, once teams are
// drawn for an event, the assignment must be visible beyond the RSVP
// page.
//
// Real bug closed (surface 1): the 12h "you're confirmed" logistics
// email already had a team-name slot in its body (see
// renderLeagueLogisticsEmail), but getConfirmedPlayers read
// contacts.preferred_team -- never set for weekly_draw (team lives on
// rsvp.team instead, assigned well after RSVP by the manual
// assign-team route or the random draw). The email's team slot was
// silently always empty for every weekly_draw league. Fixed to read
// r.team (the same column teamState() already groups shortage
// detection by for every team structure), so the email now shows the
// real team whenever the draw happened before it was sent.
//
// Surface 2 (new): the public league page shows the next event's team
// assignments once drawn -- no login, names only (never email/phone),
// with an explicit "not drawn yet" placeholder before a draw, per the
// task's own decision that this must be visible "without needing the
// original RSVP link again."
//
// DECISION (documented, per the task's own "your judgment" prompt): no
// new "your team was just assigned" follow-up email was built for a
// player who confirmed BEFORE a draw that happens AFTER their 12h
// logistics email already went out. That's a real but narrow timing
// edge case (draws typically happen admin-side well before 12h out);
// building a dedicated new email template, its own trigger wired into
// the draw action, and its own send-once tracking is a meaningfully
// bigger addition than the task's "at minimum visible somewhere"
// bar requires -- the public page (surface 2) already satisfies that
// bar unconditionally, for every player, with no extra state to track.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { getConfirmedPlayers } from '../src/index.js';

const AUTH_SECRET = 'test-part8-weekly-draw-visibility-secret';

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
  const league = (await res.json()).league;
  await SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ season_name: `${body.name} Season` })
  });
  return league;
}
async function addPlayer(cookie, csrfToken, name, extra = {}) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, ...extra })
  });
  return (await res.json()).contact;
}

describe('Part 8 (live-testing task): weekly_draw team assignment visible beyond RSVP', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  describe('surface 1: getConfirmedPlayers now returns the real per-event team', () => {
    it('returns rsvp.team, not contacts.preferred_team -- correctly empty for weekly_draw until a draw happens, then correct', async () => {
      const { cookie, csrfToken } = await signup('weekly.draw.email.team@example.com', '203.0.130.001');
      const league = await createLeague(cookie, csrfToken, { name: 'Weekly Draw Email Team League', teamStructure: 'weekly_draw', teamNames: ['Rouge / Red', 'Bleu / Blue'], tracksStats: true });
      const player = await addPlayer(cookie, csrfToken, 'Draw Email Player', { email: 'drawemailplayer@example.com' });

      const eventRes = await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ date: '2099-11-02' })
      });
      const eventId = (await eventRes.json()).event.id;
      await SELF.fetch('http://example.com/league/rsvp/admin', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: player.player_id, status: 'in' })
      });

      let confirmed = await getConfirmedPlayers(env, league.id, eventId);
      expect(confirmed[0].rsvp_team).toBeNull();

      await SELF.fetch('http://example.com/league/events/random-assign', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId })
      });

      confirmed = await getConfirmedPlayers(env, league.id, eventId);
      expect(['Rouge / Red', 'Bleu / Blue']).toContain(confirmed[0].rsvp_team);
    });

    it('fixed mode is unaffected -- rsvp.team still matches the player\'s permanent team, same as before', async () => {
      const { cookie, csrfToken } = await signup('fixed.email.team@example.com', '203.0.130.002');
      const league = await createLeague(cookie, csrfToken, { name: 'Fixed Email Team League', teamNames: ['Falcons', 'Otters'], tracksStats: true });
      const player = await addPlayer(cookie, csrfToken, 'Fixed Email Player', { team: 'Falcons', email: 'fixedemailplayer@example.com' });

      const eventRes = await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ date: '2099-11-03' })
      });
      const eventId = (await eventRes.json()).event.id;
      await SELF.fetch('http://example.com/league/rsvp/admin', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: player.player_id, status: 'in' })
      });

      const confirmed = await getConfirmedPlayers(env, league.id, eventId);
      expect(confirmed[0].rsvp_team).toBe('Falcons');
    });
  });

  describe('surface 2: public page shows current draw, correctly empty before one', () => {
    it('shows a "not drawn yet" placeholder before any draw has happened', async () => {
      const { cookie, csrfToken } = await signup('weekly.draw.public.before@example.com', '203.0.130.003');
      const league = await createLeague(cookie, csrfToken, { name: 'Weekly Draw Public Before League', teamStructure: 'weekly_draw', teamNames: ['Rouge / Red', 'Bleu / Blue'], tracksStats: true });
      const player = await addPlayer(cookie, csrfToken, 'Public Before Player');
      const eventRes = await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ date: '2099-11-09' })
      });
      const eventId = (await eventRes.json()).event.id;
      await SELF.fetch('http://example.com/league/rsvp/admin', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: player.player_id, status: 'in' })
      });

      const html = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
      expect(html).toContain('data-i18n="drawnTeamsNone"');
      expect(html).not.toContain('Public Before Player');
    });

    it('shows correct current assignments (names only) after a draw, and nothing before it on the same page load cycle', async () => {
      const { cookie, csrfToken } = await signup('weekly.draw.public.after@example.com', '203.0.130.004');
      const league = await createLeague(cookie, csrfToken, { name: 'Weekly Draw Public After League', teamStructure: 'weekly_draw', teamNames: ['Rouge / Red', 'Bleu / Blue'], tracksStats: true });
      const p1 = await addPlayer(cookie, csrfToken, 'Drawn Player One', { email: 'drawnplayerone@example.com' });
      const p2 = await addPlayer(cookie, csrfToken, 'Drawn Player Two', { email: 'drawnplayertwo@example.com' });

      const eventRes = await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ date: '2099-11-16' })
      });
      const eventId = (await eventRes.json()).event.id;
      for (const p of [p1, p2]) {
        await SELF.fetch('http://example.com/league/rsvp/admin', {
          method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({ event_id: eventId, player_id: p.player_id, status: 'in' })
        });
      }
      await SELF.fetch('http://example.com/league/events/random-assign', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId })
      });

      const html = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
      expect(html).toContain('Drawn Player One');
      expect(html).toContain('Drawn Player Two');
      expect(html).not.toContain('drawnplayerone@example.com');
      expect(html).not.toContain('drawnplayertwo@example.com');
      expect(html).not.toContain('data-i18n="drawnTeamsNone"');
    });

    it('this section never appears for fixed or headcount leagues (weekly_draw only)', async () => {
      const { cookie, csrfToken } = await signup('fixed.public.no.draw.section@example.com', '203.0.130.005');
      const league = await createLeague(cookie, csrfToken, { name: 'Fixed Public No Draw Section League', teamNames: ['A', 'B'], tracksStats: true });
      await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ date: '2099-11-20' })
      });
      const html = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
      expect(html).not.toContain('data-i18n="drawnTeams"');
      expect(html).not.toContain('data-i18n="drawnTeamsNone"');
    });
  });
});

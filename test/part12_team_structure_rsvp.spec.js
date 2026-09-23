// Team-structure task, Part 4: RSVP and public pages. headcount has no
// team concept at all (no team shown on the RSVP page, no per-team
// breakdown on the public page -- a single pool-wide aggregate figure
// instead); weekly_draw's RSVP page shows no team until an admin
// assigns one for that specific event (Part 3's assign-team route),
// then the confirmed player can see it there; fixed is unchanged.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part12-team-structure-rsvp-secret';
const RSVP_SECRET = 'test-part12-team-structure-rsvp-rsvp-secret';

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
  return (await res.json()).contact.player_id;
}
async function createEvent(cookie, csrfToken, date) {
  return (await (await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ date })
  })).json()).event.id;
}
async function setStatus(cookie, csrfToken, eventId, playerId, status) {
  return SELF.fetch('http://example.com/league/rsvp/admin', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ event_id: eventId, player_id: playerId, status })
  });
}
async function computeToken(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
async function rsvpLink(leagueId, eventId, playerId) {
  const salt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerId).first()).token_salt;
  const token = await computeToken(RSVP_SECRET, `lr:${leagueId}:${eventId}:${playerId}:${salt}`);
  return `http://example.com/league/rsvp?league=${encodeURIComponent(leagueId)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`;
}

describe('Team structure, Part 4: RSVP and public pages', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    await applyRealSchema(env);
  });

  describe('FIXED MODE -- provably unaffected', () => {
    it('RSVP page still shows the team name and meter, exactly as before', async () => {
      const { cookie, csrfToken } = await signup('ts.rsvp.fixed@example.com', '203.0.115.001');
      const league = await createLeague(cookie, csrfToken, { name: 'RSVP Fixed League', teamNames: ['Otters', 'Falcons'], tracksStats: true });
      const eventId = await createEvent(cookie, csrfToken, '2099-02-01');
      const p1 = await addPlayer(cookie, csrfToken, 'RSVP Fixed Player', { team: 'Otters' });
      const link = await rsvpLink(league.id, eventId, p1);
      const res = await SELF.fetch(link);
      const html = await res.text();
      expect(html).toContain('<b>Otters</b>');
      expect(html).toContain('rv-team');
    });

    it('public page still shows the real team-name grid', async () => {
      const { cookie, csrfToken } = await signup('ts.rsvp.fixed.public@example.com', '203.0.115.002');
      const league = await createLeague(cookie, csrfToken, { name: 'RSVP Fixed Public League', teamNames: ['Otters', 'Falcons'], tracksStats: true });
      const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`);
      const html = await res.text();
      expect(html).toContain('>Otters<');
      expect(html).toContain('>Falcons<');
      expect(html).not.toContain('data-i18n="poolConfirmed"');
    });
  });

  describe('HEADCOUNT MODE', () => {
    it('RSVP page shows no team name/meter at all', async () => {
      const { cookie, csrfToken } = await signup('ts.rsvp.headcount@example.com', '203.0.115.003');
      const league = await createLeague(cookie, csrfToken, { name: 'RSVP Headcount League', tracksStats: true, teamStructure: 'headcount', minPlayers: 2, maxPlayers: 6 });
      const eventId = await createEvent(cookie, csrfToken, '2099-02-02');
      const p1 = await addPlayer(cookie, csrfToken, 'RSVP Headcount Player');
      const link = await rsvpLink(league.id, eventId, p1);
      const res = await SELF.fetch(link);
      const html = await res.text();
      // .rv-team-top is a static CSS class name present on every RSVP
      // page load (in the <style> block) regardless of mode -- check
      // for the actual rendered element, not the bare class name.
      expect(html).not.toContain('<div class="rv-team-top">');
      expect(html).not.toContain('>Tous<');
    });

    it('public page shows an aggregate confirmed figure, no per-team grid', async () => {
      const { cookie, csrfToken } = await signup('ts.rsvp.headcount.public@example.com', '203.0.115.004');
      const league = await createLeague(cookie, csrfToken, { name: 'RSVP Headcount Public League', tracksStats: true, teamStructure: 'headcount', minPlayers: 2, maxPlayers: 6 });
      const eventId = await createEvent(cookie, csrfToken, '2099-02-03');
      const p1 = await addPlayer(cookie, csrfToken, 'RSVP Headcount Public Player');
      await setStatus(cookie, csrfToken, eventId, p1, 'in');

      const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`);
      const html = await res.text();
      expect(html).toContain('data-i18n="poolConfirmed"');
      expect(html).toContain('class="pb-hero-pool"');
      expect(html).not.toContain('<h2 data-i18n="teams">');
      expect(html).not.toContain('>Tous<');
    });
  });

  describe('WEEKLY_DRAW MODE', () => {
    it('RSVP page shows no team before assignment, then shows the real assigned team after', async () => {
      const { cookie, csrfToken } = await signup('ts.rsvp.weekly@example.com', '203.0.115.005');
      const league = await createLeague(cookie, csrfToken, { name: 'RSVP Weekly League', teamNames: ['Red', 'Blue'], tracksStats: true, teamStructure: 'weekly_draw' });
      const eventId = await createEvent(cookie, csrfToken, '2099-02-04');
      const p1 = await addPlayer(cookie, csrfToken, 'RSVP Weekly Player');
      await setStatus(cookie, csrfToken, eventId, p1, 'in');

      const link = await rsvpLink(league.id, eventId, p1);
      const beforeRes = await SELF.fetch(link);
      const beforeHtml = await beforeRes.text();
      expect(beforeHtml).not.toContain('<div class="rv-team-top">');
      expect(beforeHtml).not.toContain('<b>Red</b>');

      await SELF.fetch('http://example.com/league/events/assign-team', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId, player_id: p1, team: 'Red' })
      });

      const afterRes = await SELF.fetch(link);
      const afterHtml = await afterRes.text();
      expect(afterHtml).toContain('<b>Red</b>');
      expect(afterHtml).toContain('<div class="rv-team-top">');
    });

    it('public page still shows the real team-name grid (weekly_draw has real named teams)', async () => {
      const { cookie, csrfToken } = await signup('ts.rsvp.weekly.public@example.com', '203.0.115.006');
      const league = await createLeague(cookie, csrfToken, { name: 'RSVP Weekly Public League', teamNames: ['Red', 'Blue'], tracksStats: true, teamStructure: 'weekly_draw' });
      const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`);
      const html = await res.text();
      expect(html).toContain('>Red<');
      expect(html).toContain('>Blue<');
      expect(html).not.toContain('data-i18n="poolConfirmed"');
    });
  });
});

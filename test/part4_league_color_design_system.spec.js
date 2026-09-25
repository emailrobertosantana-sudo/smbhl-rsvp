// Design system Part 4: the league's OWN color rule -- the RSVP and
// public pages must use each league's own stored color
// (leagueFillColor()-darkened for contrast), never a hardcoded/shared
// one. Two different leagues with two different colors must render
// two different --league token overrides.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { leagueFillColor } from '../src/design_system.js';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part4-league-color-ds-secret';
const RSVP_SECRET = 'test-part4-league-color-ds-rsvp-secret';

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

async function setUpLeague(email, ip, name, color) {
  const signupRes = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookie = extractCookie(signupRes);
  const csrfToken = extractCsrfToken(signupRes);
  const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, teamNames: ['A', 'B'], tracksStats: true })
  });
  const leagueId = (await leagueRes.json()).league.id;
  if (color) await env.DB.prepare('UPDATE leagues SET color = ? WHERE id = ?').bind(color, leagueId).run();
  return { cookie, csrfToken, leagueId };
}

describe('Part 4: the league\'s own color is used, not a hardcoded one', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    await applyRealSchema(env);
  });

  it('two leagues with two different colors get two different --league token overrides on the RSVP page', async () => {
    const green = '#1b7e4e'; // already passes 4.5:1, leagueFillColor should return it unchanged
    const league1 = await setUpLeague('ds.color1@example.com', '203.0.113.841', 'Color League One', green);
    const league2 = await setUpLeague('ds.color2@example.com', '203.0.113.842', 'Color League Two', '#ffd23f'); // needs darkening

    async function rsvpHtmlFor(league) {
      const contactRes = await SELF.fetch('http://example.com/league/contacts', {
        method: 'POST', headers: { cookie: league.cookie, 'content-type': 'application/json', 'x-csrf-token': league.csrfToken },
        body: JSON.stringify({ name: 'Color Test Player', team: 'A' })
      });
      const playerId = (await contactRes.json()).contact.player_id;
      const salt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerId).first()).token_salt;
      await SELF.fetch('http://example.com/league/season/publish', {
        method: 'POST', headers: { cookie: league.cookie, 'content-type': 'application/json', 'x-csrf-token': league.csrfToken },
        body: JSON.stringify({ season_name: 'Color Test Season' })
      });
      const eventRes = await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie: league.cookie, 'content-type': 'application/json', 'x-csrf-token': league.csrfToken },
        body: JSON.stringify({ date: '2099-09-09' })
      });
      const eventId = (await eventRes.json()).event.id;
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey('raw', encoder.encode(RSVP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`lr:${league.leagueId}:${eventId}:${playerId}:${salt}`));
      const token = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
      const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(league.leagueId)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`);
      return res.text();
    }

    const html1 = await rsvpHtmlFor(league1);
    const html2 = await rsvpHtmlFor(league2);

    expect(html1).toContain(`--league:${green};--on-league:#ffffff`);
    expect(html2).toContain(`--league:${leagueFillColor('#ffd23f')};--on-league:#ffffff`);
    // Genuinely different -- not the same fallback/sample color both times.
    expect(html1).not.toContain(`--league:${leagueFillColor('#ffd23f')}`);
    expect(html2).not.toContain(`--league:${green}`);
  });

  it("a league that never set its own color gets D2's own default preset colour, not migrate-025.sql's old sample colour", async () => {
    // D2 (settings polish task): the old sample colour (#b3122e) fails
    // the new colour-preset picker's own >=3:1 legibility bar (2.57:1
    // against the Arène theme's dark surface-hero) -- superseded by an
    // explicit preset written at league-creation time (see
    // handleLeagueCreate's own comment); the schema DEFAULT itself is
    // unchanged/unreachable for this path.
    const league = await setUpLeague('ds.color.default@example.com', '203.0.113.843', 'Color Default League', null);
    const row = await env.DB.prepare('SELECT color FROM leagues WHERE id = ?').bind(league.leagueId).first();
    expect(row.color).toBe('#c0392b');
    expect(row.color).not.toBe('#b3122e');

    const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.leagueId)}`);
    const html = await res.text();
    // The public page's hero still uses leagueFillColor() darkening,
    // completely unchanged mechanism -- just fed a different default.
    expect(html).toContain(leagueFillColor('#c0392b'));
  });
});

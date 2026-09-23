// Part 4 (overnight follow-up task): foundation for a future
// per-league setting letting a league manager choose which
// language(s) their league exposes to players -- leagues.language_mode
// (migrate-023.sql), default 'both' so every existing league and every
// league created today is completely unaffected. No admin UI to
// change it exists yet (intentionally out of scope); this only proves
// the field exists, defaults correctly, and that Parts 2/3's real
// toggle already respects it end to end on the two truly
// public/player-facing pages it names (GET /league/public,
// GET /league/rsvp) -- not the session-authenticated admin pages
// (dashboard/roster/schedule/event-detail), which keep their own
// toggle regardless of what a league exposes to players.
//
// This test file also satisfies Part 5 item 1's own explicit ask (a
// test confirming language_mode='both' shows a working toggle,
// language_mode='fr' does not and renders French only, SMBHL
// unaffected throughout) -- the same thing, not duplicated separately.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part4-language-mode-secret';
const RSVP_SECRET = 'test-part4-language-mode-rsvp-secret';

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
  const cookie = extractCookie(signupRes);
  const csrfToken = extractCsrfToken(signupRes);
  const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name: leagueName, teamNames, tracksStats: true })
  });
  const leagueId = (await leagueRes.json()).league.id;
  return { cookie, csrfToken, leagueId };
}

describe('Part 4: per-league language_mode foundation', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    await applyRealSchema(env);
  });

  it('every existing/new league defaults to language_mode = \'both\' -- unaffected by this addition', async () => {
    const a = await signupAndCreateLeague('part4.default@example.com', '203.0.113.631', 'Part 4 Default League', ['A', 'B']);
    const row = await env.DB.prepare('SELECT language_mode FROM leagues WHERE id = ?').bind(a.leagueId).first();
    expect(row.language_mode).toBe('both');
  });

  it("a language_mode='both' league's public page shows a real, working toggle", async () => {
    const a = await signupAndCreateLeague('part4.both@example.com', '203.0.113.632', 'Part 4 Both League', ['Red', 'Blue']);
    const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(a.leagueId)}`);
    const html = await res.text();
    expect(html).toContain('nl-lang');
    expect(html).toContain('id="btn-lang-en"');
    expect(html).toContain('Teams'); // the real English translation is present
  });

  it("a language_mode='fr' league's public page hides the toggle entirely and renders French only", async () => {
    const a = await signupAndCreateLeague('part4.fr@example.com', '203.0.113.633', 'Part 4 French Only League', ['Rouge', 'Bleu']);
    await env.DB.prepare(`UPDATE leagues SET language_mode = 'fr' WHERE id = ?`).bind(a.leagueId).run();

    const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(a.leagueId)}`);
    const html = await res.text();
    expect(html).not.toContain('id="btn-lang-fr"');
    expect(html).not.toContain('id="btn-lang-en"');
    expect(html).toContain('Équipes'); // French content still renders correctly
    expect(html).not.toContain('>Teams<'); // English translation never rendered as visible content
  });

  it("a language_mode='en' league's public page hides the toggle and renders English only", async () => {
    const a = await signupAndCreateLeague('part4.en@example.com', '203.0.113.634', 'Part 4 English Only League', ['Home', 'Away']);
    await env.DB.prepare(`UPDATE leagues SET language_mode = 'en' WHERE id = ?`).bind(a.leagueId).run();

    const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(a.leagueId)}`);
    const html = await res.text();
    expect(html).not.toContain('id="btn-lang-fr"');
    expect(html).not.toContain('id="btn-lang-en"');
    expect(html).toContain('>Teams<');
    expect(html).not.toContain('>Équipes<');
  });

  it("a language_mode='fr' league's /league/rsvp player page also hides the toggle and forces French, regardless of the visitor's own saved preference", async () => {
    const a = await signupAndCreateLeague('part4.rsvpfr@example.com', '203.0.113.635', 'Part 4 RSVP French League', ['A', 'B']);
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ season_name: 'Part 4 Season' })
    });
    await env.DB.prepare(`UPDATE leagues SET language_mode = 'fr' WHERE id = ?`).bind(a.leagueId).run();

    const contactRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ name: 'Part 4 Player One', team: 'A' })
    });
    const playerId = (await contactRes.json()).contact.player_id;
    const playerSalt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerId).first()).token_salt;
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie: a.cookie, 'content-type': 'application/json', 'x-csrf-token': a.csrfToken },
      body: JSON.stringify({ date: '2099-07-07', season: 'Part 4 Season' })
    });
    const eventId = (await eventRes.json()).event.id;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(RSVP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`lr:${a.leagueId}:${eventId}:${playerId}:${playerSalt}`));
    const token = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(a.leagueId)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`);
    const html = await res.text();
    expect(html).not.toContain('id="btn-lang-fr"');
    expect(html).not.toContain('id="btn-lang-en"');
    // The page greets by first name only (real ScreenRSVP voice).
    expect(html).toContain('>Part, tu joues'); // forced French, even though the shared page() shell would otherwise pick a visitor's browser-language default
    expect(html).not.toContain('>Part, are you playing'); // not rendered as visible content (still present, inertly, inside the shipped JS dict -- same as every other page's toggle)
  });

  it("SMBHL is completely unaffected: its own default language_mode is 'both', and it isn't part of this per-league system at all", async () => {
    // SMBHL's own real pages never pass a leagueId-derived leagueCfg
    // with a language_mode override -- DEFAULT_SEASON_CONFIG.league
    // .languageMode is 'both', so its own toggle keeps working exactly
    // as it always has. /signup itself moved onto nlDocument in Part 2
    // (design system task) -- checked here via a still-page()-based
    // route instead (an invite-accept page, untouched by that task).
    const res = await SELF.fetch('http://example.com/league/admins/accept?token=bogus-token-value');
    const html = await res.text();
    expect(html).toContain('langswitch');
    expect(html).toContain('id="btn-lang-en"');
  });
});

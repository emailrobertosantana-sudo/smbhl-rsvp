// Design system Part 6: copy pass. ERROR_I18N (src/error_i18n.js) is
// the one shared dictionary every new-product page's client-side
// validation and server-error display resolves through -- it
// previously used formal "vous/votre/Veuillez" language throughout,
// contradicting the README's own tutoiement rule ("Tutoiement
// everywhere in French") on literally every page that shows an error.
// Converted to tutoiement; this proves the fix and that SMBHL is still
// unaffected (it never gets this dictionary embedded at all).
// Also proves the RSVP page's "Can't make it" button matches the
// README's own FR/EN word-pair table exactly (previously "I can't").
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { ERROR_I18N } from '../src/error_i18n.js';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part6-copy-voice-secret';

describe('Part 6: copy voice pass -- tutoiement in error messages', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('ERROR_I18N no longer uses formal "vous/votre/Veuillez" French', () => {
    for (const [key, { fr }] of Object.entries(ERROR_I18N)) {
      expect(fr, `${key}: "${fr}"`).not.toMatch(/\bvous\b/i);
      expect(fr, `${key}: "${fr}"`).not.toMatch(/\bvotre\b/i);
      expect(fr, `${key}: "${fr}"`).not.toMatch(/\bveuillez\b/i);
    }
  });

  it('a real validation error on the signup page renders in tutoiement, not formal French', async () => {
    const res = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.861' },
      body: JSON.stringify({ email: 'not-an-email', password: 'a-strong-password-1' })
    });
    const json = await res.json();
    expect(json.errorKey).toBe('INVALID_EMAIL');
    expect(ERROR_I18N.INVALID_EMAIL.fr).toBe('Entre un courriel valide.');
  });

  it("the RSVP page's decline button matches the design system's real word-pair table (\"Can't make it\", not \"I can't\")", async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.862' },
      body: JSON.stringify({ email: 'ds.voice.rsvp@example.com', password: 'a-strong-password-1' })
    });
    const cookie = (signupRes.headers.get('set-cookie') || '').split(';')[0];
    const cookies = typeof signupRes.headers.getSetCookie === 'function' ? signupRes.headers.getSetCookie() : [cookie];
    const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
    const csrfToken = csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';

    const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Voice Pass League', teamNames: ['A', 'B'], tracksStats: true })
    });
    const leagueId = (await leagueRes.json()).league.id;
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Voice Pass Season' })
    });
    const contactRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Voice Pass Player', team: 'A' })
    });
    const playerId = (await contactRes.json()).contact.player_id;
    const playerSalt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerId).first()).token_salt;
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2099-05-01' })
    });
    const eventId = (await eventRes.json()).event.id;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode('test-part6-copy-voice-rsvp-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    env.RSVP_SECRET = 'test-part6-copy-voice-rsvp-secret';
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`lr:${leagueId}:${eventId}:${playerId}:${playerSalt}`));
    const token = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueId)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`);
    const html = await res.text();
    expect(html).toContain("Can't make it");
    expect(html).not.toContain('I can’t');
  });
});

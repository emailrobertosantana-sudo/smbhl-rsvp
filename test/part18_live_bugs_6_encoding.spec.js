// Bug 5, investigated via a real end-to-end live verification against
// notreligue.ca: "Aréna" and "René" appeared corrupted to U+FFFD
// (replacement character) in both the HTTP response and a direct D1
// byte inspection, for text submitted through the real event-venue and
// contact-name routes.
//
// ROOT CAUSE FOUND: this is NOT a server-side encoding bug. It was a
// live-testing tooling artifact -- Git Bash on Windows (both typing an
// accented character directly into a command, and `printf`'s own
// locale-dependent handling of \uXXXX escapes) produced a single
// Windows-1252/Latin-1 byte (0xE9) for "é" instead of the correct
// 2-byte UTF-8 sequence (0xC3 0xA9). A lone 0xE9 byte is not valid
// UTF-8 on its own; per the WHATWG Encoding standard (which
// Request.json()'s underlying UTF-8 decoding follows), a genuinely
// malformed byte sequence is correctly replaced with U+FFFD -- that is
// spec-compliant, correct behavior, not a bug to fix.
//
// Confirmed via a controlled live test: sending the REAL, valid UTF-8
// bytes for "é" (0xC3 0xA9) through the exact same live route, via a
// file with guaranteed-correct bytes (bypassing shell argument
// quoting entirely), round-tripped PERFECTLY -- "Aréna Test File" came
// back byte-for-byte correct in both the HTTP response and a direct D1
// SELECT. A real browser's fetch()/form submission always encodes
// request bodies as correct UTF-8, so this malformed-input scenario
// cannot occur through the real product's own UI in the first place.
//
// No code was changed for this "bug" -- there was nothing to fix. This
// test documents the investigation and proves the real pipeline
// (HTTP -> req.json() -> D1 write -> D1 read -> HTTP response) is
// correct for genuinely well-formed UTF-8 input, with direct D1-level
// verification (not just an HTTP response check).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part18-live-bugs-6-secret';

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

describe('Live-testing Bug 5 investigation: accented-character encoding is correct for real UTF-8 input', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a contact name with real French accented characters (é, à, ç) round-trips correctly through the HTTP response AND a direct D1 read', async () => {
    const { cookie, csrfToken } = await signup('bugs6.encoding.contact@example.com', '203.0.121.001');
    await createLeague(cookie, csrfToken, { name: 'Encoding Contact League', teamNames: ['A', 'B'], tracksStats: true });
    const realName = 'René Léveillé-Côté';
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: realName })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.contact.name).toBe(realName);
    expect(json.contact.name).not.toContain('�');

    // Direct D1-level verification -- proves the byte-for-byte stored
    // value, not just what the HTTP layer happens to echo back.
    const row = await env.DB.prepare('SELECT name FROM contacts WHERE player_id = ?').bind(json.contact.player_id).first();
    expect(row.name).toBe(realName);
    expect([...row.name].map(c => c.codePointAt(0))).toEqual([...realName].map(c => c.codePointAt(0)));
  });

  it('an event venue with real French accented characters (é, è) round-trips correctly through the HTTP response AND a direct D1 read', async () => {
    const { cookie, csrfToken } = await signup('bugs6.encoding.venue@example.com', '203.0.121.002');
    await createLeague(cookie, csrfToken, { name: 'Encoding Venue League', teamNames: ['A', 'B'], tracksStats: true });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Encoding Venue Season' })
    });
    const realVenue = 'Aréna Municipale de Montréal';
    const res = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2099-11-15', venue: realVenue })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.event.venue).toBe(realVenue);
    expect(json.event.venue).not.toContain('�');

    const row = await env.DB.prepare('SELECT venue FROM events WHERE id = ?').bind(json.event.id).first();
    expect(row.venue).toBe(realVenue);
    expect([...row.venue].map(c => c.codePointAt(0))).toEqual([...realVenue].map(c => c.codePointAt(0)));
  });

  it('the exact JSON \\uXXXX escape form of an accented character (as a real browser\'s JSON.stringify might emit it) parses correctly too, at the raw-bytes level', async () => {
    const { cookie, csrfToken } = await signup('bugs6.encoding.escapeform@example.com', '203.0.121.003');
    await createLeague(cookie, csrfToken, { name: 'Encoding Escape Form League', teamNames: ['A', 'B'], tracksStats: true });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Encoding Escape Form Season' })
    });
    // A raw request body string containing the literal 6-character
    // JSON escape sequence é (not a pre-decoded JS character) --
    // this is what a real browser's own JSON.stringify sometimes emits
    // for non-ASCII characters, and is valid, unambiguous JSON.
    const rawBody = '{"date":"2099-11-22","venue":"Ar\\u00e9na Escaped"}';
    const res = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: rawBody
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.event.venue).toBe('Aréna Escaped');
    const row = await env.DB.prepare('SELECT venue FROM events WHERE id = ?').bind(json.event.id).first();
    expect(row.venue).toBe('Aréna Escaped');
  });
});

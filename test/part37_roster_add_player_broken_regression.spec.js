// Live-testing task, Part 1 (URGENT): the roster page's "Ajouter"
// button did nothing on the live site.
//
// ROOT CAUSE: parseBulkText (index.js, added in the earlier bulk-import
// task) used single-backslash regex/string escapes (\r, \n, \d, \s, \t)
// written as literal text inside index.js's own outer server-side
// template literal (the "const script = ..." string
// handleLeagueRosterPage builds). That text goes through TWO rounds of
// JS parsing -- once when index.js itself loads in the Workers
// runtime, once more when the resulting text is later parsed as real
// JS in the browser. A single backslash only survives ONE of those
// rounds: the outer parse silently drops a backslash before any
// character that isn't a recognized string escape (\d became a bare
// d), and converts \r\n into REAL raw CR/LF bytes. A raw newline byte
// landing inside a /regex/ literal is illegal JS syntax -- which
// silently killed the ENTIRE inline <script> block (a SyntaxError
// anywhere in a <script> tag prevents every function in it from being
// defined at all, including submitContact -- not a broken function,
// a NEVER-DEFINED one). Fixed by doubling every backslash so a single
// one survives the first (server-side) parse intact.
//
// These tests would have caught this: (1) a general syntax-validity
// check on every inline <script> block across the league-admin pages
// (broad net -- catches this exact class of bug anywhere it recurs,
// not just in this one function), and (2) a direct assertion that
// submitContact is actually DEFINED as a function in the roster page's
// script (the precise symptom -- "the button does nothing" is exactly
// what an undefined onclick handler looks like).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { runScript, extractInlineScripts, assertNoSyntaxError } from './support/inline_scripts.js';

const AUTH_SECRET = 'test-part1-roster-broken-regression-secret';

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
// Live-testing task (batch 5), Part 8: this file's own stubDom/
// runScript/extractInlineScripts/assertNoSyntaxError were the FIRST
// use of this technique -- now generalized into test/support/
// inline_scripts.js (see its own top-of-file comment), imported here
// instead of the local copy.

describe('Part 1 (live-testing task, URGENT): roster "Ajouter" button regression', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the exact bug: submitContact is a real, defined function in the roster page\'s script (not silently missing due to an earlier syntax error)', async () => {
    const { cookie, csrfToken } = await signup('roster.broken.exact@example.com', '203.0.136.001');
    await createLeague(cookie, csrfToken, { name: 'Roster Broken Exact League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    const scripts = extractInlineScripts(html);
    expect(scripts.length).toBeGreaterThan(0);

    // Every script block must parse; concatenating them (same order
    // the browser loads them in) and asking for typeof submitContact
    // proves the function actually got DEFINED, not just referenced.
    const combined = scripts.join('\n;\n');
    expect(() => new Function(combined)).not.toThrow();
    const typeofSubmitContact = runScript(combined, 'return typeof submitContact;');
    expect(typeofSubmitContact).toBe('function');
  });

  it('the bulk-import parser (the actual broken code) produces correct results, not just valid syntax', async () => {
    const { cookie, csrfToken } = await signup('roster.broken.parser@example.com', '203.0.136.002');
    await createLeague(cookie, csrfToken, { name: 'Roster Broken Parser League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    const combined = extractInlineScripts(html).join('\n;\n');
    // A real multi-line, tab-separated paste with a phone number --
    // exercises every one of the 4 previously-broken escapes at once
    // (\r\n line splitting, \t column splitting, \d+\s- phone
    // detection, \s+ name whitespace collapsing).
    const pasted = 'Marie Tremblay\tmarie@example.com\t514-555-0100\r\nJean Bouchard\tjean@example.com';
    const rows = runScript(combined, 'return parseBulkText(' + JSON.stringify(pasted) + ');');
    expect(rows).toEqual([
      { name: 'Marie Tremblay', email: 'marie@example.com', phone: '514-555-0100' },
      { name: 'Jean Bouchard', email: 'jean@example.com', phone: '' }
    ]);
  });

  it('every major league-admin page\'s inline scripts are syntactically valid (broad regression net for this bug class)', async () => {
    const { cookie, csrfToken } = await signup('roster.broken.broadnet@example.com', '203.0.136.003');
    const league = await createLeague(cookie, csrfToken, { name: 'Roster Broken Broad Net League', teamNames: ['A', 'B'], tracksStats: true });
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Broad Net Season' })
    });
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2099-08-15' })
    });
    const eventId = (await eventRes.json()).event.id;

    const pages = [
      ['/dashboard', {}],
      ['/league/roster', {}],
      ['/league/schedule', {}],
      ['/league/settings', {}],
      [`/league/events/detail?e=${encodeURIComponent(eventId)}`, {}],
      [`/league/public?league=${encodeURIComponent(league.id)}`, {}],
      ['/signup?step=1', {}]
    ];
    for (const [path] of pages) {
      const html = await (await SELF.fetch(`http://example.com${path}`, { headers: { cookie } })).text();
      const scripts = extractInlineScripts(html);
      assertNoSyntaxError(scripts, path);
    }
  });

  it('the server-side POST /league/contacts route (what "Ajouter" actually calls) still works -- confirms the bug was purely client-side, never a server regression', async () => {
    const { cookie, csrfToken } = await signup('roster.broken.serverside@example.com', '203.0.136.004');
    const league = await createLeague(cookie, csrfToken, { name: 'Roster Broken Serverside League', teamNames: ['A', 'B'], tracksStats: true });
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Serverside Add Player', team: 'A' })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.contact.name).toBe('Serverside Add Player');
  });
});

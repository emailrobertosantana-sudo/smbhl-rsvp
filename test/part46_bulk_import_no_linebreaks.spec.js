// Live-testing task (batch 2), Part 2: pasting several players where
// line breaks are missing between records collapsed everything into
// ONE record -- all names concatenated, only the LAST person's phone
// kept, reported as "1 sur 1" as if it were correct.
//
// ROOT CAUSE: parseBulkText always treated one physical line as exactly
// one record. A comma-separated paste with no newlines between people
// is still just ONE physical line, so every field on it (every name,
// every email, every phone, for every person) went into the SAME
// field list -- the old code found the first '@' as THE email (losing
// every other person's), found the LAST phone-looking field scanned
// (since it kept overwriting -- actually the FIRST phone found, but
// with every other field joined into one giant "name").
//
// FIX: a physical line carrying 2+ email addresses (or 2+ phone-looking
// fields) is now chunked into separate records. The boundary signal:
// once the record being built already has an email or a phone, the
// next plain field is name-like text starting a NEW record -- matching
// how a real paste actually reads ("Name, email, phone, Name, email,
// phone, ..."). A chunk that still can't be told apart with confidence
// (ends up with no real name) reports its own "no name" status in the
// preview rather than being silently imported as a garbled record.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part2-batch2-bulk-no-linebreaks-secret';

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
function stubDom() {
  const el = { querySelectorAll: () => [], addEventListener: () => {}, setAttribute: () => {}, getAttribute: () => null, style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} } };
  return {
    window: { location: { search: '' } },
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {}, createElement: () => ({ ...el, appendChild: () => {} }) },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { language: 'en-US' },
    location: { search: '' }
  };
}
function runScript(combined, tail) {
  const stub = stubDom();
  const fn = new Function('window', 'document', 'localStorage', 'navigator', 'location', combined + '\n' + (tail || ''));
  return fn(stub.window, stub.document, stub.localStorage, stub.navigator, stub.location);
}
function extractInlineScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

describe('Part 2 (live-testing task, batch 2): bulk import survives a paste with no line breaks between records', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the exact failing case: 5 players, comma-separated, no line breaks at all', async () => {
    const { cookie, csrfToken } = await signup('bulk.nolinebreak.exact@example.com', '203.0.162.001');
    await createLeague(cookie, csrfToken, { name: 'Bulk No Linebreak League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    const combined = extractInlineScripts(html).join('\n;\n');

    const pasted = [
      'Marie Tremblay, marie@example.com, 514-555-0100',
      'Jean Bouchard, jean@example.com, 514-555-0101',
      'Sophie Gagnon, sophie@example.com, 514-555-0102',
      'Luc Martin, luc@example.com, 514-555-0103',
      'Anne Roy, anne@example.com, 514-555-0104'
    ].join(', ');

    const rows = runScript(combined, 'return parseBulkText(' + JSON.stringify(pasted) + ');');
    expect(rows).toEqual([
      { name: 'Marie Tremblay', email: 'marie@example.com', phone: '514-555-0100' },
      { name: 'Jean Bouchard', email: 'jean@example.com', phone: '514-555-0101' },
      { name: 'Sophie Gagnon', email: 'sophie@example.com', phone: '514-555-0102' },
      { name: 'Luc Martin', email: 'luc@example.com', phone: '514-555-0103' },
      { name: 'Anne Roy', email: 'anne@example.com', phone: '514-555-0104' }
    ]);
  });

  it('a mix of real newlines AND a jammed multi-record line in the same paste', async () => {
    const { cookie, csrfToken } = await signup('bulk.nolinebreak.mixed@example.com', '203.0.162.002');
    await createLeague(cookie, csrfToken, { name: 'Bulk Mixed League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    const combined = extractInlineScripts(html).join('\n;\n');

    const pasted = 'Solo Player, solo@example.com, 514-555-0200\n'
      + 'Marie Tremblay, marie2@example.com, 514-555-0201, Jean Bouchard, jean2@example.com, 514-555-0202';
    const rows = runScript(combined, 'return parseBulkText(' + JSON.stringify(pasted) + ');');
    expect(rows).toEqual([
      { name: 'Solo Player', email: 'solo@example.com', phone: '514-555-0200' },
      { name: 'Marie Tremblay', email: 'marie2@example.com', phone: '514-555-0201' },
      { name: 'Jean Bouchard', email: 'jean2@example.com', phone: '514-555-0202' }
    ]);
  });

  it('a jammed line with no phone numbers, just repeating name/email pairs', async () => {
    const { cookie, csrfToken } = await signup('bulk.nolinebreak.noemail@example.com', '203.0.162.003');
    await createLeague(cookie, csrfToken, { name: 'Bulk No Phone League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    const combined = extractInlineScripts(html).join('\n;\n');

    const pasted = 'Marie Tremblay, marie@example.com, Jean Bouchard, jean@example.com, Sophie Gagnon, sophie@example.com';
    const rows = runScript(combined, 'return parseBulkText(' + JSON.stringify(pasted) + ');');
    expect(rows).toEqual([
      { name: 'Marie Tremblay', email: 'marie@example.com', phone: '' },
      { name: 'Jean Bouchard', email: 'jean@example.com', phone: '' },
      { name: 'Sophie Gagnon', email: 'sophie@example.com', phone: '' }
    ]);
  });

  it('the preview correctly reports 5 of 5 confirmed (not "1 sur 1") for the exact failing case', async () => {
    const { cookie, csrfToken } = await signup('bulk.nolinebreak.preview@example.com', '203.0.162.004');
    await createLeague(cookie, csrfToken, { name: 'Bulk Preview League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    const combined = extractInlineScripts(html).join('\n;\n');

    const pasted = [
      'Marie Tremblay, marie@example.com, 514-555-0100',
      'Jean Bouchard, jean@example.com, 514-555-0101',
      'Sophie Gagnon, sophie@example.com, 514-555-0102',
      'Luc Martin, luc@example.com, 514-555-0103',
      'Anne Roy, anne@example.com, 514-555-0104'
    ].join(', ');
    const rows = runScript(combined, 'return parseBulkText(' + JSON.stringify(pasted) + ');');
    // Mirrors bulkPreview's own per-row status logic without a real DOM
    // (bulkPreview itself writes to document.getElementById, which the
    // stub can't observe) -- proves the parsed rows themselves are the
    // 5 real, distinct, confident records the preview would count.
    expect(rows.length).toBe(5);
    const allHaveRealNames = rows.every(r => r.name && r.name.trim().split(' ').filter(Boolean).length >= 2);
    expect(allHaveRealNames).toBe(true);
    const uniqueEmails = new Set(rows.map(r => r.email.toLowerCase()));
    expect(uniqueEmails.size).toBe(5);
  });

  it('a genuinely ambiguous chunk (email arriving before any name) reports no name rather than a garbled guess', async () => {
    const { cookie, csrfToken } = await signup('bulk.nolinebreak.ambiguous@example.com', '203.0.162.005');
    await createLeague(cookie, csrfToken, { name: 'Bulk Ambiguous League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    const combined = extractInlineScripts(html).join('\n;\n');

    // Email-first ordering for the first record -- the chunker can't
    // confidently attribute a name to it, so it must come back with an
    // empty name (which bulkPreview's own existing status logic already
    // flags as "no name" and excludes from the confirmed import) rather
    // than silently borrowing the next record's name.
    const pasted = 'oddemail@example.com, 514-555-0300, Real Person, real@example.com, 514-555-0301';
    const rows = runScript(combined, 'return parseBulkText(' + JSON.stringify(pasted) + ');');
    expect(rows[0].name).toBe('');
    expect(rows[0].email).toBe('oddemail@example.com');
    expect(rows[1]).toEqual({ name: 'Real Person', email: 'real@example.com', phone: '514-555-0301' });
  });

  it('a normal single-record line (the common case) is completely unaffected', async () => {
    const { cookie, csrfToken } = await signup('bulk.nolinebreak.single@example.com', '203.0.162.006');
    await createLeague(cookie, csrfToken, { name: 'Bulk Single League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    const combined = extractInlineScripts(html).join('\n;\n');

    const pasted = 'Marie Tremblay\tmarie@example.com\t514-555-0100\r\nJean Bouchard\tjean@example.com';
    const rows = runScript(combined, 'return parseBulkText(' + JSON.stringify(pasted) + ');');
    expect(rows).toEqual([
      { name: 'Marie Tremblay', email: 'marie@example.com', phone: '514-555-0100' },
      { name: 'Jean Bouchard', email: 'jean@example.com', phone: '' }
    ]);
  });
});

// Live-testing task (batch 2), Part 3: the bulk-import overlay's
// "Annuler" button called the same toggleBulkImport() the "Importer
// d'un tableur" button opens it with -- a pure visibility toggle that
// never cleared the pasted text or the stale preview table. Reopening
// later showed the previous attempt still sitting there.
//
// FIX: a dedicated cancelBulkImport() clears the textarea, hides and
// empties the preview table/summary, resets the confirmed-rows buffer
// (BULK_ROWS), clears any error banner, and closes the overlay
// explicitly (not a toggle).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part3-batch2-bulk-cancel-resets-secret';

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
function extractInlineScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

// A small but REAL stateful DOM stub -- unlike part37's throwaway
// no-op stub, this one actually tracks element values/classes/content
// so cancelBulkImport's resets can be genuinely observed, not just
// checked for "doesn't throw."
function makeStatefulDom() {
  const elements = {};
  function makeEl(id) {
    return {
      id,
      value: '',
      textContent: '',
      innerHTML: '',
      style: { display: '' },
      classList: {
        set: new Set(),
        add(c) { this.set.add(c); },
        remove(c) { this.set.delete(c); },
        toggle(c) { this.set.has(c) ? this.set.delete(c) : this.set.add(c); },
        contains(c) { return this.set.has(c); }
      }
    };
  }
  for (const id of ['ro_bulk_text', 'ro_bulk_preview', 'ro_bulk_tbody', 'ro_bulk_summary', 'bulkErr', 'ro_bulk_overlay']) {
    elements[id] = makeEl(id);
  }
  const document = {
    getElementById: (id) => elements[id] || null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} }, appendChild: () => {} })
  };
  return { elements, document };
}

describe('Part 3 (live-testing task, batch 2): bulk import "Annuler" returns to a clean state', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('cancelBulkImport clears the textarea, hides the preview, empties the table, and resets BULK_ROWS', async () => {
    const { cookie, csrfToken } = await signup('bulk.cancel.reset@example.com', '203.0.163.001');
    await createLeague(cookie, csrfToken, { name: 'Bulk Cancel Reset League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    const combined = extractInlineScripts(html).join('\n;\n');

    const { elements, document } = makeStatefulDom();
    // Simulate the state left over from a previous, uncancelled attempt.
    elements.ro_bulk_text.value = 'Stale Person, stale@example.com, 514-555-9999';
    elements.ro_bulk_preview.style.display = 'flex';
    elements.ro_bulk_tbody.innerHTML = '<tr><td>Stale Person</td></tr>';
    elements.ro_bulk_summary.textContent = '1 sur 1';
    elements.bulkErr.style.display = 'block';
    elements.ro_bulk_overlay.classList.add('open');

    const window = { location: { search: '' } };
    const localStorage = { getItem: () => null, setItem: () => {} };
    const navigator = { language: 'en-US' };
    const location = { search: '' };
    const fn = new Function('window', 'document', 'localStorage', 'navigator', 'location',
      combined + '\n' +
      'BULK_ROWS = [{ name: "Stale Person", email: "stale@example.com", phone: "514-555-9999" }];\n' +
      'cancelBulkImport();\n' +
      'return { bulkRowsLength: BULK_ROWS.length };'
    );
    const result = fn(window, document, localStorage, navigator, location);

    expect(elements.ro_bulk_text.value).toBe('');
    expect(elements.ro_bulk_preview.style.display).toBe('none');
    expect(elements.ro_bulk_tbody.innerHTML).toBe('');
    expect(elements.ro_bulk_summary.textContent).toBe('');
    expect(elements.bulkErr.style.display).toBe('none');
    expect(elements.ro_bulk_overlay.classList.contains('open')).toBe(false);
    expect(result.bulkRowsLength).toBe(0);
  });

  it('the "Annuler" button in the rendered page calls cancelBulkImport, not the old bare toggle', async () => {
    const { cookie, csrfToken } = await signup('bulk.cancel.wiring@example.com', '203.0.163.002');
    await createLeague(cookie, csrfToken, { name: 'Bulk Cancel Wiring League', teamNames: ['A', 'B'], tracksStats: true });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    const bulkSection = html.slice(html.indexOf('id="ro_bulk_overlay"'));
    expect(bulkSection).toContain('onclick="cancelBulkImport()"');
    expect(bulkSection).not.toContain('onclick="toggleBulkImport()">Annuler');
  });
});

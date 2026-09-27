// CRITICAL data-corruption fix: the SMBHL admin Contacts page stripped
// every letter "s" from email addresses before saving them.
//
// Cause: the page's client script lives inside a server-side JS
// TEMPLATE LITERAL (page('Contacts', `...`)). In a template literal,
// `\s` is not an escape sequence, so the backslash is silently dropped
// -- the browser received `.replace(/s+/g, '')` instead of
// `.replace(/\s+/g, '')`, deleting every "s" from the address. The
// matching validation regex degraded the same way (`\.` -> `.`), so
// the corrupted address still "validated" and was saved. Production
// evidence: colinpseers@ -> colinpeer@, steven.pimentel@ ->
// teven.pimentel@, probash@ -> probah@, and more. (An earlier one-off
// hotfix, ensureContactsArchiveColumns' rantana@ -> rsantana@ UPDATE,
// was the same bug, patched in the data rather than at the cause.)
//
// The same bug class was live in 29 other places across index.js,
// review.js and season_hub.js (cookie lookups, scoresheet name
// splitting, a date prompt that rejected every valid date, a team-label
// emoji strip). This file locks both levels:
//   1. behaviour -- the Contacts page's SERVED email normaliser and
//      validator, run on the real production evidence addresses;
//   2. the whole class -- no template literal anywhere in src/ may
//      contain a backslash that JavaScript would silently drop.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import * as acorn from 'acorn';
import { applyRealSchema } from './support/real_schema.js';

const SOURCES = import.meta.glob('../src/*.js', { eager: true, query: '?raw', import: 'default' });

// The addresses that were corrupted in production, as they should be.
const EVIDENCE = [
  'colinpseers@example.com', 'steven.pimentel@example.com', 'probash@example.com',
  'arthaudplesius@example.com', 'christophersiconolfi@example.com', 'nicholasjones09@example.com',
  'josephlahoud224@example.com', 'stephane.sylvain02@example.com'
];

describe('SMBHL Contacts page: email addresses keep every "s"', () => {
  let html;
  beforeAll(async () => {
    await applyRealSchema(env);
    const res = await SELF.fetch('http://example.com/admin/contacts');
    expect(res.status).toBe(200);
    html = await res.text();
  });

  // Pull the exact normaliser/validator expressions out of the page the
  // browser receives, and run them.
  function servedNormaliser(prefix) {
    const i = html.indexOf(prefix);
    expect(i, `served page no longer contains "${prefix}"`).toBeGreaterThan(-1);
    const chain = html.slice(i + prefix.length, html.indexOf(';', i));
    return new Function('v', `return v${chain};`);
  }
  function servedValidator(varName) {
    const m = html.match(new RegExp(`if \\(${varName} && !(/\\^\\[a-z0-9[^\\n]*?\\$/)\\.test\\(${varName}\\)\\)`));
    expect(m, `served page no longer contains the ${varName} validation regex`).toBeTruthy();
    return new Function(`return ${m[1]};`)();
  }

  for (const [label, prefix, varName] of [
    ['editing an existing contact\'s email', 'let val = i.value', 'val'],
    ['adding a new contact', "let email = $('nmail').value", 'email']
  ]) {
    it(`${label}: the served normaliser leaves every production evidence address intact`, () => {
      const normalise = servedNormaliser(prefix);
      for (const addr of EVIDENCE) expect(normalise(addr)).toBe(addr);
      // It still does its real jobs: trim, lowercase, strip whitespace, comma -> dot.
      expect(normalise('  Colin P Seers@Example,com ')).toBe('colinpseers@example.com');
    });

    it(`${label}: the served validator rejects an address without a real dot before the TLD`, () => {
      const re = servedValidator(varName);
      for (const addr of EVIDENCE) expect(re.test(addr)).toBe(true);
      expect(re.test('colinpseers@examplecom')).toBe(false);
    });
  }
});

describe('No template literal in src/ silently drops a backslash', () => {
  // Escapes a template literal actually understands; any other `\X`
  // cooks to plain "X" and the backslash vanishes from the output.
  const MEANINGFUL = new Set(['n', 't', 'r', 'b', 'f', 'v', '0', 'x', 'u', '`', '$', '\\', "'", '"', '\n', '\r']);

  it('finds zero dropped backslashes across every source file', () => {
    const files = Object.keys(SOURCES);
    expect(files.length).toBeGreaterThan(10);
    const offenders = [];
    for (const [file, src] of Object.entries(SOURCES)) {
      const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
      (function walk(n) {
        if (!n || typeof n.type !== 'string') return;
        if (n.type === 'TemplateElement') {
          const seg = src.slice(n.start, n.end);
          for (let i = 0; i < seg.length; i++) {
            if (seg[i] !== '\\') continue;
            if (!MEANINGFUL.has(seg[i + 1])) {
              const line = src.slice(0, n.start + i).split('\n').length;
              offenders.push(`${file}:${line}  \\${seg[i + 1]}  in: ${seg.slice(Math.max(0, i - 50), i + 30).replace(/\s+/g, ' ')}`);
            }
            i++;
          }
        }
        for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
      })(ast);
    }
    // Inside a template literal, write `\\s`, `\\d`, `\\.` etc. so the
    // rendered script receives the single backslash you meant.
    expect(offenders).toEqual([]);
  });
});

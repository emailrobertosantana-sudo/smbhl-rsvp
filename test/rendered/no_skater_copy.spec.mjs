// Batch 7 item 5e: "skater" is "player" in all user-facing English (the
// role choice is Player / Goalie / Both). Internal names (the 'skater' role
// value, variables, keys, log lines) may keep it. Fails on:
//   - a string literal in src/*.js whose text says "skater(s)" as a word;
//   - a rendered email in the two golden recordings (part114) saying it.
// Node side (this project) because it reads the files; no browser.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A word on its own: not part of a name (cnt-skater, ps-skater-fields), not
// a quoted value inside the text (inviteSubs('', 'skater')), not a key or a
// URL parameter (call:<game>:skater:<id>, n=skater&).
const WORD = /(^|[^A-Za-z0-9_\-'"=:/])skaters?(?![A-Za-z0-9_\-'"&])/i;
const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

// A line's code with its template expressions removed (${...}, nested braces
// included), so a variable named skaters inside one is not read as text.
function stripExpressions(line) {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '$' && line[i + 1] === '{') {
      let depth = 0, j = i + 1;
      for (; j < line.length; j++) {
        if (line[j] === '{') depth++;
        else if (line[j] === '}' && --depth === 0) break;
      }
      out += '${}';
      i = j;
    } else out += line[i];
  }
  return out;
}

describe('no "skater" in user-facing English', () => {
  it('no string literal in src says skater', () => {
    const hits = [];
    for (const f of readdirSync(join(ROOT, 'src')).filter(x => x.endsWith('.js'))) {
      readFileSync(join(ROOT, 'src', f), 'utf8').split(/\r?\n/).forEach((raw, i) => {
        const t = raw.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        if (/console\.(log|warn|error)/.test(raw)) return;
        const line = stripExpressions(raw.replace(/\s\/\/ .*$/, ''));
        for (const m of line.match(LITERAL) || []) {
          const text = m.slice(1, -1);
          if (/^(sub_)?skaters?$/i.test(text)) continue; // the role value
          if (WORD.test(text)) hits.push(`${f}:${i + 1}: ${m.slice(0, 120)}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('no rendered email in the golden recordings says skater', () => {
    for (const f of ['part114_reminders_golden_leagues.spec.js.snap', 'part114_reminders_golden_smbhl.spec.js.snap']) {
      const lines = readFileSync(join(ROOT, 'test', '__snapshots__', f), 'utf8').split(/\r?\n/).filter(l => WORD.test(l));
      expect(lines, f).toEqual([]);
    }
  });
});

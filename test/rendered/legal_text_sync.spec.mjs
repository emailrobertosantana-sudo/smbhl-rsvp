// src/legal_text.js is built from legal/privacy.md and legal/terms.md
// (scripts/build_legal.mjs). This fails when one of the files changed and
// the module was not built again: run node scripts/build_legal.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLegalModule } from '../../scripts/build_legal.mjs';

describe('the published legal text', () => {
  it('matches legal/privacy.md and legal/terms.md', () => {
    const built = readFileSync(fileURLToPath(new URL('../../src/legal_text.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    expect(built).toBe(buildLegalModule());
  });
});

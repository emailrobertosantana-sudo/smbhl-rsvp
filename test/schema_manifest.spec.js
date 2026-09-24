// Schema-drift guard, part 1: proves the generated manifest
// (src/schema_manifest.js) genuinely matches what schema.sql +
// migrate-*.sql actually produce -- the safety net that keeps
// scripts/generate_schema_manifest.js's output honest. If someone adds
// a new migrate-NNN.sql file and forgets to re-run the generator, this
// test fails the full suite (which this repo's own standing discipline
// already requires to be green before any commit), rather than letting
// the manifest silently drift from reality the same way production's
// actual schema silently drifted from demo's before the Sept 24
// incident.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { SCHEMA_MANIFEST } from '../src/schema_manifest.js';

async function realTablesAndColumns(env) {
  // _cf_% is Cloudflare's own internal D1 metadata table -- PRAGMA
  // table_info is auth-restricted against it (SQLITE_AUTH), and it was
  // never created by any migration in this repo, so it's correctly out
  // of scope for this comparison, same as sqlite_%/d1_%.
  const tables = (await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'`
  ).all()).results.map(r => r.name);
  const out = {};
  for (const table of tables) {
    const rows = (await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results || [];
    out[table] = rows.map(r => r.name).sort();
  }
  return out;
}

describe('schema drift guard: the generated manifest matches the real migrated schema exactly', () => {
  beforeAll(async () => {
    await applyRealSchema(env);
  });

  it('every table the real schema has is in the manifest, with the same columns', async () => {
    const real = await realTablesAndColumns(env);
    for (const table of Object.keys(real)) {
      expect(SCHEMA_MANIFEST, `manifest is missing table "${table}" -- run: node scripts/generate_schema_manifest.js`).toHaveProperty(table);
      expect(SCHEMA_MANIFEST[table].slice().sort(), `column mismatch on table "${table}" -- run: node scripts/generate_schema_manifest.js`).toEqual(real[table]);
    }
  });

  it('the manifest names no table the real schema does not actually have -- no stale/renamed entries', async () => {
    const real = await realTablesAndColumns(env);
    for (const table of Object.keys(SCHEMA_MANIFEST)) {
      expect(real, `manifest lists table "${table}" which doesn't exist in the real migrated schema -- was it renamed or dropped? Regenerate: node scripts/generate_schema_manifest.js`).toHaveProperty(table);
    }
  });

  it('the incident column itself -- outbox.league_id -- is really in both the manifest and the real schema (the exact Sept 24 gap)', async () => {
    expect(SCHEMA_MANIFEST.outbox).toContain('league_id');
    const real = await realTablesAndColumns(env);
    expect(real.outbox).toContain('league_id');
  });
});

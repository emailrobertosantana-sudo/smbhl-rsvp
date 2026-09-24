#!/usr/bin/env node
// Schema-drift guard, generator half. Reads schema.sql + every
// migrate-*.sql in the repo root and derives the full set of tables and
// columns the migration chain has ever added, then writes it out as a
// committed JS module (src/schema_manifest.js) the Worker imports.
//
// WHY GENERATED, NOT HAND-WRITTEN: a hand-maintained list of "columns
// the code depends on" is exactly the kind of thing that silently goes
// stale -- someone adds migrate-043.sql and forgets to also update a
// second, unrelated file. Deriving the manifest directly from the same
// .sql files that ARE the source of truth means there is only one place
// to update (write the migration) and one command to re-run
// (this script) -- see test/schema_manifest.spec.js for the test that
// fails loudly if anyone forgets that second step.
//
// PARSING SCOPE: only `CREATE TABLE [IF NOT EXISTS] x (...)` and
// `ALTER TABLE x ADD COLUMN y ...` are tracked -- the only two
// statement shapes that have ever introduced a table or column in this
// repo's migration history (verified by hand against all 44 files
// before writing this parser). DROP TABLE, CREATE INDEX, and data
// statements (INSERT/UPDATE/SELECT) are deliberately ignored: they
// don't change what tables/columns exist. ORDER DOES NOT MATTER for
// this purpose (unlike test/support/real_schema.js, which has to apply
// files in dependency order to actually build a working database) --
// this script only computes the eventual union of every table/column
// that should exist once every migration to date has been applied, so
// files are read in whatever order the filesystem returns them.
//
// Run this after adding a new migrate-NNN.sql file:
//   node scripts/generate_schema_manifest.js
// Then run the full test suite -- test/schema_manifest.spec.js will
// fail if the manifest and the real migrated schema disagree.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function stripComments(sql) {
  return sql
    .split('\n')
    .map(line => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function splitStatements(sql) {
  return stripComments(sql)
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

// Splits a CREATE TABLE column-list body on top-level commas only (not
// commas inside a nested parenthesis, e.g. a CHECK(...) constraint).
function splitTopLevel(body) {
  const parts = [];
  let depth = 0, current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

const TABLE_CONSTRAINT_KEYWORDS = new Set([
  'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT'
]);

function addColumn(manifest, table, column) {
  if (!manifest[table]) manifest[table] = new Set();
  manifest[table].add(column);
}

function parseFile(sql, manifest) {
  for (const stmt of splitStatements(sql)) {
    const createMatch = stmt.match(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)\s*\(([\s\S]*)\)\s*$/i);
    if (createMatch) {
      const [, table, body] = createMatch;
      for (const rawPart of splitTopLevel(body)) {
        const part = rawPart.trim();
        if (!part) continue;
        // \w+ (not a whitespace split) so a constraint with no space
        // before its own parenthesis -- e.g. `UNIQUE(player_id, date)`,
        // real syntax used in this repo's own migrations -- is still
        // recognized as UNIQUE, not mistaken for a column named
        // "UNIQUE(player_id, date)" (the '(' stops \w+ either way, so
        // both checks now use the exact same extraction).
        const colMatch = part.match(/^(\w+)/);
        if (!colMatch) continue;
        if (TABLE_CONSTRAINT_KEYWORDS.has(colMatch[1].toUpperCase())) continue;
        addColumn(manifest, table, colMatch[1]);
      }
      continue;
    }
    const alterMatch = stmt.match(/^ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i);
    if (alterMatch) {
      const [, table, column] = alterMatch;
      addColumn(manifest, table, column);
    }
  }
}

function main() {
  const manifest = {};

  const schemaPath = path.join(ROOT, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    console.error(`generate_schema_manifest: ${schemaPath} not found`);
    process.exit(1);
  }
  parseFile(fs.readFileSync(schemaPath, 'utf8'), manifest);

  const migrationFiles = fs.readdirSync(ROOT)
    .filter(f => /^migrate-\d+\.sql$/.test(f))
    .sort();
  if (migrationFiles.length === 0) {
    console.error('generate_schema_manifest: no migrate-*.sql files found');
    process.exit(1);
  }
  for (const f of migrationFiles) {
    parseFile(fs.readFileSync(path.join(ROOT, f), 'utf8'), manifest);
  }

  const sortedManifest = {};
  for (const table of Object.keys(manifest).sort()) {
    sortedManifest[table] = [...manifest[table]].sort();
  }

  const tableCount = Object.keys(sortedManifest).length;
  const columnCount = Object.values(sortedManifest).reduce((n, cols) => n + cols.length, 0);

  const out = `// GENERATED FILE -- do not hand-edit.
// Produced by scripts/generate_schema_manifest.js from schema.sql +
// all migrate-*.sql files (${1 + migrationFiles.length} files parsed, as of this
// generation). Re-run that script after adding a new migration, then
// run the full test suite -- test/schema_manifest.spec.js fails loudly
// if this file and the real migrated schema disagree.
//
// Consumed by src/schema_guard.js (the runtime drift check) and
// scripts/check_schema_remote.js (the pre-deploy check) -- both compare
// this list against a real database's actual PRAGMA table_info output.
// This is the single source of truth both share.
//
// ${tableCount} tables, ${columnCount} columns tracked.
export const SCHEMA_MANIFEST = ${JSON.stringify(sortedManifest, null, 2)};
`;

  fs.writeFileSync(path.join(ROOT, 'src', 'schema_manifest.js'), out);
  console.log(`generate_schema_manifest: wrote src/schema_manifest.js (${tableCount} tables, ${columnCount} columns, parsed ${1 + migrationFiles.length} files)`);
}

main();

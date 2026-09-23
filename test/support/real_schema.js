// Shared test schema loader: builds each test file's isolated D1 instance
// by actually running this repo's real schema.sql + migrate-*.sql files,
// the same way the real (demo/production) database is built -- instead of
// each spec file hand-rolling its own separate, ad hoc approximation of
// the schema.
//
// WHY THIS EXISTS: migrate-020.sql's SMBHL bootstrap row failed against the
// real demo D1 database with a FOREIGN KEY constraint violation
// (leagues.created_by REFERENCES users(id), but no matching users row).
// 428 hand-rolled-schema tests never caught it, because every spec file's
// inline `CREATE TABLE leagues (...)` had silently dropped the
// `REFERENCES users(id)` clause the real migration has. Building the test
// schema from the real files closes that class of gap for good.
//
// FILE ORDER: schema.sql is this app's original (unnumbered) base schema
// -- contacts/events/rsvp/sheet_reviews/team_messages. migrate-002.sql
// onward assumes those tables already exist. migrate-021.sql is a special
// case: it backfills CREATE TABLE statements for season_pricing and
// player_dues, two tables that were created directly against the real
// database at some point and never saved to a tracked migration file --
// migrate-011.sql already ALTERs season_pricing, so migrate-021.sql's
// content chronologically belongs *before* migrate-011.sql, not after
// migrate-020.sql where its number would literally place it. It is
// numbered 021 because it was written after 020 (it documents a
// pre-existing gap discovered while building this very loader), but it is
// *applied* right after schema.sql, alongside it, since -- like
// schema.sql -- it is base/prerequisite schema, not a chronologically-last
// change. It's pure `CREATE TABLE IF NOT EXISTS`, so applying it early is
// always safe. See migrate-021.sql's own header comment for the full story
// and a note on real vs. previously-assumed default-value drift.
//
// SQL FILE FORMAT ASSUMPTION: every migrate-*.sql file in this repo uses
// only single-line `--` comments and never a `;` or `--` inside a string
// literal (audited by hand -- 20 files, all short and hand-written). The
// splitter below relies on that; if a future migration needs a multi-line
// string, block comment, or a literal containing `;`/`--`, it will need a
// smarter splitter than this one.
import { applyD1Migrations } from 'cloudflare:test';

const schemaModules = import.meta.glob('../../schema.sql', { eager: true, query: '?raw', import: 'default' });
const migrationModules = import.meta.glob('../../migrate-*.sql', { eager: true, query: '?raw', import: 'default' });

function splitStatements(sql) {
  const withoutComments = sql
    .split('\n')
    .map(line => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
  return withoutComments
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

function numberFromMigratePath(p) {
  const m = p.match(/migrate-(\d+)\.sql$/);
  return m ? parseInt(m[1], 10) : null;
}

const schemaSql = Object.values(schemaModules)[0];
if (!schemaSql) throw new Error('real_schema.js: schema.sql not found via import.meta.glob');

const migrationEntries = Object.entries(migrationModules)
  .map(([path, sql]) => ({ path, num: numberFromMigratePath(path), sql }))
  .filter(e => e.num !== null)
  .sort((a, b) => a.num - b.num);

const gapFill021 = migrationEntries.find(e => e.num === 21);
if (!gapFill021) throw new Error('real_schema.js: migrate-021.sql not found');
const restInOrder = migrationEntries.filter(e => e.num !== 21);

const orderedFiles = [
  { name: 'schema.sql', sql: schemaSql },
  { name: 'migrate-021.sql (applied early: season_pricing/player_dues gap-fill, predates migrate-011.sql -- see this file\'s header)', sql: gapFill021.sql },
  ...restInOrder.map(e => ({ name: `migrate-${String(e.num).padStart(3, '0')}.sql`, sql: e.sql })),
];

const REAL_MIGRATIONS = orderedFiles.map(f => ({ name: f.name, queries: splitStatements(f.sql) }));

// Applies the real schema.sql + migrate-*.sql chain (see file order note
// above) to `env.DB`. Idempotent per D1 instance via applyD1Migrations'
// own d1_migrations bookkeeping table -- safe to call more than once.
export async function applyRealSchema(env) {
  await applyD1Migrations(env.DB, REAL_MIGRATIONS);
}

// Returns a single real migrate-NNN.sql file's own statements (e.g. for a
// test that wants to apply exactly one migration -- such as proving
// migrate-020.sql itself applies cleanly against a hand-built
// pre-migration schema) without hand-copying that file's SQL a second
// time. `num` is the migration number (e.g. 20 for migrate-020.sql).
export function getRealMigrationQueries(num) {
  const entry = migrationEntries.find(e => e.num === num);
  if (!entry) throw new Error(`getRealMigrationQueries: migrate-${num}.sql not found`);
  return splitStatements(entry.sql);
}

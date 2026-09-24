#!/usr/bin/env node
// Schema-drift guard, pre-deploy half. Same manifest, same comparison
// logic as src/schema_guard.js (the runtime guard that actually blocks
// traffic) -- this is the "catch it before shipping" convenience layer
// Part 1's own options analysis recommended alongside the runtime
// guard, not instead of it.
//
// IMPORTANT: this is a SCRIPT. It only runs if someone remembers to run
// it. That is a real, acknowledged limitation -- see DEPLOY.md and the
// runtime guard (src/schema_guard.js), which is the actual backstop
// that cannot be forgotten, because it isn't a separate step at all;
// it's baked into the deployed code and runs on the very first request
// against a fresh isolate, in both environments, automatically.
//
// Entirely read-only: every query here is PRAGMA table_info, nothing
// that writes to or alters the target database. Safe to run against
// production.
//
// Usage:
//   node scripts/check_schema_remote.js <database-name> --remote|--local [--env <name>]
//
// --env is wrangler's own environment flag -- required for any
// database only declared under an `env.<name>` block in
// wrangler.jsonc (e.g. notreligue-demo lives under env.demo), omitted
// for the top-level/production database (smbhl-rsvp).
//
// Examples:
//   node scripts/check_schema_remote.js notreligue-demo --remote --env demo
//   node scripts/check_schema_remote.js smbhl-rsvp --remote
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// src/schema_manifest.js is an ES module (bundled into the Worker by
// wrangler/esbuild, which understands `export` regardless of this
// project's own package.json module type) -- not directly `require`-
// able from plain Node. Rather than maintain a second copy of the
// manifest in a different format, this extracts the exact JSON object
// literal scripts/generate_schema_manifest.js writes (JSON.stringify
// output, no JS-specific syntax) straight out of the file text.
function loadManifest() {
  const filePath = path.join(__dirname, '..', 'src', 'schema_manifest.js');
  const src = fs.readFileSync(filePath, 'utf8');
  const match = src.match(/export const SCHEMA_MANIFEST = ([\s\S]*?);\s*$/);
  if (!match) {
    throw new Error(`check_schema_remote: could not parse ${filePath} -- was it hand-edited, or regenerated in an unexpected format? Re-run: node scripts/generate_schema_manifest.js`);
  }
  return JSON.parse(match[1]);
}

// Runs `npx wrangler d1 execute ... --command "<sql>"`, returning
// stdout. Built as one manually-quoted command STRING passed to
// execSync -- verified, while building this script, to be the only
// reliable option on Windows: execFileSync's argv-array form can't
// launch the npx.cmd shim at all (EINVAL), and passing an argv array
// through `shell: true` does NOT escape each element (Node's own
// documented behavior -- it only concatenates them with spaces), which
// silently re-splits a multi-statement SQL command containing spaces,
// parentheses, and semicolons into a pile of bogus separate CLI
// arguments. `command` here is built entirely from this script's own
// generated manifest (table names), never from external input, so a
// double-quote wrapper with no further escaping is safe.
function runWranglerCommand(dbName, flag, envName, command) {
  const envPart = envName ? ` --env ${envName}` : '';
  const cmdLine = `npx wrangler d1 execute ${dbName} ${flag}${envPart} --json --command "${command}"`;
  return execSync(cmdLine, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 });
}

function main() {
  const args = process.argv.slice(2);
  const dbName = args.find(a => !a.startsWith('--'));
  const remote = args.includes('--remote');
  const local = args.includes('--local');
  const envIdx = args.indexOf('--env');
  const envName = envIdx !== -1 ? args[envIdx + 1] : null;

  if (!dbName || (!remote && !local) || (remote && local)) {
    console.error('Usage: node scripts/check_schema_remote.js <database-name> --remote|--local [--env <name>]');
    console.error('Examples:');
    console.error('  node scripts/check_schema_remote.js notreligue-demo --remote --env demo');
    console.error('  node scripts/check_schema_remote.js smbhl-rsvp --remote');
    process.exit(2);
  }

  const manifest = loadManifest();
  const tables = Object.keys(manifest);
  const flag = remote ? '--remote' : '--local';
  const command = tables.map(t => `PRAGMA table_info(${t});`).join(' ');

  console.log(`check_schema_remote: checking ${tables.length} tables against "${dbName}" (${flag.slice(2)}${envName ? `, env=${envName}` : ''})...`);

  let raw;
  try {
    raw = runWranglerCommand(dbName, flag, envName, command);
  } catch (err) {
    console.error('check_schema_remote: failed to run wrangler d1 execute -- is wrangler authenticated, and does this database name exist?');
    console.error(String((err && err.message) || err));
    process.exit(2);
  }

  // --remote can print a progress line or two ahead of the JSON
  // payload -- extracting the outermost [...] array is robust to that
  // rather than assuming the whole stdout is pure JSON.
  const jsonStart = raw.indexOf('[');
  const jsonEnd = raw.lastIndexOf(']');
  let results;
  try {
    results = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  } catch (err) {
    console.error('check_schema_remote: could not parse wrangler output as JSON.');
    console.error(raw);
    process.exit(2);
  }

  const missing = [];
  tables.forEach((table, i) => {
    const rows = (results[i] && results[i].results) || [];
    const columns = new Set(rows.map(r => r.name));
    if (columns.size === 0) {
      missing.push({ table, column: null });
      return;
    }
    for (const column of manifest[table]) {
      if (!columns.has(column)) missing.push({ table, column });
    }
  });

  if (missing.length === 0) {
    console.log(`check_schema_remote: OK -- "${dbName}" matches every migration in this repo (${tables.length} tables checked).`);
    process.exit(0);
  }

  console.error(`check_schema_remote: DRIFT DETECTED against "${dbName}":`);
  for (const m of missing) {
    console.error(m.column === null
      ? `  - table "${m.table}" does not exist`
      : `  - table "${m.table}" has no column named "${m.column}"`);
  }
  console.error('Apply the pending migration(s) (see migrate-*.sql in the repo root) before deploying code that depends on them.');
  process.exit(1);
}

main();

#!/usr/bin/env node
// Demo-cleanup-script task: a standalone maintenance tool for clearing
// out accumulated test leagues on the demo environment (rsvp.notreligue.ca /
// database "notreligue-demo"). Invoked from PowerShell; see the usage
// block below.
//
// REUSE, NOT REIMPLEMENTATION: the actual destructive cascade (which
// tables, in what order, the KV data_json cleanup, the conditional
// admin-account deletion, the audit-log insert) is performLeagueHardDelete
// from src/hard_delete.js -- the exact same function the live product's
// own /league/hard-delete and /super-admin/leagues/hard-delete routes
// call. This script dynamically imports it (Node's ESM `import()` loads
// src/hard_delete.js and its dependency chain cleanly outside the
// Workers runtime -- verified empirically before writing this) rather
// than copying its table list or its DELETE statements. Fixing a real
// gap found while investigating this task (two tables -- venues,
// league_mail_failure_log -- added by migrate-041/040 were never added
// to hard_delete.js's own LEAGUE_SCOPED_TABLES) benefits this script
// AND the live product's real hard-delete automatically, from the one
// place that list lives.
//
// WHAT IS NOT REUSED, AND WHY: performLeagueHardDelete is called
// directly, bypassing checkHardDeleteEligibility (the "must be
// deactivated, then wait 15 days" gate) and the confirmation-phrase
// check. Those exist in the product to protect a live admin from
// fat-fingering deletion of their OWN, real league through the public
// UI -- they would make this tool useless for its actual purpose
// (deleting freshly-created test leagues on demand). This script has
// its own, different safeguards instead, appropriate for an operator
// tool rather than a public UI: a hard-coded, non-overridable demo-only
// database target (verified against wrangler's own resolution before
// anything else runs), an explicit required target list (never "all"),
// and dry-run as the default action.
//
// TRANSPORT: a standalone Node process has no direct D1 binding, so
// performLeagueHardDelete's `env.DB`/`env.SHEETS_KV` here are a small
// adapter shelling out to `wrangler d1 execute` / `wrangler kv key
// delete` per statement (the same "one big command-line string through
// execSync" technique scripts/check_schema_remote.js already
// established as the only reliable option on Windows -- see that
// file's own comment). This is the genuinely unavoidable difference
// between "running inside the Worker" and "a script talking to the
// same database over the CLI" -- the deletion LOGIC itself is untouched.
//
// USAGE (PowerShell):
//   node scripts/demo_league_cleanup.js list
//   node scripts/demo_league_cleanup.js delete --ids=<id1>,<id2>
//   node scripts/demo_league_cleanup.js delete --ids=<id1>,<id2> --execute
//   node scripts/demo_league_cleanup.js delete --slugs=<slug1>,<slug2> --execute
//
// Dry-run (report only, deletes nothing) is what `delete` does WITHOUT
// --execute -- that is the default. --execute is required to actually
// delete anything.

'use strict';

const { execSync } = require('child_process');

// ---------------------------------------------------------------------
// SAFETY: the demo target is a compile-time constant. There is no CLI
// flag anywhere in this script that can point it at a different
// database -- the only way to change what this script can ever touch
// is to edit this file. Cross-checked against wrangler's own live
// resolution (assertDemoTarget, below) before a single query runs.
// ---------------------------------------------------------------------
const DEMO_DB_NAME = 'notreligue-demo';
const DEMO_DB_UUID = '87411a46-fc5f-414f-bd46-6ff26feb155f';
const DEMO_WRANGLER_ENV = 'demo';
const DEMO_KV_BINDING = 'SHEETS_KV';
const PRODUCTION_DB_UUID = '6f1838cf-30b0-4b4b-b9fe-716b61b961e4'; // never touched; checked as a negative assertion only.
const SMBHL_LEAGUE_ID = 'smbhl';

function fail(message) {
  console.error(`\ndemo_league_cleanup: REFUSING TO CONTINUE -- ${message}\n`);
  process.exit(1);
}

// The single most important check in this file -- confirms `wrangler
// d1 execute notreligue-demo --env demo` really resolves to the demo
// database's own uuid (not just trusting the name string), explicitly
// confirms it is NOT production's uuid, and (as a side effect, since
// this call fails the same way either case) proves the Cloudflare
// OAuth token still works right now. Pure: returns a result, never
// exits the process itself -- see assertDemoTarget/reassertAuthOrReport
// below for the two ways callers act on that result.
function resolveDemoTarget() {
  let info;
  try {
    const raw = execSync(
      `npx wrangler d1 info ${DEMO_DB_NAME} --env ${DEMO_WRANGLER_ENV} --json`,
      { encoding: 'utf8', maxBuffer: 1024 * 1024 * 5 }
    );
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    info = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  } catch (err) {
    return { ok: false, error: `could not resolve database "${DEMO_DB_NAME}" via wrangler (--env ${DEMO_WRANGLER_ENV}). ` +
      `Is wrangler authenticated? Does wrangler.jsonc still declare this database under env.${DEMO_WRANGLER_ENV}?\n${(err && err.message) || err}` };
  }
  if (info.name !== DEMO_DB_NAME) {
    return { ok: false, error: `wrangler resolved a database named "${info.name}", not "${DEMO_DB_NAME}". Aborting.` };
  }
  if (info.uuid !== DEMO_DB_UUID) {
    return { ok: false, error: `wrangler resolved "${DEMO_DB_NAME}" to uuid ${info.uuid}, not the expected ${DEMO_DB_UUID}. ` +
      `wrangler.jsonc may have changed. Aborting rather than operating on an unverified database.` };
  }
  if (info.uuid === PRODUCTION_DB_UUID) {
    // Structurally unreachable given the two checks above (the demo and
    // production uuids are different constants), but kept as an
    // explicit, self-documenting assertion rather than relying on that
    // being true by construction alone.
    return { ok: false, error: 'the resolved database uuid matches PRODUCTION. Aborting unconditionally.' };
  }
  return { ok: true, info };
}

// Runs before anything else, on every invocation, no exceptions --
// the original single check this script always had. Exits immediately
// on failure (no destructive work has started yet, nothing to report).
function assertDemoTarget() {
  const result = resolveDemoTarget();
  if (!result.ok) fail(result.error);
  return result.info;
}

// Cleanup-script robustness task (4a): a real incident -- eleven
// leagues deleted, one partially, eight completely untouched -- came
// from the Cloudflare OAuth token expiring PARTWAY through a long
// --execute run, well after assertDemoTarget()'s own single check (at
// the top of main(), before target resolution and footprint counting)
// had already passed. Re-checked here, before EACH target's own
// destructive delete -- not just once at the very top -- so a token
// dying mid-batch stops the run cleanly BEFORE the next league is
// touched, rather than crashing on it with an opaque exec error.
// Prints exactly which targets are already done vs still untouched --
// that remaining list doubles as the resume instructions (rerun with
// --ids=<remaining> --execute once the token is refreshed) -- per the
// task's own instruction that the script should report where it
// stopped. NOT auto-retried: this stops and reports once, it never
// re-authenticates or waits and tries again on its own.
function reassertAuthOrReport(completed, remaining) {
  const result = resolveDemoTarget();
  if (result.ok) return;
  console.error(`\ndemo_league_cleanup: STOPPING -- re-auth check failed before the next league's delete: ${result.error}\n`);
  console.error(`Already deleted successfully (${completed.length}): ${completed.length ? completed.map(t => `${t.id} (${t.name})`).join(', ') : '(none)'}`);
  console.error(`Still untouched (${remaining.length}): ${remaining.length ? remaining.map(t => `${t.id} (${t.name})`).join(', ') : '(none)'}`);
  if (remaining.length) {
    console.error(`\nResume once your token is refreshed:\n  node scripts/demo_league_cleanup.js delete --ids=${remaining.map(t => t.id).join(',')} --execute\n`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------
// D1-over-CLI: turns `wrangler d1 execute` into the same
// prepare/bind/run/first/all shape performLeagueHardDelete already
// expects from a real D1 binding.
// ---------------------------------------------------------------------
function escapeSqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function interpolate(sql, args) {
  let i = 0;
  return sql.replace(/\?/g, () => escapeSqlValue(args[i++]));
}
// One `wrangler d1 execute` call may carry several `;`-separated
// statements -- wrangler returns one result envelope per statement, in
// order. Same "one big command-line string through execSync" technique
// scripts/check_schema_remote.js already established as the only
// reliable way to do this on Windows (argv-array forms either can't
// launch the npx.cmd shim, or get silently re-split by the shell).
function runD1Batch(sqlStatements) {
  // performLeagueHardDelete's own SQL (src/hard_delete.js) includes at
  // least one multi-line template literal (the league_hard_delete_log
  // INSERT) -- harmless inside a real D1 binding, but a literal newline
  // embedded in a double-quoted Windows cmd.exe argument breaks the
  // command (confirmed live: SQLITE_ERROR "incomplete input" -- the
  // audit-log INSERT failed this exact way during this task's own
  // Part 3 proof run, after every real DELETE had already succeeded).
  // Collapsing all whitespace runs to a single space is semantically a
  // no-op for SQL and makes every statement, regardless of source
  // formatting, safe to pass through one shell argument.
  const combined = sqlStatements.join(' ').replace(/\s+/g, ' ');
  const shellSafeSql = combined.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const cmdLine = `npx wrangler d1 execute ${DEMO_DB_NAME} --remote --env ${DEMO_WRANGLER_ENV} --json --command "${shellSafeSql}"`;
  const raw = execSync(cmdLine, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 });
  const jsonStart = raw.indexOf('[');
  const jsonEnd = raw.lastIndexOf(']');
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error(`demo_league_cleanup: could not find a JSON array in wrangler's output:\n${raw}`);
  }
  return JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
}
function runD1One(sql) {
  return runD1Batch([sql])[0];
}

function makeD1Env() {
  return {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            const finalSql = interpolate(sql, args);
            return {
              async run() {
                const result = runD1One(finalSql);
                return { meta: { changes: (result && result.meta && result.meta.changes) || 0 } };
              },
              async first() {
                const result = runD1One(finalSql);
                return (result && result.results && result.results[0]) || null;
              },
              async all() {
                const result = runD1One(finalSql);
                return { results: (result && result.results) || [] };
              }
            };
          }
        };
      }
    },
    SHEETS_KV: {
      async delete(key) {
        try {
          execSync(
            `npx wrangler kv key delete "${key}" --binding=${DEMO_KV_BINDING} --env ${DEMO_WRANGLER_ENV} --remote`,
            { encoding: 'utf8', maxBuffer: 1024 * 1024 * 5 }
          );
        } catch (_) {
          // Matches performLeagueHardDelete's own try/catch around this
          // exact call -- a league that never published a season has no
          // data_json key to begin with, and that's fine either way.
        }
      }
    }
  };
}

// ---------------------------------------------------------------------
// Read-only reporting: same table SCOPE as performLeagueHardDelete
// (imports the real LEAGUE_SCOPED_TABLES so this can never silently
// drift from what a real delete actually touches), but this counting
// logic itself is new code written for this script -- there is no
// existing "count what a hard delete would touch" function to reuse.
// Used for both the dry-run report (before any write) and the
// post-delete orphan check (after a real one).
// ---------------------------------------------------------------------
async function countLeagueFootprint(d1Env, LEAGUE_SCOPED_TABLES, leagueId) {
  const counts = {};
  const tableSelects = LEAGUE_SCOPED_TABLES.map(t => `SELECT '${t}' AS t, COUNT(*) AS n FROM ${t} WHERE league_id = ${escapeSqlValue(leagueId)};`);
  const results = runD1Batch([
    ...tableSelects,
    `SELECT COUNT(*) AS n FROM league_team_assigned_email_log WHERE event_id IN (SELECT id FROM events WHERE league_id = ${escapeSqlValue(leagueId)});`,
    `SELECT COUNT(*) AS n FROM league_admins WHERE league_id = ${escapeSqlValue(leagueId)};`,
    `SELECT COUNT(*) AS n FROM leagues WHERE id = ${escapeSqlValue(leagueId)};`,
    `SELECT user_id FROM league_admins WHERE league_id = ${escapeSqlValue(leagueId)};`
  ]);
  LEAGUE_SCOPED_TABLES.forEach((t, i) => { counts[t] = (results[i].results[0] || {}).n || 0; });
  counts.league_team_assigned_email_log = (results[LEAGUE_SCOPED_TABLES.length].results[0] || {}).n || 0;
  counts.league_admins = (results[LEAGUE_SCOPED_TABLES.length + 1].results[0] || {}).n || 0;
  counts.leagues = (results[LEAGUE_SCOPED_TABLES.length + 2].results[0] || {}).n || 0;
  const adminUserIds = (results[LEAGUE_SCOPED_TABLES.length + 3].results || []).map(r => r.user_id);
  return { counts, adminUserIds };
}

async function listLeagues() {
  const results = runD1Batch([
    `SELECT id, name, slug, created_at FROM leagues WHERE id != '${SMBHL_LEAGUE_ID}' ORDER BY created_at DESC;`,
    `SELECT league_id, COUNT(*) AS n FROM contacts GROUP BY league_id;`,
    `SELECT league_id, COUNT(*) AS n FROM events GROUP BY league_id;`
  ]);
  const leagues = results[0].results || [];
  const playerCounts = new Map((results[1].results || []).map(r => [r.league_id, r.n]));
  const eventCounts = new Map((results[2].results || []).map(r => [r.league_id, r.n]));
  return leagues.map(l => ({
    id: l.id,
    name: l.name,
    slug: l.slug,
    createdAt: l.created_at,
    players: playerCounts.get(l.id) || 0,
    events: eventCounts.get(l.id) || 0
  }));
}

function printLeaguesTable(leagues) {
  if (!leagues.length) {
    console.log('No leagues found on the demo database (besides SMBHL, which is never listed here).');
    return;
  }
  console.log(`\n${leagues.length} league(s) on "${DEMO_DB_NAME}":\n`);
  console.log('id'.padEnd(38) + 'name'.padEnd(30) + 'slug'.padEnd(30) + 'created_at'.padEnd(26) + 'players'.padEnd(9) + 'events');
  console.log('-'.repeat(150));
  for (const l of leagues) {
    console.log(
      String(l.id).padEnd(38) +
      String(l.name).slice(0, 28).padEnd(30) +
      String(l.slug).slice(0, 28).padEnd(30) +
      String(l.createdAt || '').padEnd(26) +
      String(l.players).padEnd(9) +
      String(l.events)
    );
  }
  console.log('');
}

function printFootprint(label, footprint, LEAGUE_SCOPED_TABLES) {
  console.log(`  ${label}:`);
  for (const t of [...LEAGUE_SCOPED_TABLES, 'league_team_assigned_email_log', 'league_admins', 'leagues']) {
    console.log(`    ${t.padEnd(32)} ${footprint.counts[t]}`);
  }
  console.log(`    admin user_id(s): ${footprint.adminUserIds.length ? footprint.adminUserIds.join(', ') : '(none)'}`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (const raw of argv) {
    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=');
      if (eq === -1) args[raw.slice(2)] = true;
      else args[raw.slice(2, eq)] = raw.slice(eq + 1);
    } else {
      args._.push(raw);
    }
  }
  return args;
}

async function resolveTargets(hardDeleteMod, args) {
  const ids = typeof args.ids === 'string' ? args.ids.split(',').map(s => s.trim()).filter(Boolean) : [];
  const slugs = typeof args.slugs === 'string' ? args.slugs.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (!ids.length && !slugs.length) {
    fail('the "delete" command requires an explicit --ids=<id1>,<id2> or --slugs=<slug1>,<slug2> list. Nothing is deleted by default, and this script never infers which leagues are "test" leagues on its own. Run "list" first to find the ids/slugs you want.');
  }

  const resolved = new Map(); // id -> { id, name, slug }
  if (ids.length) {
    const rows = runD1Batch(ids.map(id => `SELECT id, name, slug FROM leagues WHERE id = ${escapeSqlValue(id)};`));
    ids.forEach((id, i) => {
      const row = (rows[i].results || [])[0];
      if (!row) fail(`league id "${id}" was not found on "${DEMO_DB_NAME}". Nothing has been deleted. Re-check with "list" and try again.`);
      resolved.set(row.id, row);
    });
  }
  if (slugs.length) {
    const rows = runD1Batch(slugs.map(slug => `SELECT id, name, slug FROM leagues WHERE slug = ${escapeSqlValue(slug)};`));
    slugs.forEach((slug, i) => {
      const row = (rows[i].results || [])[0];
      if (!row) fail(`league slug "${slug}" was not found on "${DEMO_DB_NAME}". Nothing has been deleted. Re-check with "list" and try again.`);
      resolved.set(row.id, row);
    });
  }

  const targets = [...resolved.values()];
  if (targets.some(t => t.id === SMBHL_LEAGUE_ID)) {
    fail('the resolved target list includes SMBHL. SMBHL can never be deleted by this script, under any circumstances. Nothing has been deleted.');
  }
  return targets;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  assertDemoTarget();
  console.log(`demo_league_cleanup: confirmed target is "${DEMO_DB_NAME}" (uuid ${DEMO_DB_UUID}, env=${DEMO_WRANGLER_ENV}).`);

  if (command === 'list' || !command) {
    printLeaguesTable(await listLeagues());
    return;
  }

  if (command !== 'delete') {
    console.error('Usage:');
    console.error('  node scripts/demo_league_cleanup.js list');
    console.error('  node scripts/demo_league_cleanup.js delete --ids=<id1>,<id2> [--execute]');
    console.error('  node scripts/demo_league_cleanup.js delete --slugs=<slug1>,<slug2> [--execute]');
    process.exit(2);
  }

  // Dynamic import: src/hard_delete.js is an ES module (import/export
  // syntax) -- this repo's own package.json has no "type": "module", so
  // plain require() would fail; import() loads it cleanly regardless
  // (verified empirically -- its dependency chain, auth.js/leagues.js,
  // has nothing Workers-runtime-exclusive at module-load time).
  const hardDeleteMod = await import('../src/hard_delete.js');
  const { performLeagueHardDelete, LEAGUE_SCOPED_TABLES } = hardDeleteMod;

  const targets = await resolveTargets(hardDeleteMod, args);
  const d1Env = makeD1Env();

  console.log(`\nTarget league(s) resolved (${targets.length}):`);
  for (const t of targets) console.log(`  - ${t.id}  "${t.name}"  (slug: ${t.slug})`);

  console.log('\nCurrent footprint per league (this is what a real delete would remove):');
  const beforeByLeague = new Map();
  for (const t of targets) {
    const footprint = await countLeagueFootprint(d1Env, LEAGUE_SCOPED_TABLES, t.id);
    beforeByLeague.set(t.id, footprint);
    printFootprint(`"${t.name}" (${t.id})`, footprint, LEAGUE_SCOPED_TABLES);
  }

  if (!args.execute) {
    console.log('\nDRY RUN -- nothing was deleted. Re-run with --execute to actually delete the league(s) listed above.\n');
    return;
  }

  console.log(`\n--execute given. PERMANENTLY DELETING ${targets.length} league(s) now (this cannot be undone)...\n`);
  const summary = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    // 4a: re-verified before EACH league's own delete, not just once
    // at the top of main() -- see reassertAuthOrReport's own comment.
    reassertAuthOrReport(targets.slice(0, i), targets.slice(i));
    const result = await performLeagueHardDelete(d1Env, t.id, t.name, null, 'demo_cleanup_script');
    const after = await countLeagueFootprint(d1Env, LEAGUE_SCOPED_TABLES, t.id);
    summary.push({ target: t, result, before: beforeByLeague.get(t.id), after });
  }

  console.log('Summary -- what was deleted, per table:\n');
  for (const { target, result, before, after } of summary) {
    console.log(`"${target.name}" (${target.id}):`);
    for (const table of [...LEAGUE_SCOPED_TABLES, 'league_team_assigned_email_log', 'league_admins', 'leagues']) {
      const b = before.counts[table] || 0;
      const a = after.counts[table] || 0;
      console.log(`  ${table.padEnd(32)} ${b} -> ${a}${a !== 0 ? '  !! ORPHAN ROWS REMAIN' : ''}`);
    }
    console.log(`  total rows deleted (per performLeagueHardDelete): ${result.rowsDeleted}`);
    console.log(`  admin user accounts deleted: ${result.usersDeleted} (${result.deletedUserIds.join(', ') || 'none'})`);
    console.log('');
  }
}

// Cleanup-script robustness task (4a): exported so a test can exercise
// the pure auth-check logic (resolveDemoTarget/reassertAuthOrReport)
// directly, with execSync mocked -- without this guard, `require()`ing
// this file for that purpose would also kick off the real, destructive
// main() against the real demo database. main() itself is unchanged;
// it only ever ran via this exact same invocation before.
if (require.main === module) {
  main().catch(err => {
    console.error('\ndemo_league_cleanup: unexpected error:');
    console.error(err);
    process.exit(1);
  });
}

module.exports = { resolveDemoTarget, assertDemoTarget, reassertAuthOrReport, fail };

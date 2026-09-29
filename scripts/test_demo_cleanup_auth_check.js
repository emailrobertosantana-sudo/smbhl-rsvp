#!/usr/bin/env node
// Standalone Node-level test for demo_league_cleanup.js's own auth-
// check logic (small-outstanding-items task, 4a). NOT part of the
// vitest suite: that suite runs entirely in the Cloudflare Workers
// runtime pool (vitest.config.mjs), which has no `child_process`/
// `execSync` at all -- this script's own logic can only be exercised
// from plain Node, exactly how it actually runs in production. Run
// directly: `node scripts/test_demo_cleanup_auth_check.js`.
//
// Mocks child_process.execSync BEFORE requiring the cleanup script,
// so its own (already-destructured, at require time) execSync
// reference is the mock, never a real `wrangler` call -- nothing here
// ever touches a real database, demo or otherwise.
'use strict';

const assert = require('assert');
const cp = require('child_process');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

// ---- Mock execSync: succeeds with a valid demo target by default ----
const DEMO_DB_UUID = '87411a46-fc5f-414f-bd46-6ff26feb155f';
let mode = 'ok';
// Later tests route other wrangler calls here (the script keeps its own
// reference to this mock from require time).
let extraHandler = null;
cp.execSync = (cmd, opts) => {
  if (extraHandler) return extraHandler(cmd, opts);
  if (mode === 'bad_token') {
    const err = new Error('Authentication error [code: 10001]: Unable to authenticate request');
    throw err;
  }
  if (cmd.includes('wrangler d1 info')) {
    return JSON.stringify({ name: 'notreligue-demo', uuid: DEMO_DB_UUID });
  }
  throw new Error(`unexpected execSync call in this mock: ${cmd}`);
};

const cleanup = require('./demo_league_cleanup.js');

console.log('demo_league_cleanup auth-check tests\n');

check('resolveDemoTarget() succeeds when wrangler/the token works', () => {
  mode = 'ok';
  const result = cleanup.resolveDemoTarget();
  assert.strictEqual(result.ok, true, 'expected ok:true');
  assert.strictEqual(result.info.uuid, DEMO_DB_UUID);
});

check('resolveDemoTarget() reports failure (never throws) when the token is bad', () => {
  mode = 'bad_token';
  const result = cleanup.resolveDemoTarget();
  assert.strictEqual(result.ok, false, 'expected ok:false');
  assert.ok(/authenticat/i.test(result.error), `expected an authentication-related message, got: ${result.error}`);
});

check('assertDemoTarget() exits the process (loudly) on a bad token, before returning', () => {
  mode = 'bad_token';
  let exitCode = null;
  const realExit = process.exit;
  process.exit = code => { exitCode = code; throw new Error('__exit__'); };
  const realError = console.error;
  let loggedMessage = '';
  console.error = msg => { loggedMessage += msg; };
  try {
    try { cleanup.assertDemoTarget(); } catch (e) { if (e.message !== '__exit__') throw e; }
    assert.strictEqual(exitCode, 1, 'expected process.exit(1)');
    assert.ok(/REFUSING TO CONTINUE/.test(loggedMessage), 'expected the loud refusal message');
    assert.ok(/authenticat/i.test(loggedMessage), 'expected the underlying auth error to be included');
  } finally {
    process.exit = realExit;
    console.error = realError;
  }
});

check('reassertAuthOrReport() stops BEFORE the next league\'s delete on a bad token, reporting done vs remaining', () => {
  mode = 'bad_token';
  let exitCode = null;
  const realExit = process.exit;
  process.exit = code => { exitCode = code; throw new Error('__exit__'); };
  const realError = console.error;
  let loggedMessage = '';
  console.error = msg => { loggedMessage += msg + '\n'; };
  const completed = [{ id: 'league-a', name: 'Already Deleted League' }];
  const remaining = [{ id: 'league-b', name: 'Next League' }, { id: 'league-c', name: 'League After That' }];
  try {
    try { cleanup.reassertAuthOrReport(completed, remaining); } catch (e) { if (e.message !== '__exit__') throw e; }
    assert.strictEqual(exitCode, 1, 'expected process.exit(1)');
    assert.ok(loggedMessage.includes('league-a'), 'expected the completed league in the report');
    assert.ok(loggedMessage.includes('league-b') && loggedMessage.includes('league-c'), 'expected both remaining leagues in the report');
    assert.ok(loggedMessage.includes('--ids=league-b,league-c'), 'expected a ready-to-run resume command with exactly the remaining ids');
    console.log('        --- actual reported output ---');
    loggedMessage.trim().split('\n').forEach(line => console.log('        ' + line));
    console.log('        -------------------------------');
  } finally {
    process.exit = realExit;
    console.error = realError;
  }
});

check('reassertAuthOrReport() does nothing (no exit, no report) when the token still works', () => {
  mode = 'ok';
  let exited = false;
  const realExit = process.exit;
  process.exit = () => { exited = true; };
  try {
    cleanup.reassertAuthOrReport([], [{ id: 'x', name: 'X' }]);
    assert.strictEqual(exited, false, 'expected no exit when auth still works');
  } finally {
    process.exit = realExit;
  }
});

// ---- orphan-users: the SQL, on a real SQLite database (node:sqlite) ----
// Same shape as demo's users / league_admins / leagues (migrate-018/019).
check('orphanUsersStatements(): lists and deletes only accounts with no league, sparing --keep', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at TEXT, last_login_at TEXT);
    CREATE TABLE leagues (id TEXT PRIMARY KEY, created_by TEXT REFERENCES users(id));
    CREATE TABLE league_admins (user_id TEXT NOT NULL REFERENCES users(id), league_id TEXT NOT NULL, PRIMARY KEY (user_id, league_id));
    INSERT INTO users VALUES ('u-admin', 'admin@example.com', '1', NULL), ('u-creator', 'creator@example.com', '2', NULL),
      ('u-orphan1', 'orphan1@example.com', '3', NULL), ('u-orphan2', 'Keep.Me@example.com', '4', NULL), ('u-orphan3', 'orphan3@example.com', '5', NULL);
    INSERT INTO leagues VALUES ('L1', 'u-creator'), ('L2', NULL);
    INSERT INTO league_admins VALUES ('u-admin', 'L2');`);
  const sql = cleanup.orphanUsersStatements(['keep.me@example.com']);
  assert.deepStrictEqual(db.prepare(sql.list).all().map(r => r.id), ['u-orphan1', 'u-orphan3']);
  assert.strictEqual(db.prepare(sql.del).run().changes, 2);
  assert.deepStrictEqual(db.prepare('SELECT id FROM users ORDER BY id').all().map(r => r.id), ['u-admin', 'u-creator', 'u-orphan2']);
  assert.strictEqual(db.prepare(sql.remaining).get().n, 0);
  // Without --keep, the kept one is an orphan too.
  assert.deepStrictEqual(db.prepare(cleanup.orphanUsersStatements([]).list).all().map(r => r.id), ['u-orphan2']);
});

// ---- orphan-users: the command's flow, execSync mocked ----
(async () => {
  const run = async (args, dbState) => {
    const calls = [];
    extraHandler = (cmd, opts) => {
      if (cmd.includes('wrangler d1 info')) return JSON.stringify({ name: 'notreligue-demo', uuid: DEMO_DB_UUID });
      calls.push(cmd);
      if (/DELETE FROM users/.test(cmd)) { const n = dbState.users.length; dbState.users = []; return JSON.stringify([{ results: [], meta: { changes: n } }]); }
      if (/SELECT COUNT\(\*\) AS n FROM users/.test(cmd)) return JSON.stringify([{ results: [{ n: dbState.users.length }] }]);
      if (/SELECT id, email/.test(cmd)) return JSON.stringify([{ results: dbState.users }]);
      throw new Error(`unexpected execSync call: ${cmd}`);
    };
    const log = console.log; console.log = () => {};
    try { return { result: await cleanup.orphanUsers(args), calls }; }
    finally { console.log = log; extraHandler = null; }
  };
  const users = () => ({ users: [{ id: 'a', email: 'a@example.com' }, { id: 'b', email: 'b@example.com' }] });

  await (async () => {
    const { result, calls } = await run({ _: ['orphan-users'] }, users());
    check('orphan-users without --execute is a dry run: lists, deletes nothing', () => {
      assert.deepStrictEqual(result, { listed: 2, deleted: 0 });
      assert.ok(calls.every(c => !/DELETE/.test(c)), 'no DELETE in a dry run');
    });
  })();
  await (async () => {
    const { result, calls } = await run({ _: ['orphan-users'], execute: true }, users());
    check('orphan-users --execute deletes them, with the no-league condition in the DELETE itself', () => {
      assert.deepStrictEqual(result, { listed: 2, deleted: 2, left: 0 });
      const del = calls.find(c => /DELETE FROM users/.test(c));
      assert.ok(del && /NOT IN \(SELECT user_id FROM league_admins\)/.test(del) && /NOT IN \(SELECT created_by FROM leagues/.test(del));
    });
  })();

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  process.exitCode = failures === 0 ? 0 : 1;
})();

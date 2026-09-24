// Schema-drift guard, part 2: proves the guard actually FIRES against a
// genuinely drifted database -- not just that it stays quiet when
// everything is fine. Built after the Sept 24 production incident (see
// src/schema_guard.js's own header for the full story): 22 migrations
// had been applied to demo but never to production, and nothing caught
// it before a deploy shipped code that broke against production's real
// schema. This test file simulates that exact shape of gap (a column a
// later migration adds, missing from an otherwise-real database) and
// confirms the guard reports it specifically, plus exercises the
// guard's own safety properties (memoization, fail-open on a check
// that can't run, and the wired-in HTTP-level 503).
import { env, SELF, reset } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { checkSchemaOnce, formatSchemaDriftMessage, _resetSchemaGuardCacheForTests } from '../src/schema_guard.js';

describe('schema drift guard: checkSchemaOnce', () => {
  beforeEach(async () => {
    _resetSchemaGuardCacheForTests();
    // D1 state persists across `it()`s within a file otherwise (see
    // test/real_schema_loader.spec.js's own identical use of reset())
    // -- several of these tests deliberately mutate the schema
    // (DROP COLUMN/TABLE), so each one needs a genuinely fresh database.
    await reset();
  });

  it('reports ok against a real, fully-migrated schema', async () => {
    await applyRealSchema(env);
    const result = await checkSchemaOnce(env);
    expect(result).toEqual({ ok: true });
  });

  it('FIRES, naming the exact table and column, when a real database is missing a column a migration added -- the Sept 24 shape of gap', async () => {
    await applyRealSchema(env);
    // Simulates "this migration was never applied here" by removing a
    // column a later migration added from an otherwise fully-migrated,
    // real database -- not a hand-rolled fake schema.
    await env.DB.prepare('ALTER TABLE events DROP COLUMN auto_reminders_enabled').run();

    const result = await checkSchemaOnce(env);
    expect(result.ok).toBe(false);
    expect(result.missing).toContainEqual({ table: 'events', column: 'auto_reminders_enabled' });

    const message = formatSchemaDriftMessage(result.missing);
    expect(message).toContain('table "events" has no column named "auto_reminders_enabled"');
  });

  it('FIRES, naming the missing table, when an entire table a migration created does not exist', async () => {
    await applyRealSchema(env);
    await env.DB.prepare('DROP TABLE venues').run();

    const result = await checkSchemaOnce(env);
    expect(result.ok).toBe(false);
    expect(result.missing).toContainEqual({ table: 'venues', column: null });

    const message = formatSchemaDriftMessage(result.missing);
    expect(message).toContain('table "venues" does not exist');
  });

  it('reproduces the ACTUAL Sept 24 incident: production missing outbox.league_id specifically', async () => {
    await applyRealSchema(env);
    // idx_outbox_league indexes this column -- drop the index first,
    // the same real-world dependency order a real DROP COLUMN would need.
    await env.DB.prepare('DROP INDEX idx_outbox_league').run();
    await env.DB.prepare('ALTER TABLE outbox DROP COLUMN league_id').run();

    const result = await checkSchemaOnce(env);
    expect(result.ok).toBe(false);
    expect(result.missing.some(m => m.table === 'outbox' && m.column === 'league_id')).toBe(true);
  });

  it('is memoized -- a second call against the same isolate does not re-query D1', async () => {
    await applyRealSchema(env);
    const first = await checkSchemaOnce(env);
    expect(first.ok).toBe(true);

    // If the DB were queried again, this would now report drift --
    // proving the second call below returns the cached first result
    // instead of actually re-checking.
    await env.DB.prepare('ALTER TABLE events DROP COLUMN auto_reminders_enabled').run();
    const second = await checkSchemaOnce(env);
    expect(second).toBe(first); // same cached object, not merely equal
    expect(second.ok).toBe(true);
  });

  it('fails OPEN (does not block traffic) when the check itself cannot run -- an infrastructure error is not evidence of drift', async () => {
    const brokenEnv = { DB: { prepare() { throw new Error('simulated D1 unreachable'); } } };
    const result = await checkSchemaOnce(brokenEnv);
    expect(result.ok).toBe(true);
    expect(result.checkFailed).toBe(true);
    expect(result.error).toContain('simulated D1 unreachable');
  });

  it('a failed check is never cached -- it retries on the next call rather than being stuck', async () => {
    const brokenEnv = { DB: { prepare() { throw new Error('simulated D1 unreachable'); } } };
    const first = await checkSchemaOnce(brokenEnv);
    expect(first.checkFailed).toBe(true);

    // A working env right after -- if the failure had been cached, this
    // would still report checkFailed instead of the real, good result.
    await applyRealSchema(env);
    const second = await checkSchemaOnce(env);
    expect(second).toEqual({ ok: true });
  });
});

describe('schema drift guard: wired into the real HTTP request path', () => {
  beforeEach(async () => {
    _resetSchemaGuardCacheForTests();
    await reset();
  });

  it('a genuinely drifted database makes EVERY request 503 with the specific missing column named, not a generic error', async () => {
    await applyRealSchema(env);
    await env.DB.prepare('DROP INDEX idx_outbox_league').run();
    await env.DB.prepare('ALTER TABLE outbox DROP COLUMN league_id').run();

    const res = await SELF.fetch('http://example.com/');
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain('table "outbox" has no column named "league_id"');
  });

  it('a healthy database serves requests normally -- the guard is invisible when nothing is wrong', async () => {
    await applyRealSchema(env);
    const res = await SELF.fetch('http://example.com/');
    expect(res.status).not.toBe(503);
  });
});

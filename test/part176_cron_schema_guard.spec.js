// The schema guard before a cron pass. Requests were guarded; the cron was
// not, so code deployed ahead of its migrations could send an email, fail
// to record it, and send it again -- the shape of the Sept 24 outage.
//  - a database behind the code skips the pass, and the heartbeat (and
//    /health/status) say so; the next pass after the migration runs;
//  - a check that can't run fails open: the pass runs;
//  - a clean check is remembered per deployed version, so only the first
//    pass after a deploy pays for the PRAGMA queries.
import { env, SELF, reset } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { installMailCapture, removeMailCapture, mail } from './support/league_season.js';
import { runCronPass } from '../src/index.js';
import { checkSchemaForPass, _resetSchemaGuardCacheForTests } from '../src/schema_guard.js';
import { SCHEMA_MANIFEST } from '../src/schema_manifest.js';

const heartbeat = async () => JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'health:cron:leagues'").first())?.value || '{}');

// env with its own DB (counting or failing PRAGMAs) and version -- env is a
// Proxy, so properties are defined, not assigned.
function envWith({ version = null, pragma = 'count' } = {}) {
  const counter = { pragmas: 0 };
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'prepare') return sql => {
        if (/^PRAGMA table_info/.test(sql)) {
          counter.pragmas++;
          if (pragma === 'fail') throw new Error('D1 unreachable (simulated)');
        }
        return target.prepare(sql);
      };
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
  const e = Object.create(env);
  Object.defineProperty(e, 'DB', { value: db });
  Object.defineProperty(e, 'CF_VERSION_METADATA', { value: version ? { id: version, tag: '', timestamp: '' } : undefined });
  Object.defineProperty(e, 'LEAGUE_PRODUCT', { value: 'true' });
  return { e, counter };
}

beforeEach(async () => {
  _resetSchemaGuardCacheForTests();
  await reset();
  await applyRealSchema(env);
  env.RESEND_API_KEY = 'x'; env.MAIL_DAILY_CAP = '';
  installMailCapture();
});
afterAll(() => removeMailCapture());

describe('The cron pass and a database behind the code', () => {
  it('skips the pass, records it in the heartbeat and /health/status; after the migration the next pass runs', async () => {
    await env.DB.prepare('ALTER TABLE events DROP COLUMN auto_reminders_enabled').run();
    const { e } = envWith({ version: 'v-behind' });
    const before = mail.sent.length;
    await runCronPass(e);
    let hb = await heartbeat();
    expect(hb.ok).toBe(false);
    expect(hb.error).toContain('events.auto_reminders_enabled');
    expect(hb.schema_behind.missing).toBe('events.auto_reminders_enabled');
    expect(hb.last_ok_at).toBeUndefined();
    expect(mail.sent.length).toBe(before);
    // Not remembered: a database found behind is checked again every pass.
    expect(await env.DB.prepare("SELECT 1 FROM settings WHERE key LIKE 'schema:ok:%'").first()).toBeNull();
    // /health/status answers (JSON, not the plain-text 503 the other routes give) with the reason.
    _resetSchemaGuardCacheForTests();
    const res = await SELF.fetch('http://example.com/health/status');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reasons).toContain('schema_behind');
    expect(body.schema_missing).toEqual(['events.auto_reminders_enabled']);
    // Another route still gets the guard's 503.
    expect((await SELF.fetch('http://example.com/login')).status).toBe(503);

    // The migration is applied (no redeploy): the next pass runs.
    await env.DB.prepare('ALTER TABLE events ADD COLUMN auto_reminders_enabled INTEGER DEFAULT 1').run();
    // Requests recover on their own too (no redeploy, no cache reset).
    expect((await SELF.fetch('http://example.com/login')).status).toBe(200);
    await runCronPass(e);
    hb = await heartbeat();
    expect(hb.ok).toBe(true);
    expect(hb.schema_behind).toBeNull();
    expect(hb.last_ok_at).toBeTruthy();
  });

  it('a check that cannot run fails open: the pass runs', async () => {
    const { e, counter } = envWith({ version: 'v-failing', pragma: 'fail' });
    const r = await checkSchemaForPass(e);
    expect(r.ok).toBe(true);
    expect(r.checkFailed).toBe(true);
    expect(counter.pragmas).toBeGreaterThan(0);
    await runCronPass(e);
    const hb = await heartbeat();
    expect(hb.ok).toBe(true);
    expect(hb.schema_behind).toBeNull();
    // A failed check is not remembered either.
    expect(await env.DB.prepare("SELECT 1 FROM settings WHERE key = 'schema:ok:v-failing'").first()).toBeNull();
  });
});

describe('A clean check is remembered per deployed version', () => {
  it('only the first pass after a deploy pays for the PRAGMAs', async () => {
    const tables = Object.keys(SCHEMA_MANIFEST).length;
    const first = envWith({ version: 'v1' });
    expect(await checkSchemaForPass(first.e)).toEqual({ ok: true, source: 'checked' });
    expect(first.counter.pragmas).toBe(tables);
    expect(await env.DB.prepare("SELECT 1 AS x FROM settings WHERE key = 'schema:ok:v1'").first()).toEqual({ x: 1 });

    // A later pass in a fresh isolate of the same version: one settings read.
    _resetSchemaGuardCacheForTests();
    const later = envWith({ version: 'v1' });
    expect(await checkSchemaForPass(later.e)).toEqual({ ok: true, source: 'version' });
    expect(later.counter.pragmas).toBe(0);
    // Same isolate again: nothing at all.
    expect(await checkSchemaForPass(later.e)).toEqual({ ok: true, source: 'isolate' });

    // The next deploy checks again.
    _resetSchemaGuardCacheForTests();
    const next = envWith({ version: 'v2' });
    expect((await checkSchemaForPass(next.e)).source).toBe('checked');
    expect(next.counter.pragmas).toBe(tables);
  });
});

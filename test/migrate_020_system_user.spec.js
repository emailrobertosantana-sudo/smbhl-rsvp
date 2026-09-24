// Investigation finding: migrate-020.sql's original SMBHL bootstrap row
// (`INSERT INTO leagues (..., created_by, ...) SELECT ..., 'system', ...`)
// failed against the real demo D1 database with
// "FOREIGN KEY constraint failed" -- leagues.created_by REFERENCES
// users(id) (migrate-019.sql), and no row with id 'system' existed in
// users. 428 hand-rolled-schema tests never caught this, because every
// spec file's inline `leagues` table had silently dropped the
// `REFERENCES users(id)` clause.
//
// Fix (Option C from the investigation): migrate-020.sql now inserts a
// real, inert 'system' user before the leagues insert.
//
// This file now applies the real base_schema_v1.sql + migrate-*.sql chain via
// test/support/real_schema.js (Part 2 of the follow-up) instead of
// hand-rolling its own copy -- test/real_schema_loader.spec.js already
// covers that the real chain applies cleanly, is idempotent, and would
// catch this exact class of FK bug automatically. This file keeps only
// the assertions specific to the sentinel user's login-safety properties.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { verifyPassword } from '../src/auth.js';
import { applyRealSchema } from './support/real_schema.js';

describe('migrate-020.sql: SMBHL bootstrap system user is safe by construction', () => {
  beforeAll(async () => {
    await applyRealSchema(env);
  });

  it('the sentinel password_hash is provably unusable -- verifyPassword rejects it for any password, without throwing', async () => {
    const row = await env.DB.prepare(`SELECT password_hash FROM users WHERE id = 'system'`).first();
    expect(row.password_hash).toBe('not-a-valid-hash:system-bootstrap-user-no-login');

    // Not a well-formed 'pbkdf2$<iterations>$<salt>$<hash>' string, so
    // verifyPassword's format check rejects it before ever deriving
    // anything -- fails closed, never throws, for any input.
    await expect(verifyPassword('', row.password_hash)).resolves.toBe(false);
    await expect(verifyPassword('password123', row.password_hash)).resolves.toBe(false);
    await expect(verifyPassword('not-a-valid-hash:system-bootstrap-user-no-login', row.password_hash)).resolves.toBe(false);
  });

  it("the sentinel email can never collide with a real signup's email column", async () => {
    const row = await env.DB.prepare(`SELECT email FROM users WHERE id = 'system'`).first();
    expect(row.email).toBe('system@smbhl-rsvp.internal.invalid');
    // .invalid is a reserved TLD (RFC 2606) that can never be installed in
    // the real DNS root -- no real /auth/signup could ever legitimately
    // produce an address ending in it.
    expect(row.email.endsWith('.invalid')).toBe(true);
  });
});

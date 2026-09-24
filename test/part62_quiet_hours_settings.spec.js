// Live-testing task (batch 4), Part 2: SMBHL bug -- the Comms
// quiet-hours card read/wrote quiet_hours_enabled/_start/_end, but
// afterQuiet() used hardcoded QUIET_FROM=23/QUIET_TO=7 and never read
// them. Toggling the card changed nothing about real send timing.
//
// Fixed: afterQuiet(env, d) now reads getEmailSettings(env.DB) for
// real. DEFAULT_EMAIL_SETTINGS.quiet_hours_enabled changed from false
// to true (that field was never read before, so the REAL default
// behavior was always "enabled, 23, 7" regardless of what it said --
// this makes the stored default match the behavior it's replacing).
//
// All times constructed at a fixed mid-January instant (no DST
// ambiguity for America/Toronto, the app's own TZ constant) so these
// tests are deterministic regardless of what time this suite actually
// runs -- no fake-timer infrastructure needed (this test suite has
// none, and afterQuiet is a pure-enough function of its own `d`
// argument plus stored settings to not need any).
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { afterQuiet } from '../src';

// 2027-01-15 is deep winter (America/Toronto is EST, UTC-5, no DST) --
// 07:00Z = 02:00 local, 12:00Z = 07:00 local.
const TWO_AM_TORONTO = '2027-01-15T07:00:00.000Z';
const SEVEN_AM_TORONTO_MS = new Date('2027-01-15T12:00:00.000Z').getTime();

describe('Part 2 (live-testing task, batch 4): quiet-hours settings are genuinely wired up', () => {
  beforeAll(async () => {
    await applyRealSchema(env);
  });

  it('with no settings row saved at all (every league today, and SMBHL unless an operator already used the card): 2am is deferred to 7am -- byte-identical to the old hardcoded behavior', async () => {
    const result = await afterQuiet(env, new Date(TWO_AM_TORONTO));
    expect(result.getTime()).toBe(SEVEN_AM_TORONTO_MS);
  });

  it('a moment already outside the default 23:00-07:00 window is returned unchanged', async () => {
    const noonToronto = new Date('2027-01-15T17:00:00.000Z'); // 12:00 local
    const result = await afterQuiet(env, noonToronto);
    expect(result.getTime()).toBe(noonToronto.getTime());
  });

  it('changing the settings actually changes send timing -- a different window (quiet 8pm-6am instead of the default 11pm-7am) defers 2am to 6am, not 7am', async () => {
    // Same wrap-past-midnight shape as the default (quiet_hours_start
    // is always later in the day than quiet_hours_end -- this simple
    // hour-in-range check, unchanged from the original hardcoded
    // version, only ever supported a window that wraps midnight, the
    // same as every real value this card has ever stored).
    await env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES ('email_cadence_settings', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(JSON.stringify({ quiet_hours_enabled: true, quiet_hours_start: 20, quiet_hours_end: 6 })).run();

    const result = await afterQuiet(env, new Date(TWO_AM_TORONTO));
    const sixAmToronto = new Date('2027-01-15T11:00:00.000Z').getTime();
    expect(result.getTime()).toBe(sixAmToronto);
  });

  it('quiet_hours_enabled: false genuinely disables the whole thing -- 2am is returned unchanged', async () => {
    await env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES ('email_cadence_settings', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(JSON.stringify({ quiet_hours_enabled: false, quiet_hours_start: 23, quiet_hours_end: 7 })).run();

    const d = new Date(TWO_AM_TORONTO);
    const result = await afterQuiet(env, d);
    expect(result.getTime()).toBe(d.getTime());
  });

  it('a malformed/missing start or end in a saved row falls back to the hardcoded QUIET_FROM/QUIET_TO (23/7), not a crash or NaN comparison', async () => {
    await env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES ('email_cadence_settings', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(JSON.stringify({ quiet_hours_enabled: true, quiet_hours_start: null, quiet_hours_end: undefined })).run();

    const result = await afterQuiet(env, new Date(TWO_AM_TORONTO));
    expect(result.getTime()).toBe(SEVEN_AM_TORONTO_MS);
  });
});

// NOTE on skipQuietHours (enqueue()'s own opt-in flag, batch 2 Part
// 16): its bypass branch (`skipQuietHours ? target : await
// afterQuiet(env, target)`) never calls afterQuiet() at all when true
// -- untouched by this fix, and already proven to keep bypassing
// quiet hours regardless of the current settings by
// test/part58_mail_queue_quiet_hours.spec.js's own existing tests
// (which exercise the real maybeInviteSubsForShortage/
// handleLeagueInviteSubs routes end to end and pass unchanged in the
// same full-suite run this task requires after every part).

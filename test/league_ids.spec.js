// Part F follow-up: the ID-collision fix. events.id (a literal calendar
// date) and contacts.player_id (a global sequential counter) had no league
// scoping at all — two leagues creating a game on the same date would
// collide, and this codebase's `INSERT ... ON CONFLICT(id) DO UPDATE`
// pattern would silently merge one league's data into another's row. This
// file proves: (1) the new league-prefixed scheme actually prevents that
// collision, (2) eventStart() — which parses events.id as a literal date to
// compute real game start times — behaves identically for old (unprefixed)
// ids and correctly for new (prefixed) ones, and (3) an already-issued
// SMBHL magic link (built from an old-style id) still resolves unchanged.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  SMBHL_LEAGUE_ID,
  makeEventId,
  eventDateFromId,
  makeContactId,
  contactIdLikePattern,
  extractTrailingNumber
} from '../src/league_ids.js';
import { eventStart } from '../src/index.js';
import { applyRealSchema } from './support/real_schema.js';

describe('league_ids.js — pure ID-scheme helpers', () => {
  it('SMBHL_LEAGUE_ID matches the sentinel row migrate-020.sql creates in `leagues`', () => {
    expect(SMBHL_LEAGUE_ID).toBe('smbhl');
  });

  it('makeEventId prefixes the date with the owning league id', () => {
    expect(makeEventId('smbhl', '2026-10-04')).toBe('smbhl:2026-10-04');
  });

  it('two different leagues creating an event on the identical calendar date get distinct ids', () => {
    const a = makeEventId('smbhl', '2026-10-04');
    const b = makeEventId('11111111-2222-3333-4444-555555555555', '2026-10-04');
    expect(a).not.toBe(b);
  });

  it('eventDateFromId recovers the date from a new-style prefixed id', () => {
    expect(eventDateFromId('smbhl:2026-10-04')).toBe('2026-10-04');
    expect(eventDateFromId('11111111-2222-3333-4444-555555555555:2026-10-04')).toBe('2026-10-04');
  });

  it('eventDateFromId returns an old-style unprefixed id unchanged, since the whole string already IS the date', () => {
    expect(eventDateFromId('2026-09-20')).toBe('2026-09-20');
  });

  it('eventDateFromId falls back to returning the raw id when there is no date-shaped suffix (e.g. the week-N fallback)', () => {
    expect(eventDateFromId('week-5')).toBe('week-5');
    expect(eventDateFromId('smbhl:week-5')).toBe('smbhl:week-5');
  });

  it('makeContactId prefixes the suffix with the owning league id, and two leagues never collide even reusing the same suffix', () => {
    const a = makeContactId('smbhl', 'P0001');
    const b = makeContactId('11111111-2222-3333-4444-555555555555', 'P0001');
    expect(a).toBe('smbhl:P0001');
    expect(a).not.toBe(b);
  });

  it('contactIdLikePattern scopes the "find the next id" lookup to one league\'s own namespace, and never matches an old bare id', () => {
    expect(contactIdLikePattern('smbhl')).toBe('smbhl:P%');
    expect(contactIdLikePattern('smbhl', 'P9')).toBe('smbhl:P9%');
  });

  it('extractTrailingNumber works for both old bare ids and new prefixed ids', () => {
    expect(extractTrailingNumber('P0298')).toBe(298);
    expect(extractTrailingNumber('smbhl:P0512')).toBe(512);
    expect(extractTrailingNumber('smbhl:P9007')).toBe(9007);
  });
});

describe('eventStart() — identical behavior for old ids, correct for new prefixed ids', () => {
  it('produces the exact same Date for an old-style unprefixed id and the equivalent new-style prefixed id (any league)', () => {
    const oldStyle = eventStart({ id: '2026-09-20', start_time: '10:30' });
    const smbhlNewStyle = eventStart({ id: 'smbhl:2026-09-20', start_time: '10:30' });
    const otherLeagueStyle = eventStart({ id: '11111111-2222-3333-4444-555555555555:2026-09-20', start_time: '10:30' });

    expect(oldStyle).toBeTruthy();
    expect(smbhlNewStyle).toBeTruthy();
    expect(otherLeagueStyle).toBeTruthy();
    expect(smbhlNewStyle.getTime()).toBe(oldStyle.getTime());
    expect(otherLeagueStyle.getTime()).toBe(oldStyle.getTime());
  });

  it('still returns null when start_time is missing, exactly as before, regardless of id shape', () => {
    expect(eventStart({ id: '2026-09-20' })).toBeNull();
    expect(eventStart({ id: 'smbhl:2026-09-20' })).toBeNull();
  });
});

describe('Collision safety: two leagues writing data for the same calendar date / same counter value', () => {
  beforeAll(async () => {
    await applyRealSchema(env);
  });

  it('demonstrates the actual bug this fix prevents: under the OLD bare-date-id scheme, two leagues writing an event for the same date silently collide via this codebase\'s own ON CONFLICT(id) DO UPDATE pattern', async () => {
    const date = '2026-11-08';
    const upsert = (season, venue) => env.DB.prepare(
      `INSERT INTO events (id, season, week, date, venue, state) VALUES (?, ?, ?, ?, ?, 'open')
       ON CONFLICT(id) DO UPDATE SET season = excluded.season, venue = excluded.venue`
    ).bind(date, season, 6, date, venue).run(); // id = the bare date, exactly as events.id used to always be

    await upsert('Fall 2026', 'SMBHL Venue');
    await upsert('League B Season', 'League B Venue');

    const row = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(date).first();
    expect(row.venue).toBe('League B Venue'); // League B's write silently overwrote SMBHL's row
    const count = await env.DB.prepare('SELECT COUNT(*) c FROM events WHERE date = ?').bind(date).first();
    expect(count.c).toBe(1); // only one row survives -- this is the exact collision the fix below prevents
  });

  it('with the new league-prefixed scheme, two leagues creating an event on the identical calendar date produce two genuinely distinct, non-colliding rows', async () => {
    const date = '2026-10-04';
    const smbhlId = makeEventId('smbhl', date);
    const otherLeagueId = makeEventId('22222222-3333-4444-5555-666666666666', date);

    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state) VALUES (?, 'Fall 2026', 7, ?, 'SMBHL Venue', 'open')`).bind(smbhlId, date).run();
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state) VALUES (?, 'League B Season', 1, ?, 'League B Venue', 'open')`).bind(otherLeagueId, date).run();

    const smbhlRow = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(smbhlId).first();
    const otherRow = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(otherLeagueId).first();
    expect(smbhlRow.venue).toBe('SMBHL Venue');
    expect(otherRow.venue).toBe('League B Venue'); // neither overwrote the other

    const count = await env.DB.prepare('SELECT COUNT(*) c FROM events WHERE date = ?').bind(date).first();
    expect(count.c).toBe(2);
  });

  it('two different leagues\' contacts never collide on player_id, even reusing the identical numeric suffix', async () => {
    const idA = makeContactId('smbhl', 'P0001');
    const idB = makeContactId('22222222-3333-4444-5555-666666666666', 'P0001');

    await env.DB.prepare(`INSERT INTO contacts (player_id, name, token_salt) VALUES (?, 'SMBHL Player', 'salt-a')`).bind(idA).run();
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, token_salt) VALUES (?, 'League B Player', 'salt-b')`).bind(idB).run();

    const a = await env.DB.prepare('SELECT * FROM contacts WHERE player_id = ?').bind(idA).first();
    const b = await env.DB.prepare('SELECT * FROM contacts WHERE player_id = ?').bind(idB).first();
    expect(a.name).toBe('SMBHL Player');
    expect(b.name).toBe('League B Player');
  });
});

describe('SMBHL\'s existing (old-style) ids and already-issued links resolve completely unchanged', () => {
  beforeAll(async () => {
    await applyRealSchema(env);

    env.RSVP_SECRET = 'test-secret-existing-link';
    await env.DB.prepare(`INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time) VALUES ('2026-09-20', 'Fall 2026', 3, 'Sunday September 20', 'College Jean-de-Brebeuf', 'open', '10:30')`).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt) VALUES ('P0001', 'Real Existing Player', 'real.player@smbhl.com', 'roster', 'real-salt-1')`).run();
    // Deliberately no rsvp row: status stays 'pending' and team stays null,
    // keeping this test focused on token verification against the old
    // (unprefixed) event id, without pulling in the team-scoped UI branches
    // (season config, team salts, fixtures) that are unrelated to what this
    // test is proving.
  });

  it('an RSVP magic link generated the exact way this codebase has always generated it (bare event id, no prefix) still verifies and resolves correctly', async () => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode('test-secret-existing-link'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode('p:2026-09-20:P0001:real-salt-1'));
    const token = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

    const res = await SELF.fetch(`http://example.com/rsvp?e=2026-09-20&p=P0001&t=${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('Lien invalide');
    expect(html).not.toContain('introuvable');
  });
});

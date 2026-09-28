// SMBHL's player-facing pages show French and English together, like
// SMBHL's emails (French then English, in one message). A short-lived
// change (15a0cd9, reverted) made them French-only behind a toggle, which
// sent English-speaking players to a French RSVP page. Strings that had no
// English half at all got one.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { hmac } from '../src/crypto_utils.js';

const SEASON = 'Fall 2099';
const EVENT_ID = '2099-10-04';

beforeAll(async () => {
  env.RSVP_SECRET = 'test-part141-rsvp';
  await applyRealSchema(env);
  await env.DB.prepare(`INSERT INTO events (id, date, season, week, state, start_time, league_id) VALUES (?, ?, ?, 3, 'open', '10:30', 'smbhl')`).bind(EVENT_ID, EVENT_ID, SEASON).run();
  await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES ('P141', 'Lang Player', 'p141@example.com', 'roster', 0, 0, 's', 'smbhl')`).run();
  await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, 'P141', 'Blue', 'in', 'roster', 'self', ?, 'smbhl')`).bind(EVENT_ID, new Date().toISOString()).run();
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, 'fixedsalt')`).bind(`teamsalt:${SEASON}:Blue`).run();
});

describe('Player pages show both languages at once', () => {
  it('the rsvp page', async () => {
    const t = await hmac(env.RSVP_SECRET, `p:${EVENT_ID}:P141:s`);
    const html = await (await SELF.fetch(`http://example.com/rsvp?e=${EVENT_ID}&p=P141&t=${t}`)).text();
    expect(html).toContain('PRÉSENT<span class="en">IN</span>');
    expect(html).toContain('ABSENT<span class="en">OUT</span>');
    expect(html).toContain('Attaquant / Forward (A)');
    expect(html).toContain('Helps balance the lineups');
    expect(html).not.toContain('data-t-fr=');
  });

  it('the team page', async () => {
    const t = await hmac(env.RSVP_SECRET, `t:${SEASON}:Blue:fixedsalt`);
    const html = await (await SELF.fetch(`http://example.com/team-rsvp?s=${encodeURIComponent(SEASON)}&team=Blue&t=${t}`)).text();
    expect(html).toContain('Ajouter un invité<span class="en">Add a guest');
    expect(html).toContain('Mark your forwards (A) and defense (D)');
    expect(html).not.toContain('data-t-fr=');
  });

  it('a notice and the invitation error page', async () => {
    const notice = await (await SELF.fetch('http://example.com/rsvp')).text();
    expect(notice).toContain('Lien incomplet<span class="en">Incomplete link</span>');
    const invite = await (await SELF.fetch('http://example.com/league/admins/accept?token=nope')).text();
    expect(invite).toContain('Invitation invalide ou expirée<span class="en">Invalid or expired invitation</span>');
  });
});

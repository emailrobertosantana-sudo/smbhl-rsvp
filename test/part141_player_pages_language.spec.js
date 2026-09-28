// SMBHL's player-facing pages follow the FR/EN toggle: each string is
// rendered once, in French, carrying both languages for the toggle to swap
// (the swap itself is exercised in Chromium, test/rendered/
// player_page_language.spec.mjs). They used to stack French over an
// English subtitle ("PRÉSENT" + "IN") regardless of the toggle.
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

const both = (fr, en) => `data-t-fr="${fr}" data-t-en="${en}">${fr}<`;

describe('Player pages carry both languages for the toggle, one shown at a time', () => {
  it('the rsvp page', async () => {
    const t = await hmac(env.RSVP_SECRET, `p:${EVENT_ID}:P141:s`);
    const html = await (await SELF.fetch(`http://example.com/rsvp?e=${EVENT_ID}&p=P141&t=${t}`)).text();
    expect(html).toContain('id="btn-lang-en"');
    expect(html).toContain(both('PRÉSENT', 'IN'));
    expect(html).toContain(both('ABSENT', 'OUT'));
    expect(html).toContain(both('Ma position habituelle', 'My usual position'));
    expect(html).not.toContain('PRÉSENT<span class="en">IN');
    expect(html).not.toContain('Attaquant / Forward');
  });

  it('the team page', async () => {
    const t = await hmac(env.RSVP_SECRET, `t:${SEASON}:Blue:fixedsalt`);
    const html = await (await SELF.fetch(`http://example.com/team-rsvp?s=${encodeURIComponent(SEASON)}&team=Blue&t=${t}`)).text();
    expect(html).toContain('id="btn-lang-en"');
    expect(html).toContain(both('Ajouter un invité', 'Add a guest — someone not in the pool'));
    expect(html).toContain('placeholder="Prénom Nom" data-t-placeholder-fr="Prénom Nom" data-t-placeholder-en="First Last"');
    expect(html).toContain('<option value="" data-t-fr="— choisir —" data-t-en="— choose —">');
    expect(html).not.toContain('Team Message Board');
  });

  it('a notice carries both titles for the toggle', async () => {
    const html = await (await SELF.fetch('http://example.com/rsvp')).text();
    expect(html).toContain(both('Lien incomplet', 'Incomplete link'));
    expect(html).toMatch(/<meta name="nl-titles" data-title-fr="Lien incomplet — [^"]+" data-title-en="Incomplete link — /);
  });
});

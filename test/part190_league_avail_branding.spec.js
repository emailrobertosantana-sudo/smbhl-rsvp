// A Notre Ligue sub call's YES and NO links open /avail. For a league's
// game that page (and every answer and error page after it) is the
// league's: its name, the Notre Ligue footer, "Page | League" as the tab
// title, the real date in the league's language, and no SMBHL anywhere.
// An SMBHL game's /avail is unchanged.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { hmac } from '../src/crypto_utils.js';

const RSVP_SECRET = 'test-part190-rsvp';
const SMBHL_WORDS = /smbhl|sunday morning|ball hockey league/i;
// What a person can see: the page without its scripts (the language toggle
// stores its choice under the shared key 'smbhl_admin_lang', which no one sees).
const seen = html => html.replace(/<script[\s\S]*?<\/script>/g, '');

async function league(id, name, mode) {
  await env.DB.prepare(`INSERT INTO leagues (id, name, team_count, team_names, created_by, created_at, slug, team_structure, language_mode) VALUES (?, ?, 2, '["Loutres","Ours"]', 'u190', '2026-10-01T00:00:00Z', ?, 'fixed', ?)`).bind(id, name, id, mode).run();
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'S1', 1, '2099-03-07', 'Aréna Saint-Michel', 'open', '19:30', ?)`).bind(`${id}:2099-03-07`, id).run();
  await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, 'Sam Remplaçant', 'sam@example.com', 'sub_skater', 1, 0, 'salt190', ?)`).bind(`${id}:S1`, id).run();
}
async function link(eventId, playerId, need = 'skater', a = 'yes') {
  const t = await hmac(RSVP_SECRET, `a:${eventId}:${playerId}:${need}:salt190`);
  return `http://example.com/avail?e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&n=${need}&t=${t}&a=${a}`;
}
const titleOf = html => (html.match(/<title>([^<]*)<\/title>/) || [])[1];
const post = (url, a) => SELF.fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `a=${a}` });

beforeAll(async () => {
  env.RSVP_SECRET = RSVP_SECRET;
  env.PUBLIC_URL = 'https://rsvp.notreligue.ca';
  await applyRealSchema(env);
  await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at) VALUES ('u190', 'owner@example.com', 'x', '2026-10-01T00:00:00Z')`).run();
  await league('lg190fr', 'Ligue du mercredi', 'fr');
  await league('lg190en', 'Wednesday League', 'en');
  await league('lg190both', 'Ligue mixte', 'both');
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES ('smbhl:2099-03-08', 'Fall 2099', 1, 'Sunday March 8 2099', 'Aréna', 'open', '10:30', 'smbhl')`).run();
  await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES ('P1901', 'Smbhl Sub', 'smbhl-sub@example.com', 'sub_skater', 1, 0, 'salt190', 'smbhl')`).run();
});

describe('/avail for a Notre Ligue game', () => {
  it('French league: the confirmation page is the league\'s, in French, with the real date', async () => {
    const res = await SELF.fetch(await link('lg190fr:2099-03-07', 'lg190fr:S1'));
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(titleOf(html)).toBe('À confirmer | Ligue du mercredi');
    expect(html).toContain('Ligue du mercredi');
    expect(html).toContain('Samedi 7 mars · 19 h 30');
    expect(html).toContain('Lieu : Aréna Saint-Michel');
    expect(html).toContain('Propulsé par Notre Ligue');
    expect(seen(html)).not.toMatch(SMBHL_WORDS);
    expect(html).not.toMatch(/ce jour-là|that day/);
    expect(html).not.toContain('One more tap');
  });

  it('English league: English only', async () => {
    const html = await (await SELF.fetch(await link('lg190en:2099-03-07', 'lg190en:S1'))).text();
    expect(titleOf(html)).toBe('To confirm | Wednesday League');
    expect(html).toContain('Saturday Mar 7 · 7:30 PM');
    expect(html).toContain('Venue: Aréna Saint-Michel');
    expect(html).toContain('Powered by Notre Ligue');
    expect(seen(html)).not.toMatch(SMBHL_WORDS);
    expect(html).not.toContain('Encore un clic');
  });

  it('bilingual league: both languages, one shown at a time, with the toggle', async () => {
    const html = await (await SELF.fetch(await link('lg190both:2099-03-07', 'lg190both:S1'))).text();
    expect(html).toContain('Encore un clic pour confirmer');
    expect(html).toContain('One more tap to confirm');
    expect(html).toContain('id="btn-lang-en"');
    expect(html).toMatch(/data-lb="en" hidden/);
    expect(seen(html)).not.toMatch(SMBHL_WORDS);
  });

  it('every answer page and every error page is the league\'s too', async () => {
    const yes = await link('lg190fr:2099-03-07', 'lg190fr:S1');
    const accepted = await (await post(yes, 'yes')).text();
    expect(accepted).toContain('Ligue du mercredi');
    expect(seen(accepted)).not.toMatch(SMBHL_WORDS);

    const no = await link('lg190fr:2099-03-07', 'lg190fr:S1', 'skater', 'no');
    const declined = await (await post(no, 'no')).text();
    expect(declined).toContain('Merci, noté');
    expect(titleOf(declined)).toBe('Merci, noté | Ligue du mercredi');
    expect(seen(declined)).not.toMatch(SMBHL_WORDS);

    const bad = yes.replace(/t=[0-9a-f]+/, 't=bad');
    const invalid = await (await SELF.fetch(bad)).text();
    expect(invalid).toContain('Lien invalide ou expiré');
    expect(invalid).toContain('Ligue du mercredi');
    expect(seen(invalid)).not.toMatch(SMBHL_WORDS);
  });
});

describe('/avail for an SMBHL game is unchanged', () => {
  it('keeps SMBHL\'s page', async () => {
    const html = await (await SELF.fetch(await link('smbhl:2099-03-08', 'P1901'))).text();
    expect(titleOf(html)).toMatch(/\| SMBHL$/);
    expect(html).toContain('One more tap to confirm');
  });
});

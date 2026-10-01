// The sub call's closing line and footer, as delivered (drain() to Resend).
// Notre Ligue: « liste des remplaçants » / "subs list", and no tagline (a
// league has none; it used to inherit SMBHL's "Sunday Morning Ball Hockey
// League"). SMBHL: « liste de substituts » and its tagline, exactly.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { drain } from '../src/index.js';

let originalFetch;
const sent = [];
const visibleText = html => html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

beforeAll(async () => {
  env.RSVP_SECRET = 'p191'; env.RESEND_API_KEY = 'p191'; env.MAIL_DAILY_CAP = '100'; env.PUBLIC_URL = 'https://rsvp.notreligue.ca';
  await applyRealSchema(env);
  await env.DB.prepare('DELETE FROM contacts').run();
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('email_cadence_settings', '{"quiet_hours_enabled":false}')`).run();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) { sent.push(JSON.parse(opts.body)); return new Response('{"id":"x"}', { status: 200 }); }
    return new Response('{}', { status: 404 });
  };
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: 'Fall 2026', seasons: [{ name: 'Fall 2026', standings: [], fixtures: [] }], players: [] }));
  await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at) VALUES ('u191', 'owner@example.com', 'x', '2026-10-01T00:00:00Z')`).run();
  await env.DB.prepare(`INSERT INTO leagues (id, name, team_count, team_names, created_by, created_at, slug, team_structure, language_mode) VALUES ('lg191', 'Ligue du mercredi', 2, '["Loutres","Ours"]', 'u191', '2026-10-01T00:00:00Z', 'ligue-du-mercredi', 'fixed', 'both')`).run();
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES ('lg191:2099-03-07', 'S1', 1, '2099-03-07', 'Aréna', 'open', '19:30', 'lg191')`).run();
  await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES ('lg191:S1', 'Sam Remplaçant', 'sam@example.com', 'sub_skater', 1, 0, 's', 'lg191')`).run();
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES ('2099-09-27', 'Fall 2026', 3, 'Sunday September 27 2099', 'Letendre', 'open', '10:30', 'smbhl')`).run();
  await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES ('P1911', 'Smbhl Sub', 'smbhl@example.com', 'sub_skater', 1, 0, 's', 'smbhl')`).run();
});
afterAll(() => { globalThis.fetch = originalFetch; });

async function deliver(eventId, playerId, leagueId) {
  sent.length = 0;
  await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, dedup_key, payload, send_after, created_at, league_id) VALUES ('sub_call', ?, ?, ?, '{"need":"skater"}', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z', ?)`).bind(eventId, playerId, 'p191:' + playerId, leagueId).run();
  await drain(env);
  expect(sent).toHaveLength(1);
  return sent[0];
}

describe('the sub call closing line and footer', () => {
  it('Notre Ligue: « liste des remplaçants », "subs list", no tagline', async () => {
    const m = await deliver('lg191:2099-03-07', 'lg191:S1', 'lg191');
    for (const body of [m.text, visibleText(m.html)]) {
      expect(body).toContain('Tu ne veux plus être sur la liste des remplaçants ? Réponds à ce courriel.');
      expect(body).toContain('Want off the subs list? Just reply to this email.');
      expect(body).not.toMatch(/substitut|Sunday Morning|Ball Hockey League/i);
    }
    expect(visibleText(m.html)).toMatch(/Ligue du mercredi · rsvp\.notreligue\.ca/);
  });

  it('SMBHL: « liste de substituts », "sub list" and its tagline, unchanged', async () => {
    const m = await deliver('2099-09-27', 'P1911', 'smbhl');
    for (const body of [m.text, visibleText(m.html)]) {
      expect(body).toContain('Tu ne veux plus être sur la liste de substituts ? Réponds à ce courriel.');
      expect(body).toContain('Want off the sub list? Just reply to this email.');
    }
    expect(visibleText(m.html)).toContain('SMBHL · Sunday Morning Ball Hockey League ·');
  });
});

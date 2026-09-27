// Admin-addressed mail has no player row; it must still be sent -- to the
// admin. The "week created" notice never worked: drain() treated only
// 'summary' and 'season_recap_prompt' as admin mail, so 'created' looked up
// a contact for player_id NULL and failed permanently as "contact gone"
// (production: week 5's at 21:30 UTC on 27 Sept, week 4's the same).
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { drain, ensureNextEvent } from '../src/index.js';

let originalFetch;
const sent = [];
beforeAll(async () => {
  env.RSVP_SECRET = 'p123'; env.RESEND_API_KEY = 'p123'; env.MAIL_DAILY_CAP = '100';
  env.ADMIN_EMAIL = 'admin@smbhl.test'; env.PUBLIC_URL = 'https://rsvp.example';
  await applyRealSchema(env);
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('email_cadence_settings', '{"quiet_hours_enabled":false}')`).run();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) { const b = JSON.parse(opts.body); sent.push({ to: Array.isArray(b.to) ? b.to[0] : b.to, subject: b.subject, text: b.text }); return new Response('{"id":"x"}', { status: 200 }); }
    return new Response('{}', { status: 404 });
  };
  // A fixture far enough ahead that ensureNextEvent creates it.
  const d = new Date(Date.now() + 5 * 86400000);
  const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' }).replace(/,/g, '');
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: 'Fall 2026', seasons: [{ name: 'Fall 2026', standings: [], fixtures: [{ week: 4, date: label, time: '10:30 AM', home: 'Red', away: 'Blue' }] }], players: [] }));
});
afterAll(() => { globalThis.fetch = originalFetch; });

describe('Admin mail with no recipient player', () => {
  it('the "week created" notice is queued with no player and actually sent -- to the admin', async () => {
    const made = await ensureNextEvent(env);
    expect(made).toBeTruthy();
    const row = await env.DB.prepare(`SELECT player_id FROM outbox WHERE kind = 'created'`).first();
    expect(row.player_id).toBeNull();
    sent.length = 0;
    await drain(env);
    const r = await env.DB.prepare(`SELECT sent_at, failed_at, error FROM outbox WHERE kind = 'created'`).first();
    expect(r).toMatchObject({ failed_at: null, error: null });
    expect(r.sent_at).toBeTruthy();
    const mail = sent.find(m => m.to === 'admin@smbhl.test');
    expect(mail.subject).toMatch(/Semaine 4 créée/);
  });

  it('any other player-less row goes to the admin too (not "contact gone")', async () => {
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, dedup_key, payload, send_after, created_at) VALUES ('summary', (SELECT id FROM events LIMIT 1), NULL, 'p123-summary', '{"text":"Sommaire"}', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')`).run();
    sent.length = 0;
    await drain(env);
    expect(sent.map(m => m.to)).toEqual(['admin@smbhl.test']);
  });
});

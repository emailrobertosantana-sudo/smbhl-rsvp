// The sub call as DELIVERED: what drain() actually hands to Resend, in every
// part a reader can see -- subject, text part, and the HTML part mail clients
// render. Sam Cartwright (P0221) reported a French-only sub call; SMBHL sub
// calls must carry both languages, French first, and the subject "FR / EN"
// like every other bilingual SMBHL email.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { drain } from '../src/index.js';

let originalFetch;
const sent = [];
const visibleText = html => html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ');

beforeAll(async () => {
  env.RSVP_SECRET = 'p121'; env.RESEND_API_KEY = 'p121'; env.MAIL_DAILY_CAP = '100';
  await applyRealSchema(env);
  await env.DB.prepare('DELETE FROM contacts').run();
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('email_cadence_settings', '{"quiet_hours_enabled":false}')`).run();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) { sent.push(JSON.parse(opts.body)); return new Response('{"id":"x"}', { status: 200 }); }
    return new Response('{}', { status: 404 });
  };
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: 'Fall 2026', seasons: [{ name: 'Fall 2026', standings: [], fixtures: [] }], players: [] }));
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES ('2099-09-27', 'Fall 2026', 3, 'Sunday September 27 2099', 'Letendre', 'open', '10:30', 'smbhl')`).run();
  await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES ('P0221', 'Sam Cartwright', 'sam@example.com', 'sub_skater', 1, 0, 's', 'smbhl')`).run();
});
afterAll(() => { globalThis.fetch = originalFetch; });

async function deliver(payload, dedup) {
  sent.length = 0;
  await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at, league_id) VALUES ('sub_call', '2099-09-27', 'P0221', 'Blue', ?, ?, '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z', 'smbhl')`).bind(dedup, JSON.stringify(payload)).run();
  await drain(env);
  expect(sent).toHaveLength(1);
  return sent[0];
}

// Sam has no stored team preference, so the call is generic -- no team
// named (sub calls follow-up): the team is decided when a sub accepts.
describe('SMBHL sub call, as delivered to Resend', () => {
  it('subject is "FR / EN"; the text AND the HTML part carry the whole English half after the French', async () => {
    const m = await deliver({ need: 'skater' }, 'p121-call');
    expect(m.subject).toBe('SMBHL a besoin d\'un substitut dimanche 27 sept. / SMBHL needs a sub on Sunday, Sep 27');
    for (const [part, body] of [['text', m.text], ['html', visibleText(m.html)]]) {
      const fr = body.indexOf('SMBHL a besoin d'), en = body.indexOf('SMBHL needs a sub on');
      expect(fr, `${part}: French`).toBeGreaterThanOrEqual(0);
      expect(en, `${part}: English after French`).toBeGreaterThan(fr);
      expect(body, `${part}: English question`).toMatch(/SMBHL needs a sub on Sunday, Sep 27 at 10:30 AM\. Are you in\?/);
      expect(body, `${part}: no team or waitlist line`).not.toMatch(/isn.t decided|waitlist/);
      expect(body, `${part}: no team named`).not.toContain('Blue');
      expect(body, `${part}: English opt-out line`).toContain('Want off the sub list? Just reply to this email.');
    }
    const html = visibleText(m.html);
    // Email review item 3: one bilingual pair after both languages.
    expect(html).toMatch(/J.embarque \/ I.m in/);
    expect(html).toContain('Pas cette fois / Not this time');
    expect(html).toMatch(/Want off the sub list\?[\s\S]*J.embarque \/ I.m in/);
  });

  it('the reminder too: "(rappel) / (reminder)" and both languages', async () => {
    const m = await deliver({ need: 'skater', reminder: true }, 'p121-remind');
    expect(m.subject).toBe("SMBHL a besoin d'un substitut dimanche 27 sept. (rappel) / SMBHL needs a sub on Sunday, Sep 27 (reminder)");
    expect(visibleText(m.html)).toContain('SMBHL needs a sub on');
  });
});

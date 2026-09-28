// Group A: preview an email without sending it. The preview renders with the
// real next game and real recipients, through the same path drain() sends
// from -- and sends nothing: no outbox row, no Resend call, no daily count.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { drain } from '../src/index.js';
import { buildEmailPreview, PREVIEW_KINDS } from '../src/email_preview.js';

const ADMIN_KEY = 'p130-admin';
const label = days => new Date(Date.now() + days * 86400000).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' }).replace(/,/g, '');
const isoOf = days => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() + days * 86400000)); const g = t => p.find(x => x.type === t).value; return `${g('year')}-${g('month')}-${g('day')}`; };
const EV = `smbhl:${isoOf(3)}`;
const LEV = `lg-p130:${isoOf(2)}`;

const DATA = {
  current_season: 'Fall 2026',
  seasons: [
    { name: 'Fall 2026', standings: [], fixtures: [
      { week: 5, date: label(3), time: '10:30 AM', home: 'Red', away: 'Blue', venue: 'Collège Laval' },
      { week: 5, date: label(3), time: '11:30 AM', home: 'White', away: 'Black', venue: 'Collège Laval' }
    ] },
    { name: 'Spring 2026', champion: 'Blue', standings: [], fixtures: [] }
  ],
  players: []
};

let originalFetch;
const resend = [];
const outboxCount = async () => (await env.DB.prepare('SELECT count(*) n FROM outbox').first()).n;
const dailyCount = async () => (await env.DB.prepare('SELECT COALESCE(SUM(sent), 0) n FROM mail_daily_count').first()).n;

beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  env.RSVP_SECRET = 'p130'; env.RESEND_API_KEY = 'p130'; env.MAIL_DAILY_CAP = '100';
  env.PUBLIC_URL = 'https://rsvp.example';
  await applyRealSchema(env);
  await env.DB.prepare('DELETE FROM contacts').run();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('api.resend.com')) { resend.push(JSON.parse(opts.body)); return new Response('{"id":"x"}', { status: 200 }); }
    if (u.endsWith('/data.json')) return new Response(JSON.stringify(DATA), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  await env.SHEETS_KV.put('data_json', JSON.stringify(DATA));
  await env.SHEETS_KV.put('season_recap_draft:Spring 2026', JSON.stringify({ season: 'Spring 2026', champion: 'Blue', awards: { rocketRichard: 'Alex Roster, 30 buts / goals' }, intro_note: 'Quelle saison !' }));
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('email_cadence_settings', '{"quiet_hours_enabled":false}')`).run();

  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'Fall 2026', 5, ?, 'Collège Laval', 'open', '10:30', 'smbhl')`).bind(EV, label(3)).run();
  await env.DB.prepare(`INSERT INTO season_pricing (season, price_player, price_goalie, price_sub_player, price_sub_goalie, etransfer_phone, updated_at) VALUES ('Fall 2026', 170, 85, 5, 0, '514-555-0000', '2026-01-01T00:00:00Z')`).run();
  const contact = (id, name, role, isSub, isGoalie) => env.DB.prepare(
    `INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt, league_id) VALUES (?, ?, ?, ?, ?, ?, 's', 'smbhl')`
  ).bind(id, name, `${id.toLowerCase()}@example.com`, role, isSub, isGoalie).run();
  await contact('P1', 'Alex Roster', 'roster', 0, 0);
  await contact('P2', 'Bea Confirmed', 'roster', 0, 0);
  await contact('P3', 'Gus Goalie', 'roster', 0, 1);
  await contact('S1', 'Sam Free', 'sub_skater', 1, 0);
  await contact('S2', 'Sue Placed', 'sub_skater', 1, 0);
  const rsvp = (pid, team, status, role) => env.DB.prepare(
    `INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00Z', 'smbhl')`
  ).bind(EV, pid, team, status, role).run();
  await rsvp('P1', 'Red', 'pending', 'roster');
  await rsvp('P2', 'Red', 'in', 'roster');
  await rsvp('P3', 'Red', 'in', 'roster');
  await rsvp('S2', 'Blue', 'in', 'sub');
  await env.DB.prepare(`INSERT INTO team_messages (event_id, team, player_name, player_id, message, created_at) VALUES (?, 'Red', 'Bea Confirmed', 'P2', 'On apporte les ballons', ?)`).bind(EV, new Date().toISOString()).run();
  await env.DB.prepare(`INSERT INTO polls (season, title, description, created_at) VALUES ('Fall 2026', 'Meilleur gardien', 'Vote !', '2026-09-01T00:00:00Z')`).run();

  // A league-product league with its next game.
  await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at, email_verified_at) VALUES ('u-p130', 'owner@p130.example', 'x', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
  await env.DB.prepare(
    `INSERT INTO leagues (id, name, tracks_stats, team_count, team_names, created_by, created_at, slug, team_structure, color, language_mode)
     VALUES ('lg-p130', 'Otters', 1, 2, '["Otters","Bears"]', 'u-p130', '2026-01-01T00:00:00Z', 'otters-p130', 'fixed', '#2a5fa8', 'both')`
  ).run();
  await env.DB.prepare(`INSERT INTO league_admins (league_id, user_id, created_at) VALUES ('lg-p130', 'u-p130', '2026-01-01T00:00:00Z')`).run();
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'S1', 1, ?, 'Parc', 'open', '19:00', 'lg-p130')`).bind(LEV, isoOf(2)).run();
  for (const [id, name, role, team] of [['L1', 'Lea Undecided', 'roster', 'Otters'], ['L2', 'Luc In', 'roster', 'Otters'], ['L3', 'Lou Sub', 'sub_skater', null]]) {
    await env.DB.prepare(
      `INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, preferred_team, token_salt, is_active, league_id) VALUES (?, ?, ?, ?, ?, 0, ?, 's', 1, 'lg-p130')`
    ).bind(id, name, `${id.toLowerCase()}@example.com`, role, role === 'roster' ? 0 : 1, team).run();
  }
  await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, 'L2', 'Otters', 'in', 'roster', '2026-01-01T00:00:00Z', 'lg-p130')`).bind(LEV).run();
});
afterAll(() => { globalThis.fetch = originalFetch; });

describe('Group A: an email preview sends nothing', () => {
  it('the weekly invite renders with the real next game and a real recipient, and queues, sends and counts nothing', async () => {
    const before = { outbox: await outboxCount(), daily: await dailyCount(), resend: resend.length };
    const res = await SELF.fetch('http://example.com/admin/comms/preview', {
      method: 'POST', headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'invite' })
    });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.ok).toBe(true);
    expect(d.subject).toMatch(/^Présence : .+ \/ RSVP: /);
    expect(d.to).toBe('p1@example.com');
    expect(d.recipientCount).toBe(3);
    expect(d.source.en).toContain('Next game: week 5');
    expect(d.html).toContain('Salut <b>Alex</b>');
    expect(d.html).toContain(`/rsvp?e=${encodeURIComponent(EV)}&amp;p=P1&amp;t=`);
    expect(d.html).toContain('Montant dû : 170,00 $ / Amount due: $170.00');
    expect({ outbox: await outboxCount(), daily: await dailyCount(), resend: resend.length }).toEqual(before);
  });

  it('every SMBHL and league kind previews (or says plainly why it cannot) with nothing queued or sent', async () => {
    const before = { outbox: await outboxCount(), daily: await dailyCount(), resend: resend.length };
    const results = {};
    for (const kind of Object.keys(PREVIEW_KINDS.smbhl)) {
      const params = kind === 'broadcast' ? { kind, subject: 'Info', message: 'Bonjour à tous', target: 'roster' } : { kind };
      results[`smbhl:${kind}`] = await buildEmailPreview(env, 'smbhl', params);
    }
    for (const kind of Object.keys(PREVIEW_KINDS.league)) {
      const params = kind === 'broadcast' ? { kind, subject: 'Info', message: 'Salut', target: 'all' } : { kind };
      results[`league:${kind}`] = await buildEmailPreview(env, 'lg-p130', params);
    }
    const failed = Object.entries(results).filter(([, r]) => !r.ok).map(([k, r]) => `${k}: ${r.error.en}`);
    expect(failed).toEqual([]);
    for (const [k, r] of Object.entries(results)) {
      expect(r.subject, k).toBeTruthy();
      expect(r.html || r.text, k).toBeTruthy();
    }
    expect({ outbox: await outboxCount(), daily: await dailyCount(), resend: resend.length }).toEqual(before);
  });

  it('the season recap renders from the most recent COMPLETED season and says which one', async () => {
    const d = await buildEmailPreview(env, 'smbhl', { kind: 'season_recap' });
    expect(d.ok).toBe(true);
    expect(d.source).toEqual({ fr: 'Saison terminée la plus récente : Spring 2026', en: 'Most recent completed season: Spring 2026' });
    expect(d.subject).toContain('Bilan Spring 2026');
    expect(d.subject).toContain('Champions (Bleu)');
    expect(d.html).toContain('Quelle saison !');
    expect(d.notes.map(n => n.en)).toContain('Content: the saved draft.');
    const prompt = await buildEmailPreview(env, 'smbhl', { kind: 'season_recap_prompt' });
    expect(prompt.source.en).toBe('Most recent completed season: Spring 2026');
    expect(prompt.subject).toContain('(Spring 2026)');
  });

  it('what the preview shows is what drain() sends for the same row', async () => {
    const preview = await buildEmailPreview(env, 'smbhl', { kind: 'chase_72' });
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, dedup_key, payload, send_after, created_at, league_id) VALUES ('chase', ?, 'P1', 'p130-chase', '{"stage":"72"}', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z', 'smbhl')`).bind(EV).run();
    resend.length = 0;
    await drain(env);
    const sent = resend.find(m => m.to[0] === 'p1@example.com');
    expect(sent).toBeTruthy();
    expect(sent.subject).toBe(preview.subject);
    expect(sent.html).toBe(preview.html);
  });

  it('a league preview goes through the league route (session-gated) and SMBHL\'s requires the admin key', async () => {
    const r1 = await SELF.fetch('http://example.com/admin/comms/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"kind":"invite"}' });
    expect(r1.status).toBe(403);
    const r2 = await SELF.fetch('http://example.com/league/comms/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"kind":"reminder_72h"}' });
    expect([401, 403]).toContain(r2.status);
  });

  it('league reminders: the non-responder gets it, in the league\'s language mode', async () => {
    const d = await buildEmailPreview(env, 'lg-p130', { kind: 'reminder_72h' });
    expect(d.to).toBe('l1@example.com');
    expect(d.subject).toMatch(/^Lea, as-tu décidé pour .+\? \/ Lea, have you decided for .+\?$/);
    expect(d.html).toContain('Propulsé par Notre Ligue pour Otters · Powered by Notre Ligue for Otters');
  });

  it('an unknown kind is refused, not a server error', async () => {
    const d = await buildEmailPreview(env, 'smbhl', { kind: 'nope' });
    expect(d.ok).toBe(false);
    expect(d.error.en).toBe('Unknown preview: nope');
  });
});

// Copy follow-ups: the SMBHL poll email pairs French and English line by
// line (3b); the stuck-mail alert's French section is in French, and an
// alert already sent under the old wording is not sent again (3c); Notre
// Ligue's team_assigned email says the team is new (3d). The SMBHL
// game-day « ta présence est confirmée » (3a) is pinned in index.spec.js
// and the SMBHL golden record.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { renderPollEmail, deadMan, renderLeagueLogisticsEmail } from '../src/index.js';

let sent = [];
let originalFetch;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
  env.RSVP_SECRET = 'p197';
  env.RESEND_API_KEY = 'p197-resend';
  env.ADMIN_EMAIL = 'admin@smbhl.test';
  await applyRealSchema(env);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) { sent.push(JSON.parse(opts.body)); return new Response('{"id":"x"}', { status: 200 }); }
    return new Response('{}', { status: 404 });
  };
});
afterAll(() => { globalThis.fetch = originalFetch; vi.useRealTimers(); });

describe('3b: the SMBHL poll email, French and English', () => {
  it('each French line has its English line', async () => {
    const m = await renderPollEmail(env, { id: 7, title: 'Gala 2026', description: '' }, { player_id: 'P0001', name: 'Marc Tremblay', token_salt: 's' });
    expect(m.subject).toBe('Vote SMBHL : Gala 2026 / SMBHL Poll');
    expect(m.text).toContain('Un vote officiel de la SMBHL est maintenant ouvert : Gala 2026\nAn official SMBHL vote is now open: Gala 2026\n');
    expect(m.text).toContain('Pour soumettre ou modifier ton vote, clique sur ce lien direct :\nTo cast or change your vote, use this direct link:\n');
    expect(m.html).toContain("Ce lien de vote t'est réservé. Tu peux modifier ton choix en tout temps tant que le scrutin est ouvert.<br>");
    expect(m.html).toContain('This voting link is yours alone. You can change your choice any time while the vote is open.');
  });
});

describe('3c: the stuck-mail alert', () => {
  const stuck = (n, extra = '') => env.DB.prepare(
    `INSERT INTO outbox (kind, event_id, player_id, dedup_key, payload, send_after, created_at, error, league_id${extra ? ', failed_at' : ''}) VALUES ('gameday', 'smbhl:2026-11-08', 'P1', ?, '{}', '2026-11-01T09:00:00Z', '2026-11-01T09:00:00Z', 'upstream', 'smbhl'${extra ? ', ?' : ''})`
  ).bind(...(extra ? [`p197:${n}`, extra] : [`p197:${n}`])).run();

  it('the French section is in French, the English section in English, the old keys kept', async () => {
    await stuck(1); await stuck(2);
    await stuck(3, '2026-11-01T10:00:00Z');
    sent = [];
    await deadMan(env);
    expect(sent).toHaveLength(1);
    const [fr, en] = sent[0].text.split('Something did not run:');
    expect(fr).toContain("- 3 messages bloqués dans la file d'envoi depuis plus d'une heure");
    expect(fr).toContain('- 1 courriel a échoué définitivement dans les dernières 24 heures');
    expect(fr).toContain("À vérifier : l'onglet Comms (filtre des échecs) et la table des tâches (jobs).");
    expect(fr).not.toMatch(/stuck|failed permanently/);
    expect(en).toContain('- 3 messages stuck in the outbox over an hour');
    expect(en).toContain('- 1 email failed permanently in the last 24 hours');
    const keys = ((await env.DB.prepare("SELECT key FROM settings WHERE key LIKE 'alert:%'").all()).results || []).map(r => r.key);
    expect(keys).toContain('alert:3_message(s)_stuck_in_the_outbox_over_an_hour');
    expect(keys).toContain('alert:1_email(s)_failed_permanently_in_the_last_24_hours');
    // Sent once: the next pass finds the same keys and sends nothing.
    sent = [];
    await deadMan(env);
    expect(sent).toHaveLength(0);
  });
});

describe('3d: Notre Ligue team_assigned says the team is new', () => {
  const args = { leagueName: 'Ligue Test', leagueColor: '#2a5fa8', firstName: 'Lea', dayLabel: { fr: 'dimanche', en: 'Sunday' }, ev: { id: 'lg:2026-11-15', date: '2026-11-15', start_time: '19:00', venue: 'Gym' }, team: 'Otters', optOutLink: 'https://x.test/o', forcedLang: null };

  it('a short heading above the shared details, in French and English', () => {
    const m = renderLeagueLogisticsEmail({ ...args, newTeam: true });
    expect(m.text).toContain('Tu fais maintenant partie de Otters\n\n');
    expect(m.text).toContain("You're now on Otters\n\n");
    expect(m.html).toContain('Tu fais maintenant partie de Otters</p>');
    expect(m.html).toMatch(/You(&#39;|&#x27;|')re now on Otters<\/p>/);
  });

  it('the details email itself is unchanged', () => {
    const plain = renderLeagueLogisticsEmail(args);
    expect(plain.text).not.toMatch(/maintenant partie|now on/);
    const withHeading = renderLeagueLogisticsEmail({ ...args, newTeam: true });
    expect(withHeading.subject).toBe(plain.subject);
  });
});

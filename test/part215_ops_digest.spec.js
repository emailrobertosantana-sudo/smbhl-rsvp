// Stage 2 item 2g: the operator's daily digest (src/ops_digest.js), through
// the real cron entry point (scheduled(), LEAGUE_PRODUCT=true):
//   - one email a day to bonjour@notreligue.ca, French then English, through
//     the outbox (kind ops_digest, league 'system');
//   - only on days with something to report: new sign-ups, leagues that
//     turned yellow or red, trials entering their last 7 days, failed
//     payments; nothing on quiet days;
//   - never into the payment reminder reserve: it waits, nothing is lost;
//   - not on SMBHL, and not with HEALTH_ALERTS off (the golden tests).
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import worker from '../src/index.js';
import { renderOpsDigest, OPS_DIGEST_TO } from '../src/ops_digest.js';

let sent = [];
const originalFetch = globalThis.fetch;

async function pass(isoUtc) {
  vi.setSystemTime(new Date(isoUtc));
  const ctx = createExecutionContext();
  await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, env, ctx);
  await waitOnExecutionContext(ctx);
}
const digests = () => sent.filter(m => m.to === OPS_DIGEST_TO);
const league = async (id, name, createdAt) => {
  await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email, password_hash, created_at, last_login_at) VALUES (?, ?, 'x', ?, ?)`)
    .bind(`u-${id}`, `owner-${id}@example.com`, createdAt, createdAt).run();
  await env.DB.prepare(`INSERT INTO leagues (id, name, team_count, team_names, created_by, created_at) VALUES (?, ?, 2, '["A","B"]', ?, ?)`)
    .bind(id, name, `u-${id}`, createdAt).run();
  await env.DB.prepare(`INSERT INTO league_admins (user_id, league_id, created_at) VALUES (?, ?, ?)`).bind(`u-${id}`, id, createdAt).run();
};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
  env.RSVP_SECRET = 'p215-rsvp';
  env.RESEND_API_KEY = 'p215-resend';
  env.PUBLIC_URL = 'https://rsvp.notreligue.example';
  env.LEAGUE_PRODUCT = 'true';
  env.MAIL_DAILY_CAP = '10';
  env.MAIL_HARD_DAILY_CAP = '10';
  env.PAYMENT_REMINDER_RESERVE = '2';
  await applyRealSchema(env);
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      const b = JSON.parse(opts.body);
      sent.push({ to: Array.isArray(b.to) ? b.to[0] : b.to, subject: b.subject, text: b.text, html: b.html, from: b.from });
      return new Response('{"id":"x"}', { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Signed up the evening before the first digest, and one long before.
  await league('lg-old', 'Ligue Ancienne', '2026-09-01T12:00:00Z');
  // lg-old is green: an admin signed in yesterday, a player, a game soon.
  await env.DB.prepare("UPDATE users SET last_login_at = '2026-11-01T12:00:00Z' WHERE id = 'u-lg-old'").run();
  await env.DB.prepare("INSERT INTO contacts (player_id, name, email, role, is_sub, token_salt, league_id) VALUES ('old-p1', 'Olga', 'olga@example.com', 'roster', 0, 's', 'lg-old')").run();
  await env.DB.prepare("INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES ('lg-old:2026-11-10', 'S', 1, '2026-11-10', 'Gym', 'open', '19:00', 'lg-old')").run();
  await league('lg-new', 'Les Castors', '2026-11-01T22:00:00Z');
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const k of ['LEAGUE_PRODUCT', 'MAIL_DAILY_CAP', 'MAIL_HARD_DAILY_CAP', 'PAYMENT_REMINDER_RESERVE', 'HEALTH_ALERTS']) delete env[k];
});

describe('the daily digest', () => {
  it('not before 07:00 league time', async () => {
    await pass('2026-11-02T10:30:00Z'); // 05:30 in Montreal
    expect(digests()).toEqual([]);
  });

  it('a day with a new sign-up: one email to bonjour@, French then English, through the outbox', async () => {
    await pass('2026-11-02T12:30:00Z'); // 07:30
    expect(digests()).toHaveLength(1);
    const m = digests()[0];
    expect(m.subject).toBe('Notre Ligue : résumé du jour / daily digest (2026-11-02)');
    expect(m.text).toContain('Nouvelles inscriptions\n- Les Castors : inscrite le 2026-11-01, o***@example.com');
    expect(m.text).toContain('New sign-ups\n- Les Castors: signed up on 2026-11-01, o***@example.com');
    expect(m.text.indexOf('Nouvelles inscriptions')).toBeLessThan(m.text.indexOf('New sign-ups'));
    expect(m.text).not.toContain('Ligue Ancienne');
    expect(m.text).toContain('https://rsvp.notreligue.example/super-admin/leagues');
    expect(m.html.indexOf('Nouvelles inscriptions')).toBeLessThan(m.html.indexOf('New sign-ups'));
    for (const s of [m.subject, m.text, m.html]) expect(s).not.toContain('—');
    const row = await env.DB.prepare(`SELECT kind, league_id, event_id, sent_at FROM outbox WHERE kind = 'ops_digest'`).first();
    expect(row).toMatchObject({ kind: 'ops_digest', league_id: 'system', event_id: 'system' });
    expect(row.sent_at).toBeTruthy();
  });

  it('once a day: later passes the same day send nothing more', async () => {
    await pass('2026-11-02T15:00:00Z');
    await pass('2026-11-02T20:00:00Z');
    expect(digests()).toHaveLength(1);
  });

  it('a quiet day: nothing', async () => {
    await pass('2026-11-03T12:30:00Z');
    await pass('2026-11-03T18:00:00Z');
    expect(digests()).toHaveLength(1);
  });

  it('a league that turned red and a failed payment are reported', async () => {
    const createdSecs = Math.floor(Date.parse('2026-11-03T20:00:00Z') / 1000);
    await env.DB.prepare(`INSERT INTO stripe_events (id, type, league_id, object_id, created, received_at, processed_at, attempts) VALUES ('evt_p215_1', 'invoice.payment_failed', 'lg-old', 'in_1', ?, '2026-11-03T20:00:00Z', '2026-11-03T20:00:05Z', 1)`).bind(createdSecs).run();
    await pass('2026-11-04T12:30:00Z');
    expect(digests()).toHaveLength(2);
    const m = digests()[1];
    expect(m.text).toContain('Ligues passées au jaune ou au rouge\n- Ligue Ancienne : rouge (était vert)');
    expect(m.text).toContain('Paiements en échec\n- Ligue Ancienne : le 2026-11-03');
    expect(m.text).toContain('Leagues that turned yellow or red\n- Ligue Ancienne: red (was green)');
    expect(m.text).toContain('Failed payments\n- Ligue Ancienne: on 2026-11-03');
    expect(m.text).not.toContain('Nouvelles inscriptions');
  });

  it('never into the payment reminder reserve: it waits, then goes with nothing lost', async () => {
    await league('lg-late', 'Les Aurores', '2026-11-04T23:00:00Z');
    // 8 of the day's 10 already sent: what is left is the reserve (2).
    await env.DB.prepare(`INSERT INTO mail_daily_count (day, sent, sub_calls) VALUES ('2026-11-05', 8, 0) ON CONFLICT(day) DO UPDATE SET sent = 8`).run();
    await pass('2026-11-05T12:30:00Z');
    await pass('2026-11-05T20:00:00Z');
    expect(digests()).toHaveLength(2);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'ops_digest'`).first()).toEqual({ n: 2 });
    // The next day: the waiting digest goes, with the sign-up it held.
    await pass('2026-11-06T12:30:00Z');
    expect(digests()).toHaveLength(3);
    expect(digests()[2].text).toContain('Les Aurores : inscrite le 2026-11-04');
  });

  it('nothing with HEALTH_ALERTS off (the recorded-behaviour tests), and nothing on SMBHL', async () => {
    await league('lg-x1', 'Ligue X1', '2026-11-06T20:00:00Z');
    env.HEALTH_ALERTS = 'off';
    try {
      await pass('2026-11-07T12:30:00Z');
      expect(digests()).toHaveLength(3);
    } finally { delete env.HEALTH_ALERTS; }
    await league('lg-x2', 'Ligue X2', '2026-11-07T20:00:00Z');
    delete env.LEAGUE_PRODUCT;
    try {
      await pass('2026-11-08T12:30:00Z');
      expect(digests()).toHaveLength(3);
    } finally { env.LEAGUE_PRODUCT = 'true'; }
  });

  it('a trial entering its last 7 days, in both languages', () => {
    const m = renderOpsDigest({ day: '2026-11-09', items: { signups: [], worsened: [], payments: [], trials: [{ id: 'a', name: 'Les Hiboux', trialEndsAt: '2026-11-15T00:00:00.000Z' }] } }, 'https://x.example');
    expect(m.text).toContain("Essais qui finissent dans 7 jours ou moins, sans abonnement\n- Les Hiboux : fin de l'essai le 2026-11-15");
    expect(m.text).toContain('Trials ending within 7 days, without a subscription\n- Les Hiboux: trial ends on 2026-11-15');
  });
});

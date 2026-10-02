// Stage 2 items 2b and 2c: each Notre Ligue league's health for the
// super-admin (src/league_health.js), and the list's filter and search.
//   - each rule, one league per rule, against the real schema;
//   - computed by the daily job and stored in settings (no migration), once
//     a day from 07:00 league time; an admin's visit counts as a sign-in;
//   - the list: red and yellow first, filter by state, search by name,
//     SMBHL never in it; the SMBHL product's data is unchanged.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { evaluateHealth, HEALTH_RULES, collectLeagueMetrics, computeLeagueHealth, runDailyLeagueHealth, storedHealth, recordAdminSeen, filterLeagueRows, healthKey, HEALTH_DAY_KEY } from '../src/league_health.js';
import { localParts } from '../src/league_ids.js';

const ADMIN_KEY = 'test-p213-admin';
const DAY = 86400000;
const NOW = Date.now();
const ago = d => new Date(NOW - d * DAY).toISOString();
const localDay = d => localParts(new Date(NOW + d * DAY)).date;

const user = (id, lastLogin) => env.DB.prepare(
  `INSERT OR REPLACE INTO users (id, email, password_hash, created_at, last_login_at) VALUES (?, ?, 'x', ?, ?)`
).bind(id, `${id}@example.com`, ago(90), lastLogin).run();
// A league that is green unless told otherwise: created 30 days ago, an
// admin signed in 2 days ago, 3 players, a game in 3 days, 4 invitations
// sent 2 days ago and 3 answered.
async function league(id, o = {}) {
  const owner = `u-${id}`;
  await user(owner, o.lastLogin === undefined ? ago(2) : o.lastLogin);
  await env.DB.prepare(
    `INSERT INTO leagues (id, name, team_count, team_names, created_by, created_at, deactivated_at) VALUES (?, ?, 2, '["A","B"]', ?, ?, ?)`
  ).bind(id, o.name || `League ${id}`, owner, o.createdAt || ago(30), o.deactivatedAt || null).run();
  await env.DB.prepare(`INSERT INTO league_admins (user_id, league_id, created_at) VALUES (?, ?, ?)`).bind(owner, id, ago(30)).run();
  const players = o.players === undefined ? 3 : o.players;
  for (let i = 1; i <= players; i++) {
    await env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, token_salt, league_id) VALUES (?, ?, ?, 'roster', 0, 's', ?)`)
      .bind(`${id}-p${i}`, `P${i}`, `${id}-p${i}@example.com`, id).run();
  }
  // gameDay null: its only game was 30 days ago (outside the window).
  const gameDay = o.gameDay === undefined ? 3 : o.gameDay === null ? -30 : o.gameDay;
  const ev = `${id}:${localDay(gameDay)}`;
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'S', 1, ?, 'Gym', 'open', '19:00', ?)`)
    .bind(ev, localDay(gameDay), id).run();
  const invites = o.invites === undefined ? 4 : o.invites;
  const answered = o.answered === undefined ? 3 : o.answered;
  for (let i = 1; i <= invites; i++) {
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, payload, send_after, sent_at, created_at, league_id) VALUES ('reminder_72h', ?, ?, '{}', ?, ?, ?, ?)`)
      .bind(ev, `${id}-p${i}`, ago(2), ago(2), ago(2), id).run();
    if (i <= answered) {
      await env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, updated_at, league_id) VALUES (?, ?, 'A', 'in', 'roster', ?, ?)`)
        .bind(ev, `${id}-p${i}`, ago(1), id).run();
    }
  }
  if (o.failedMail) {
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, payload, send_after, created_at, failed_at, cancelled, error, league_id) VALUES ('reminder_24h', ?, ?, '{}', ?, ?, ?, 1, 'resend 422', ?)`)
      .bind(ev, `${id}-p1`, ago(1), ago(1), ago(1), id).run();
  }
  if (o.billing) {
    await env.DB.prepare(`INSERT INTO league_billing (league_id, owner_user_id, regular_count, regular_count_at, count_tier, stripe_subscription_id, status, tier, updated_at) VALUES (?, ?, 20, ?, 'standard', ?, ?, 'standard', ?)`)
      .bind(id, owner, ago(0), o.billing.sub || null, o.billing.status || null, ago(0)).run();
  }
}

const data = async (query = '') => (await SELF.fetch(`http://example.com/super-admin/leagues/data${query}`, { headers: { 'x-admin': ADMIN_KEY } })).json();

beforeAll(async () => {
  env.AUTH_SECRET = 'test-p213-auth';
  env.ADMIN_KEY = ADMIN_KEY;
  env.LEAGUE_PRODUCT = 'true';
  // Billing on, launched long enough ago that a league created 30 days ago
  // has 3 days of trial left (the trial-ending rule).
  const launch = new Date(NOW);
  launch.setUTCMonth(launch.getUTCMonth() - 2);
  env.BILLING_LAUNCH_AT = new Date(launch.getTime() + 3 * DAY).toISOString();
  await applyRealSchema(env);
  // Every league subscribes unless a test says otherwise, so the trial rule
  // stays quiet; lg-trial has no subscription.
  await league('lg-green', { name: 'Les Castors', billing: { sub: 'sub_g', status: 'active' } });
  await league('lg-signin7', { lastLogin: ago(10), billing: { sub: 'sub_1', status: 'active' } });
  await league('lg-nogame', { gameDay: null, billing: { sub: 'sub_2', status: 'active' } });
  await league('lg-answers', { invites: 4, answered: 1, billing: { sub: 'sub_3', status: 'active' } });
  await league('lg-trial', { createdAt: ago(70) });
  await league('lg-mail', { failedMail: true, billing: { sub: 'sub_4', status: 'active' } });
  await league('lg-setup', { createdAt: ago(10), players: 0, invites: 0, billing: { sub: 'sub_5', status: 'active' } });
  await league('lg-signin21', { lastLogin: ago(30), billing: { sub: 'sub_6', status: 'active' } });
  await league('lg-pay', { billing: { sub: 'sub_7', status: 'past_due' } });
  await league('lg-young', { name: 'Les Aurores', createdAt: ago(2), players: 0, gameDay: null, invites: 0, billing: { sub: 'sub_8', status: 'active' } });
  await league('lg-off', { deactivatedAt: ago(5), billing: { sub: 'sub_9', status: 'active' } });
});
afterAll(() => { delete env.LEAGUE_PRODUCT; delete env.BILLING_LAUNCH_AT; });

const byId = async () => new Map((await computeLeagueHealth(env, new Date(NOW))).map(r => [r.id, r]));
const broken = r => r.signals.filter(s => !s.ok).map(s => s.key);

describe('the health rules', () => {
  it('are data: eight rules, each with French and English text and a level', () => {
    expect(HEALTH_RULES.map(r => [r.key, r.level])).toEqual([
      ['admin_signin_7', 'yellow'], ['game_window', 'yellow'], ['answers_half', 'yellow'], ['trial_not_ending', 'yellow'],
      ['mail_ok', 'yellow'], ['setup_done', 'red'], ['admin_signin_21', 'red'], ['payment_ok', 'red']
    ]);
    for (const r of HEALTH_RULES) { expect(r.fr).toBeTruthy(); expect(r.en).toBeTruthy(); expect(r.fr).not.toContain('—'); }
  });

  it('green: an admin within 7 days, a game in the window, at least half answered', async () => {
    const r = (await byId()).get('lg-green');
    expect(r.light).toBe('green');
    expect(broken(r)).toEqual([]);
    expect(r).toMatchObject({ players: 3, invitations14: 4, answered14: 3, gameInWindow: true, ownerMasked: 'u***@example.com' });
    expect(r.nextGame).toBe(`${localDay(3)} 19:00`);
  });

  it('yellow, one rule each: sign-in over 7 days, no game in the window, under half answered, trial ending, failed email', async () => {
    const m = await byId();
    expect([m.get('lg-signin7').light, broken(m.get('lg-signin7'))]).toEqual(['yellow', ['admin_signin_7']]);
    expect([m.get('lg-nogame').light, broken(m.get('lg-nogame'))]).toEqual(['yellow', ['game_window']]);
    expect([m.get('lg-answers').light, broken(m.get('lg-answers'))]).toEqual(['yellow', ['answers_half']]);
    expect([m.get('lg-trial').light, broken(m.get('lg-trial'))]).toEqual(['yellow', ['trial_not_ending']]);
    expect(m.get('lg-trial').trialDaysLeft).toBeLessThanOrEqual(4);
    expect([m.get('lg-mail').light, broken(m.get('lg-mail'))]).toEqual(['yellow', ['mail_ok']]);
  });

  it('red: setup not finished after 7 days, no admin sign-in for 21 days, a failed payment', async () => {
    const m = await byId();
    expect(m.get('lg-setup').light).toBe('red');
    expect(broken(m.get('lg-setup'))).toContain('setup_done');
    expect(m.get('lg-signin21').light).toBe('red');
    expect(broken(m.get('lg-signin21'))).toEqual(['admin_signin_7', 'admin_signin_21']);
    expect([m.get('lg-pay').light, broken(m.get('lg-pay'))]).toEqual(['red', ['payment_ok']]);
  });

  it('a failed payment is also the last invoice event of the week being a failure', () => {
    const base = { signInDays: 1, gameInWindow: true, invitations14: 0, answered14: 0, trialEndingNoSub: false, mailFailures7: 0, ageDays: 30, players: 3, games: 2 };
    expect(evaluateHealth({ ...base, paymentFailed: false }).light).toBe('green');
    expect(evaluateHealth({ ...base, paymentFailed: true }).light).toBe('red');
    // No invitation sent: the answers rule has nothing to judge.
    expect(evaluateHealth({ ...base, paymentFailed: false, invitations14: 0 }).signals.find(s => s.key === 'answers_half').ok).toBe(true);
  });

  it('a league younger than 7 days is not stalled for its setup; a deactivated league has no light; SMBHL is never there', async () => {
    const m = await byId();
    expect(m.get('lg-young').light).toBe('yellow');
    expect(broken(m.get('lg-young'))).toEqual(['game_window']);
    expect(m.get('lg-off')).toMatchObject({ deactivated: true, light: null });
    expect(m.has('smbhl')).toBe(false);
  });

  it("an admin's visit while signed in counts as a sign-in (sessions last 30 days)", async () => {
    await recordAdminSeen(env, 'lg-signin7', new Date(NOW));
    const metrics = (await collectLeagueMetrics(env, new Date(NOW))).find(r => r.id === 'lg-signin7');
    expect(Date.parse(metrics.lastAdminSignInAt)).toBeGreaterThan(NOW - DAY);
    expect((await byId()).get('lg-signin7').light).toBe('green');
    await env.DB.prepare(`DELETE FROM settings WHERE key = 'admin_seen:lg-signin7'`).run();
  });
});

describe('the daily job stores it', () => {
  it('from 07:00 league time, once a day; the snapshot is in settings with the league id', async () => {
    const at = h => { const d = new Date(NOW); d.setUTCHours(h, 30, 0, 0); return d; };
    // 05:30 UTC is 00:30 or 01:30 in Montreal: too early.
    expect((await runDailyLeagueHealth(env, at(5))).ran).toBe(false);
    const first = await runDailyLeagueHealth(env, at(13));
    expect(first.ran).toBe(true);
    expect((await runDailyLeagueHealth(env, at(15))).ran).toBe(false);
    const stored = await storedHealth(env.DB);
    expect(stored.get('lg-green')).toMatchObject({ light: 'green', previousLight: null });
    expect(stored.get('lg-pay').light).toBe('red');
    expect(stored.has('lg-off')).toBe(false);
    const row = await env.DB.prepare('SELECT league_id FROM settings WHERE key = ?').bind(healthKey('lg-green')).first();
    expect(row.league_id).toBe('lg-green');
    expect((await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(HEALTH_DAY_KEY).first()).value).toBe(localParts(at(13)).date);
  });

  it('the next day: a league that turned worse is reported, one that stayed is not', async () => {
    await env.DB.prepare(`UPDATE league_billing SET status = 'past_due' WHERE league_id = 'lg-green'`).run();
    const next = new Date(NOW + DAY); next.setUTCHours(13, 30, 0, 0);
    const r = await runDailyLeagueHealth(env, next);
    expect(r.ran).toBe(true);
    expect(r.worsened.map(w => [w.id, w.from, w.to])).toEqual([['lg-green', 'green', 'red']]);
    expect((await storedHealth(env.DB)).get('lg-green')).toMatchObject({ light: 'red', previousLight: 'green' });
    await env.DB.prepare(`UPDATE league_billing SET status = 'active' WHERE league_id = 'lg-green'`).run();
    // Better again the day after: stored green, nothing reported.
    const after = new Date(NOW + 2 * DAY); after.setUTCHours(13, 30, 0, 0);
    const r2 = await runDailyLeagueHealth(env, after);
    expect(r2.worsened.some(w => w.id === 'lg-green')).toBe(false);
    expect((await storedHealth(env.DB)).get('lg-green')).toMatchObject({ light: 'green', previousLight: 'red' });
  });

  it('nothing on the SMBHL product', async () => {
    delete env.LEAGUE_PRODUCT;
    try { expect((await runDailyLeagueHealth(env, new Date(NOW + 5 * DAY))).ran).toBe(false); }
    finally { env.LEAGUE_PRODUCT = 'true'; }
  });
});

describe('the list: filter and search', () => {
  it('red and yellow first, then green, deactivated last; SMBHL is not a row', async () => {
    const { rows } = await data();
    const lights = rows.map(r => r.light);
    const firstYellow = lights.indexOf('yellow'), lastRed = lights.lastIndexOf('red');
    expect(lastRed).toBeLessThan(firstYellow);
    expect(lights.lastIndexOf('yellow')).toBeLessThan(lights.indexOf('green'));
    expect(rows[rows.length - 1].id).toBe('lg-off');
    expect(rows.some(r => r.id === 'smbhl')).toBe(false);
    for (const r of rows) for (const k of ['light', 'name', 'ownerMasked', 'createdAt', 'regularCount', 'countTier', 'billingStatus', 'lastAdminSignInAt', 'answeredShare', 'nextGame']) expect(r).toHaveProperty(k);
  });

  it('filter by state', async () => {
    expect((await data('?status=red')).rows.map(r => r.id).sort()).toEqual(['lg-pay', 'lg-setup', 'lg-signin21']);
    expect((await data('?status=yellow')).rows.every(r => r.light === 'yellow')).toBe(true);
    expect((await data('?status=green')).rows.map(r => r.id)).toEqual(['lg-green']);
    expect((await data('?status=deactivated')).rows.map(r => r.id)).toEqual(['lg-off']);
  });

  it('search by name, accents and case ignored, with a filter or alone', async () => {
    expect((await data('?q=castors')).rows.map(r => r.id)).toEqual(['lg-green']);
    expect((await data(`?q=${encodeURIComponent('AURORES')}`)).rows.map(r => r.id)).toEqual(['lg-young']);
    expect((await data('?q=castors&status=red')).rows).toEqual([]);
    expect(filterLeagueRows([{ name: 'Équipe Été', light: 'red' }], { q: 'equipe ete' })).toHaveLength(1);
  });

  it('the existing leagues list is still there (and SMBHL in it, as before)', async () => {
    const d = await data();
    expect(d.leagues.find(l => l.id === 'smbhl')).toBeTruthy();
    expect(d.leagues.find(l => l.id === 'lg-green').flags).toBeTruthy();
  });

  it('the SMBHL product: no rows, the same data as before', async () => {
    delete env.LEAGUE_PRODUCT;
    try {
      const d = await data('?status=red');
      expect(d.rows).toBeUndefined();
      expect(d.leagues.length).toBeGreaterThan(5);
    } finally { env.LEAGUE_PRODUCT = 'true'; }
  });
});

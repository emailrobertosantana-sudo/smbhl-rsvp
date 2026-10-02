// Ad test, item 3 (2026-10-02): the super-admin league list shows each
// league's angle, utm_source, utm_campaign and utm_content (a dash when
// empty), and a table, per utm_content, of the leagues created in a period of
// creation days (default: the last 30) and how many sent a first game
// invitation. Read-only. Plus the six ad links of docs/ads-test-links.md,
// each answering with its angle's headline in its language.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { attributionSummary } from '../src/league_health.js';
import { localParts } from '../src/league_ids.js';

const ADMIN_KEY = 'test-p227-admin';
const DAY = 86400000;
const NOW = Date.now();
const ago = d => new Date(NOW - d * DAY).toISOString();
const dayAgo = d => localParts(new Date(NOW - d * DAY)).date;

async function league(id, { createdDaysAgo = 3, angle = null, source = null, campaign = null, content = null, invited = false } = {}) {
  const owner = `u-${id}`;
  await env.DB.prepare(`INSERT OR REPLACE INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', ?)`).bind(owner, `${id}@example.com`, ago(90)).run();
  await env.DB.prepare(
    `INSERT INTO leagues (id, name, team_count, team_names, created_by, created_at, angle, utm_source, utm_campaign, utm_content) VALUES (?, ?, 2, '["A","B"]', ?, ?, ?, ?, ?, ?)`
  ).bind(id, `League ${id}`, owner, ago(createdDaysAgo), angle, source, campaign, content).run();
  await env.DB.prepare(`INSERT INTO league_admins (user_id, league_id, created_at) VALUES (?, ?, ?)`).bind(owner, id, ago(createdDaysAgo)).run();
  if (invited) {
    await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, payload, send_after, sent_at, created_at, league_id) VALUES ('reminder_72h', ?, ?, '{}', ?, ?, ?, ?)`)
      .bind(`${id}:g`, `${id}-p1`, ago(1), ago(1), ago(1), id).run();
  }
}
const data = async (query = '') => (await SELF.fetch(`http://example.com/super-admin/leagues/data${query}`, { headers: { 'x-admin': ADMIN_KEY } })).json();

beforeAll(async () => {
  env.AUTH_SECRET = 'test-p227-auth'; env.ADMIN_KEY = ADMIN_KEY; env.LEAGUE_PRODUCT = 'true';
  await applyRealSchema(env);
  await league('lg-prix-1', { angle: 'prix', source: 'facebook', campaign: 'test1', content: 'prix-fr', invited: true });
  await league('lg-prix-2', { angle: 'prix', source: 'facebook', campaign: 'test1', content: 'prix-fr' });
  await league('lg-remp-1', { angle: 'remplacants', source: 'facebook', campaign: 'test1', content: 'remplacants-en', invited: true });
  await league('lg-old', { createdDaysAgo: 45, angle: 'comptes', source: 'facebook', campaign: 'test1', content: 'comptes-fr', invited: true });
  await league('lg-plain', { invited: true });
});
afterAll(() => { delete env.LEAGUE_PRODUCT; });

describe('the data', () => {
  it('each row carries its attribution; a league with none, nulls', async () => {
    const d = await data();
    const byId = Object.fromEntries(d.rows.map(r => [r.id, r]));
    expect(byId['lg-prix-1']).toMatchObject({ angle: 'prix', utmSource: 'facebook', utmCampaign: 'test1', utmContent: 'prix-fr' });
    expect(byId['lg-plain']).toMatchObject({ angle: null, utmSource: null, utmCampaign: null, utmContent: null });
  });

  it('the table counts match, over the last 30 days by default', async () => {
    const d = await data();
    expect(d.attribution.from).toBe(dayAgo(29));
    expect(d.attribution.to).toBe(dayAgo(0));
    expect(d.attribution.rows).toEqual([
      { utmContent: 'prix-fr', leagues: 2, firstInvites: 1 },
      { utmContent: 'remplacants-en', leagues: 1, firstInvites: 1 },
      { utmContent: null, leagues: 1, firstInvites: 1 }
    ]);
  });

  it('the period filter: the older league in, the recent ones out', async () => {
    const d = await data(`?from=${dayAgo(60)}&to=${dayAgo(40)}`);
    expect(d.attribution.rows).toEqual([{ utmContent: 'comptes-fr', leagues: 1, firstInvites: 1 }]);
    // A bad date falls back to the default.
    expect((await data('?from=yesterday')).attribution.from).toBe(dayAgo(29));
    // The list itself still shows every league.
    expect(d.rows.map(r => r.id).sort()).toEqual(['lg-old', 'lg-plain', 'lg-prix-1', 'lg-prix-2', 'lg-remp-1']);
  });

  it('pure: an empty period, no rows', () => {
    expect(attributionSummary([], {})).toEqual([]);
    expect(attributionSummary([{ createdAt: ago(1), utmContent: 'x', firstInvitationAt: null }], { from: dayAgo(0), to: dayAgo(0) })).toEqual([]);
  });

  it('needs the admin key', async () => {
    expect((await SELF.fetch('http://example.com/super-admin/leagues/data')).status).not.toBe(200);
  });
});

describe('the page', () => {
  it('the new columns, the period and the table, in both languages', async () => {
    const html = await (await SELF.fetch(`http://example.com/super-admin/leagues?key=${ADMIN_KEY}`, { headers: { cookie: `admin_key=${ADMIN_KEY}` } })).text();
    for (const [k, fr] of [['colAngle', 'Angle'], ['colSource', 'Source'], ['colCampaign', 'Campagne'], ['colContent', 'Contenu'], ['colLeaguesCreated', 'Ligues créées'], ['colFirstInvites', 'Premières invitations envoyées'], ['periodLabel', 'Période']]) {
      expect(html).toContain(`data-i18n="${k}">${fr}<`);
    }
    for (const en of ['"colCampaign":"Campaign"', '"colContent":"Content"', '"colLeaguesCreated":"Leagues created"', '"colFirstInvites":"First invites sent"', '"periodLabel":"Period"']) expect(html).toContain(en);
    expect(html).toContain(`id="sa-from" class="nl-input" type="date" value="${dayAgo(29)}"`);
    expect(html).toContain(`id="sa-to" class="nl-input" type="date" value="${dayAgo(0)}"`);
    // Empty values show a dash.
    expect(html).toContain("esc(m.angle || '–')");
  });
});

describe('the ad links (docs/ads-test-links.md)', () => {
  const H1 = {
    fr: { comptes: 'Tes joueurs répondent sans compte et sans application.', remplacants: 'Il manque du monde? Tes remplaçants sont invités automatiquement.', prix: 'Gratuit sous 15 joueurs. Ensuite, un prix fixe par mois.' },
    en: { comptes: 'Your players answer without an account or an app.', remplacants: 'Short on players? Your subs are invited automatically.', prix: 'Free under 15 players. Then one flat monthly price.' }
  };
  for (const lang of ['fr', 'en']) for (const a of ['comptes', 'remplacants', 'prix']) {
    it(`/${lang}?a=${a}`, async () => {
      const url = `https://notreligue.ca/${lang}?a=${a}&utm_source=facebook&utm_medium=paid&utm_campaign=test1&utm_content=${a}-${lang}`;
      const res = await SELF.fetch(url);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect((html.match(/<h1 data-i18n="heroTitle">([^<]*)<\/h1>/) || [])[1]).toBe(H1[lang][a]);
      expect(html).toContain(`href="/signup?a=${a}&amp;utm_source=facebook&amp;utm_medium=paid&amp;utm_campaign=test1&amp;utm_content=${a}-${lang}&amp;lang_landing=${lang}"`);
    });
  }
});

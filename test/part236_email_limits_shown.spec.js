// Stage 2, item 2b: the email limits of the plans (src/mail_guard.js
// FREE_DAILY_CAP; paid plans and the trial have no daily limit) shown on the
// homepage's pricing and on the league billing page, both languages.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { FREE_DAILY_CAP } from '../src/mail_guard.js';

const home = path => SELF.fetch(`http://notreligue.ca${path}`);
const tier = (html, key) => (html.match(new RegExp(`<div class="mail" data-i18n="${key}">([^<]*)</div>`, 'g')) || []);

beforeAll(async () => {
  env.AUTH_SECRET = 'p236-auth'; env.LEAGUE_PRODUCT = 'true'; env.BILLING_LAUNCH_AT = '2026-10-01T00:00:00Z';
  await applyRealSchema(env);
});
afterAll(() => { delete env.LEAGUE_PRODUCT; delete env.BILLING_LAUNCH_AT; });

describe('the homepage pricing', () => {
  it('the free tier names its daily limit, the paid tiers have none, in French', async () => {
    expect(FREE_DAILY_CAP).toBe(25);
    const fr = await (await home('/?lang=fr')).text();
    expect(tier(fr, 't1Mail')).toEqual(["<div class=\"mail\" data-i18n=\"t1Mail\">Jusqu'à 25 courriels par jour aux joueurs et aux remplaçants</div>"]);
    expect(tier(fr, 'paidMail')).toHaveLength(3);
    expect(fr).toContain('<div class="mail" data-i18n="paidMail">Courriels sans limite quotidienne</div>');
  });

  it('and in English, with both languages in the toggle', async () => {
    const en = await (await home('/?lang=en')).text();
    expect(en).toContain('<div class="mail" data-i18n="t1Mail">Up to 25 emails a day to players and subs</div>');
    expect(tier(en, 'paidMail')).toHaveLength(3);
    expect(en).toContain('<div class="mail" data-i18n="paidMail">Emails with no daily limit</div>');
    expect(en).toContain('Courriels sans limite quotidienne');
  });
});

describe('the billing page', () => {
  it('shows the email limits of the plans', async () => {
    const res = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.236.1' },
      body: JSON.stringify({ accept_terms: true, email: 'p236.owner@example.com', password: 'a-strong-password-1' })
    });
    const cookies = res.headers.getSetCookie();
    const s = { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
    await SELF.fetch('http://example.com/leagues/create', { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ligue Limites', teamNames: ['A', 'B'] }) });
    const fr = await (await SELF.fetch('http://example.com/league/billing', { headers: { cookie: s.cookie + '; nl_lang=fr' }, redirect: 'manual' })).text();
    expect(fr).toContain('<section class="nl-card nl-card--pad-lg bl-card" id="bl-mail">');
    expect(fr).toContain('<h2 class="h3" data-i18n="mailTitle">Limites de courriels</h2>');
    expect(fr).toContain("data-i18n=\"mailFree\">Gratuit : jusqu&#39;à 25 courriels par jour aux joueurs et aux remplaçants. Les autres attendent le lendemain.</p>");
    expect(fr).toContain("data-i18n=\"mailPaid\">Standard, Plus et l&#39;essai gratuit : aucune limite quotidienne.</p>");
    const en = await (await SELF.fetch('http://example.com/league/billing', { headers: { cookie: s.cookie + '; nl_lang=en' }, redirect: 'manual' })).text();
    expect(en).toContain('data-i18n="mailTitle">Email limits</h2>');
    expect(en).toContain('data-i18n="mailFree">Free: up to 25 emails a day to players and subs. The rest wait for the next day.</p>');
    expect(en).toContain('data-i18n="mailPaid">Standard, Plus and the free trial: no daily limit.</p>');
  });
});

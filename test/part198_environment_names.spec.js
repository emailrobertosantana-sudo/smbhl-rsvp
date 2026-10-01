// Each environment names itself: the operator health alert (webhook and
// email title) and the invalid co-admin invitation page's tab title say
// SMBHL on the SMBHL environment and Notre Ligue on Notre Ligue's
// (LEAGUE_PRODUCT=true).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { notifyAlerts, checkCronOnRequest, productName } from '../src/health.js';

let hooks, mails, original;
beforeAll(async () => {
  await applyRealSchema(env);
  env.AUTH_SECRET = env.AUTH_SECRET || 'p198-auth';
});
afterEach(() => { if (original) globalThis.fetch = original; original = null; });

function capture() {
  hooks = []; mails = [];
  original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('ntfy.sh')) { hooks.push(decodeURIComponent(opts.headers.Title || '')); return new Response('ok'); }
    return new Response('{}', { status: 200 });
  };
}
const host = { sendMail: async (_env, _to, subject) => { mails.push(subject); }, opsEmail: 'ops@p198.example', publicUrl: 'https://x.test', leagueAdminEmails: async () => [], renderAdminAlert: () => ({}) };
const environment = product => ({ DB: env.DB, ALERT_WEBHOOK_URL: 'https://ntfy.sh/p198', ...(product === 'leagues' ? { LEAGUE_PRODUCT: 'true' } : {}) });
const alerts = n => Array.from({ length: n }, (_, i) => ({ scope: 'system', fr: `Problème ${i}`, en: `Problem ${i}`, storeKey: `health:alert:p198:${Math.random()}`, admin_notified_at: 'x' }));

describe('the operator health alert names the environment', () => {
  it('SMBHL', async () => {
    const e = environment('smbhl');
    expect(productName(e)).toBe('SMBHL');
    capture();
    await notifyAlerts(e, host, alerts(3));
    expect(hooks).toEqual(['SMBHL : 3 alertes / alerts']);
    expect(mails).toEqual(['SMBHL : 3 alertes / alerts']);
  });

  it('Notre Ligue', async () => {
    const e = environment('leagues');
    expect(productName(e)).toBe('Notre Ligue');
    capture();
    await notifyAlerts(e, host, alerts(1));
    expect(hooks).toEqual(['Notre Ligue : 1 alerte / alert']);
  });

  it('the stopped-cron alert too', async () => {
    for (const [product, name] of [['smbhl', 'SMBHL'], ['leagues', 'Notre Ligue']]) {
      const e = environment(product);
      await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).bind(`health:cron:${product}`, JSON.stringify({ last_ok_at: '2000-01-01T00:00:00Z', ok: true })).run();
      await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(`health:stale_alerted:${product}`).run();
      capture(); mails = [];
      await checkCronOnRequest(e, host);
      expect(hooks).toEqual([`${name} : cron ${product} arrêté / stopped`]);
    }
  });
});

describe('the invalid co-admin invitation page names the environment', () => {
  const title = async () => {
    const html = await (await SELF.fetch('http://example.com/league/admins/accept?token=nope')).text();
    return html.match(/<title>([^<]*)<\/title>/)[1];
  };
  it('SMBHL, then Notre Ligue', async () => {
    delete env.LEAGUE_PRODUCT;
    expect(await title()).toBe('Invitation invalide | SMBHL');
    env.LEAGUE_PRODUCT = 'true';
    expect(await title()).toBe('Invitation invalide | Notre Ligue');
    delete env.LEAGUE_PRODUCT;
  });
});

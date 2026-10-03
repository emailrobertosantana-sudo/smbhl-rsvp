// The super-admin's « Envoyer une alerte test » / "Send a test alert": one
// push through the operator webhook (the same call as the new-league and
// new-subscription alerts, src/operator_alerts.js), with what the webhook
// answered and how long it took. Admin key only, Notre Ligue only, nothing
// written, the webhook URL and the token never shown.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { TEST_ALERT_TITLE } from '../src/operator_alerts.js';

const HOOK = 'https://ntfy.sh/p239-secret-topic';
const KEY = 'p239-admin-key';
const calls = [];
let answer = 200;
let originalFetch;

beforeAll(async () => {
  Object.assign(env, { LEAGUE_PRODUCT: 'true', ADMIN_KEY: KEY, ALERT_WEBHOOK_URL: HOOK });
  delete env.ALERT_WEBHOOK_TOKEN;
  await applyRealSchema(env);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url && url.url ? url.url : url);
    if (u === HOOK) {
      calls.push({ title: decodeURIComponent((opts.headers && opts.headers.Title) || ''), tags: opts.headers && opts.headers.Tags, auth: opts.headers && opts.headers.Authorization, body: String(opts.body || ''), signal: !!opts.signal });
      if (answer === 'throw') throw new Error(`connect failed to ${HOOK}`);
      return new Response('{}', { status: answer });
    }
    return new Response('{}', { status: 404 });
  };
});
afterAll(() => { globalThis.fetch = originalFetch; delete env.LEAGUE_PRODUCT; });
beforeEach(() => { calls.length = 0; answer = 200; });

const press = (headers = { 'x-admin': KEY }) => SELF.fetch('http://example.com/super-admin/alert/test', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
const settingsCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM settings').first()).n;

describe('Send a test alert', () => {
  it('sends one push with the test title and says the status and the time; nothing written', async () => {
    const before = await settingsCount();
    const res = await press();
    expect(res.status).toBe(200);
    const r = await res.json();
    // Email alerts batch: one answer per channel; no alert email here.
    expect(r).toMatchObject({ ok: true, email: { configured: false }, webhook: { configured: true, sent: true, status: 200, token: false, error: '' } });
    expect(typeof r.webhook.ms).toBe('number');
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe("Notre Ligue : test d'alerte / alert test");
    expect(calls[0].title).toBe(TEST_ALERT_TITLE);
    expect(calls[0].tags).toBe('test_tube');
    expect(calls[0].body).toContain('Rien à faire.');
    expect(calls[0].body).toContain('Nothing to do.');
    // The same 4 s limit as the league and subscription alerts.
    expect(calls[0].signal).toBe(true);
    expect(await settingsCount()).toBe(before);
    expect(JSON.stringify(r)).not.toContain('p239-secret-topic');
  });

  it('with the access token: sent in the header, shown only as yes', async () => {
    env.ALERT_WEBHOOK_TOKEN = 'tk_p239_secret';
    try {
      const r = await (await press()).json();
      expect(r.webhook.token).toBe(true);
      expect(calls[0].auth).toBe('Bearer tk_p239_secret');
      expect(JSON.stringify(r)).not.toContain('tk_p239_secret');
    } finally { delete env.ALERT_WEBHOOK_TOKEN; }
  });

  it("a refusal shows the webhook's status", async () => {
    answer = 429;
    const r = await (await press()).json();
    expect(r.webhook).toMatchObject({ sent: false, status: 429, error: 'webhook 429' });
  });

  it('a failed connection: status 0, and the webhook URL never in the error', async () => {
    answer = 'throw';
    const r = await (await press()).json();
    expect(r.webhook).toMatchObject({ sent: false, status: 0 });
    expect(r.webhook.error).toContain('[webhook]');
    expect(JSON.stringify(r)).not.toContain('p239-secret-topic');
  });

  it('without a webhook: nothing sent, said so', async () => {
    delete env.ALERT_WEBHOOK_URL;
    try {
      const r = await (await press()).json();
      expect(r).toMatchObject({ email: { configured: false }, webhook: { configured: false } });
      expect(calls).toHaveLength(0);
    } finally { env.ALERT_WEBHOOK_URL = HOOK; }
  });

  it('only with the admin key, and only on Notre Ligue', async () => {
    expect((await press({})).status).toBeGreaterThanOrEqual(401);
    expect((await press({ 'x-admin': 'wrong' })).status).toBeGreaterThanOrEqual(401);
    env.LEAGUE_PRODUCT = 'false';
    try { expect((await press()).status).toBe(404); } finally { env.LEAGUE_PRODUCT = 'true'; }
    expect(calls).toHaveLength(0);
  });

  it('the button is on the super-admin list page, in both languages', async () => {
    const html = await (await SELF.fetch('http://example.com/super-admin/leagues', { headers: { 'x-admin': KEY } })).text();
    expect(html).toContain('id="sa-test-alert"');
    expect(html).toContain('Envoyer une alerte test');
    expect(html).toContain('Send a test alert');
  });
});

// What the privacy policy says, made true (batch 5 item 3): the rate
// limits' IP addresses are erased after 24 hours; the operator webhook
// (ntfy.sh) never receives an email or an IP address; Notre Ligue pages load
// their font from this Worker, not from Google; the published text says so,
// and says nothing about a draft.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { purgeRateLimitIps, IP_RETENTION_HOURS } from '../src/auth.js';
import { scrubForWebhook, postWebhook } from '../src/health.js';

beforeAll(async () => {
  env.AUTH_SECRET = 'p203-auth';
  await applyRealSchema(env);
});
let original;
afterEach(() => { if (original) globalThis.fetch = original; original = null; delete env.LEAGUE_PRODUCT; });

describe('IP addresses kept 24 hours', () => {
  it('older rows are erased, recent ones kept', async () => {
    expect(IP_RETENTION_HOURS).toBe(24);
    const now = Date.now();
    await env.DB.prepare('DELETE FROM signup_attempts').run();
    for (const [ip, ago] of [['203.0.113.1', 25], ['login:203.0.113.2', 30], ['203.0.113.3', 2]]) {
      await env.DB.prepare('INSERT INTO signup_attempts (ip, window_start, count) VALUES (?, ?, 1)').bind(ip, String(now - ago * 3600000)).run();
    }
    expect(await purgeRateLimitIps(env, now)).toBe(2);
    const left = ((await env.DB.prepare('SELECT ip FROM signup_attempts').all()).results || []).map(r => r.ip);
    expect(left).toEqual(['203.0.113.3']);
  });
});

describe('the operator webhook', () => {
  it('masks any email or IP address in free text', async () => {
    expect(scrubForWebhook('resend 422: lea.joueuse@example.com refused from 203.0.113.9 and 2001:db8:0:0:0:0:0:1'))
      .toBe('resend 422: [courriel/email] refused from [IP] and [IP]');
    expect(scrubForWebhook('3 alertes, dimanche 15 nov. · 18 h 08')).toBe('3 alertes, dimanche 15 nov. · 18 h 08');
    original = globalThis.fetch;
    let sent = null;
    globalThis.fetch = async (url, opts) => { sent = { title: decodeURIComponent(opts.headers.Title), body: opts.body }; return new Response('ok'); };
    await postWebhook({ ALERT_WEBHOOK_URL: 'https://ntfy.sh/p203' }, 'Alerte', 'Erreur pour bob@example.com');
    expect(sent.body).toBe('Erreur pour [courriel/email]');
  });
});

describe('Notre Ligue pages: the font from this Worker', () => {
  it('no request to Google from a page, and the font is served here', async () => {
    env.LEAGUE_PRODUCT = 'true';
    for (const path of ['/', '/signup', '/login', '/confidentialite']) {
      const html = await (await SELF.fetch('http://example.com' + path)).text();
      expect(html, path).not.toContain('fonts.googleapis.com');
      expect(html, path).not.toContain('fonts.gstatic.com');
      expect(html, path).toContain("src:url(/fonts/archivo-latin.woff2) format('woff2')");
    }
    for (const f of ['archivo-latin.woff2', 'archivo-latin-ext.woff2']) {
      const res = await SELF.fetch('http://example.com/fonts/' + f);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('font/woff2');
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('wOF2');
    }
    expect((await SELF.fetch('http://example.com/fonts/other.woff2')).status).not.toBe(200);
  });
});

describe('the published privacy policy', () => {
  it('says what is true, and nothing about a draft', async () => {
    env.LEAGUE_PRODUCT = 'true';
    const pages = {};
    for (const path of ['/confidentialite', '/conditions']) pages[path] = await (await SELF.fetch('http://example.com' + path)).text();
    const p = pages['/confidentialite'];
    expect(p).toContain('Adresse courriel, mot de passe (conservé sous forme hachée, jamais en clair), paramètres de la ligue');
    expect(p).toContain('Email address, password (stored hashed, never in plain text), league settings');
    expect(p).toContain('pendant 24 heures, afin de bloquer les abus.');
    expect(p).toContain('for 24 hours, to block abuse.');
    expect(p).toContain('rester connecté, protéger les formulaires, et retenir ta langue et la ligue que tu consultes.');
    expect(p).toContain('keeping you signed in, protecting forms, and remembering your language and the league you are viewing.');
    for (const html of Object.values(pages)) {
      const text = html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ');
      expect(text).not.toMatch(/ébauche|provisoire|draft|provisional|review/i);
    }
  });
});

// The mail provider switch (src/mail_provider.js).
//
// MAIL_PROVIDER 'cloudflare' sends a message From mail.notreligue.ca
// through Cloudflare Email Sending (the SEND_EMAIL binding); everything
// else goes through Resend. SMBHL's From is joueur@smbhl.com, so SMBHL is
// always on Resend, whatever the variable says. Production has neither the
// variable nor the binding (wrangler.jsonc, checked in
// test/rendered/wrangler_mail_config.spec.mjs): Resend for everything.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { chooseMailProvider, parseAddress } from '../src/mail_provider.js';
import { classifySendError } from '../src/mail_queue.js';
import { sendMail } from '../src/index.js';

const SMBHL_FROM = 'SMBHL - Hockey <joueur@smbhl.com>';
const LEAGUE_FROM = 'Ligue du mercredi <ligue-du-mercredi@mail.notreligue.ca>';

describe('chooseMailProvider', () => {
  it('SMBHL is on Resend whatever MAIL_PROVIDER says', () => {
    for (const MAIL_PROVIDER of [undefined, '', 'resend', 'cloudflare', 'CLOUDFLARE', ' cloudflare ']) {
      expect(chooseMailProvider({ MAIL_PROVIDER, SEND_EMAIL: {} }, SMBHL_FROM), String(MAIL_PROVIDER)).toBe('resend');
    }
  });

  it('a Notre Ligue message: Cloudflare only when the environment says so', () => {
    expect(chooseMailProvider({}, LEAGUE_FROM)).toBe('resend');
    expect(chooseMailProvider({ MAIL_PROVIDER: 'resend' }, LEAGUE_FROM)).toBe('resend');
    expect(chooseMailProvider({ MAIL_PROVIDER: 'cloudflare' }, LEAGUE_FROM)).toBe('cloudflare');
    expect(chooseMailProvider({ MAIL_PROVIDER: 'cloudflare' }, 'Notre Ligue <bonjour@mail.notreligue.ca>')).toBe('cloudflare');
    // Another domain, even a lookalike, is not the one Cloudflare signs for.
    expect(chooseMailProvider({ MAIL_PROVIDER: 'cloudflare' }, 'x <a@notreligue.ca>')).toBe('resend');
    expect(chooseMailProvider({ MAIL_PROVIDER: 'cloudflare' }, 'x <a@mail.notreligue.ca.evil.example>')).toBe('resend');
  });

  it('parses a display name and an address', () => {
    expect(parseAddress(LEAGUE_FROM)).toEqual({ email: 'ligue-du-mercredi@mail.notreligue.ca', name: 'Ligue du mercredi' });
    expect(parseAddress('a@b.c')).toEqual({ email: 'a@b.c', name: '' });
  });
});

describe('sendMail through each provider', () => {
  let resendCalls, cfCalls, originalFetch, saved;
  beforeAll(async () => { await applyRealSchema(env); originalFetch = globalThis.fetch; saved = { MAIL_PROVIDER: env.MAIL_PROVIDER, SEND_EMAIL: env.SEND_EMAIL, RESEND_API_KEY: env.RESEND_API_KEY, PUBLIC_URL: env.PUBLIC_URL }; });
  beforeEach(() => {
    resendCalls = []; cfCalls = [];
    globalThis.fetch = async (url, opts) => { if (String(url).includes('api.resend.com')) { resendCalls.push(JSON.parse(opts.body)); return new Response('{"id":"r1"}', { status: 200 }); } return new Response('{}', { status: 404 }); };
    Object.defineProperty(env, 'RESEND_API_KEY', { value: 'test', configurable: true, writable: true });
    Object.defineProperty(env, 'PUBLIC_URL', { value: 'https://rsvp.notreligue.ca', configurable: true, writable: true });
    Object.defineProperty(env, 'MAIL_PROVIDER', { value: 'cloudflare', configurable: true, writable: true });
    Object.defineProperty(env, 'SEND_EMAIL', { value: { send: async m => { cfCalls.push(m); return { messageId: '<m1@mail.notreligue.ca>' }; } }, configurable: true, writable: true });
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(saved)) Object.defineProperty(env, k, { value: v, configurable: true, writable: true });
  });

  it('a league message goes to Cloudflare, with the same From, Reply-To and headers', async () => {
    await sendMail(env, 'player@example.com', 'Sujet', 'Texte', '<p>Html</p>', null, { fromEmail: LEAGUE_FROM, replyToEmail: 'admin@example.com' });
    expect(resendCalls).toEqual([]);
    expect(cfCalls).toEqual([{
      from: { email: 'ligue-du-mercredi@mail.notreligue.ca', name: 'Ligue du mercredi' }, to: 'player@example.com', replyTo: 'admin@example.com',
      subject: 'Sujet', text: 'Texte', html: '<p>Html</p>', headers: { 'List-Unsubscribe': '<mailto:ligue-du-mercredi@mail.notreligue.ca?subject=unsubscribe>' }
    }]);
  });

  it('an SMBHL message goes to Resend, even with MAIL_PROVIDER cloudflare and the binding present', async () => {
    await sendMail(env, 'player@example.com', 'Subject', 'Text', null, null, { fromEmail: SMBHL_FROM, replyToEmail: 'info@smbhl.com' });
    expect(cfCalls).toEqual([]);
    expect(resendCalls).toHaveLength(1);
    expect(resendCalls[0].from).toBe(SMBHL_FROM);
  });

  it('a refusal is not dropped and not sent through Resend: it throws, and the outbox classifies it', async () => {
    Object.defineProperty(env, 'SEND_EMAIL', { value: { send: async () => { throw new Error('recipient is suppressed'); } }, configurable: true, writable: true });
    const err = await sendMail(env, 'player@example.com', 'S', 'T', null, null, { fromEmail: LEAGUE_FROM }).catch(e => e);
    expect(err.message).toBe('cloudflare: recipient is suppressed');
    expect(resendCalls).toEqual([]);
    expect(classifySendError(err)).toBe('permanent');
    expect(classifySendError(new Error('cloudflare: temporarily unavailable'))).toBe('transient');
    // No binding in an environment set to cloudflare: a configuration fault, retried and reported.
    Object.defineProperty(env, 'SEND_EMAIL', { value: undefined, configurable: true, writable: true });
    const missing = await sendMail(env, 'player@example.com', 'S', 'T', null, null, { fromEmail: LEAGUE_FROM }).catch(e => e);
    expect(missing.message).toMatch(/^cloudflare: the SEND_EMAIL binding is not set/);
    expect(classifySendError(missing)).toBe('transient');
    expect(resendCalls).toEqual([]);
  });
});

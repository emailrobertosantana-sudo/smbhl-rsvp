// Design system Part 5: verification, password-reset, and co-admin
// invite emails rebuilt on the real design system
// (components/Emails/preview.html, guidelines/30-emails.md) -- a
// 560px bulletproof table, Archivo/Arial/Helvetica, a single button,
// no more the old "SMBHL Ligue" copy-paste leftover (these emails
// belong exclusively to the new account/league system; SMBHL has no
// user accounts and never sends any of them).
//
// The literal "sub-invite" (sub_call) email named in this task's Part
// 5 is NOT rebuilt: it's built on emailWrap()/body() (src/index.js),
// shared verbatim with SMBHL's own real, live weekly game-invite and
// sub-call emails (parameterized by leagueCfg, not a separate code
// path the way every other page in this task had via page()/
// nlDocument()). Redesigning that shared template would restyle
// SMBHL's actual production email output, which this task's own scope
// explicitly forbids -- flagged in the final report as a genuine,
// safety-relevant scope gap rather than silently skipped or silently
// touched.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { leagueFillColor } from '../src/design_system.js';

const AUTH_SECRET = 'test-part5-emails-ds-secret';

async function withMailMock(fn) {
  const sent = [];
  const mockFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.includes('resend.com')) {
      const body = JSON.parse(opts.body);
      sent.push({ to: body.to, subject: body.subject, text: body.text, html: body.html });
      return new Response(JSON.stringify({ id: 'mock' }), { status: 200 });
    }
    return mockFetch(url, opts);
  };
  try {
    const result = await fn();
    return { sentMails: sent, result };
  } finally {
    globalThis.fetch = mockFetch;
  }
}

describe('Part 5: verification/password-reset/co-admin-invite emails (design system)', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RESEND_API_KEY = 'mock-key';
    await applyRealSchema(env);
  });

  it('the verification email uses the real design system, not the old "SMBHL Ligue" copy', async () => {
    const { sentMails } = await withMailMock(async () =>
      SELF.fetch('http://example.com/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.851' },
        body: JSON.stringify({ email: 'ds.email.verify@example.com', password: 'a-strong-password-1' })
      })
    );
    expect(sentMails.length).toBe(1);
    const mail = sentMails[0];
    expect(mail.html).not.toContain('SMBHL');
    expect(mail.html).toContain('Archivo,Arial,Helvetica,sans-serif');
    expect(mail.html).toContain('role="presentation"');
    expect(mail.html).toContain('width:560px');
    expect(mail.html).toContain('font-stretch:118%');
    expect(mail.html).toContain('Confirmer mon courriel');
    expect(mail.html).toContain('Confirm my email');
  });

  it("the password-reset email also uses the real design system, no 'SMBHL Ligue'", async () => {
    await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.852' },
      body: JSON.stringify({ email: 'ds.email.reset@example.com', password: 'a-strong-password-1' })
    });
    const { sentMails } = await withMailMock(async () =>
      SELF.fetch('http://example.com/auth/request-password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ds.email.reset@example.com' })
      })
    );
    expect(sentMails.length).toBe(1);
    const mail = sentMails[0];
    expect(mail.html).not.toContain('SMBHL');
    expect(mail.html).toContain('Archivo,Arial,Helvetica,sans-serif');
    expect(mail.html).toContain('role="presentation"');
    expect(mail.html).toContain('Choisir un nouveau mot de passe');
  });

  it("the co-admin invite email's header bar/button use the league's own stored color, not a hardcoded one", async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.853' },
      body: JSON.stringify({ email: 'ds.email.invite@example.com', password: 'a-strong-password-1' })
    });
    const cookie = (signupRes.headers.get('set-cookie') || '').split(';')[0];
    const cookies = typeof signupRes.headers.getSetCookie === 'function' ? signupRes.headers.getSetCookie() : [cookie];
    const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
    const csrfToken = csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';

    const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'DS Invite Email League', teamNames: ['A', 'B'], tracksStats: true })
    });
    const leagueId = (await leagueRes.json()).league.id;
    const greenColor = '#1b7e4e';
    await env.DB.prepare('UPDATE leagues SET color = ? WHERE id = ?').bind(greenColor, leagueId).run();

    const { sentMails } = await withMailMock(async () =>
      SELF.fetch('http://example.com/league/admins/invite', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ email: 'coadmin.invite@example.com' })
      })
    );
    expect(sentMails.length).toBe(1);
    const mail = sentMails[0];
    expect(mail.html).toContain(leagueFillColor(greenColor));
    expect(mail.html).toContain('DS Invite Email League');
    expect(mail.html).toContain('Archivo,Arial,Helvetica,sans-serif');
    expect(mail.html).not.toContain('SMBHL');
  });
});

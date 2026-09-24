// Live-testing task (batch 2), Part 10 (BIG): a per-league setting to
// disable the public-facing page entirely.
//
// Requirements: (1) the public URL returns a clear "not public"
// response, never a plain-text 404 that looks like a broken link, and
// never distinguishing "doesn't exist" from "exists but hidden" (a
// deliberate choice: leaking that distinction would defeat half the
// point of hiding a page specifically to keep its existence quiet --
// documented in publicPageNotAvailableResponse's own comment,
// index.js). (2) the dashboard's public-page card reflects the
// disabled state instead of offering a link to copy. (3) default is
// ENABLED (migrate-037.sql, DEFAULT 1) so every existing league is
// completely unaffected. (4) both states are tested.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part10-batch2-hide-public-page-secret';

function extractCookie(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(', ');
  const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
  return csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
}
async function signup(email, ip) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  return { cookie: extractCookie(res), csrfToken: extractCsrfToken(res) };
}
async function createLeague(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).league;
}

describe('Part 10 (live-testing task, batch 2): per-league public-page visibility setting', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('safety: every existing league defaults to public_page_enabled = 1 (unaffected)', async () => {
    const { cookie, csrfToken } = await signup('hidepage.default@example.com', '203.0.170.001');
    const league = await createLeague(cookie, csrfToken, { name: 'Hide Page Default League', teamNames: ['A', 'B'], tracksStats: true });
    const row = await env.DB.prepare('SELECT public_page_enabled FROM leagues WHERE id = ?').bind(league.id).first();
    expect(row.public_page_enabled).toBe(1);
    const html = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
    expect(html).not.toContain("n'est pas publique");
  });

  it('a real league (unset) and a genuinely nonexistent league id return the SAME response shape (status + body), not distinguishable', async () => {
    const realRes = await SELF.fetch('http://example.com/league/public?league=00000000-0000-0000-0000-000000000000');
    const realHtml = await realRes.text();

    const { cookie, csrfToken } = await signup('hidepage.indistinguishable@example.com', '203.0.170.002');
    const league = await createLeague(cookie, csrfToken, { name: 'Hide Page Indistinguishable League', teamNames: ['A', 'B'], tracksStats: true });
    await SELF.fetch('http://example.com/league/settings/identity', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ publicPageEnabled: false })
    });
    const disabledRes = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`);
    const disabledHtml = await disabledRes.text();

    expect(realRes.status).toBe(disabledRes.status);
    expect(realRes.status).toBe(404);
    expect(realHtml).toBe(disabledHtml);
    // Not a bare, broken-link-looking plain-text 404.
    expect(disabledHtml).toContain('<html');
    expect(disabledHtml).not.toBe('not found');
  });

  it('disabling and re-enabling actually flips real visibility end to end', async () => {
    const { cookie, csrfToken } = await signup('hidepage.toggle@example.com', '203.0.170.003');
    const league = await createLeague(cookie, csrfToken, { name: 'Hide Page Toggle League', teamNames: ['A', 'B'], tracksStats: true });
    const publicUrl = `http://example.com/league/public?league=${encodeURIComponent(league.id)}`;

    const beforeHtml = await (await SELF.fetch(publicUrl)).text();
    expect(beforeHtml).toContain('Hide Page Toggle League');

    const disableRes = await SELF.fetch('http://example.com/league/settings/identity', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ publicPageEnabled: false })
    });
    expect(disableRes.status).toBe(200);
    expect((await disableRes.json()).settings.publicPageEnabled).toBe(false);
    const disabledHtml = await (await SELF.fetch(publicUrl)).text();
    expect(disabledHtml).not.toContain('Hide Page Toggle League');
    expect((await SELF.fetch(publicUrl)).status).toBe(404);

    const enableRes = await SELF.fetch('http://example.com/league/settings/identity', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ publicPageEnabled: true })
    });
    expect((await enableRes.json()).settings.publicPageEnabled).toBe(true);
    const reenabledRes = await SELF.fetch(publicUrl);
    expect(reenabledRes.status).toBe(200);
    expect(await reenabledRes.text()).toContain('Hide Page Toggle League');
  });

  it('the dashboard reflects the disabled state instead of offering a link to copy', async () => {
    const { cookie, csrfToken } = await signup('hidepage.dashboard@example.com', '203.0.170.004');
    await createLeague(cookie, csrfToken, { name: 'Hide Page Dashboard League', teamNames: ['A', 'B'], tracksStats: true });
    const beforeHtml = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(beforeHtml).toContain('id="publicUrlLink"');
    expect(beforeHtml).toContain('id="copyPublicUrlBtn"');

    await SELF.fetch('http://example.com/league/settings/identity', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ publicPageEnabled: false })
    });
    const afterHtml = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(afterHtml).not.toContain('id="publicUrlLink"');
    expect(afterHtml).not.toContain('id="copyPublicUrlBtn"');
    expect(afterHtml).toContain('data-i18n="publicPageDisabled"');
  });

  it('the settings page renders the toggle reflecting the league\'s real current state', async () => {
    const { cookie, csrfToken } = await signup('hidepage.settingsrender@example.com', '203.0.170.005');
    await createLeague(cookie, csrfToken, { name: 'Hide Page Settings Render League', teamNames: ['A', 'B'], tracksStats: true });
    const enabledHtml = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(enabledHtml).toMatch(/aria-checked="true"[^>]*id="se_public_page_switch"/);

    await SELF.fetch('http://example.com/league/settings/identity', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ publicPageEnabled: false })
    });
    const disabledHtml = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(disabledHtml).toMatch(/aria-checked="false"[^>]*id="se_public_page_switch"/);
  });

  it('the slug-based public route (no ?league= param) is covered by the same gate', async () => {
    const { cookie, csrfToken } = await signup('hidepage.slugroute@example.com', '203.0.170.006');
    const league = await createLeague(cookie, csrfToken, { name: 'Hide Page Slug Route League', teamNames: ['A', 'B'], tracksStats: true });
    await SELF.fetch('http://example.com/league/settings/identity', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ publicPageEnabled: false })
    });
    const res = await SELF.fetch(`http://example.com/${league.slug}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("n'est pas publique");
  });

  it('a deactivated league still shows its own distinct message (unaffected by this change -- checked in the opposite order deliberately)', async () => {
    const { cookie, csrfToken } = await signup('hidepage.deactivated@example.com', '203.0.170.007');
    const league = await createLeague(cookie, csrfToken, { name: 'Hide Page Deactivated League', teamNames: ['A', 'B'], tracksStats: true });
    await SELF.fetch('http://example.com/league/deactivate', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ confirmName: 'Hide Page Deactivated League' })
    });
    const res = await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("n'est plus active");
  });
});

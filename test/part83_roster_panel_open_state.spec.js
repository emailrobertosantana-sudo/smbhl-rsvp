// D1 (forms polish task): "Add a player" used to do nothing -- the
// panel it opens (#ro_panel) was forced open at any desktop-width
// viewport by a stray "@media (min-width: 900px) { .ro-panel {
// display: flex; } }" rule, the same class of bug fixed earlier for
// the event create form. DECIDED behaviour: the panel opens by
// default ONLY when the roster is empty (nothing to hide behind a
// click for a brand-new league); otherwise it starts collapsed and the
// button opens it; if it's already open, the button focuses the first
// field instead of doing nothing.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part83-roster-panel-open-state-secret';

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
async function addContact(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).contact;
}

describe('D1 (forms polish task): the roster panel opens/collapses by real state, not a viewport-width CSS override', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('no stray width-based CSS override remains -- visibility is governed by the .open class alone', async () => {
    const { cookie, csrfToken } = await signup('d1.css@example.com', '203.0.198.001');
    await createLeague(cookie, csrfToken, { name: 'D1 CSS League', teamNames: ['A', 'B'] });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    // Scoped to the actual <style> block, not the explanatory JS
    // comment further down (in <script>) that documents the removed
    // rule by name -- checking the whole page for that substring would
    // trip on the comment's own prose.
    const styleBlock = (html.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
    expect(styleBlock).not.toMatch(/@media[^{]*900px[^{]*\{\s*\.ro-panel\s*\{\s*display:\s*flex/);
  });

  it('empty roster: the panel is open by default, no click needed', async () => {
    const { cookie, csrfToken } = await signup('d1.empty@example.com', '203.0.198.002');
    await createLeague(cookie, csrfToken, { name: 'D1 Empty League', teamNames: ['A', 'B'] });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    const asideTag = (html.match(/<aside[^>]*id="ro_panel"[^>]*>/) || [''])[0];
    expect(asideTag).toContain('class="ro-panel open"');
  });

  it('non-empty roster: the panel starts collapsed', async () => {
    const { cookie, csrfToken } = await signup('d1.nonempty@example.com', '203.0.198.003');
    await createLeague(cookie, csrfToken, { name: 'D1 Non-Empty League', teamNames: ['A', 'B'] });
    await addContact(cookie, csrfToken, { name: 'Existing Player', role: 'roster' });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    const asideTag = (html.match(/<aside[^>]*id="ro_panel"[^>]*>/) || [''])[0];
    expect(asideTag).toContain('class="ro-panel"');
    expect(asideTag).not.toContain('open');
  });

  it('the Add a player button opens the panel, and (per the DECIDED behaviour) focuses the first field when already open, rather than doing nothing', async () => {
    const { cookie, csrfToken } = await signup('d1.button@example.com', '203.0.198.004');
    await createLeague(cookie, csrfToken, { name: 'D1 Button League', teamNames: ['A', 'B'] });
    await addContact(cookie, csrfToken, { name: 'Existing Player', role: 'roster' });
    const html = await (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    expect(html).toContain('id="ro_toggle_panel"');
    expect(html).toContain('onclick="openRosterPanel()"');
    expect(html).toContain('function openRosterPanel()');
    expect(html).toContain("panel.classList.add('open')");
    // C2 (events polish task): a create button now also scrolls its
    // panel into view, not just focuses it -- preventScroll on the
    // focus call itself avoids fighting that smooth scroll.
    expect(html).toContain("panel.scrollIntoView({ behavior: 'smooth', block: 'start' })");
    expect(html).toContain("nameField.focus({ preventScroll: true })");
    // Cancel closes it -- a distinct function from the open button's,
    // so the "already open -> focus" behaviour above can't silently
    // reduce back to a toggle that closes the panel.
    expect(html).toContain('onclick="closeRosterPanel()"');
    expect(html).toContain('function closeRosterPanel()');
    expect(html).not.toContain('function toggleRosterPanel()');
    expect(html).not.toContain('onclick="toggleRosterPanel()"');
  });
});

// Public page QA batch, D1: there was no way to see a public-page theme
// without saving it -- the only way was to apply it live to the
// league's real public page. ?theme=<name> on the public page now
// previews any of the four themes without saving anything, with a
// banner (both languages) saying so, and the Settings page's link
// previews whichever theme is currently selected in its dropdown.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part101-theme-preview-secret';

function extractCookie(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.get('set-cookie') || '').split(', ');
  const c = cookies.find(x => x.startsWith('csrf_token='));
  return c ? c.split(';')[0].split('=')[1] : '';
}
async function setup(email, ip, name) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookie = extractCookie(res), csrfToken = extractCsrfToken(res);
  const post = (path, body) => SELF.fetch('http://example.com' + path, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(body)
  });
  const league = (await (await post('/leagues/create', { name, teamNames: ['A', 'B'], tracksStats: false })).json()).league;
  await post('/league/settings/identity', { tracksResults: true });
  await post('/league/season/publish', { season_name: 'S1' });
  const slug = (await env.DB.prepare('SELECT slug FROM leagues WHERE id = ?').bind(league.id).first()).slug;
  return { league, slug, cookie, post };
}
const page = async (slug, qs = '') => (await SELF.fetch(`http://example.com/${slug}${qs}`)).text();

// Each theme's own CSS starts with its own pinned colour-scheme/--surface.
const THEME_MARKER = {
  arene: 'color-scheme: dark; --surface: #16181d;',
  clean: 'color-scheme: light; --surface: #ffffff; --surface-sunken: #f4f4f2; --surface-raised: #ffffff; --ink: #1a1a1a;',
  classique: 'color-scheme: light; --surface: #ffffff; --surface-sunken: #f4f4f2; --surface-raised: #ffffff; --ink: #111318;',
  quartier: 'color-scheme: light; --surface: #f4f4f2;'
};

describe('Theme preview (?theme=) on the public page', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('renders each of the four themes on request, without saving anything', async () => {
    const { league, slug } = await setup('preview.all@example.com', '203.0.221.001', 'Preview All League');
    for (const theme of Object.keys(THEME_MARKER)) {
      const html = await page(slug, `?theme=${theme}`);
      expect(html).toContain(THEME_MARKER[theme]);
    }
    const row = await env.DB.prepare('SELECT public_theme FROM leagues WHERE id = ?').bind(league.id).first();
    expect(row.public_theme).toBe('arene'); // still the saved default
    expect(await page(slug)).toContain(THEME_MARKER.arene);
  });

  it('a real preview carries a "not saved" banner in both languages; previewing the saved theme, or no preview, carries none', async () => {
    const { slug } = await setup('preview.banner@example.com', '203.0.221.002', 'Preview Banner League');
    const html = await page(slug, '?theme=quartier');
    expect(html).toContain('class="pb-preview-banner"');
    expect(html).toContain('Aperçu du thème Quartier, non enregistré. Les visiteurs voient toujours ton thème actuel.');
    expect(html).toContain('Preview of the Neighbourhood theme, not saved. Visitors still see your current theme.');
    expect(await page(slug, '?theme=arene')).not.toContain('class="pb-preview-banner"');
    const plain = await page(slug);
    expect(plain).not.toContain('class="pb-preview-banner"');
    expect(plain).not.toContain('themePreviewBanner'); // never ships the unused string
  });

  it('an unknown ?theme= value is ignored -- the saved theme renders, no banner', async () => {
    const { slug } = await setup('preview.bad@example.com', '203.0.221.003', 'Preview Bad League');
    const html = await page(slug, '?theme=<script>');
    expect(html).toContain(THEME_MARKER.arene);
    expect(html).not.toContain('class="pb-preview-banner"');
    expect(html).not.toContain('<script>"');
  });

  it('in-page links (History, All time) keep the preview while the visitor clicks around', async () => {
    const { slug } = await setup('preview.links@example.com', '203.0.221.004', 'Preview Links League');
    const html = await page(slug, '?theme=clean');
    expect(html).toContain('href="?season=all&amp;theme=clean#standings"');
    expect(await page(slug)).toContain('href="?season=all#standings"');
  });

  it('the Settings page links to a preview of whichever theme is selected', async () => {
    const { slug, cookie } = await setup('preview.settings@example.com', '203.0.221.005', 'Preview Settings League');
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toContain(`id="se_theme_preview" href="/${slug}?theme=arene"`);
    expect(html).toContain("a.href=a.getAttribute('data-base')+'?theme='+encodeURIComponent(this.value)");
    expect(html).toContain("Aperçu de ce thème (sans l'enregistrer)");
    expect(html).toContain('Preview this theme (without saving)');
  });
});

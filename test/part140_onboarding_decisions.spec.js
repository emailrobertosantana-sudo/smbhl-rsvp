// Onboarding decisions (items 1-7 of the onboarding follow-up).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.140.${++ip}` },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = async (s, path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const page = async (s, path) => (await SELF.fetch('http://example.com' + path, { headers: s ? { cookie: s.cookie } : {}, redirect: 'manual' })).text();

beforeAll(async () => {
  env.AUTH_SECRET = 'p140-auth';
  await applyRealSchema(env);
});

describe('1. The step counter waits for the structure', () => {
  it('steps 1 and 2 show no total; once chosen, the real total (8 fixed, 6 pickup, 5 no teams)', async () => {
    const step1 = await page(null, '/signup?step=1');
    expect(step1).toContain('data-i18n="step1">Étape 1<');
    expect(step1).not.toContain('role="progressbar"');
    for (const [structure, total, extra] of [['fixed', 8, { teamNames: ['A', 'B'] }], ['weekly_draw', 6, { teamNames: ['A', 'B'] }], ['headcount', 5, {}]]) {
      const s = await signup(`p140.count.${structure}@example.com`);
      expect(await page(s, '/signup?step=2')).not.toContain('role="progressbar"');
      await post(s, '/leagues/create', { name: `P140 ${structure}`, teamStructure: structure, ...extra });
      await post(s, '/league/season/publish', { season_name: 'S1' });
      const ob = await page(s, '/onboarding/season?step=1');
      expect(ob).toContain(`aria-valuemax="${total}"`);
      expect(ob).toMatch(new RegExp(`Étape \\d sur ${total}`));
    }
  });
});

describe('2. The mid-flow screen says created, not ready', () => {
  it('the league-created screen does not claim the league is ready, and says what is left', async () => {
    const s = await signup('p140.done@example.com');
    await post(s, '/leagues/create', { name: 'P140 Done', teamNames: ['A', 'B'] });
    const html = await page(s, '/signup?step=done');
    expect(html).toContain('data-i18n="doneTitle">Ta ligue est créée.<');
    expect(html).toContain('data-i18n="doneNext">Il reste quelques étapes : crée ta saison, puis ton horaire et tes joueurs.<');
    expect(html).toContain('"doneTitle":"Your league is created."');
    expect(html).not.toContain('est prête');
    expect(html).not.toContain('is ready');
  });
});

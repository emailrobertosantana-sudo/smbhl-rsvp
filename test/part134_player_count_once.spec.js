// Item 2/3: the player count is asked exactly once in every team structure
// -- at onboarding's roster step. A no-teams (headcount) league used to be
// asked on signup step 3 too.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.134.${++ip}` },
    body: JSON.stringify({ accept_terms: true, email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = (s, path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const page = async (s, path) => (await SELF.fetch('http://example.com' + path, { headers: { cookie: s.cookie }, redirect: 'manual' })).text();
// The player-count question: its min label (the max always travels with it).
const asks = html => (html.match(/data-i18n="lblMinPlayers(Team)?"/g) || []).length;

beforeAll(async () => {
  env.AUTH_SECRET = 'p134-auth';
  await applyRealSchema(env);
});

describe('The player count is asked once, in every structure', () => {
  for (const [structure, steps, create] of [
    ['fixed', 5, { teamNames: ['Équipe 1', 'Équipe 2', 'Équipe 3', 'Équipe 4'] }],
    ['weekly_draw', 3, { teamNames: ['Équipe 1', 'Équipe 2'] }],
    ['headcount', 3, {}]
  ]) {
    it(`${structure}: signup step 3 plus every onboarding step ask it exactly once`, async () => {
      const s = await signup(`p134.${structure}@example.com`);
      // Signup step 3 as it is before the league exists (only fixed uses it).
      let total = asks(await page(s, '/signup?step=3'));
      const res = await post(s, '/leagues/create', { name: `P134 ${structure}`, teamStructure: structure, tracksStats: false, ...create });
      expect(res.status).toBe(200);
      expect((await post(s, '/league/season/publish', { season_name: 'S1' })).status).toBe(200);
      for (let step = 1; step <= steps; step++) total += asks(await page(s, `/onboarding/season?step=${step}`));
      expect(total).toBe(1);
    });
  }
});

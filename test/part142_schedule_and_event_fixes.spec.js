// Follow-up batch: the bye note, the Schedule page's nudge and order,
// bulk-created times, the event page's result/stats card, and the Players
// table's team control.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { computePlayoffSlots } from '../src/leagues.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.142.${++ip}` },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = async (s, path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const page = async (s, path) => (await SELF.fetch('http://example.com' + path, { headers: s ? { cookie: s.cookie } : {}, redirect: 'manual' })).text();

beforeAll(async () => {
  env.AUTH_SECRET = 'p142-auth';
  await applyRealSchema(env);
});

describe('2. The bye note agrees with the slot arithmetic', () => {
  it('an odd team count reserves no extra slot, and the note says a bye uses none', async () => {
    const odd = computePlayoffSlots({ format: 'single_elimination', numTeams: 5, thirdPlace: false });
    expect(odd.hasBye).toBe(true);
    expect(odd.playoffSlots).toBe(4); // numTeams - 1: real games only
    const s = await signup('p142.bye@example.com');
    await post(s, '/leagues/create', { name: 'P142 Bye', teamNames: ['A', 'B', 'C', 'D', 'E'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const html = await page(s, '/onboarding/season?step=3');
    expect(html).toContain('id="ob_bye_note"');
    expect(html).toContain("Un bye n'est pas un match : il n'utilise aucun créneau.");
    expect(html).toContain('A bye is not a game: it uses no slot.');
    expect(html).not.toContain('créneau de plus');
    expect(html).not.toContain('extra slot');
  });
});

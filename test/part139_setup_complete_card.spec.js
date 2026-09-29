// Item 1: after setup, something says so. Players is the last setup step;
// once the checklist (schedule, players, team names, roster size) is done,
// a dismissible card offers the public page, its settings, the next game
// and Comms -- and, when reminders are off (they are on by default now),
// says the league will email no one until they are on. The Players page shows it too, after a
// spreadsheet import exactly as after a manual add.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { withGameTimes } from './support/game_times.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.139.${++ip}` },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = async (s, path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const page = async (s, path) => (await SELF.fetch('http://example.com' + path, { headers: { cookie: s.cookie } })).text();

// Everything but the players: season, schedule, real team names, roster size.
async function almostSetUp(email) {
  const s = await signup(email);
  await post(s, '/leagues/create', { name: `League ${email}`, teamNames: ['Otters', 'Bears'] });
  await post(s, '/league/season/publish', { season_name: 'S1' });
  await post(s, '/league/settings/structure', { min_players: 1, max_players: 20 });
  await post(s, '/league/events', withGameTimes({ date: '2099-06-07', season: 'S1', venue: 'Parc', start_time: '19:00' }));
  return s;
}

beforeAll(async () => {
  env.AUTH_SECRET = 'p139-auth';
  await applyRealSchema(env);
});

describe('Setup complete card', () => {
  it('absent while a step is left; shown once it is done, with its four links (reminders on by default: no reminders-off prompt); dismissible', async () => {
    const s = await almostSetUp('p139.dash@example.com');
    expect(await page(s, '/dashboard')).not.toContain('id="setup_done_card"');
    await post(s, '/league/contacts', { name: 'Lea Player', role: 'roster', team: 'Otters' });
    const html = await page(s, '/dashboard');
    expect(html).toContain('id="setup_done_card"');
    expect(html).toContain('data-i18n="setupDoneTitle">Bravo, ta ligue est prête!<');
    expect(html).toContain('"setupDoneTitle":"Congratulations, your league is ready!"');
    for (const key of ['setupDoneConfigure', 'setupDoneNextGame', 'setupDoneComms']) expect(html).toContain(`data-i18n="${key}"`);
    expect(html).toMatch(/data-i18n="setupDonePublic(Off)?"/);
    expect(html).toContain('/league/events/detail?e=');
    expect(html).not.toContain('data-i18n="setupDoneRemindersOff"');
    // Hidden once dismissed.
    expect((await post(s, '/league/setup-card/dismiss')).status).toBe(200);
    expect(await page(s, '/dashboard')).not.toContain('id="setup_done_card"');
  });

  it('with every reminder turned off, the reminders-off prompt', async () => {
    const s = await almostSetUp('p139.reminders@example.com');
    await post(s, '/league/reminders/settings', { reminder72h: false, reminder24h: false, reminder12h: false });
    await post(s, '/league/contacts', { name: 'Lea Player', role: 'roster', team: 'Otters' });
    const html = await page(s, '/dashboard');
    expect(html).toContain('id="setup_done_card"');
    expect(html).toContain('data-i18n="setupDoneRemindersOff"');
  });

  it('Players page: an import that completes setup shows the card, the same as a manual add', async () => {
    const manual = await almostSetUp('p139.manual@example.com');
    expect(await page(manual, '/league/roster')).not.toContain('id="setup_done_card"');
    await post(manual, '/league/contacts', { name: 'Lea Player', role: 'roster', team: 'Otters' });
    const afterManual = await page(manual, '/league/roster');
    expect(afterManual).toContain('id="setup_done_card"');

    const imported = await almostSetUp('p139.import@example.com');
    const res = await post(imported, '/league/contacts/bulk', { contacts: [{ name: 'Ann Import', role: 'roster', team: 'Otters' }, { name: 'Ben Import', role: 'roster', team: 'Bears' }] });
    expect(res.status).toBe(200);
    const afterImport = await page(imported, '/league/roster');
    expect(afterImport).toContain('id="setup_done_card"');
    expect(afterImport).toContain('data-i18n="setupDoneTitle"');
  });
});

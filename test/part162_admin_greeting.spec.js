// Admin-only emails greeted "Roberto" by name, hard-coded -- wrong for
// anyone else who runs or inherits the admin inbox. The name now comes from
// ADMIN_NAME when it is set; otherwise the greeting has no name.
import { env } from 'cloudflare:test';
import { describe, it, expect, afterEach } from 'vitest';
import { adminName, adminHello } from '../src/admin_greeting.js';
import { body, renderGoalieCancelEmail } from '../src/index.js';

afterEach(() => { delete env.ADMIN_NAME; });
const ev = { id: '2026-12-20', season: 'Fall 2026', week: 14, date: '2026-12-20', start_time: '10:30' };

describe('Admin greeting', () => {
  it('no name unless ADMIN_NAME is set', () => {
    expect(adminName({})).toBe('');
    expect(adminHello({}, 'fr')).toBe('Bonjour,');
    expect(adminHello({}, 'en')).toBe('Hi,');
    expect(adminHello({ ADMIN_NAME: ' Marie ' }, 'fr')).toBe('Bonjour Marie,');
    expect(adminHello({ ADMIN_NAME: 'Marie' }, 'en')).toBe('Hi Marie,');
  });

  it('the goalie-out alert greets by ADMIN_NAME, or no one -- never "Roberto"', async () => {
    let m = await renderGoalieCancelEmail(env, ev, { name: 'Sean Pichette' }, 'Red', 'self', 'in');
    expect(m.text).not.toContain('Roberto');
    expect(m.text).toContain('\nHi,\n');
    env.ADMIN_NAME = 'Marie';
    m = await renderGoalieCancelEmail(env, ev, { name: 'Sean Pichette' }, 'Red', 'self', 'in');
    expect(m.text).toContain('\nHi Marie,\n');
  });

  it('the season recap prompt uses the name it is given (the admin\'s, from prepareOutboxMessage), or none', () => {
    const payload = { season: 'Fall 2026', to: 'admin@example.com' };
    const none = body('season_recap_prompt', { ev, name: '', payload });
    expect(none.text.startsWith('Bonjour,\n')).toBe(true);
    expect(none.html).toContain('>Bonjour,</p>');
    expect(none.html).not.toContain('Roberto');
    const named = body('season_recap_prompt', { ev, name: 'Marie', payload });
    expect(named.text.startsWith('Bonjour Marie,\n')).toBe(true);
    expect(named.html).toContain('Bonjour <b>Marie</b>,</p>');
  });
});

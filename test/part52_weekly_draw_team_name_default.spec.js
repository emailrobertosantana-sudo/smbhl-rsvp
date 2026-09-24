// Live-testing task (batch 2), Part 8: the weekly_draw signup wizard's
// automatically-created default team names were a single, jammed
// bilingual string per team ("Rouge / Red", "Bleu / Blue"), so every
// surface that displays a team name showed that literal combined
// string instead of a real, single-language name. Fixed to use the
// same numbered-placeholder convention the 'fixed' wizard's own
// team-name step already uses (window.__pageDict().teamPlaceholder +
// '1'/'2', matching the signup's own current language) -- "Équipe 1"/
// "Équipe 2" (FR) or "Team 1"/"Team 2" (EN), never a bilingual pair.
// Existing leagues (or a fresh one that never customizes the default)
// can be corrected via the settings page's own team-rename route.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part8-batch2-weekly-draw-team-name-secret';

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

describe('Part 8 (live-testing task, batch 2): weekly_draw default team names are single-language, not a bilingual pair', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('no page ever renders the literal old default anywhere in this app', async () => {
    const { cookie, csrfToken } = await signup('teamname.noliteral@example.com', '203.0.168.001');
    const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Team Name Literal League', tracksStats: true, teamStructure: 'weekly_draw', teamNames: ['Équipe 1', 'Équipe 2'] })
    });
    const league = (await leagueRes.json()).league;
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'S1' })
    });
    for (const url of [
      'http://example.com/dashboard',
      'http://example.com/league/roster',
      'http://example.com/league/settings',
      `http://example.com/league/public?league=${encodeURIComponent(league.id)}`
    ]) {
      const html = await (await SELF.fetch(url, { headers: { cookie } })).text();
      expect(html).not.toContain('Rouge / Red');
      expect(html).not.toContain('Bleu / Blue');
    }
  });

  it('the settings page team-rename route accepts a rename for a weekly_draw league (the "still editable" half of this fix)', async () => {
    const { cookie, csrfToken } = await signup('teamname.editable@example.com', '203.0.168.002');
    const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Team Name Editable League', tracksStats: true, teamStructure: 'weekly_draw', teamNames: ['Équipe 1', 'Équipe 2'] })
    });
    const league = (await leagueRes.json()).league;
    const res = await SELF.fetch('http://example.com/league/settings/teams', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ teamNames: ['Les Faucons', 'Les Loutres'], teamColors: ['#2980b9', '#c0392b'] })
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT team_names FROM leagues WHERE id = ?').bind(league.id).first();
    expect(JSON.parse(row.team_names)).toEqual(['Les Faucons', 'Les Loutres']);
  });

  it('the settings page renders the current (post-default) team names as plain, single-language editable fields', async () => {
    const { cookie, csrfToken } = await signup('teamname.settingsrender@example.com', '203.0.168.003');
    await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Team Name Settings Render League', tracksStats: true, teamStructure: 'weekly_draw', teamNames: ['Équipe 1', 'Équipe 2'] })
    });
    const html = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(html).toContain('value="Équipe 1"');
    expect(html).toContain('value="Équipe 2"');
    expect(html).not.toContain('Rouge / Red');
  });
});
